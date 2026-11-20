/**
 * SSRF 防护：URL 校验与 DNS 解析结果检查（设计文档 §12.3）。
 *
 * 这里只做“这个 URL 能否安全抓取”的判定，不发起任何 HTTP 请求：
 * 调用方（封面代理）负责用返回的 `address` 固定连接、限流、重定向复检与大小限制。
 *
 * 判定策略是 fail closed：无法解析的输入一律视为不可访问，宁可误拒也不放行。
 */
import { lookup as dnsLookup } from "node:dns/promises";

/** 单次 DNS 解析结果。`family` 交给调用方参考，实际族别以地址本身为准。 */
export interface LookupAddressResult {
  address: string;
  family: number;
}

/** 可注入的 DNS 解析函数，便于测试且避免真实网络请求。 */
export type LookupFn = (hostname: string) => Promise<ReadonlyArray<LookupAddressResult>>;

/** `resolvePublicUrl` 的可选依赖。 */
export interface ResolvePublicUrlDeps {
  lookup?: LookupFn;
}

/** 校验通过的抓取目标：固定连接 `address`，`url` 仅用于路径与 Host 头。 */
export interface ResolvedPublicUrl {
  url: URL;
  address: string;
  family: 4 | 6;
}

/** 默认 DNS 解析：一次取回全部地址，任一地址不合规都会被拒绝。 */
const defaultLookup: LookupFn = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results;
};

/** 无条件允许的端口（其余端口需 >= 1024 且不在服务端口黑名单内）。 */
const ALLOWED_PORTS = new Set([80, 443, 8080, 8443]);

/**
 * 常见内网服务端口：即使 >= 1024 也拒绝。
 * 覆盖数据库、缓存、搜索、容器/集群管理、消息队列、远程管理等。
 */
const BLOCKED_SERVICE_PORTS = new Set([
  21, 22, 23, 25, 53, 110, 111, 135, 137, 138, 139, 143, 389, 445, 465, 514, 587, 636, 993, 995,
  1080, 1433, 1521, 2049, 2375, 2376, 2379, 2380, 3128, 3306, 3389, 4369, 4444, 5000, 5432, 5601,
  5672, 5900, 5984, 6379, 6443, 7001, 7199, 9042, 9092, 9160, 9200, 9300, 9418, 10250, 11211,
  15672, 27017, 27018, 27019, 50000, 61616,
]);

/**
 * 严格解析点分十进制 IPv4（IPv6 末尾内嵌 IPv4 时使用）。
 * 返回 4 个 0-255 的字节，非法返回 `null`。
 */
function parseDottedIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    octets.push(octet);
  }
  return octets;
}

/** 按 WHATWG 规则解析单个 IPv4 分段：支持十进制、`0x` 十六进制与 `0` 前缀八进制。 */
function parseIpv4Number(part: string): number | null {
  if (part === "") return null;
  let value: number;
  if (/^0x[0-9a-f]+$/.test(part)) {
    value = Number.parseInt(part.slice(2), 16);
  } else if (/^0[0-7]+$/.test(part)) {
    value = Number.parseInt(part.slice(1), 8);
  } else if (/^(0|[1-9]\d*)$/.test(part)) {
    value = Number.parseInt(part, 10);
  } else {
    return null;
  }
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * 宽松解析 IPv4，兼容 URL 解析器会规范化的简写形式：
 * `2130706433`、`0x7f.1`、`0177.0.0.1`、`127.1`、以及末尾带点的 `127.0.0.1.`。
 *
 * `resolvePublicUrl` 拿到的 `hostname` 已被 WHATWG URL 规范化为点分十进制，
 * 这里再支持一遍是为了让 `isBlockedIp` 被复用时不会漏判。
 */
function parseIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  if (parts.length === 0 || parts.length > 4) return null;

  const numbers: number[] = [];
  for (const part of parts) {
    const parsed = parseIpv4Number(part);
    if (parsed === null) return null;
    numbers.push(parsed);
  }

  for (let i = 0; i < numbers.length - 1; i += 1) {
    if (numbers[i]! > 255) return null;
  }
  const last = numbers[numbers.length - 1]!;
  if (last >= 256 ** (5 - numbers.length)) return null;

  let packed = last;
  for (let i = 0; i < numbers.length - 1; i += 1) {
    packed += numbers[i]! * 256 ** (3 - i);
  }
  return [(packed >>> 24) & 255, (packed >>> 16) & 255, (packed >>> 8) & 255, packed & 255];
}

