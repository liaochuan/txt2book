/**
 * calibre-web 地址策略（设计文档 §6.2）。
 *
 * 分两步：`parseCalibreBaseUrl` 只做结构与端口校验；`resolveCalibreTarget`
 * 在此基础上执行主机名/IP 策略与 DNS 解析，返回可固定连接的地址。
 * 任何拒绝都使用固定的 `CALIBRE_INVALID_URL`，消息不含主机名或 IP。
 */
import { lookup as dnsLookup } from "node:dns/promises";
import {
  isAllowedPort,
  isAlwaysBlockedIp,
  isBlockedIp,
  normalizeIp,
  type LookupFn,
} from "../ssrf.js";
import { CalibreError, type CalibreBase, type CalibreTarget } from "./types.js";

/** base URL 最大字符数（设计文档 §6.2）。 */
const MAX_BASE_URL_LENGTH = 2048;

/** 所有拒绝共用的固定消息，避免泄露主机名或 IP。 */
const INVALID_URL_MESSAGE = "calibre-web 地址无效或不可访问。";

/** 默认 DNS 解析：一次取回全部地址，任一地址不合规都会整体拒绝。 */
const defaultLookup: LookupFn = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results;
};

/** 无论 `allowPrivate` 如何都拒绝的主机名。 */
const ALWAYS_BLOCKED_HOSTNAMES = new Set(["metadata", "instance-data", "metadata.google.internal"]);

/** 仅在 `allowPrivate=false` 时拒绝的域名后缀。 */
const STRICT_BLOCKED_SUFFIXES = [".local", ".internal", ".lan"];

function invalidUrl(): CalibreError {
  return new CalibreError("CALIBRE_INVALID_URL", 400, INVALID_URL_MESSAGE);
}

/** 去掉 IPv6 字面量的方括号。 */
function stripBrackets(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1);
  return host;
}

/** 归一化主机名：去方括号、空白、大小写与尾部点。 */
function normalizeHostname(host: string): string {
  return stripBrackets(host).trim().toLowerCase().replace(/\.+$/, "");
}

/** WHATWG URL 会把 IPv4 规范化为点分十进制，故这里只需识别该形态。 */
function isIpv4Literal(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

/** IPv6 字面量在 `URL.hostname` 中保留方括号。 */
function isIpv6Literal(host: string): boolean {
  return host.startsWith("[") && host.endsWith("]");
}

/**
 * 主机名策略：
 * - 始终拒绝云元数据别名；
 * - `allowPrivate=false` 时额外拒绝 localhost 与常见内网后缀。
 */
function isBlockedCalibreHostname(host: string, allowPrivate: boolean): boolean {
  const name = normalizeHostname(host);
  if (name === "") return true;
  if (ALWAYS_BLOCKED_HOSTNAMES.has(name)) return true;

  if (!allowPrivate) {
    if (name === "localhost" || name.endsWith(".localhost")) return true;
    if (name === "home.arpa" || name.endsWith(".home.arpa")) return true;
    if (STRICT_BLOCKED_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  }

  return false;
}

/**
 * 校验并规范化 calibre-web base URL。
 *
 * 只允许 http/https；禁止 userinfo、query、fragment；端口沿用封面代理策略；
 * 路径保留子路径并去掉尾部 `/`（根路径为 `""`）。
 *
 * @throws `CalibreError("CALIBRE_INVALID_URL", 400, ...)`
 */
export function parseCalibreBaseUrl(raw: string): CalibreBase {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (trimmed === "" || trimmed.length > MAX_BASE_URL_LENGTH) throw invalidUrl();

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw invalidUrl();
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") throw invalidUrl();
  if (url.username !== "" || url.password !== "") throw invalidUrl();
  if (url.search !== "" || url.hash !== "") throw invalidUrl();
  if (url.hostname === "") throw invalidUrl();

  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (!isAllowedPort(port)) throw invalidUrl();

  const basePath = url.pathname.replace(/\/+$/, "");
  const origin = url.origin;

  return { url, baseUrl: `${origin}${basePath}`, origin, basePath };
}

/**
 * 解析 calibre-web 的目标地址，应用地址策略并固定一个合法 IP。
 *
 * - IP 字面量直接判定，不触发 DNS；
 * - 域名先过主机名策略，再用注入的 `lookup` 解析全部 A/AAAA；
 * - 任一地址被策略拒绝则整体拒绝；返回第一个合法地址与 family。
 *
 * @throws `CalibreError("CALIBRE_INVALID_URL", 400, ...)`
 */
export async function resolveCalibreTarget(
  raw: string,
  opts: { allowPrivate: boolean; lookup?: LookupFn },
): Promise<CalibreTarget> {
  const base = parseCalibreBaseUrl(raw);
  const allowPrivate = opts.allowPrivate;
  const isRejectedIp = allowPrivate ? isAlwaysBlockedIp : isBlockedIp;
  const host = base.url.hostname;

  if (isIpv6Literal(host)) {
    const address = normalizeIp(host);
    const family: 4 | 6 = address.includes(":") ? 6 : 4;
    if (isRejectedIp(address)) throw invalidUrl();
    return { ...base, address, family };
  }

  if (isIpv4Literal(host)) {
    const address = normalizeIp(host);
    if (isRejectedIp(address)) throw invalidUrl();
    return { ...base, address, family: 4 };
  }

  if (isBlockedCalibreHostname(host, allowPrivate)) throw invalidUrl();

  const lookupFn = opts.lookup ?? defaultLookup;
  const dnsName = normalizeHostname(host);

  let results: ReadonlyArray<{ address: string; family: number }>;
  try {
    results = await lookupFn(dnsName);
  } catch {
    throw invalidUrl();
  }

  if (!Array.isArray(results) || results.length === 0) throw invalidUrl();

  let first: { address: string; family: 4 | 6 } | null = null;
  for (const entry of results) {
    if (typeof entry !== "object" || entry === null || typeof entry.address !== "string") {
      throw invalidUrl();
    }
    const address = normalizeIp(entry.address);
    if (isRejectedIp(address)) throw invalidUrl();
    if (first === null) {
      first = { address, family: address.includes(":") ? 6 : 4 };
    }
  }

  // `results` 非空且每个条目合法，`first` 必然已赋值；兜底保持类型完整。
  if (first === null) throw invalidUrl();
  return { ...base, ...first };
}
