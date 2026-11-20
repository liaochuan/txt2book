/**
 * calibre-web 的底层 HTTP 客户端（设计文档 §6.3）。
 *
 * 安全要点：
 * - 只用 `node:http` / `node:https`，并用自定义 `lookup` 固定 S1 校验出的 IP，
 *   避免 DNS 重绑定；`Host` 头仍保持用户填写的域名。
 * - 总超时覆盖连接、响应与全部重定向；超限或超时时主动销毁 socket。
 * - 只跟随 GET/HEAD 的 3xx，且目标 origin 必须与连接目标一致，最多 3 次。
 * - 响应体按字节累计，超过 `maxBytes` 立即断开。
 * - 对外错误统一为 `CalibreError`，消息固定为中文，不包含主机名、IP 或上游细节。
 */
import { request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { LookupFunction } from "node:net";
import { CalibreError, type CalibreTarget } from "./types.js";

/** 发往 calibre-web 的固定 User-Agent。 */
const USER_AGENT = "txt2book-calibre/1.0";

/** 允许跟随的最大重定向次数（设计文档 §6.3）。 */
const MAX_REDIRECTS = 3;

/** 本模块可能产生的错误；状态码与设计文档的错误映射表一致。 */
function invalidRequest(): CalibreError {
  return new CalibreError("CALIBRE_INVALID_REQUEST", 400, "calibre-web 请求参数无效。");
}
function tooLarge(): CalibreError {
  return new CalibreError("CALIBRE_TOO_LARGE", 413, "calibre-web 响应内容过大。");
}
function timedOut(): CalibreError {
  return new CalibreError("CALIBRE_TIMEOUT", 504, "calibre-web 响应超时，请稍后重试。");
}
function unreachable(): CalibreError {
  return new CalibreError("CALIBRE_UNREACHABLE", 502, "无法连接 calibre-web 服务。");
}
function badUpstream(): CalibreError {
  return new CalibreError("CALIBRE_UPSTREAM", 502, "calibre-web 服务返回了异常响应。");
}

export interface CalibreHttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer;
  timeoutMs: number;
  maxBytes: number;
  cookies?: ReadonlyMap<string, string>;
  collectCookies?: Map<string, string>;
  redirects?: number;
  headersOnly?: boolean;
}

export interface CalibreHttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  location?: string;
  url: URL;
}

/** 单跳结果；`url` 由 `calibreRequest` 在重定向结束后补上。 */
type HopResponse = Omit<CalibreHttpResponse, "url">;

/** 去掉 IPv6 字面量的方括号，供 socket/TLS 的 `servername` 使用。 */
function bareHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

/** URL 的显式或默认端口。 */
function portOf(url: URL): number {
  if (url.port !== "") return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

/**
 * 固定连接地址的 `lookup`。Node 20+ 在 `autoSelectFamily` 下会传 `all: true`，
 * 此时必须返回地址数组，否则内部会按数组处理并出错。
 */
function pinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all === true) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
}

/** 读取单值响应头；Node 对大部分头返回字符串，`location` 理论上可能是数组。 */
function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * 组装请求头：默认头可被调用方覆盖，但 `Host` 始终来自连接目标，
 * 且 `lookup` 永远不会作为头发送。
 */
