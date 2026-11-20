/**
 * calibre-web 路由（设计文档 §6.4）：
 *
 * - `GET    /api/calibre/session`：当前连接状态；
 * - `POST   /api/calibre/session`：用提交的地址/账号/密码建立连接；
 * - `POST   /api/calibre/session/reconnect`：用已保存配置重连；
 * - `DELETE /api/calibre/session`：断开连接但保留已保存配置；
 * - `DELETE /api/calibre/credentials`：断开并删除已保存配置；
 * - `GET    /api/calibre/feed`：原样代理 OPDS XML；
 * - `GET    /api/calibre/books/:id/file?format=txt`：下载 TXT 字节；
 * - `GET    /api/calibre/books/:id/cover`：下载并转换 PNG 封面；
 * - `POST   /api/calibre/books/:id/epub?overwrite=`：multipart 推送 EPUB。
 *
 * 认证由全局守卫（`server/lib/authGuard.ts`）在 `onRequest` 阶段完成；本文件只做
 * 参数校验、按客户端 IP 限流与错误映射。所有响应 `cache-control: no-store`，
 * 且不转发上游 `Set-Cookie`。
 *
 * 上游认证失败（`CALIBRE_AUTH_FAILED`）必须保持 400：返回 401 会让前端误判
 * 本应用会话失效而退出登录（设计文档 §6.4）。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../lib/config.js";
import { clientIp } from "../lib/clientIp.js";
import type { CalibreFeedInput, CalibreService } from "../lib/calibre/service.js";
import { CalibreError } from "../lib/calibre/types.js";
import { createRateLimiter, type RateLimiter } from "../lib/rateLimit.js";

/** 三类 calibre 限流的窗口：60 秒（次数来自 `CALIBRE_*_RATE_LIMIT_PER_MIN`）。 */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RETRY_AFTER_SECONDS = 60;

/** 连接 body 的字段上限（设计文档 §6.4）。 */
const MAX_BASE_URL_LENGTH = 2048;
const MAX_USERNAME_LENGTH = 256;
const MAX_PASSWORD_LENGTH = 1024;

/** 查询参数上限：搜索词 200，格式名 16。 */
const MAX_QUERY_LENGTH = 200;
const MAX_FORMAT_QUERY_LENGTH = 16;

/** 书籍 ID 最多 16 位数字（`Number.MAX_SAFE_INTEGER` 也是 16 位）。 */
const MAX_BOOK_ID_DIGITS = 16;

/** 分页偏移同样限制为 16 位，避免超长数字进入 `Number`。 */
const MAX_OFFSET_DIGITS = 16;

/** 只允许 `txt`：v1 不支持从 calibre-web 直接下载其他格式。 */
const ALLOWED_FILE_FORMATS = new Set(["txt"]);

const INVALID_REQUEST_MESSAGE = "calibre-web 请求参数无效。";
const UPSTREAM_MESSAGE = "无法访问 calibre-web，请稍后重试。";
const READ_RATE_LIMITED_MESSAGE = "请求过于频繁，请稍后再试。";
const PUSH_RATE_LIMITED_MESSAGE = "推送过于频繁，请稍后再试。";
const CONNECT_RATE_LIMITED_MESSAGE = "连接尝试过于频繁，请稍后再试。";
const EPUB_TOO_LARGE_MESSAGE = "EPUB 文件过大，无法推送。";

/** 测试可注入的依赖：限流时钟。 */
export interface CalibreRouteDeps {
  now?: () => number;
}

interface ErrorBody {
  error: { code: string; message: string };
}

function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

/** 所有 calibre 响应都不缓存：连接状态、书单与书籍内容都可能是敏感数据。 */
function noStore(reply: FastifyReply): FastifyReply {
  return reply.header("cache-control", "no-store");
}

function sendInvalidRequest(reply: FastifyReply): FastifyReply {
  return reply.status(400).send(errorBody("CALIBRE_INVALID_REQUEST", INVALID_REQUEST_MESSAGE));
}

function sendRateLimited(reply: FastifyReply, message: string): FastifyReply {
  return reply
    .header("retry-after", String(RETRY_AFTER_SECONDS))
    .status(429)
    .send(errorBody("CALIBRE_RATE_LIMITED", message));
}

