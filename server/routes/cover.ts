/**
 * 封面路由（设计文档 §12.2）：
 *
 * - `POST /api/cover/from-url`：JSON `{ url }`，抓取并转换为 PNG。
 * - `POST /api/cover/from-file`：multipart，单文件字段 `file`，默认转换为 PNG；
 *   查询参数 `format=jpeg|png` 可切换输出格式（透明图请求 jpeg 时仍返回 PNG）。
 *
 * 两个接口都只返回图片字节（`Cache-Control: no-store`），不转发上游响应头。
 * 错误体固定为 `{error:{code,message}}`，消息为中文且不包含主机名、IP、DNS 或 SSRF 细节。
 * 认证由全局守卫（`server/lib/authGuard.ts`）在 `onRequest` 阶段完成；
 * 本文件只负责按客户端 IP 限流、参数校验与转换。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../lib/config.js";
import { clientIp } from "../lib/clientIp.js";
import { CoverError, fetchCoverPng, toImage } from "../lib/image.js";
import { createRateLimiter } from "../lib/rateLimit.js";

/** multipart 上传硬上限：10MB（设计文档 §12.3）。 */
export const MAX_COVER_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * 封面单请求的 multipart 限制。
 *
 * 全局插件上限取封面与 calibre 推送的较大值（推送默认 50MB），
 * 因此封面路由必须显式声明自己的 10MB，避免借推送上限绕过封面限制。
 */
const COVER_UPLOAD_LIMITS = {
  fileSize: MAX_COVER_UPLOAD_BYTES,
  files: 1,
  parts: 8,
} as const;

/** URL 输入长度上限，避免超长字符串进入解析与日志路径。 */
const MAX_URL_LENGTH = 2048;

/** 封面限流窗口：60 秒（设计文档 §12.3：按 IP 30 次/分钟，次数来自 `RATE_LIMIT_PER_MIN`）。 */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RETRY_AFTER_SECONDS = Math.ceil(RATE_LIMIT_WINDOW_MS / 1000);

const INVALID_URL_MESSAGE = "封面地址无效或不可访问。";
const INVALID_REQUEST_MESSAGE = "请求格式无效。";
const INVALID_FORMAT_MESSAGE = "不支持的输出格式。";
const TOO_LARGE_MESSAGE = "封面图片过大。";
const RATE_LIMITED_MESSAGE = "请求过于频繁，请稍后再试。";

/** 上传背景图时允许的输出格式；默认 PNG。 */
const OUTPUT_FORMATS = new Set(["png", "jpeg"]);

/** 解析 `?format=`；缺省返回 png，非法值返回 null。 */
function parseOutputFormat(query: unknown): "png" | "jpeg" | null {
  if (typeof query !== "object" || query === null) return "png";
  const raw = (query as { format?: unknown }).format;
  if (raw === undefined) return "png";
  if (typeof raw !== "string" || !OUTPUT_FORMATS.has(raw)) return null;
  return raw as "png" | "jpeg";
}

interface ErrorBody {
  error: { code: string; message: string };
}

function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

function noStore(reply: FastifyReply): FastifyReply {
  return reply.header("cache-control", "no-store");
}

/** 未知错误也映射成固定的上游错误，绝不回传内部消息。 */
function sendCoverFailure(reply: FastifyReply, error: unknown): FastifyReply {
  const coverError = error instanceof CoverError ? error : new CoverError("UPSTREAM_ERROR");
  return reply
    .status(coverError.statusCode)
    .send(errorBody(coverError.code, coverError.message));
}

/** `@fastify/multipart` 的超限错误码；其余解析错误都按格式错误处理。 */
function isFileTooLarge(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "FST_REQ_FILE_TOO_LARGE"
  );
}

/** 读取单个 `file` 字段；字段名不符或存在多个文件时拒绝。 */
async function readUploadedFile(request: FastifyRequest): Promise<Buffer | null> {
  const file = await request.file({ limits: COVER_UPLOAD_LIMITS });
  if (file === undefined) return null;

  if (file.fieldname !== "file") {
    // 消费掉数据流，避免连接悬挂。
    await file.toBuffer().catch(() => undefined);
    return null;
  }

  return file.toBuffer();
}

/**
 * 注册封面路由。返回的 Promise 立即 resolve，调用方可以统一 `await`。
 */
export function registerCoverRoutes(app: FastifyInstance, config: AppConfig): Promise<void> {
  // 两个封面接口共用一个桶：同一 IP 每分钟的抓取 + 上传总次数受限。
  const limiter = createRateLimiter({
    limit: config.rateLimitPerMin,
    windowMs: RATE_LIMIT_WINDOW_MS,
  });

  /** 记录一次命中；超限时返回 true，由调用方回复 429。 */
  function isRateLimited(request: FastifyRequest): boolean {
    return !limiter.hit(`cover:${clientIp(request)}`);
  }

  /** 429 固定响应：中文提示 + `Retry-After`，并且不缓存。 */
  function sendRateLimited(reply: FastifyReply): FastifyReply {
    return reply
      .header("retry-after", String(RETRY_AFTER_SECONDS))
      .status(429)
      .send(errorBody("RATE_LIMITED", RATE_LIMITED_MESSAGE));
  }

  app.post(
    "/api/cover/from-url",
    {
      // schema 校验失败时由处理器返回统一中文错误，避免框架默认英文消息。
      attachValidation: true,
      schema: {
        body: {
          type: "object",
          required: ["url"],
          additionalProperties: false,
          properties: {
            url: { type: "string", minLength: 1, maxLength: MAX_URL_LENGTH },
          },
        },
      },
    },
    async (request, reply) => {
      noStore(reply);

      if (isRateLimited(request)) return sendRateLimited(reply);
      if (request.validationError !== undefined && request.validationError !== null) {
        return reply.status(400).send(errorBody("INVALID_URL", INVALID_URL_MESSAGE));
      }

      const body = request.body as { url?: unknown } | null;
      const rawUrl = body?.url;
      if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
        return reply.status(400).send(errorBody("INVALID_URL", INVALID_URL_MESSAGE));
      }

      try {
        const result = await fetchCoverPng(rawUrl.trim(), config);
        return reply.type("image/png").send(result.png);
      } catch (error) {
        return sendCoverFailure(reply, error);
      }
    },
  );

  app.post("/api/cover/from-file", async (request, reply) => {
    noStore(reply);

    if (isRateLimited(request)) return sendRateLimited(reply);
    const format = parseOutputFormat(request.query);
    if (format === null) {
      return reply.status(400).send(errorBody("INVALID_FORMAT", INVALID_FORMAT_MESSAGE));
    }
    if (!request.isMultipart()) {
      return reply.status(400).send(errorBody("INVALID_REQUEST", INVALID_REQUEST_MESSAGE));
    }

    let uploaded: Buffer | null;
    try {
      uploaded = await readUploadedFile(request);
    } catch (error) {
      if (isFileTooLarge(error)) {
        return reply.status(400).send(errorBody("TOO_LARGE", TOO_LARGE_MESSAGE));
      }
      return reply.status(400).send(errorBody("INVALID_REQUEST", INVALID_REQUEST_MESSAGE));
    }

    if (uploaded === null) {
      return reply.status(400).send(errorBody("INVALID_REQUEST", INVALID_REQUEST_MESSAGE));
    }

    try {
      const result = await toImage(uploaded, { maxBytes: config.maxCoverBytes, format });
      return reply.type(result.mimeType).send(result.data);
    } catch (error) {
      return sendCoverFailure(reply, error);
    }
  });

  return Promise.resolve();
}
