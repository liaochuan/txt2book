/**
 * calibre-web 连接、恢复与读取服务（设计文档 §6.2 / §6.4）。
 *
 * 单个 txt2book 进程只维护一个内存连接：
 * - `connect` 用 Basic 读取 `/opds/`，再尝试网页表单登录决定 `canPush`；
 * - `ensureConnection` 在内存为空但存在加密配置时只恢复一次，并用共享 Promise 去重；
 * - 所有上游状态码统一映射为 `CalibreError`，消息固定为中文，不含主机、IP、
 *   上游正文、密码或 Cookie。
 *
 * 限流、文件句柄与路由参数校验不属于本模块（由路由层负责）。
 */
import { randomBytes } from "node:crypto";
import type { LookupFn } from "../ssrf.js";
import type { AppConfig } from "../config.js";
import { CoverError, toImage } from "../image.js";
import { calibreRequest } from "./client.js";
import { deriveConfigKey } from "./crypto.js";
import { buildAllBooksPath, buildCoverPath, buildDownloadPath, buildFeedPath } from "./opds.js";
import {
  buildLoginBody,
  buildMultipartBody,
  extractCsrfToken,
  sanitizeEpubFilename,
} from "./login.js";
import { createCalibreStore, type CalibreStore } from "./store.js";
import { resolveCalibreTarget } from "./target.js";
import {
  CalibreError,
  type CalibreConnection,
  type CalibreSessionInfo,
  type CalibreTarget,
  type SavedCalibrePayload,
} from "./types.js";

/** `/opds/` 与登录页的响应上限。 */
const OPDS_MAX_BYTES = 2 * 1024 * 1024;
/** 书单/搜索 feed 的响应上限（设计文档 §6.4）。 */
const FEED_MAX_BYTES = 8 * 1024 * 1024;
/** 封面下载的原始字节上限（设计文档 §6.4）。 */
const COVER_MAX_BYTES = 10 * 1024 * 1024;
/** TXT 下载的固定超时（设计文档 §6.4）。 */
const FILE_TIMEOUT_MS = 60_000;
/** 网页表单登录失败时的固定原因（设计文档 §6.2）。 */
const PUSH_REASON = "该账号无法通过网页表单登录（可能使用 LDAP / OAuth），只能读取。";
/** 上传响应体上限（设计文档 §6.4）：只需要读取错误页面的少量内容。 */
const UPLOAD_MAX_BYTES = 1024 * 1024;
/** 上传后确认未就绪时的等待时间（设计文档 §6.4）。 */
const VERIFY_RETRY_MS = 300;

/** 登录页是否仍包含密码输入框；用于判断 200 响应是否仍是登录页。 */
const PASSWORD_INPUT_PATTERN =
  /<input\b[^>]*\btype\s*=\s*(?:"password"|'password'|password)\b/i;

/** `connect` 的入参；字段已由路由层校验长度。 */
export interface CalibreConnectInput {
  baseUrl: string;
  username: string;
  password: string;
}

/** `feed` 的入参；`""` 与数组归一化由路由层完成（S7）。 */
export interface CalibreFeedInput {
  q?: string;
  format?: string;
  offset?: number;
}

export interface CalibreService {
  status(): Promise<CalibreSessionInfo>;
  connect(input: CalibreConnectInput): Promise<CalibreSessionInfo>;
  resume(): Promise<CalibreSessionInfo>;
  disconnect(): void;
  forget(): Promise<void>;
  feed(input: CalibreFeedInput): Promise<string>;
  textFile(bookId: number): Promise<Buffer>;
  coverPng(bookId: number): Promise<Buffer>;
  pushEpub(bookId: number, data: Buffer, filename: string, overwrite: boolean): Promise<void>;
  clearLive(): void;
}

export interface CalibreServiceDeps {
  lookup?: LookupFn;
  store?: CalibreStore;
}

