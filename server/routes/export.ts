/**
 * PDF 导出路由（设计文档 §6.4）：
 *
 * - `POST /api/export/pdf`：请求 JSON `{ book, layout?, options? }`，返回 PDF 字节。
 * - 认证由全局守卫（`server/lib/authGuard.ts`）完成，本文件只处理限流、校验、
 *   并发与超时；所有错误统一为 `{error:{code,message}}`，中文文案，
 *   不包含字体路径、堆栈或上游细节。
 *
 * 资源限制（设计文档 §6.4 / §8）：
 * - 请求体 20MB；
 * - 章节 ≤ 2000，单章 ≤ 200 万字符，全书 ≤ 2000 万字符；
 * - 同时只允许 1 个渲染任务，超出立即返回 429；
 * - 单次渲染 60 秒超时，超时返回 504。pdfkit 没有安全的取消接口，已开始的渲染
 *   不会被中断，会继续执行到结束，期间并发位保持占用；
 * - 按客户端 IP 每分钟 6 次。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../lib/config.js";
import { clientIp } from "../lib/clientIp.js";
import { PdfFontError, PdfLimitError, renderPdf } from "../lib/pdf/render.js";
import type { PdfBook, PdfChapter, PdfOptions, PdfVolume } from "../lib/pdf/types.js";
import { createRateLimiter } from "../lib/rateLimit.js";

/** 请求体硬上限：20MB（设计文档 §6.4）。 */
const MAX_BODY_BYTES = 20 * 1024 * 1024;

/** 内容规模上限（设计文档 §6.4）。 */
const MAX_CHAPTERS = 2000;
const MAX_CHAPTER_CHARS = 2_000_000;
const MAX_TOTAL_CHARS = 20_000_000;

/** 单次渲染超时：60 秒（设计文档 §6.4）。 */
const RENDER_TIMEOUT_MS = 60_000;

/** 导出限流：每 IP 每分钟 6 次，与封面限流分开计。 */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_PER_MIN = 6;
const RATE_LIMIT_RETRY_AFTER_SECONDS = 60;

/** 渲染占用中的重试间隔。 */
const BUSY_RETRY_AFTER_SECONDS = 5;

const INVALID_EXPORT_MESSAGE = "导出内容无效或过大。";
/** 路由粗筛与引擎 `PdfLimitError` 共用同一文案，保证错误码与提示一致。 */
const EXPORT_TOO_LARGE_MESSAGE = "导出内容超过大小限制。";
const BUSY_MESSAGE = "正在生成 PDF，请稍后再试。";
const RATE_LIMITED_MESSAGE = "请求过于频繁，请稍后再试。";
const TIMEOUT_MESSAGE = "PDF 生成超时，请稍后再试。";
const FAILED_MESSAGE = "PDF 生成失败，请稍后再试。";

/** 测试可注入的依赖：渲染器与时钟。 */
export interface ExportRouteDeps {
  renderPdf?: typeof renderPdf;
  now?: () => number;
}

interface ErrorBody {
  error: { code: string; message: string };
}

function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isVolume(value: unknown): value is PdfVolume {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    (value.lines === undefined || isStringArray(value.lines))
  );
}

function isChapter(value: unknown): value is PdfChapter {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    isStringArray(value.lines) &&
    (value.volumeId === undefined || value.volumeId === null || typeof value.volumeId === "string")
  );
}

/** 单章字符数：标题 + 正文行（与渲染时实际处理的文本一致）。 */
function chapterChars(chapter: PdfChapter): number {
  let total = chapter.title.length;
  for (const line of chapter.lines) total += line.length;
  return total;
}

type ValidationResult =
  | { ok: true; book: PdfBook; options: PdfOptions }
  | { ok: false; code: "INVALID_EXPORT" | "EXPORT_TOO_LARGE" };

const INVALID: ValidationResult = { ok: false, code: "INVALID_EXPORT" };
const TOO_LARGE: ValidationResult = { ok: false, code: "EXPORT_TOO_LARGE" };

/**
 * 校验请求体并整理渲染参数。
 *
 * 这里的规模检查只是进入渲染前的快速粗筛（章节数、单章字数、章节总字数）；
 * 引擎 `assertPdfLimits` 还会把 meta、卷标题与卷首文字计入总量并做权威校验，
 * 两边都以 `EXPORT_TOO_LARGE` 表达超限。
 *
 * `layout` 只接受顶层字段（设计文档 §6.4 的 `{ book, layout, options }`）；
 * `options.layout` 会被忽略，保证只有一份排版配置。
 */
