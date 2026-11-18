/**
 * 封面图片获取与 PNG/JPEG 转换（设计文档 §12.2 / §12.3）。
 *
 * 安全要点：
 * - 只通过 `node:http` / `node:https` 的 `request()` 抓取，并用自定义 `lookup`
 *   固定 `resolvePublicUrl` 校验出的 IP，避免 DNS 重绑定；绝不使用全局 `fetch`。
 * - 每一跳重定向都重新解析并校验，最多跟随 3 次。
 * - 响应体流式累计，超过上限或超时立即销毁连接。
 * - 对外抛出的错误统一为 `CoverError`，消息固定为中文，不包含主机名、IP、DNS 或 SSRF 细节。
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { IncomingMessage } from "node:http";
import type { LookupFunction } from "node:net";
import sharp from "sharp";
import type { AppConfig } from "./config.js";
import { resolvePublicUrl, type ResolvedPublicUrl } from "./ssrf.js";

/** 输出图片最长边（设计文档 §12.2）。 */
const MAX_OUTPUT_EDGE = 1600;

/** sharp 解码像素上限，防止压缩炸弹。 */
const MAX_INPUT_PIXELS = 40_000_000;

/** 允许重定向的最大次数（设计文档 §12.3）。 */
const MAX_REDIRECTS = 3;

/** 抓取时发送的固定请求头。 */
const REQUEST_HEADERS = {
  accept: "image/*",
  "user-agent": "txt2book/1.0",
} as const;

/** 允许交给 sharp 解码的栅格格式；SVG 等可引用外部资源的格式一律拒绝。 */
const ALLOWED_FORMATS = new Set([
  "jpeg",
  "png",
  "webp",
  "gif",
  "avif",
  "heif",
  "tiff",
  "bmp",
]);

/** 对外稳定错误码。 */
export type CoverErrorCode =
  | "INVALID_URL"
  | "UNSUPPORTED_IMAGE"
  | "UPSTREAM_ERROR"
  | "TOO_LARGE"
  | "TIMEOUT";

interface CoverErrorDefinition {
  message: string;
  statusCode: 400 | 415 | 504;
}

const ERROR_DEFINITIONS: Record<CoverErrorCode, CoverErrorDefinition> = {
  INVALID_URL: { message: "封面地址无效或不可访问。", statusCode: 400 },
  UNSUPPORTED_IMAGE: { message: "不支持的图片格式。", statusCode: 415 },
  UPSTREAM_ERROR: { message: "无法获取封面图片。", statusCode: 400 },
  TOO_LARGE: { message: "封面图片过大。", statusCode: 400 },
  TIMEOUT: { message: "封面抓取超时，请稍后重试。", statusCode: 504 },
};

/**
 * 统一的封面错误：`code` 与 HTTP 状态码固定，`message` 是可以直接展示给用户的中文。
 * 内部原因（解析到的 IP、上游状态、框架细节）不会出现在消息里。
 */
export class CoverError extends Error {
  readonly code: CoverErrorCode;
  readonly statusCode: 400 | 415 | 504;

  constructor(code: CoverErrorCode) {
    const definition = ERROR_DEFINITIONS[code];
    super(definition.message);
    this.name = "CoverError";
    this.code = code;
    this.statusCode = definition.statusCode;
  }
}

/** 单次请求的原始结果；重定向只需要状态码与 Location，不读取响应体。 */
interface RawResponse {
  statusCode: number;
  location: string | undefined;
  contentType: string | undefined;
  body: Buffer;
}

export interface FetchImageOptions {
  timeoutMs: number;
  maxBytes: number;
}

/** 测试可替换的 URL 解析器，默认使用 `resolvePublicUrl`。 */
export type CoverResolveFn = (raw: string) => Promise<ResolvedPublicUrl>;

/** `fetchCoverPng` 的可选依赖，仅用于测试注入。 */
export interface FetchCoverDeps {
  resolve?: CoverResolveFn;
}

/** 去掉 IPv6 字面量的方括号，供 socket/TLS 使用。 */
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

/**
 * 发起一次 GET 请求，返回状态、Location 与（非重定向时的）响应体。
 *
 * 流式读取，超过 `maxBytes` 立即 `destroy()`；`timeoutMs` 是整次请求的总时限。
 */