function notConnected(): CalibreError {
  return new CalibreError("CALIBRE_NOT_CONNECTED", 409, "尚未连接 calibre-web，请先配置连接。");
}
function busy(): CalibreError {
  return new CalibreError("CALIBRE_BUSY", 429, "正在连接 calibre-web，请稍后重试。");
}
function authFailed(): CalibreError {
  return new CalibreError("CALIBRE_AUTH_FAILED", 400, "calibre-web 账号或密码错误。");
}
function upstream(): CalibreError {
  return new CalibreError("CALIBRE_UPSTREAM", 502, "calibre-web 服务返回了异常响应。");
}
function notFound(): CalibreError {
  return new CalibreError("CALIBRE_NOT_FOUND", 404, "未找到指定的图书。");
}
function formatUnavailable(): CalibreError {
  return new CalibreError("CALIBRE_FORMAT_UNAVAILABLE", 404, "该格式在 calibre-web 中不可用。");
}
function noCover(): CalibreError {
  return new CalibreError("CALIBRE_NO_COVER", 404, "未找到图书封面。");
}
function tooLarge(): CalibreError {
  return new CalibreError("CALIBRE_TOO_LARGE", 413, "calibre-web 响应内容过大。");
}
function timedOut(): CalibreError {
  return new CalibreError("CALIBRE_TIMEOUT", 504, "calibre-web 响应超时，请稍后重试。");
}
function configError(): CalibreError {
  return new CalibreError(
    "CALIBRE_CONFIG",
    500,
    "无法删除已保存的连接配置，请检查服务端权限。",
  );
}
function pushUnavailable(): CalibreError {
  return new CalibreError("CALIBRE_PUSH_UNAVAILABLE", 403, "当前连接不支持推送。");
}
function pushForbidden(): CalibreError {
  return new CalibreError(
    "CALIBRE_PUSH_FORBIDDEN",
    403,
    "该账号没有上传权限，或 calibre-web 未开启上传功能。",
  );
}
function epubExists(): CalibreError {
  return new CalibreError(
    "CALIBRE_EPUB_EXISTS",
    409,
    "该书已有 EPUB；如需覆盖，请确认后重试。",
  );
}
function pushUnverified(): CalibreError {
  return new CalibreError(
    "CALIBRE_PUSH_UNVERIFIED",
    502,
    "EPUB 已提交但未确认，请到 calibre-web 检查。",
  );
}
/** 预检无法判断是否已有 EPUB：必须 fail closed，绝不上传。 */
function pushPreflightUnverified(): CalibreError {
  return new CalibreError(
    "CALIBRE_PUSH_UNVERIFIED",
    502,
    "无法确认该书是否已有 EPUB，已取消上传，请检查网络后重试。",
  );
}
function pushBusy(): CalibreError {
  return new CalibreError("CALIBRE_BUSY", 429, "正在推送 EPUB，请稍后重试。");
}
function pushTooLarge(): CalibreError {
  return new CalibreError("CALIBRE_TOO_LARGE", 413, "EPUB 文件过大，无法推送。");
}
function pushTimedOut(): CalibreError {
  return new CalibreError(
    "CALIBRE_TIMEOUT",
    504,
    "上传 EPUB 超时，推送结果未确认，请到 calibre-web 检查。",
  );
}

/** RFC 7617 Basic 认证头；用户名或密码中的非 ASCII 字符按 UTF-8 编码。 */
function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

/** 从进程内连接重建固定连接目标（Host 头仍来自原始 origin）。 */
function targetOf(connection: CalibreConnection): CalibreTarget {
  return {
    url: new URL(connection.origin),
    baseUrl: connection.baseUrl,
    origin: connection.origin,
    basePath: connection.basePath,
    address: connection.hostIp,
    family: connection.family,
  };
}

/** 读取类请求的固定头：Basic + 已保存 Cookie 由 client 追加。 */
function readHeaders(
  connection: CalibreConnection,
  accept: string,
): Record<string, string> {
  return {
    authorization: basicAuth(connection.username, connection.password),
    accept,
  };
}

