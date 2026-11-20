import { computed, ref, type ComputedRef, type Ref } from "vue";
import { ApiError, api } from "../core/api";
import { mapCalibreLanguage, parseOpdsFeed } from "../core/calibre/feed";
import type { BookMeta, BookSource, CoverAsset } from "../types/book";
import type { CalibreBook, CalibreFeed, CalibreSessionInfo } from "../types/calibre";
import type { BookSession } from "./useBookSession";
import type { UseCover } from "./useCover";
import type { UseImport } from "./useImport";

export interface CalibreClient {
  status(): Promise<CalibreSessionInfo>;
  connect(input: { baseUrl: string; username: string; password: string }): Promise<CalibreSessionInfo>;
  reconnect(): Promise<CalibreSessionInfo>;
  disconnect(): Promise<void>;
  forget(): Promise<void>;
  feed(input: { offset?: number; q?: string; format?: string }): Promise<string>;
  textFile(id: number): Promise<Blob>;
  cover(id: number): Promise<Blob>;
  push(id: number, blob: Blob, filename: string, overwrite: boolean): Promise<void>;
}

export interface UseCalibre {
  info: Ref<CalibreSessionInfo | null>;
  books: Ref<CalibreBook[]>;
  query: Ref<string>;
  txtOnly: Ref<boolean>;
  loading: Ref<boolean>;
  error: Ref<string>;
  notice: Ref<string>;
  nextOffset: Ref<number | null>;
  connecting: Ref<boolean>;
  pushing: Ref<boolean>;
  linkedBook: ComputedRef<BookSource | null>;
  canPush: ComputedRef<boolean>;
  loadStatus(): Promise<void>;
  connect(input: { baseUrl: string; username: string; password: string }): Promise<boolean>;
  resume(): Promise<boolean>;
  disconnect(): Promise<void>;
  forget(): Promise<void>;
  refresh(): Promise<void>;
  loadMore(): Promise<void>;
  importBook(book: CalibreBook): Promise<boolean>;
  push(blob: Blob, filename: string): Promise<boolean>;
  clearLocal(): void;
}

/** 一次刷新最多自动翻页数：只用于 `txtOnly` 过滤后页页为空的情况。 */
const MAX_FILTER_PAGES = 3;
const TXT_FORMAT = "TXT";
const FILTERED_NOTICE = "连续 3 页没有含 TXT 的图书，已停止加载。";
const COVER_NOTICE = "封面获取失败，已跳过封面。";
const PUSH_CANCELLED = "已取消推送";
const PUSH_DONE = "已推送到 calibre-web。";
const NOT_CONNECTED_ERROR = "尚未连接 calibre-web，请先配置连接。";
const PUSH_UNAVAILABLE_ERROR = "当前书籍无法推送到 calibre-web。";
const GENERIC_ERROR = "操作失败，请稍后重试。";
const CONFIRM_OVERWRITE = "该书已有 EPUB，推送会覆盖原文件，是否继续？";

/** 服务端错误码对应的固定中文文案，避免把上游细节直接暴露给用户。 */
const FIXED_ERRORS: Record<string, string> = {
  CALIBRE_AUTH_FAILED: "calibre-web 账号或密码错误。",
  CALIBRE_TIMEOUT: "calibre-web 响应超时，请稍后重试。",
  CALIBRE_TOO_LARGE: "calibre-web 响应内容过大。",
  CALIBRE_NOT_CONNECTED: "尚未连接 calibre-web，请先配置连接。",
  CALIBRE_PUSH_FORBIDDEN: "该账号没有上传权限，或 calibre-web 未开启上传功能。",
  CALIBRE_UNREACHABLE: "无法连接 calibre-web 服务。",
};

function isChineseMessage(message: string): boolean {
  return /[\u4e00-\u9fa5]/.test(message);
}

/** 只展示固定文案或服务端给出的中文消息；其余异常统一兜底。 */
function errorText(cause: unknown): string {
  if (cause instanceof ApiError) {
    const fixed = FIXED_ERRORS[cause.code];
    if (fixed) return fixed;
    if (isChineseMessage(cause.message)) return cause.message.trim();
  }
  return GENERIC_ERROR;
}

function isNotConnected(cause: unknown): boolean {
  return cause instanceof ApiError && cause.code === "CALIBRE_NOT_CONNECTED";
}