/**
 * 统一错误出口：领域错误透传状态码与代码，未知错误固定 502。
 * 未知错误绝不回传内部消息，避免泄露主机名、IP 或上游正文。
 */
function sendFailure(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof CalibreError) {
    // 防御性归一化：即使将来出现 401 的领域错误，也不能让前端误判登录失效。
    const statusCode = error.statusCode === 401 ? 400 : error.statusCode;
    return reply.status(statusCode).send(errorBody(error.code, error.message));
  }
  return reply.status(502).send(errorBody("CALIBRE_UPSTREAM", UPSTREAM_MESSAGE));
}

/** 按种类创建独立限流桶；三个桶互不影响。 */
function createLimiter(limit: number, deps: CalibreRouteDeps): RateLimiter {
  return createRateLimiter({
    limit,
    windowMs: RATE_LIMIT_WINDOW_MS,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
}

function isRateLimited(limiter: RateLimiter, kind: string, request: FastifyRequest): boolean {
  return !limiter.hit(`calibre:${kind}:${clientIp(request)}`);
}

/** 读取可选的字符串查询参数：缺失/空串视为未提供，非字符串或超长返回 `null`。 */
function readOptionalQueryString(
  value: unknown,
  maxLength: number,
): string | undefined | null {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.length > maxLength) return null;
  return value;
}

/** 读取可选的分页偏移：缺失/空串视为未提供，非非负整数返回 `null`。 */
function readOptionalOffset(value: unknown): number | undefined | null {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  if (value.length > MAX_OFFSET_DIGITS) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * 归一化 `/feed` 查询参数。
 *
 * 重复参数在 Fastify 默认解析器下是数组；这里要求全部为字符串，
 * 避免数组被下游当成第一个值而静默改变查询语义。
 */
function parseFeedQuery(raw: unknown): CalibreFeedInput | null {
  if (typeof raw !== "object" || raw === null) return null;
  const query = raw as Record<string, unknown>;

  const q = readOptionalQueryString(query.q, MAX_QUERY_LENGTH);
  const format = readOptionalQueryString(query.format, MAX_FORMAT_QUERY_LENGTH);
  const offset = readOptionalOffset(query.offset);
  if (q === null || format === null || offset === null) return null;

  return {
    ...(q === undefined ? {} : { q }),
    ...(format === undefined ? {} : { format }),
    ...(offset === undefined ? {} : { offset }),
  };
}

/** 书籍 ID：路由 schema 已限制为纯数字字符串；这里再要求落在安全整数区间。 */
function parseBookId(params: unknown): number | null {
  if (typeof params !== "object" || params === null) return null;
  const raw = (params as { id?: unknown }).id;
  if (typeof raw !== "string" || !/^[1-9][0-9]*$/.test(raw)) return null;
  const bookId = Number(raw);
  return Number.isSafeInteger(bookId) ? bookId : null;
}

/** `?format=`：缺省按 `txt` 处理，其他值一律拒绝；大小写不敏感。 */
function readFileFormat(raw: unknown): "txt" | null {
  if (raw === undefined || raw === "") return "txt";
  if (typeof raw !== "string") return null;
  const normalized = raw.toLowerCase();
  return ALLOWED_FILE_FORMATS.has(normalized) ? "txt" : null;
}

/** `?overwrite=`：只接受 `"true"`/`"false"`，缺省为 `false`。 */
function readOverwrite(raw: unknown): boolean | null {
  if (raw === undefined) return false;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

/** `@fastify/multipart` 的文件体积超限错误码。 */
function isFileTooLarge(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "FST_REQ_FILE_TOO_LARGE"
  );
}

type UploadResult =
  | { ok: true; data: Buffer; filename: string }
  | { ok: false; code: "CALIBRE_INVALID_REQUEST" | "CALIBRE_TOO_LARGE" };

const INVALID_UPLOAD: UploadResult = { ok: false, code: "CALIBRE_INVALID_REQUEST" };
const TOO_LARGE_UPLOAD: UploadResult = { ok: false, code: "CALIBRE_TOO_LARGE" };

/**
 * 读取 EPUB multipart 上传。
 *
 * 每个请求单独设置 `fileSize`，与全局插件上限（`max(封面, 推送)`）解耦：
 * 封面仍是 10MB，推送使用 `CALIBRE_MAX_PUSH_BYTES`。字段名必须是 `file`，
 * 文件名必须以 `.epub` 结尾（大小写不敏感）。
 */
async function readEpubUpload(
  request: FastifyRequest,
  maxBytes: number,
): Promise<UploadResult> {
  try {
    const file = await request.file({
      limits: { fileSize: maxBytes, files: 1, parts: 4 },
    });
    if (file === undefined) return INVALID_UPLOAD;

    if (file.fieldname !== "file") {
      // 消费掉数据流，避免连接悬挂。
      await file.toBuffer().catch(() => undefined);
      return INVALID_UPLOAD;
    }

    const filename = file.filename;
    if (typeof filename !== "string" || !filename.toLowerCase().endsWith(".epub")) {
      await file.toBuffer().catch(() => undefined);
      return INVALID_UPLOAD;
    }

    return { ok: true, data: await file.toBuffer(), filename };
  } catch (error) {
    return isFileTooLarge(error) ? TOO_LARGE_UPLOAD : INVALID_UPLOAD;
  }
}

/** 书籍 ID 路由参数 schema；`attachValidation` 后由处理器返回统一中文错误。 */
const BOOK_PARAMS_SCHEMA = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: `^[1-9][0-9]{0,${MAX_BOOK_ID_DIGITS - 1}}$` },
  },
} as const;