function requestOnce(
  target: URL,
  address: string,
  family: 4 | 6,
  opts: FetchImageOptions,
): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    let settled = false;
    let request: ReturnType<typeof httpRequest> | null = null;
    let timer: NodeJS.Timeout | null = null;

    const cleanup = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const succeed = (value: RawResponse): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const fail = (error: CoverError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      request?.destroy();
      reject(error);
    };

    timer = setTimeout(() => fail(new CoverError("TIMEOUT")), opts.timeoutMs);

    const hostname = bareHostname(target.hostname);
    const requestOptions: RequestOptions = {
      protocol: target.protocol,
      hostname,
      port: portOf(target),
      path: `${target.pathname}${target.search}`,
      method: "GET",
      headers: { ...REQUEST_HEADERS, host: target.host },
      lookup: pinnedLookup(address, family),
      ...(target.protocol === "https:" ? { servername: hostname } : {}),
    };

    const onResponse = (response: IncomingMessage): void => {
      // 先挂错误监听：非 200 分支会主动销毁响应，避免连接重置时出现未处理的 error 事件。
      response.on("error", () => fail(new CoverError("UPSTREAM_ERROR")));

      const statusCode = response.statusCode ?? 0;
      const location = response.headers.location;
      const contentType = response.headers["content-type"];

      // 重定向与非 200 响应不需要响应体：直接销毁连接，避免被无限响应体拖住。
      if (statusCode !== 200) {
        succeed({ statusCode, location, contentType, body: Buffer.alloc(0) });
        response.destroy();
        return;
      }

      const declared = Number(response.headers["content-length"]);
      if (Number.isFinite(declared) && declared > opts.maxBytes) {
        fail(new CoverError("TOO_LARGE"));
        response.destroy();
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;

      response.on("data", (chunk: Buffer) => {
        if (settled) return;
        size += chunk.length;
        if (size > opts.maxBytes) {
          fail(new CoverError("TOO_LARGE"));
          response.destroy();
          return;
        }
        chunks.push(chunk);
      });

      response.on("end", () => {
        succeed({
          statusCode,
          location,
          contentType,
          body: Buffer.concat(chunks, size),
        });
      });
    };

    try {
      request =
        target.protocol === "https:"
          ? httpsRequest(requestOptions, onResponse)
          : httpRequest(requestOptions, onResponse);
    } catch {
      fail(new CoverError("UPSTREAM_ERROR"));
      return;
    }

    request.on("error", () => fail(new CoverError("UPSTREAM_ERROR")));
    request.end();
  });
}

/**
 * 下载一张图片，返回原始字节。调用方负责提供已校验的固定地址。
 *
 * 不跟随重定向（`fetchCoverPng` 负责逐跳复检）；非 200 一律视为上游错误。
 */
export async function fetchImage(
  url: URL,
  address: string,
  family: 4 | 6,
  opts: FetchImageOptions,
): Promise<Buffer> {
  const response = await requestOnce(url, address, family, opts);
  if (response.statusCode !== 200) throw new CoverError("UPSTREAM_ERROR");
  return response.body;
}

export interface ToImageOptions {
  maxBytes: number;
  /** 期望输出格式；默认 png。带透明通道的图片请求 jpeg 时仍输出 png。 */
  format?: "png" | "jpeg";
  /** JPEG 质量，默认 82。 */
  quality?: number;
}

export interface ConvertedImage {
  data: Buffer;
  width: number;
  height: number;
  format: "png" | "jpeg";
  mimeType: "image/png" | "image/jpeg";
}

/**
 * 把任意受支持的图片字节转成 PNG 或 JPEG：
 * 应用 EXIF 旋转、最长边缩到 1600px（不放大）、输出无损 PNG 或 q82 JPEG。
 *
 * 带透明通道的图片即使请求 JPEG 也输出 PNG，避免透明区域被填成黑色。
 * 非图片、空输入或无法解码的格式统一抛 `UNSUPPORTED_IMAGE`（415）。
 */