function buildHeaders(
  target: CalibreTarget,
  opts: CalibreHttpOptions,
): Record<string, string> {
  const headers: Record<string, string> = {
    "user-agent": USER_AGENT,
    accept: "*/*",
    connection: "close",
  };

  for (const [name, value] of Object.entries(opts.headers ?? {})) {
    const key = name.toLowerCase();
    if (key === "host" || key === "lookup") continue;
    headers[key] = value;
  }

  headers.host = target.url.host;

  if (
    opts.body !== undefined &&
    headers["content-length"] === undefined &&
    headers["transfer-encoding"] === undefined
  ) {
    headers["content-length"] = String(opts.body.length);
  }

  if (opts.cookies !== undefined && opts.cookies.size > 0) {
    headers.cookie = [...opts.cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  return headers;
}

/**
 * 把响应里的 `Set-Cookie` 写入连接 Cookie：
 * 只取 `;` 之前的 `name=value`；`Max-Age=0` 或空值表示删除。
 */
function storeCookies(headers: IncomingHttpHeaders, jar: Map<string, string>): void {
  const raw = headers["set-cookie"];
  const entries = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];

  for (const entry of entries) {
    const firstSemicolon = entry.indexOf(";");
    const pair = (firstSemicolon === -1 ? entry : entry.slice(0, firstSemicolon)).trim();
    const equals = pair.indexOf("=");
    if (equals <= 0) continue;

    const name = pair.slice(0, equals).trim();
    if (name === "") continue;
    const value = pair.slice(equals + 1).trim();

    const expired = /(?:^|;)\s*max-age\s*=\s*"?0"?\s*(?:;|$)/i.test(entry);
    if (expired || value === "") {
      jar.delete(name);
    } else {
      jar.set(name, value);
    }
  }
}

/**
 * 发起单跳请求（不处理重定向）。`timeoutMs` 由调用方按剩余总时限传入。
 *
 * 流式读取，超过 `maxBytes` 立即 `destroy()`；`headersOnly` 在响应头到达后
 * 立即返回空 body 并断开，不检查 `maxBytes`。
 */
function requestOnce(
  target: CalibreTarget,
  url: URL,
  method: string,
  opts: CalibreHttpOptions,
  timeoutMs: number,
): Promise<HopResponse> {
  return new Promise<HopResponse>((resolve, reject) => {
    let settled = false;
    let request: ReturnType<typeof httpRequest> | null = null;
    let response: IncomingMessage | null = null;
    let timer: NodeJS.Timeout | null = null;

    const cleanup = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const succeed = (value: HopResponse): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const fail = (error: CalibreError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      response?.destroy();
      request?.destroy();
      reject(error);
    };

    timer = setTimeout(() => fail(timedOut()), timeoutMs);

    const hostname = bareHostname(url.hostname);
    const requestOptions: RequestOptions = {
      protocol: url.protocol,
      hostname,
      port: portOf(url),
      path: `${url.pathname}${url.search}`,
      method,
      headers: buildHeaders(target, opts),
      lookup: pinnedLookup(target.address, target.family),
      ...(url.protocol === "https:" ? { servername: hostname } : {}),
    };

    const onResponse = (incoming: IncomingMessage): void => {
      response = incoming;
      // 先挂错误监听：主动销毁响应时连接重置可能触发 error，缺少监听会导致未处理事件。
      incoming.on("error", () => fail(unreachable()));
      incoming.on("aborted", () => fail(unreachable()));

      const status = incoming.statusCode ?? 0;
      const headers = incoming.headers;
      const location = headerValue(headers.location);

      if (opts.collectCookies !== undefined) {
        storeCookies(headers, opts.collectCookies);
      }

      const withoutBody = (): HopResponse => ({
        status,
        headers,
        body: Buffer.alloc(0),
        ...(location !== undefined && location !== "" ? { location } : {}),
      });

      // headersOnly：只关心响应头，立即断开，且不受 maxBytes 限制。
      if (opts.headersOnly === true) {
        succeed(withoutBody());
        incoming.destroy();
        return;
      }

      // 3xx 的响应体对调用方没有价值，避免被上游的大重定向页拖住。
      if (status >= 300 && status < 400) {
        succeed(withoutBody());
        incoming.destroy();
        return;
      }

      const declared = Number(headers["content-length"]);
      if (Number.isFinite(declared) && declared > opts.maxBytes) {
        fail(tooLarge());
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;

      incoming.on("data", (chunk: Buffer) => {
        if (settled) return;
        size += chunk.length;
        if (size > opts.maxBytes) {
          fail(tooLarge());
          return;
        }
        chunks.push(chunk);
      });

      incoming.on("end", () => {
        succeed({
          status,
          headers,
          body: Buffer.concat(chunks, size),
          ...(location !== undefined && location !== "" ? { location } : {}),
        });
      });
    };

    try {
      request =
        url.protocol === "https:"
          ? httpsRequest(requestOptions, onResponse)
          : httpRequest(requestOptions, onResponse);
    } catch {
      // 同步抛错只会来自非法请求头等本地参数问题，不透传原始消息。
      fail(invalidRequest());
      return;
    }

    request.on("error", () => fail(unreachable()));

    if (opts.body !== undefined && opts.body.length > 0) {
      request.end(opts.body);
    } else {
      request.end();
    }
  });
}

/**
 * 向 calibre-web 发起请求。
 *
 * `path` 必须是绝对路径，并与 `target.basePath` 拼接；GET/HEAD 的同 origin 3xx
 * 会被跟随，最多 3 次。任何网络/TLS 失败统一映射为 `CALIBRE_UNREACHABLE`。
 *
 * @throws `CalibreError`：`CALIBRE_INVALID_REQUEST`、`CALIBRE_TOO_LARGE`、
 * `CALIBRE_TIMEOUT`、`CALIBRE_UNREACHABLE`、`CALIBRE_UPSTREAM`
 */
export async function calibreRequest(
  target: CalibreTarget,
  path: string,
  opts: CalibreHttpOptions,
): Promise<CalibreHttpResponse> {
  if (typeof path !== "string" || !path.startsWith("/")) throw invalidRequest();

  const method = (opts.method ?? "GET").toUpperCase();
  // 默认跟随同源重定向（设计文档 §6.3）；headersOnly 与非 GET/HEAD 永不跟随。
  const followRedirects = opts.headersOnly !== true && (method === "GET" || method === "HEAD");
  const redirectBudget = Math.max(
    0,
    Math.min(opts.redirects ?? MAX_REDIRECTS, MAX_REDIRECTS),
  );
  const deadline = Date.now() + opts.timeoutMs;

  let currentUrl: URL;
  try {
    currentUrl = new URL(`${target.basePath}${path}`, target.origin);
  } catch {
    throw invalidRequest();
  }
  // 拒绝 `//other-origin/...` 这类协议相对写法，确保首跳也落在连接目标上。
  if (currentUrl.origin !== target.origin) throw invalidRequest();

  let redirectsLeft = redirectBudget;

  for (;;) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw timedOut();

    const hop = await requestOnce(target, currentUrl, method, opts, remainingMs);
    const isRedirect =
      hop.status >= 300 &&
      hop.status < 400 &&
      hop.location !== undefined &&
      hop.location !== "";

    if (isRedirect && followRedirects) {
      if (redirectsLeft === 0) throw badUpstream();

      let next: URL;
      try {
        next = new URL(hop.location as string, currentUrl);
      } catch {
        throw badUpstream();
      }
      if (next.origin !== target.origin) throw badUpstream();
      if (next.protocol !== "http:" && next.protocol !== "https:") throw badUpstream();

      currentUrl = next;
      redirectsLeft -= 1;
      continue;
    }

    return { ...hop, url: currentUrl };
  }
}