/** `POST /session` body schema：字段长度与设计文档 §6.4 一致，拒绝额外字段。 */
const CONNECT_BODY_SCHEMA = {
  type: "object",
  required: ["baseUrl", "username", "password"],
  additionalProperties: false,
  properties: {
    baseUrl: { type: "string", minLength: 1, maxLength: MAX_BASE_URL_LENGTH },
    username: { type: "string", minLength: 1, maxLength: MAX_USERNAME_LENGTH },
    password: { type: "string", minLength: 1, maxLength: MAX_PASSWORD_LENGTH },
  },
} as const;

/**
 * 注册 calibre-web 路由。返回的 Promise 立即 resolve，调用方可以统一 `await`。
 */
export function registerCalibreRoutes(
  app: FastifyInstance,
  config: AppConfig,
  service: CalibreService,
  deps: CalibreRouteDeps = {},
): Promise<void> {
  const readLimiter = createLimiter(config.calibreRateLimitPerMin, deps);
  const pushLimiter = createLimiter(config.calibrePushRateLimitPerMin, deps);
  const connectLimiter = createLimiter(config.calibreConnectRateLimitPerMin, deps);

  app.get("/api/calibre/session", async (_request, reply) => {
    noStore(reply);
    try {
      return reply.send(await service.status());
    } catch (error) {
      return sendFailure(reply, error);
    }
  });

  app.post(
    "/api/calibre/session",
    { attachValidation: true, schema: { body: CONNECT_BODY_SCHEMA } },
    async (request, reply) => {
      noStore(reply);
      if (request.validationError !== undefined && request.validationError !== null) {
        return sendInvalidRequest(reply);
      }
      // 连接尝试失败也计数：避免用错误密码绕过限流做暴力枚举。
      if (isRateLimited(connectLimiter, "connect", request)) {
        return sendRateLimited(reply, CONNECT_RATE_LIMITED_MESSAGE);
      }

      const body = request.body as { baseUrl: string; username: string; password: string };
      try {
        await service.connect({
          baseUrl: body.baseUrl,
          username: body.username,
          password: body.password,
        });
        // connect 只保证连接成功；状态（baseUrl/username/saved）统一由 status 提供。
        return reply.send(await service.status());
      } catch (error) {
        return sendFailure(reply, error);
      }
    },
  );

  app.post("/api/calibre/session/reconnect", async (request, reply) => {
    noStore(reply);
    if (isRateLimited(connectLimiter, "connect", request)) {
      return sendRateLimited(reply, CONNECT_RATE_LIMITED_MESSAGE);
    }
    try {
      await service.resume();
      return reply.send(await service.status());
    } catch (error) {
      return sendFailure(reply, error);
    }
  });

  app.delete("/api/calibre/session", async (_request, reply) => {
    noStore(reply);
    service.disconnect();
    return reply.status(204).send();
  });

  app.delete("/api/calibre/credentials", async (_request, reply) => {
    noStore(reply);
    try {
      await service.forget();
      return reply.status(204).send();
    } catch (error) {
      return sendFailure(reply, error);
    }
  });

  app.get("/api/calibre/feed", async (request, reply) => {
    noStore(reply);
    if (isRateLimited(readLimiter, "read", request)) {
      return sendRateLimited(reply, READ_RATE_LIMITED_MESSAGE);
    }

    const input = parseFeedQuery(request.query);
    if (input === null) return sendInvalidRequest(reply);

    try {
      const xml = await service.feed(input);
      return reply.type("application/atom+xml; charset=utf-8").send(xml);
    } catch (error) {
      return sendFailure(reply, error);
    }
  });

  app.get(
    "/api/calibre/books/:id/file",
    { attachValidation: true, schema: { params: BOOK_PARAMS_SCHEMA } },
    async (request, reply) => {
      noStore(reply);
      if (isRateLimited(readLimiter, "read", request)) {
        return sendRateLimited(reply, READ_RATE_LIMITED_MESSAGE);
      }
      if (request.validationError !== undefined && request.validationError !== null) {
        return sendInvalidRequest(reply);
      }

      const bookId = parseBookId(request.params);
      if (bookId === null) return sendInvalidRequest(reply);

      const query = request.query as { format?: unknown } | undefined;
      if (readFileFormat(query?.format) === null) return sendInvalidRequest(reply);

      try {
        const data = await service.textFile(bookId);
        return reply.type("application/octet-stream").send(data);
      } catch (error) {
        return sendFailure(reply, error);
      }
    },
  );

  app.get(
    "/api/calibre/books/:id/cover",
    { attachValidation: true, schema: { params: BOOK_PARAMS_SCHEMA } },
    async (request, reply) => {
      noStore(reply);
      if (isRateLimited(readLimiter, "read", request)) {
        return sendRateLimited(reply, READ_RATE_LIMITED_MESSAGE);
      }
      if (request.validationError !== undefined && request.validationError !== null) {
        return sendInvalidRequest(reply);
      }

      const bookId = parseBookId(request.params);
      if (bookId === null) return sendInvalidRequest(reply);

      try {
        const png = await service.coverPng(bookId);
        return reply.type("image/png").send(png);
      } catch (error) {
        return sendFailure(reply, error);
      }
    },
  );

  app.post(
    "/api/calibre/books/:id/epub",
    { attachValidation: true, schema: { params: BOOK_PARAMS_SCHEMA } },
    async (request, reply) => {
      noStore(reply);
      if (isRateLimited(pushLimiter, "push", request)) {
        return sendRateLimited(reply, PUSH_RATE_LIMITED_MESSAGE);
      }
      if (request.validationError !== undefined && request.validationError !== null) {
        return sendInvalidRequest(reply);
      }

      const bookId = parseBookId(request.params);
      if (bookId === null) return sendInvalidRequest(reply);

      const query = request.query as { overwrite?: unknown } | undefined;
      const overwrite = readOverwrite(query?.overwrite);
      if (overwrite === null) return sendInvalidRequest(reply);

      if (!request.isMultipart()) return sendInvalidRequest(reply);

      const upload = await readEpubUpload(request, config.calibreMaxPushBytes);
      if (!upload.ok) {
        if (upload.code === "CALIBRE_TOO_LARGE") {
          return reply.status(413).send(errorBody("CALIBRE_TOO_LARGE", EPUB_TOO_LARGE_MESSAGE));
        }
        return sendInvalidRequest(reply);
      }

      try {
        await service.pushEpub(bookId, upload.data, upload.filename, overwrite);
        return reply.status(204).send();
      } catch (error) {
        return sendFailure(reply, error);
      }
    },
  );

  return Promise.resolve();
}