export async function toImage(input: Buffer, opts: ToImageOptions): Promise<ConvertedImage> {
  if (!Buffer.isBuffer(input) || input.length === 0) {
    throw new CoverError("UNSUPPORTED_IMAGE");
  }
  if (input.length > opts.maxBytes) {
    throw new CoverError("TOO_LARGE");
  }

  try {
    const image = sharp(input, {
      limitInputPixels: MAX_INPUT_PIXELS,
      failOn: "error",
    });
    const metadata = await image.metadata();
    if (metadata.format === undefined || !ALLOWED_FORMATS.has(metadata.format)) {
      throw new CoverError("UNSUPPORTED_IMAGE");
    }

    const requested = opts.format ?? "png";
    const format: "png" | "jpeg" =
      requested === "jpeg" && metadata.hasAlpha === true ? "png" : requested;

    const pipeline = image.rotate().resize({
      width: MAX_OUTPUT_EDGE,
      height: MAX_OUTPUT_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    });
    const { data, info } =
      format === "jpeg"
        ? await pipeline.jpeg({ quality: opts.quality ?? 82 }).toBuffer({ resolveWithObject: true })
        : await pipeline.png().toBuffer({ resolveWithObject: true });

    if (info.width <= 0 || info.height <= 0) {
      throw new CoverError("UNSUPPORTED_IMAGE");
    }
    return {
      data,
      width: info.width,
      height: info.height,
      format,
      mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
    };
  } catch (error) {
    // `CoverError`（输入过大或格式不允许）原样抛出；sharp 的解码错误统一转 415。
    if (error instanceof CoverError) throw error;
    throw new CoverError("UNSUPPORTED_IMAGE");
  }
}

/** 封面固定输出 PNG 的包装，保持既有调用方与测试不变。 */
export async function toPng(
  input: Buffer,
  opts: { maxBytes: number },
): Promise<{ png: Buffer; width: number; height: number }> {
  const result = await toImage(input, { ...opts, format: "png" });
  return { png: result.data, width: result.width, height: result.height };
}

/** 内容类型是否属于图片；`image/svg+xml` 会在 `toPng` 的格式白名单被拒绝。 */
function isImageContentType(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return mime.startsWith("image/");
}

/**
 * 抓取远程封面并转换为 PNG。
 *
 * 每一跳（初始地址与最多 3 次重定向）都重新调用 `resolvePublicUrl`，用返回的 IP 固定连接。
 * 解析失败、非 2xx、非图片、超限或超时都会被转换成不含内部细节的 `CoverError`。
 */
export async function fetchCoverPng(
  rawUrl: string,
  config: AppConfig,
  deps: FetchCoverDeps = {},
): Promise<{ png: Buffer; width: number; height: number }> {
  const resolve = deps.resolve ?? ((raw: string) => resolvePublicUrl(raw));
  let current = rawUrl;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    let resolved: ResolvedPublicUrl;
    try {
      resolved = await resolve(current);
    } catch {
      // 不保留 SSRF 错误消息：其中可能包含主机名或 IP。
      throw new CoverError("INVALID_URL");
    }

    const response = await requestOnce(resolved.url, resolved.address, resolved.family, {
      timeoutMs: config.coverTimeoutMs,
      maxBytes: config.maxCoverBytes,
    });

    const isRedirect =
      response.statusCode >= 300 &&
      response.statusCode < 400 &&
      response.location !== undefined &&
      response.location !== "";

    if (isRedirect) {
      if (redirects === MAX_REDIRECTS) {
        // 初始请求之外已经跟随了 3 次，这是第 4 次重定向。
        throw new CoverError("UPSTREAM_ERROR");
      }
      let next: URL;
      try {
        next = new URL(response.location as string, resolved.url);
      } catch {
        throw new CoverError("UPSTREAM_ERROR");
      }
      // 只允许 http(s)，具体校验交给下一跳的 resolve。
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        throw new CoverError("UPSTREAM_ERROR");
      }
      current = next.toString();
      continue;
    }

    if (response.statusCode !== 200) {
      throw new CoverError("UPSTREAM_ERROR");
    }
    if (!isImageContentType(response.contentType)) {
      throw new CoverError("UNSUPPORTED_IMAGE");
    }

    return await toPng(response.body, { maxBytes: config.maxCoverBytes });
  }

  throw new CoverError("UPSTREAM_ERROR");
}
