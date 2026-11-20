/**
 * calibre-web OPDS 路径构造（设计文档 §4、§6.1）。
 *
 * 这些函数只做校验与编码，不发起网络请求。返回的路径均相对于
 * calibre-web 站点根（不含 `basePath`，由调用方拼接）。
 */

import { CalibreError } from "./types.js";

/** 格式名只允许 1–8 个 ASCII 字母或数字，避免路径穿越与注入。 */
const FORMAT_PATTERN = /^[a-z0-9]{1,8}$/i;

/** 不带任何筛选时的默认书单：最近添加，按加入时间倒序。 */
const DEFAULT_FEED_PATH = "/opds/new";

/** 「最近添加」不可见时的回退书单：按书名分组，排序取决于 calibre-web 默认设置。 */
const ALL_BOOKS_FEED_PATH = "/opds/books/letter/00";

function invalidRequest(): CalibreError {
  return new CalibreError("CALIBRE_INVALID_REQUEST", 400, "calibre-web 请求参数无效。");
}

function notFound(): CalibreError {
  return new CalibreError("CALIBRE_NOT_FOUND", 404, "未找到指定的图书。");
}

/** 书籍 ID 必须是正安全整数；否则视为书不存在。 */
function requireBookId(bookId: number): number {
  if (!Number.isSafeInteger(bookId) || bookId <= 0) throw notFound();
  return bookId;
}

/** 校验并规范化格式名：先 trim，再匹配白名单，输出小写。 */
function requireFormat(format: string): string {
  const trimmed = format.trim();
  if (!FORMAT_PATTERN.test(trimmed)) throw invalidRequest();
  return trimmed.toLowerCase();
}

/** 分页偏移只允许非负安全整数；未提供等价于 0。 */
function requireOffset(offset: number | undefined): number {
  if (offset === undefined) return 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw invalidRequest();
  return offset;
}

function withOffset(path: string, offset: number): string {
  return offset > 0 ? `${path}?offset=${offset}` : path;
}

export interface FeedPathInput {
  /** 搜索关键词；非空（trim 后）时优先于 `format`。 */
  q?: string;
  /** 格式筛选名，例如 `txt`。 */
  format?: string;
  /** 分页偏移；只有大于 0 时才写入查询串。 */
  offset?: number;
}

/**
 * 构造 OPDS 书单/搜索路径。
 *
 * 优先级：非空 `q` > `format` > 默认书单（`/opds/new`，最近添加）。搜索结果只使用
 * calibre-web 的 `/opds/search/<关键词>` 端点，因此 `offset` 在搜索时被忽略。
 */
export function buildFeedPath(input: FeedPathInput = {}): string {
  const offset = requireOffset(input.offset);

  const query = input.q?.trim() ?? "";
  if (query !== "") {
    // encodeURIComponent 只调用一次：`%20` 保持为 `%20`，不改成 `+`。
    return `/opds/search/${encodeURIComponent(query)}`;
  }

  // 显式传入 format 时即使为空也视为非法，避免静默回退到全部书单。
  if (input.format !== undefined) {
    return withOffset(`/opds/formats/${requireFormat(input.format)}`, offset);
  }

  return withOffset(DEFAULT_FEED_PATH, offset);
}

/**
 * 构造「全部书籍」路径，用于 `/opds/new` 返回 404 时的回退。
 *
 * 与默认书单共享分页偏移校验，保证回退请求沿用同一个 offset。
 */
export function buildAllBooksPath(offset?: number): string {
  return withOffset(ALL_BOOKS_FEED_PATH, requireOffset(offset));
}

/** 构造下载路径；保留末尾斜杠，calibre-web 会在其后拼接文件名。 */
export function buildDownloadPath(bookId: number, format: string): string {
  const id = requireBookId(bookId);
  return `/opds/download/${id}/${requireFormat(format)}/`;
}

/** 构造封面路径。 */
export function buildCoverPath(bookId: number): string {
  return `/opds/cover/${requireBookId(bookId)}`;
}