/** 去掉路径分隔符、Windows 保留字符与控制字符，空标题回退为 `book`。 */
function safeTitle(title: string): string {
  const cleaned = title
    .replace(/[/\\:*?"<>|]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return cleaned || "book";
}

function hasTxt(book: CalibreBook): boolean {
  return book.formats.includes(TXT_FORMAT);
}

/** 解析 `<updated>`；缺失或非法时间返回 null，排序时排最后。 */
function updatedTime(book: CalibreBook): number | null {
  if (!book.updated) return null;
  const time = Date.parse(book.updated);
  return Number.isFinite(time) ? time : null;
}

/** 按更新时间倒序复制一页；同时间或都缺失时保持原始相对顺序。 */
function sortByUpdatedDesc(books: CalibreBook[]): CalibreBook[] {
  return books
    .map((book, index) => ({ book, index, time: updatedTime(book) }))
    .sort((a, b) => {
      if (a.time === null && b.time === null) return a.index - b.index;
      if (a.time === null) return 1;
      if (b.time === null) return -1;
      if (a.time !== b.time) return b.time - a.time;
      return a.index - b.index;
    })
    .map((entry) => entry.book);
}

/** 默认客户端只是 `api.calibre*` 的薄适配器，测试与组件可以注入替身。 */
function defaultClient(): CalibreClient {
  return {
    status: () => api.calibreStatus(),
    connect: (input) => api.calibreConnect(input),
    reconnect: () => api.calibreReconnect(),
    disconnect: () => api.calibreDisconnect(),
    forget: () => api.calibreForget(),
    feed: (input) => api.calibreFeed(input),
    textFile: (id) => api.calibreTextFile(id),
    cover: (id) => api.calibreCover(id),
    push: (id, blob, filename, overwrite) => api.calibrePush(id, blob, filename, overwrite),
  };
}

/**
 * calibre-web 书库的浏览、导入与推送状态。
 *
 * 连接信息由服务端持有，这里只保留界面需要的副本；`autoResumeSuppressed`
 * 在主动断开或忘记凭据后阻止 `loadStatus` 自动重连，直到用户再次显式连接。
 */
export function useCalibre(deps: {
  session: BookSession;
  importer: Pick<UseImport, "importBytes">;
  cover: Pick<UseCover, "prepare">;
  client?: CalibreClient;
  confirm?: (message: string) => boolean;
}): UseCalibre {
  const client = deps.client ?? defaultClient();
  const confirmAction =
    deps.confirm ??
    ((message: string): boolean =>
      typeof window !== "undefined" && typeof window.confirm === "function"
        ? window.confirm(message)
        : false);

  const info = ref<CalibreSessionInfo | null>(null);
  const books = ref<CalibreBook[]>([]);
  const query = ref("");
  const txtOnly = ref(false);
  const loading = ref(false);
  const error = ref("");
  const notice = ref("");
  const nextOffset = ref<number | null>(null);
  const connecting = ref(false);
  const pushing = ref(false);

  /** 主动断开后抑制自动重连；显式连接或成功恢复时解除。 */
  let autoResumeSuppressed = false;
  /** 状态代次：重置连接或发起新刷新时递增，用于丢弃迟到的 feed 响应。 */
  let generation = 0;
  /** 会话代次：登出、断开、忘记或重新连接时递增，用于丢弃迟到的导入与状态写入。 */
  let sessionEpoch = 0;

  /** 让所有在途 feed 请求失效，并松开 loading 闩锁。 */
  function invalidate(): void {
    generation += 1;
    loading.value = false;
  }

  /** 让在途的导入与状态请求失效；调用方用捕获的代次判断是否还能写状态。 */
  function resetSession(): void {
    sessionEpoch += 1;
  }

  const linkedBook = computed<BookSource | null>(() => deps.session.book.value.source ?? null);

  const canPush = computed<boolean>(() => {
    const current = info.value;
    const source = linkedBook.value;
    if (!current?.connected || current.canPush !== true || !current.baseUrl || !source) {
      return false;
    }
    try {
      return new URL(current.baseUrl).origin === source.origin;
    } catch {
      return false;
    }
  });

  function handleError(cause: unknown): void {
    error.value = errorText(cause);
    if (isNotConnected(cause) && info.value) {
      info.value = { ...info.value, connected: false };
    }
  }

  /** 解析一页 feed；格式筛选不可用时退回不带 format 的请求并在前端过滤。 */
  async function fetchPage(offset: number): Promise<CalibreFeed> {
    const input: { offset: number; q?: string; format?: string } = { offset };
    const keyword = query.value.trim();
    if (keyword) input.q = keyword;
    if (!txtOnly.value) return parseOpdsFeed(await client.feed(input));

    try {
      return parseOpdsFeed(await client.feed({ ...input, format: "txt" }));
    } catch (cause) {
      if (!(cause instanceof ApiError) || cause.code !== "CALIBRE_FORMAT_UNAVAILABLE") {
        throw cause;
      }
      const feed = parseOpdsFeed(await client.feed(input));
      return {
        books: feed.books.filter((book) => hasTxt(book)),
        nextOffset: feed.nextOffset,
        source: feed.source,
      };
    }
  }

  /**
   * 追加一页；`txtOnly` 下若整页被过滤且还有下一页，最多自动再取两页。
   * `nextOffset` 始终跟随最后一次上游响应；代次变化后不再写入任何状态。
   * 回退到 `/opds/books`（书名顺序）时，在没有搜索词的情况下按 `updated`
   * 倒序对当前页做近似排序；其他 feed 保持上游顺序。
   */
  async function appendPage(offset: number, gen: number): Promise<void> {
    let current: number | null = offset;
    let requests = 0;

    while (current !== null && requests < MAX_FILTER_PAGES) {
      if (gen !== generation) return;
      requests += 1;
      const feed = await fetchPage(current);
      if (gen !== generation) return;

      const shouldSort = feed.source === "books" && query.value.trim() === "";
      const pageBooks = shouldSort ? sortByUpdatedDesc(feed.books) : feed.books;
      const visible = txtOnly.value ? pageBooks.filter((book) => hasTxt(book)) : pageBooks;

      if (visible.length > 0) books.value = [...books.value, ...visible];
      nextOffset.value = feed.nextOffset;

      if (visible.length > 0 || !txtOnly.value) return;
      if (feed.nextOffset === null) return;
      current = feed.nextOffset;
    }

    if (gen === generation && txtOnly.value && current !== null) {
      notice.value = FILTERED_NOTICE;
    }
  }

  /** 新刷新总是取代旧刷新：旧请求即使后返回也不会再写状态。 */
  async function refresh(): Promise<void> {
    const gen = ++generation;
    loading.value = true;
    error.value = "";
    notice.value = "";
    books.value = [];
    nextOffset.value = null;
    try {
      await appendPage(0, gen);
    } catch (cause) {
      if (gen === generation) handleError(cause);
    } finally {
      if (gen === generation) loading.value = false;
    }
  }

  async function loadMore(): Promise<void> {
    const offset = nextOffset.value;
    if (loading.value || offset === null) return;
    const gen = ++generation;
    loading.value = true;
    error.value = "";
    notice.value = "";
    try {
      await appendPage(offset, gen);
    } catch (cause) {
      if (gen === generation) handleError(cause);
    } finally {
      if (gen === generation) loading.value = false;
    }
  }

  async function loadStatus(): Promise<void> {
    const epoch = sessionEpoch;
    error.value = "";
    notice.value = "";
    let next: CalibreSessionInfo;
    try {
      next = await client.status();
    } catch (cause) {
      if (epoch === sessionEpoch) handleError(cause);
      return;
    }
    // 状态返回前已登出：不要写回已清空的本地状态。
    if (epoch !== sessionEpoch) return;
    info.value = next;

    if (info.value.connected) {
      autoResumeSuppressed = false;
      await refresh();
      return;
    }
    if (info.value.saved && !autoResumeSuppressed) {
      await resume();
      // 恢复期间登出：resume 已自行放弃写入，这里也不再触碰列表。
      if (epoch !== sessionEpoch) return;
      return;
    }

    books.value = [];
    nextOffset.value = null;
  }

  async function connect(input: {
    baseUrl: string;
    username: string;
    password: string;
  }): Promise<boolean> {
    invalidate();
    // 新连接视为新会话：让先前的导入/状态请求全部失效。
    resetSession();
    const epoch = sessionEpoch;
    autoResumeSuppressed = false;
    connecting.value = true;
    error.value = "";
    notice.value = "";
    try {
      const next = await client.connect(input);
      if (epoch !== sessionEpoch) return false;
      info.value = next;
      await refresh();
      return true;
    } catch (cause) {
      if (epoch === sessionEpoch) handleError(cause);
      return false;
    } finally {
      if (epoch === sessionEpoch) connecting.value = false;
    }
  }

  async function resume(): Promise<boolean> {
    const epoch = sessionEpoch;
    error.value = "";
    notice.value = "";
    // 真实恢复状态：成功、失败或登出后都必须清除，避免永久显示“正在恢复”。
    connecting.value = true;
    try {
      const next = await client.reconnect();
      if (epoch !== sessionEpoch) return false;
      info.value = next;
      autoResumeSuppressed = false;
      await refresh();
      return true;
    } catch (cause) {
      // 失败时保留 `info.saved`，让用户仍能看到已保存的连接并手动重试。
      if (epoch === sessionEpoch) handleError(cause);
      return false;
    } finally {
      if (epoch === sessionEpoch) connecting.value = false;
    }
  }

  async function disconnect(): Promise<void> {
    invalidate();
    resetSession();
    connecting.value = false;
    const epoch = sessionEpoch;
    error.value = "";
    notice.value = "";
    try {
      await client.disconnect();
    } catch (cause) {
      if (epoch === sessionEpoch) handleError(cause);
    }
    if (epoch !== sessionEpoch) return;

    try {
      const next = await client.status();
      if (epoch !== sessionEpoch) return;
      info.value = next;
    } catch {
      if (epoch !== sessionEpoch) return;
      info.value = { connected: false, saved: true };
    }

    // 等待期间可能又发起了刷新或导入，清理前再次让它们失效。
    invalidate();
    resetSession();
    books.value = [];
    nextOffset.value = null;
    autoResumeSuppressed = true;
  }

  async function forget(): Promise<void> {
    invalidate();
    resetSession();
    connecting.value = false;
    const epoch = sessionEpoch;
    error.value = "";
    notice.value = "";
    try {
      await client.forget();
    } catch (cause) {
      if (epoch === sessionEpoch) handleError(cause);
      return;
    }
    if (epoch !== sessionEpoch) return;

    invalidate();
    resetSession();
    info.value = { connected: false, saved: false };
    books.value = [];
    nextOffset.value = null;
    autoResumeSuppressed = true;
  }

  async function importBook(book: CalibreBook): Promise<boolean> {
    const current = info.value;
    if (!current?.connected || !current.baseUrl) {
      error.value = NOT_CONNECTED_ERROR;
      return false;
    }

    const epoch = sessionEpoch;
    error.value = "";
    notice.value = "";
    try {
      const blob = await client.textFile(book.id);
      if (epoch !== sessionEpoch) return false;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (epoch !== sessionEpoch) return false;

      let cover: CoverAsset | null = null;
      if (book.hasCover) {
        try {
          const coverBlob = await client.cover(book.id);
          if (epoch !== sessionEpoch) return false;
          cover = await deps.cover.prepare(coverBlob);
          if (epoch !== sessionEpoch) return false;
        } catch {
          if (epoch !== sessionEpoch) return false;
          cover = null;
          notice.value = COVER_NOTICE;
        }
      }

      const title = book.title.trim() || `书籍 ${book.id}`;
      const filename = `${safeTitle(title)}.txt`;
      const meta: BookMeta = {
        title,
        author: book.authors.join("、"),
        language: mapCalibreLanguage(book.language),
        description: book.summary || undefined,
      };
      const source: BookSource = {
        kind: "calibre-web",
        origin: new URL(current.baseUrl).origin,
        bookId: book.id,
        title,
        formats: [...book.formats],
      };

      const imported = await deps.importer.importBytes(bytes, filename, "auto", {
        meta,
        source,
        cover,
      });
      // 登出可能发生在导入期间：此时不得再向 reset 后的会话写提示。
      if (epoch !== sessionEpoch) return false;
      if (imported) notice.value = `已从 Calibre-Web 导入「${title}」`;
      return imported;
    } catch (cause) {
      if (epoch === sessionEpoch) handleError(cause);
      return false;
    }
  }

  async function push(blob: Blob, filename: string): Promise<boolean> {
    const source = linkedBook.value;
    if (!canPush.value || !source) {
      error.value = PUSH_UNAVAILABLE_ERROR;
      return false;
    }

    pushing.value = true;
    error.value = "";
    notice.value = "";
    try {
      try {
        await client.push(source.bookId, blob, filename, false);
      } catch (cause) {
        if (!(cause instanceof ApiError) || cause.code !== "CALIBRE_EPUB_EXISTS") throw cause;
        if (!confirmAction(CONFIRM_OVERWRITE)) {
          notice.value = PUSH_CANCELLED;
          return false;
        }
        await client.push(source.bookId, blob, filename, true);
      }

      deps.session.addSourceFormat("EPUB");
      notice.value = PUSH_DONE;
      return true;
    } catch (cause) {
      handleError(cause);
      return false;
    } finally {
      pushing.value = false;
    }
  }

  /** 退出登录等场景只清理本地 calibre 状态，不碰会话书籍或服务端连接。 */
  function clearLocal(): void {
    invalidate();
    resetSession();
    connecting.value = false;
    info.value = null;
    books.value = [];
    nextOffset.value = null;
    error.value = "";
    notice.value = "";
    autoResumeSuppressed = false;
  }

  return {
    info,
    books,
    query,
    txtOnly,
    loading,
    error,
    notice,
    nextOffset,
    connecting,
    pushing,
    linkedBook,
    canPush,
    loadStatus,
    connect,
    resume,
    disconnect,
    forget,
    refresh,
    loadMore,
    importBook,
    push,
    clearLocal,
  };
}