export function createCalibreService(
  config: AppConfig,
  deps: CalibreServiceDeps = {},
): CalibreService {
  const storeEnabled = config.calibrePersistCredentials && config.sessionSecret !== "";
  const store =
    deps.store ??
    createCalibreStore({
      path: config.calibreStorePath,
      key: storeEnabled ? deriveConfigKey(config.sessionSecret) : null,
      enabled: storeEnabled,
    });

  /** 当前内存连接；为 null 表示未连接（saved 配置可能仍存在）。 */
  let live: CalibreConnection | null = null;
  /** `connect` 的全局串行标记；在途时新的连接尝试返回 429。 */
  let connecting = false;
  /** 推送的全局串行标记；在途时新的推送返回 429。 */
  let pushing = false;
  /** 恢复中的共享 Promise，避免并发读取各触发一次 resume。 */
  let resumePromise: Promise<CalibreSessionInfo> | null = null;

  /** `loadSaved` 失败的统一处理：视为没有可复用配置，不向上抛。 */
  async function loadSavedSafe(): Promise<SavedCalibrePayload | null> {
    try {
      return await store.loadSaved();
    } catch {
      return null;
    }
  }

  /**
   * 尝试网页表单登录，并返回登录页的 CSRF token 供后续取 token 时兜底。
   * 任何失败（含网络错误）都只返回 `ok: false`，因为登录失败不应让本来可读的
   * 连接失效。
   */
  async function performLogin(
    target: CalibreTarget,
    username: string,
    password: string,
    cookies: Map<string, string>,
  ): Promise<{ ok: boolean; token: string }> {
    try {
      const authorization = basicAuth(username, password);
      const page = await calibreRequest(target, "/login", {
        headers: { authorization, accept: "text/html,application/xhtml+xml" },
        timeoutMs: config.calibreTimeoutMs,
        maxBytes: OPDS_MAX_BYTES,
        cookies,
        collectCookies: cookies,
      });
      if (page.status !== 200) return { ok: false, token: "" };

      const token = extractCsrfToken(page.body.toString("utf8")) ?? "";
      const body = Buffer.from(buildLoginBody(username, password, token), "utf8");
      const result = await calibreRequest(target, "/login", {
        method: "POST",
        headers: {
          authorization,
          "content-type": "application/x-www-form-urlencoded",
          accept: "text/html,application/xhtml+xml",
        },
        body,
        timeoutMs: config.calibreTimeoutMs,
        maxBytes: OPDS_MAX_BYTES,
        cookies,
        collectCookies: cookies,
      });

      // 成功必须收到 session Cookie，且响应不再是登录页。
      if (!cookies.has("session")) return { ok: false, token };
      if (result.status >= 300 && result.status < 400) {
        return { ok: !(result.location ?? "").includes("/login"), token };
      }
      if (result.status === 200) {
        return { ok: !PASSWORD_INPUT_PATTERN.test(result.body.toString("utf8")), token };
      }
      return { ok: false, token };
    } catch {
      return { ok: false, token: "" };
    }
  }

  async function tryLogin(
    target: CalibreTarget,
    username: string,
    password: string,
    cookies: Map<string, string>,
  ): Promise<boolean> {
    return (await performLogin(target, username, password, cookies)).ok;
  }

  async function connect(input: CalibreConnectInput): Promise<CalibreSessionInfo> {
    if (connecting) throw busy();
    connecting = true;
    try {
      const target = await resolveCalibreTarget(input.baseUrl, {
        allowPrivate: config.calibreAllowPrivate,
        lookup: deps.lookup,
      });

      const cookies = new Map<string, string>();
      const opds = await calibreRequest(target, "/opds/", {
        headers: {
          authorization: basicAuth(input.username, input.password),
          accept: "application/atom+xml, application/xml;q=0.9",
        },
        timeoutMs: config.calibreTimeoutMs,
        maxBytes: OPDS_MAX_BYTES,
        cookies,
        collectCookies: cookies,
      });

      if (opds.status === 401 || opds.status === 403) throw authFailed();
      if (opds.status !== 200) throw upstream();
      if (!opds.body.toString("utf8").includes("<feed")) throw upstream();

      const canPush = await tryLogin(target, input.username, input.password, cookies);
      const connection: CalibreConnection = {
        baseUrl: target.baseUrl,
        origin: target.origin,
        basePath: target.basePath,
        hostIp: target.address,
        family: target.family,
        username: input.username,
        password: input.password,
        cookies,
        canPush,
        ...(canPush ? {} : { pushReason: PUSH_REASON }),
        connectedAt: Date.now(),
      };
      live = connection;

      // 保存失败只影响 `saved` 回显，连接继续以内存方式工作。
      let saved = false;
      try {
        saved = await store.saveSaved({
          baseUrl: target.baseUrl,
          username: input.username,
          password: input.password,
        });
      } catch {
        saved = false;
      }

      return {
        connected: true,
        saved,
        canPush,
        ...(canPush ? {} : { pushReason: PUSH_REASON }),
      };
    } finally {
      connecting = false;
    }
  }

  async function resume(): Promise<CalibreSessionInfo> {
    const saved = await loadSavedSafe();
    if (saved === null) throw notConnected();
    return connect(saved);
  }

  async function status(): Promise<CalibreSessionInfo> {
    const saved = await loadSavedSafe();

    if (live !== null) {
      return {
        connected: true,
        saved: saved !== null,
        baseUrl: live.baseUrl,
        username: live.username,
        canPush: live.canPush,
        ...(live.pushReason === undefined ? {} : { pushReason: live.pushReason }),
      };
    }

    if (saved === null) return { connected: false, saved: false };
    return {
      connected: false,
      saved: true,
      baseUrl: saved.baseUrl,
      username: saved.username,
    };
  }

  /** 确保读取前有一个可用连接；必要时只尝试一次恢复。 */
  async function ensureConnection(): Promise<CalibreConnection> {
    if (live !== null) return live;

    const saved = await loadSavedSafe();
    if (saved === null) throw notConnected();

    if (resumePromise === null) {
      resumePromise = resume().finally(() => {
        resumePromise = null;
      });
    }

    try {
      await resumePromise;
    } catch {
      // 恢复失败只暴露稳定的 409，不泄露上游原因。
      throw notConnected();
    }

    if (live === null) throw notConnected();
    return live;
  }

  async function feed(input: CalibreFeedInput): Promise<string> {
    const connection = await ensureConnection();
    const target = targetOf(connection);
    const readFeed = (path: string) =>
      calibreRequest(target, path, {
        headers: readHeaders(connection, "application/atom+xml, application/xml;q=0.9"),
        timeoutMs: config.calibreTimeoutMs,
        maxBytes: FEED_MAX_BYTES,
        cookies: connection.cookies,
        collectCookies: connection.cookies,
      });

    const isQuery = (input.q?.trim() ?? "") !== "";
    // 只有默认书单（无 q、无 format）才走「最近添加」与它的 404 回退。
    const isRecent = !isQuery && input.format === undefined;

    let response = await readFeed(buildFeedPath(input));

    // 账号不可见「最近添加」栏目时 calibre-web 返回 404：回退到全部书单。
    // 其他状态（401/403/500 等）不做回退，避免掩盖真实的认证或上游错误。
    if (response.status === 404 && isRecent) {
      response = await readFeed(buildAllBooksPath(input.offset));
    }

    if (response.status === 401 || response.status === 403) throw authFailed();
    if (response.status === 404) {
      if (!isQuery && input.format !== undefined) throw formatUnavailable();
      throw upstream();
    }
    if (response.status !== 200) throw upstream();
    return response.body.toString("utf8");
  }

  async function textFile(bookId: number): Promise<Buffer> {
    const connection = await ensureConnection();
    const response = await calibreRequest(
      targetOf(connection),
      buildDownloadPath(bookId, "txt"),
      {
        headers: readHeaders(connection, "text/plain, application/octet-stream"),
        timeoutMs: FILE_TIMEOUT_MS,
        maxBytes: config.calibreMaxFileBytes,
        cookies: connection.cookies,
        collectCookies: connection.cookies,
      },
    );

    if (response.status === 401 || response.status === 403) throw authFailed();
    if (response.status === 404) throw notFound();
    if (response.status !== 200) throw upstream();
    return response.body;
  }

  async function coverPng(bookId: number): Promise<Buffer> {
    const connection = await ensureConnection();
    const response = await calibreRequest(targetOf(connection), buildCoverPath(bookId), {
      headers: readHeaders(connection, "image/*"),
      timeoutMs: config.calibreTimeoutMs,
      maxBytes: COVER_MAX_BYTES,
      cookies: connection.cookies,
      collectCookies: connection.cookies,
    });

    if (response.status === 401 || response.status === 403) throw authFailed();
    if (response.status === 404) throw noCover();
    if (response.status !== 200) throw upstream();

    try {
      const image = await toImage(response.body, {
        maxBytes: config.maxCoverBytes,
        format: "png",
      });
      return image.data;
    } catch (error) {
      if (error instanceof CoverError) {
        if (error.code === "TOO_LARGE") throw tooLarge();
        if (error.code === "TIMEOUT") throw timedOut();
      }
      throw upstream();
    }
  }

  /** 读取单值响应头并去掉首尾空白。 */
  function headerText(value: string | string[] | undefined): string | undefined {
    const text = Array.isArray(value) ? value[0] : value;
    return text === undefined ? undefined : text.trim();
  }

  interface EpubHead {
    status: number;
    exists: boolean;
    contentLength?: string;
    lastModified?: string;
  }

  /** EPUB 预检/确认：只读响应头，不下载正文。 */
  async function readEpubHead(
    target: CalibreTarget,
    connection: CalibreConnection,
    path: string,
  ): Promise<EpubHead> {
    const response = await calibreRequest(target, path, {
      headers: readHeaders(connection, "application/epub+zip, application/octet-stream"),
      timeoutMs: config.calibreTimeoutMs,
      maxBytes: OPDS_MAX_BYTES,
      cookies: connection.cookies,
      collectCookies: connection.cookies,
      headersOnly: true,
    });

    return {
      status: response.status,
      exists: response.status === 200 || response.status === 206,
      contentLength: headerText(response.headers["content-length"]),
      lastModified: headerText(response.headers["last-modified"]),
    };
  }

  /** 从 HTML 页面提取 CSRF token；任何失败都返回空字符串。 */
  async function readCsrfToken(
    target: CalibreTarget,
    connection: CalibreConnection,
    path: string,
  ): Promise<string> {
    try {
      const response = await calibreRequest(target, path, {
        headers: readHeaders(connection, "text/html,application/xhtml+xml"),
        timeoutMs: config.calibreTimeoutMs,
        maxBytes: OPDS_MAX_BYTES,
        cookies: connection.cookies,
        collectCookies: connection.cookies,
      });
      if (response.status !== 200) return "";
      return extractCsrfToken(response.body.toString("utf8")) ?? "";
    } catch {
      return "";
    }
  }

  /** 编辑页 → 首页 → 登录页依次取 token；全部失败时使用调用方提供的兜底值。 */
  async function resolveCsrfToken(
    target: CalibreTarget,
    connection: CalibreConnection,
    bookId: number,
    fallback: string,
  ): Promise<string> {
    const admin = await readCsrfToken(target, connection, `/admin/book/${bookId}`);
    if (admin !== "") return admin;

    const root = await readCsrfToken(target, connection, "/");
    if (root !== "") return root;

    const login = await readCsrfToken(target, connection, "/login");
    return login !== "" ? login : fallback;
  }

  /** 上传响应是否表示会话失效/CSRF 校验失败，需要重新登录后重试。 */
  function needsRelogin(response: {
    status: number;
    location?: string;
    body: Buffer;
  }): boolean {
    if (
      response.status >= 300 &&
      response.status < 400 &&
      (response.location ?? "").includes("/login")
    ) {
      return true;
    }
    if (response.status === 400 || response.status === 403) {
      return /csrf/i.test(response.body.toString("utf8"));
    }
    return false;
  }

  function clearLive(): void {
    live = null;
  }

  function disconnect(): void {
    live = null;
  }

  async function forget(): Promise<void> {
    live = null;
    try {
      await store.clearSaved();
    } catch {
      // 不把文件路径或系统错误暴露给客户端。
      throw configError();
    }
  }

  /**
   * 向原书追加 EPUB（设计文档 §6.4 push 步骤 1–10）。
   *
   * 先预检目标格式是否已存在；未显式覆盖时直接返回 409，绝不发起上传。
   * 预检无法判定（超时、不可达、3xx 或其他非 200/206/404）时同样取消上传并
   * 返回 `CALIBRE_PUSH_UNVERIFIED`，避免在状态未知时覆盖已有文件。
   * 上传后再次只读下载路径确认：原本不存在则出现即成功；原本已存在则必须
   * 看到 `content-length` 或 `last-modified` 变化。
   */
  async function pushEpub(
    bookId: number,
    data: Buffer,
    filename: string,
    overwrite: boolean,
  ): Promise<void> {
    const connection = await ensureConnection();
    if (!connection.canPush) throw pushUnavailable();
    if (pushing) throw pushBusy();

    pushing = true;
    try {
      const target = targetOf(connection);
      const epubPath = buildDownloadPath(bookId, "epub");
      let before: EpubHead;
      try {
        before = await readEpubHead(target, connection, epubPath);
      } catch {
        // 超时或不可达时无法判断是否已有 EPUB：取消失败关闭，绝不盲目上传。
        throw pushPreflightUnverified();
      }
      // 只有 200/206（存在）与 404（不存在）是可判定的结果；其余状态一律拒绝。
      if (before.status !== 200 && before.status !== 206 && before.status !== 404) {
        throw pushPreflightUnverified();
      }
      if (before.exists && !overwrite) throw epubExists();

      let loginToken = "";
      if (!connection.cookies.has("session")) {
        const attempt = await performLogin(
          target,
          connection.username,
          connection.password,
          connection.cookies,
        );
        if (!attempt.ok) throw pushUnavailable();
        loginToken = attempt.token;
      }

      let token = await resolveCsrfToken(target, connection, bookId, loginToken);

      const sendUpload = async (
        csrf: string,
      ): Promise<Awaited<ReturnType<typeof calibreRequest>>> => {
        const boundary = `----txt2book${randomBytes(12).toString("hex")}`;
        const body = buildMultipartBody({
          boundary,
          fields: { csrf_token: csrf, book_id: String(bookId) },
          file: {
            field: "btn-upload-format",
            // 调用方可能传入书名或已带后缀的文件名；去掉后缀后统一清洗。
            filename: sanitizeEpubFilename(filename.replace(/\.epub$/i, "")),
            contentType: "application/epub+zip",
            data,
          },
        });

        return calibreRequest(target, "/upload", {
          method: "POST",
          headers: {
            authorization: basicAuth(connection.username, connection.password),
            accept: "text/html,application/xhtml+xml",
            "content-type": `multipart/form-data; boundary=${boundary}`,
            "x-csrftoken": csrf,
          },
          body,
          timeoutMs: config.calibrePushTimeoutMs,
          maxBytes: UPLOAD_MAX_BYTES,
          cookies: connection.cookies,
          collectCookies: connection.cookies,
        });
      };

      let response: Awaited<ReturnType<typeof calibreRequest>>;
      try {
        response = await sendUpload(token);
        if (needsRelogin(response)) {
          const attempt = await performLogin(
            target,
            connection.username,
            connection.password,
            connection.cookies,
          );
          if (!attempt.ok) throw pushForbidden();

          token = await resolveCsrfToken(target, connection, bookId, attempt.token);
          response = await sendUpload(token);
        }
      } catch (error) {
        if (error instanceof CalibreError && error.code === "CALIBRE_TIMEOUT") {
          throw pushTimedOut();
        }
        throw error;
      }

      // 重试后仍然是登录跳转或 CSRF 错误，说明会话/权限不可用。
      if (needsRelogin(response)) throw pushForbidden();
      if (response.status === 401 || response.status === 403) throw pushForbidden();
      if (response.status === 413) throw pushTooLarge();
      if (response.status < 200 || response.status >= 400) throw upstream();

      // 确认时上游不可达/超时同样视为“已提交但未确认”，避免谎报失败。
      try {
        let after = await readEpubHead(target, connection, epubPath);
        if (after.status === 404) {
          await new Promise<void>((resolve) => setTimeout(resolve, VERIFY_RETRY_MS));
          after = await readEpubHead(target, connection, epubPath);
        }

        if (after.exists) {
          if (!before.exists) return;
          if (
            before.contentLength !== after.contentLength ||
            before.lastModified !== after.lastModified
          ) {
            return;
          }
        }
      } catch {
        throw pushUnverified();
      }

      throw pushUnverified();
    } finally {
      pushing = false;
    }
  }

  return {
    status,
    connect,
    resume,
    disconnect,
    forget,
    feed,
    textFile,
    coverPng,
    pushEpub,
    clearLive,
  };
}