function validateExportPayload(body: unknown): ValidationResult {
  if (!isRecord(body)) return INVALID;

  const book = body.book;
  if (!isRecord(book)) return INVALID;

  const meta = book.meta;
  if (!isRecord(meta) || typeof meta.title !== "string") return INVALID;
  if (meta.author !== undefined && typeof meta.author !== "string") return INVALID;
  if (meta.language !== undefined && typeof meta.language !== "string") return INVALID;
  if (meta.description !== undefined && typeof meta.description !== "string") return INVALID;

  const volumes = book.volumes;
  if (!Array.isArray(volumes) || !volumes.every(isVolume)) return INVALID;

  const chapters = book.chapters;
  if (!Array.isArray(chapters)) return INVALID;
  if (chapters.length > MAX_CHAPTERS) return TOO_LARGE;

  let totalChars = 0;
  for (const chapter of chapters) {
    if (!isChapter(chapter)) return INVALID;
    const chars = chapterChars(chapter);
    if (chars > MAX_CHAPTER_CHARS) return TOO_LARGE;
    totalChars += chars;
  }
  if (totalChars > MAX_TOTAL_CHARS) return TOO_LARGE;

  const rawOptions = body.options;
  if (rawOptions !== undefined && !isRecord(rawOptions)) return INVALID;
  const options: Record<string, unknown> = { ...(rawOptions ?? {}) };

  // `layout` 只认顶层；旧客户端放在 `options.layout` 的值一律丢弃，避免两份配置歧义。
  delete options.layout;
  if (body.layout !== undefined) {
    if (!isRecord(body.layout)) return INVALID;
    options.layout = body.layout;
  }

  return {
    ok: true,
    book: book as unknown as PdfBook,
    options: options as PdfOptions,
  };
}

/** 超时哨兵；与渲染错误区分开，才能映射到 504。 */
class ExportTimeoutError extends Error {
  constructor() {
    super("PDF 生成超时。");
    this.name = "ExportTimeoutError";
  }
}

function sendFailure(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof PdfLimitError) {
    return reply.status(400).send(errorBody("EXPORT_TOO_LARGE", EXPORT_TOO_LARGE_MESSAGE));
  }
  if (error instanceof PdfFontError) {
    // PdfFontError 的文案固定为「安装字体 / 设置 PDF_FONT_PATH」，不含实际路径。
    return reply.status(500).send(errorBody("PDF_FONT_MISSING", error.message));
  }
  // 未知错误只返回固定文案，绝不透传内部消息或堆栈。
  return reply.status(500).send(errorBody("EXPORT_FAILED", FAILED_MESSAGE));
}

/**
 * 注册 PDF 导出路由。返回的 Promise 立即 resolve，调用方可以统一 `await`。
 */
export function registerExportRoutes(
  app: FastifyInstance,
  _config: AppConfig,
  deps: ExportRouteDeps = {},
): Promise<void> {
  const render = deps.renderPdf ?? renderPdf;
  const limiter = createRateLimiter({
    limit: RATE_LIMIT_PER_MIN,
    windowMs: RATE_LIMIT_WINDOW_MS,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });

  /** 同一时刻只允许一个渲染任务；占用期间新请求立即失败。 */
  let busy = false;

  function sendRateLimited(reply: FastifyReply): FastifyReply {
    return reply
      .header("retry-after", String(RATE_LIMIT_RETRY_AFTER_SECONDS))
      .status(429)
      .send(errorBody("RATE_LIMITED", RATE_LIMITED_MESSAGE));
  }

  function sendBusy(reply: FastifyReply): FastifyReply {
    return reply
      .header("retry-after", String(BUSY_RETRY_AFTER_SECONDS))
      .status(429)
      .send(errorBody("EXPORT_BUSY", BUSY_MESSAGE));
  }

  app.post(
    "/api/export/pdf",
    { bodyLimit: MAX_BODY_BYTES },
    async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header("cache-control", "no-store");

      if (!limiter.hit(`export:${clientIp(request)}`)) return sendRateLimited(reply);

      const validation = validateExportPayload(request.body);
      if (!validation.ok) {
        return reply
          .status(400)
          .send(
            errorBody(
              validation.code,
              validation.code === "EXPORT_TOO_LARGE"
                ? EXPORT_TOO_LARGE_MESSAGE
                : INVALID_EXPORT_MESSAGE,
            ),
          );
      }

      if (busy) return sendBusy(reply);

      busy = true;
      let settled = false;
      const release = (): void => {
        if (settled) return;
        settled = true;
        busy = false;
      };

      // 超时返回 504 后渲染不会中断（pdfkit 无法安全取消），必须等它真正结束
      // 才释放并发位，避免上一任务仍在吃 CPU 时又启动新任务。
      const task = Promise.resolve().then(() => render(validation.book, validation.options));
      void task.then(release, release);

      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ExportTimeoutError()), RENDER_TIMEOUT_MS);
      });

      try {
        const result = await Promise.race([task, timeout]);
        return reply
          .type("application/pdf")
          .header("content-disposition", 'attachment; filename="book.pdf"')
          .header("x-pdf-font", result.fontFamily)
          .send(result.buffer);
      } catch (error) {
        if (error instanceof ExportTimeoutError) {
          return reply.status(504).send(errorBody("EXPORT_TIMEOUT", TIMEOUT_MESSAGE));
        }
        return sendFailure(reply, error);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  );

  return Promise.resolve();
}