/** IPv6 单个分段 → 1 个（或内嵌 IPv4 的 2 个）16 位分组。 */
function parseIpv6Part(part: string, allowEmbeddedIpv4: boolean): number[] | null {
  if (allowEmbeddedIpv4 && part.includes(".")) {
    const ipv4 = parseDottedIpv4(part);
    if (ipv4 === null) return null;
    return [(ipv4[0]! << 8) | ipv4[1]!, (ipv4[2]! << 8) | ipv4[3]!];
  }
  if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
  return [Number.parseInt(part, 16)];
}

/** 解析 IPv6（不含方括号与 zone id）为 8 个 16 位分组；非法返回 `null`。 */
function parseIpv6(value: string): number[] | null {
  if (!value.includes(":")) return null;

  const doubleColonIndex = value.indexOf("::");
  if (doubleColonIndex !== -1 && value.indexOf("::", doubleColonIndex + 2) !== -1) return null;

  const head = doubleColonIndex === -1 ? value : value.slice(0, doubleColonIndex);
  const tail = doubleColonIndex === -1 ? "" : value.slice(doubleColonIndex + 2);
  const headParts = head === "" ? [] : head.split(":");
  const tailParts = tail === "" ? [] : tail.split(":");

  const headGroups: number[] = [];
  for (let i = 0; i < headParts.length; i += 1) {
    const allowEmbeddedIpv4 = doubleColonIndex === -1 && i === headParts.length - 1;
    const parsed = parseIpv6Part(headParts[i]!, allowEmbeddedIpv4);
    if (parsed === null) return null;
    headGroups.push(...parsed);
  }

  const tailGroups: number[] = [];
  for (let i = 0; i < tailParts.length; i += 1) {
    const parsed = parseIpv6Part(tailParts[i]!, i === tailParts.length - 1);
    if (parsed === null) return null;
    tailGroups.push(...parsed);
  }

  if (doubleColonIndex === -1) {
    return headGroups.length === 8 ? headGroups : null;
  }

  const zeros = 8 - headGroups.length - tailGroups.length;
  if (zeros < 1) return null;
  return [...headGroups, ...new Array<number>(zeros).fill(0), ...tailGroups];
}

/** 取出 `::ffff:a.b.c.d` / `::ffff:xxxx:yyyy` 内嵌的 IPv4；非映射地址返回 `null`。 */
function mappedIpv4(groups: readonly number[]): number[] | null {
  if (
    groups[0] !== 0 ||
    groups[1] !== 0 ||
    groups[2] !== 0 ||
    groups[3] !== 0 ||
    groups[4] !== 0 ||
    groups[5] !== 0xffff
  ) {
    return null;
  }
  const high = groups[6]!;
  const low = groups[7]!;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

/**
 * 取出 IPv6 中可能内嵌的 IPv4，覆盖以下过渡形式：
 * - IPv4-mapped（`::ffff:a.b.c.d`）；
 * - IPv4-translated 及其他 `::ffff:...` 变体（`::ffff:0:a.b.c.d`）；
 * - NAT64 well-known 前缀 `64:ff9b::/96`；
 * - 6to4（`2002::/16`）。
 *
 * 非上述形式返回 `null`。IPv6 与 IPv4 的策略判定共用这段逻辑，避免
 * `allowPrivate=true` 时通过 `[64:ff9b::a9fe:a9fe]` 之类地址绕过元数据黑名单。
 */
function embeddedIpv4(groups: readonly number[]): number[] | null {
  const mapped = mappedIpv4(groups);
  if (mapped !== null) return mapped;

  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;

  if (g0 === 0 && g1 === 0 && g2 === 0 && (g3 === 0xffff || g4 === 0xffff)) {
    return [g6! >> 8, g6! & 0xff, g7! >> 8, g7! & 0xff];
  }

  // 6to4：IPv4 内嵌在第 2、3 个分组。
  if (g0 === 0x2002) {
    return [g1! >> 8, g1! & 0xff, g2! >> 8, g2! & 0xff];
  }

  // NAT64 well-known 前缀 `64:ff9b::/96`，IPv4 在最后两个分组。
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return [g6! >> 8, g6! & 0xff, g7! >> 8, g7! & 0xff];
  }

  return null;
}

/** IPv4 私有/回环/链路本地/CGNAT/组播/保留段判定。 */
function isBlockedIpv4(octets: readonly number[]): boolean {
  const [a, b, c] = octets;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 链路本地（云元数据）
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 基准测试
  if (a >= 224) return true; // 224.0.0.0/4 组播 + 240.0.0.0/4 保留
  return false;
}

/**
 * IPv6 保留段判定。
 *
 * 除需求列出的 `::/128`、`::1/128`、`fc00::/7`、`fe80::/10`、`ff00::/8` 外，
 * 还处理会“藏” IPv4 的过渡形式，避免 `64:ff9b::7f00:1`、`2002:7f00:1::`
 * 这类地址绕过点分十进制黑名单：
 * - `::/96`：未指定、回环以及已废弃的 IPv4-compatible 地址；
 * - `::ffff:0:0:0/96` 等 IPv4-translated 变体：检查末 32 位内嵌 IPv4；
 * - `64:ff9b::/96` 与 `64:ff9b:1::/48`：NAT64；
 * - `2002::/16`：6to4，检查内嵌 IPv4；
 * - `fec0::/10`：已废弃的站点本地地址。
 */
function isBlockedIpv6(groups: readonly number[]): boolean {
  const [g0, g1, g2, g3, g4, g5] = groups;

  // IPv4-mapped / translated、NAT64 与 6to4：按内嵌 IPv4 判定。
  const embedded = embeddedIpv4(groups);
  if (embedded !== null) return isBlockedIpv4(embedded);

  if ((g0! | g1! | g2! | g3! | g4! | g5!) === 0) return true; // ::/96
  if ((g0! & 0xfe00) === 0xfc00) return true; // fc00::/7 唯一本地地址
  if ((g0! & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
  if ((g0! & 0xffc0) === 0xfec0) return true; // fec0::/10 站点本地（已废弃）
  if ((g0! & 0xff00) === 0xff00) return true; // ff00::/8 组播

  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0x0001) return true; // 64:ff9b:1::/48 本地 NAT64

  return false;
}

/**
 * 归一化 IP：去空白、转小写、去掉方括号与 zone id（`%eth0`），
 * 并把 IPv4-mapped IPv6（`::ffff:10.0.0.1`、`::ffff:a00:1`）转成 IPv4。
 * 非 IP 输入原样返回（仍会规范化为小写），是否可用交给 `isBlockedIp` 判断。
 */
export function normalizeIp(ip: string): string {
  if (typeof ip !== "string") return "";

  let value = ip.trim().toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  const zoneIndex = value.indexOf("%");
  if (zoneIndex !== -1) value = value.slice(0, zoneIndex);
  if (value === "") return "";

  const ipv4 = parseIpv4(value);
  if (ipv4 !== null) return ipv4.join(".");

  const ipv6 = parseIpv6(value);
  if (ipv6 !== null) {
    const mapped = mappedIpv4(ipv6);
    if (mapped !== null) return mapped.join(".");
  }
  return value;
}

/**
 * 判断 IP 是否属于私有/回环/链路本地/CGNAT/组播/保留段。
 * 无法解析为 IP 的输入按 fail closed 返回 `true`。
 */
export function isBlockedIp(ip: string): boolean {
  if (typeof ip !== "string") return true;
  const normalized = normalizeIp(ip);
  if (normalized === "") return true;

  const ipv4 = parseIpv4(normalized);
  if (ipv4 !== null) return isBlockedIpv4(ipv4);

  const ipv6 = parseIpv6(normalized);
  if (ipv6 !== null) return isBlockedIpv6(ipv6);

  return true;
}

/** `allowPrivate=true` 时仍必须拒绝的 IPv4 网段：未指定、链路本地、组播/保留与云元数据。 */
function isAlwaysBlockedIpv4(octets: readonly number[]): boolean {
  const [a, b, c, d] = octets;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 链路本地（云元数据）
  if (a >= 224) return true; // 224.0.0.0/4 组播 + 240.0.0.0/4 保留
  if (a === 100 && b === 100 && c === 100 && d === 200) return true; // 云元数据固定地址
  return false;
}

/** `allowPrivate=true` 时仍必须拒绝的 IPv6 网段：`::/128`、链路本地、组播与站点本地。 */
function isAlwaysBlockedIpv6(groups: readonly number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;

  if ((g0! | g1! | g2! | g3! | g4! | g5! | g6! | g7!) === 0) return true; // ::/128
  if ((g0! & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
  if ((g0! & 0xff00) === 0xff00) return true; // ff00::/8 组播
  if ((g0! & 0xffc0) === 0xfec0) return true; // fec0::/10 站点本地（已废弃）

  // IPv4-mapped / translated、NAT64 与 6to4：内嵌 IPv4 命中始终拒绝段时同样拒绝。
  const embedded = embeddedIpv4(groups);
  if (embedded !== null) return isAlwaysBlockedIpv4(embedded);

  return false;
}

/**
 * 判断 IP 是否属于“即使允许私网也必须拒绝”的地址。
 *
 * 用于 calibre-web 的 `CALIBRE_ALLOW_PRIVATE=true` 模式：允许 RFC1918、回环与
 * CGNAT，但链路本地、未指定、组播、保留段与云元数据地址始终不可访问。
 * 无法解析为 IP 的输入按 fail closed 返回 `true`。
 */
export function isAlwaysBlockedIp(ip: string): boolean {
  if (typeof ip !== "string") return true;
  const normalized = normalizeIp(ip);
  if (normalized === "") return true;

  const ipv4 = parseIpv4(normalized);
  if (ipv4 !== null) return isAlwaysBlockedIpv4(ipv4);

  const ipv6 = parseIpv6(normalized);
  if (ipv6 !== null) return isAlwaysBlockedIpv6(ipv6);

  return true;
}

/**
 * 判断主机名是否指向本地/内网。
 *
 * 必须先于 DNS 执行：即使 `localhost` 被 hosts 或解析器指向公网 IP，
 * 也不应允许，避免依赖解析器行为。
 */
export function isBlockedHostname(host: string): boolean {
  if (typeof host !== "string") return true;

  // 去掉全部尾点：`localhost.`、`localhost..` 都是同一个绝对域名。
  const name = host.trim().toLowerCase().replace(/\.+$/, "");
  if (name === "") return true;

  if (name === "localhost" || name.endsWith(".localhost")) return true;
  if (name === "localhost.localdomain") return true;
  if (name.endsWith(".local")) return true; // mDNS
  if (name === "home.arpa" || name.endsWith(".home.arpa")) return true; // RFC 8375 家庭网络
  if (name.endsWith(".lan")) return true; // 常见内网私有后缀
  if (name.endsWith(".internal")) return true; // 云厂商内网域名
  if (name === "metadata") return true; // 云元数据短名
  if (name === "instance-data") return true; // AWS 元数据别名
  return false;
}

/** 端口策略：80/443/8080/8443，或 >= 1024 且不属于常见内网服务端口。 */
export function isAllowedPort(port: number): boolean {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return false;
  if (ALLOWED_PORTS.has(port)) return true;
  if (port < 1024) return false;
  return !BLOCKED_SERVICE_PORTS.has(port);
}

/** 去掉 IPv6 字面量的方括号。 */
function stripBrackets(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1);
  return host;
}

/** 统一的“内网地址”错误，消息含 `private` 便于调用方与测试识别。 */
function privateAddressError(host: string): Error {
  return new Error(`封面地址指向内网或保留地址（${host}），已拒绝（private address）。`);
}

/** 地址族：归一化后按是否含冒号判断。 */
function familyOf(address: string): 4 | 6 {
  return address.includes(":") ? 6 : 4;
}

/**
 * 校验用户提交的封面 URL，并解析出可固定连接的公网地址。
 *
 * 校验顺序：
 * 1. 仅 `http:` / `https:`，且不允许 URL 内嵌用户名或密码；
 * 2. 端口必须是 80/443/8080/8443 或 >= 1024 的常规端口；
 * 3. 主机名先过黑名单（`localhost`、`*.local`、`*.internal`、`metadata` 等）；
 * 4. IP 字面量直接判定，不触发 DNS；
 * 5. 域名用注入的 `lookup` 解析出全部地址，任一命中内网段即整体拒绝。
 *
 * 返回第一个地址供调用方固定连接（`lookup` 自定义实现可防止 DNS 重绑定）。
 * 本函数不发起 HTTP 请求，也不跟随重定向——重定向复检由调用方完成。
 *
 * @throws 输入非法、端口不允许、主机名被拉黑、地址解析失败或解析到内网地址时抛错。
 */
export async function resolvePublicUrl(
  raw: string,
  deps: ResolvePublicUrlDeps = {},
): Promise<ResolvedPublicUrl> {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("封面地址不能为空。");
  }

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("封面地址格式无效。");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("封面地址仅支持 http 或 https 协议。");
  }

  if (url.username !== "" || url.password !== "") {
    throw new Error("封面地址不能包含用户名或密码。");
  }

  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (!isAllowedPort(port)) {
    throw new Error(`不允许访问端口 ${port}，仅支持 80、443 或 1024 以上的常规端口。`);
  }

  const host = stripBrackets(url.hostname).toLowerCase();
  if (host === "") {
    throw new Error("封面地址缺少主机名。");
  }

  if (isBlockedHostname(host)) {
    throw privateAddressError(host);
  }

  // IP 字面量：直接判定，不做 DNS，避免解析器/注入的 lookup 改变结果。
  const literalIpv4 = parseIpv4(host);
  if (literalIpv4 !== null) {
    const address = literalIpv4.join(".");
    if (isBlockedIp(address)) throw privateAddressError(host);
    return { url, address, family: 4 };
  }

  const literalIpv6 = parseIpv6(host);
  if (literalIpv6 !== null) {
    if (isBlockedIp(host)) throw privateAddressError(host);
    const address = normalizeIp(host);
    return { url, address, family: familyOf(address) };
  }

  const dnsName = host.replace(/\.+$/, "");
  const lookupFn = deps.lookup ?? defaultLookup;

  let results: ReadonlyArray<LookupAddressResult>;
  try {
    results = await lookupFn(dnsName);
  } catch {
    throw new Error(`无法解析封面地址的主机名（${dnsName}）。`);
  }

  if (!Array.isArray(results) || results.length === 0) {
    throw new Error(`无法解析封面地址的主机名（${dnsName}）：未获得任何地址。`);
  }

  let first: ResolvedPublicUrl | null = null;
  for (const entry of results) {
    if (typeof entry !== "object" || entry === null || typeof entry.address !== "string") {
      throw new Error("封面地址的 DNS 解析结果无效。");
    }
    const address = normalizeIp(entry.address);
    if (isBlockedIp(address)) throw privateAddressError(host);
    if (first === null) {
      first = { url, address, family: familyOf(address) };
    }
  }

  // `results.length > 0` 且每个条目都合法，`first` 必然已赋值；这里兜底保持类型完整。
  if (first === null) {
    throw new Error(`无法解析封面地址的主机名（${dnsName}）：未获得任何地址。`);
  }
  return first;
}
