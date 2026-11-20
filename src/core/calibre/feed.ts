import type { Language } from "../../types/book";
import type { CalibreBook, CalibreFeed } from "../../types/calibre";

const SUMMARY_LIMIT = 5000;
const BASE_URL = "http://localhost";
const BOOK_ID_PATTERN = /\/opds\/(?:download|cover)\/(\d+)/;

/** 把 calibre-web 的原始语言代码映射为书籍语言。 */
export function mapCalibreLanguage(raw: string | undefined): Language {
  const value = raw?.trim().toLowerCase() ?? "";
  if (value === "zho" || value === "chi" || value.startsWith("zh")) return "zh-CN";
  if (value === "eng" || value.startsWith("en")) return "en";
  return "zh-CN";
}

function isElement(node: Node): node is Element {
  return node.nodeType === 1;
}

function childElements(parent: Element): Element[] {
  return Array.from(parent.childNodes).filter(isElement);
}

function nameOf(element: Element): string {
  return (element.localName ?? element.tagName).toLowerCase();
}

function isNamed(element: Element, name: string): boolean {
  return nameOf(element) === name;
}

function descendants(root: Element): Element[] {
  const result: Element[] = [];
  for (const child of childElements(root)) {
    result.push(child);
    result.push(...descendants(child));
  }
  return result;
}

function descendantNamed(root: Element, name: string): Element[] {
  return descendants(root).filter((element) => isNamed(element, name));
}

function childNamed(root: Element, name: string): Element | null {
  return childElements(root).find((element) => isNamed(element, name)) ?? null;
}

function textOf(element: Element | null): string {
  return element?.textContent?.trim() ?? "";
}

function extractTitle(entry: Element): string {
  return textOf(childNamed(entry, "title"));
}

function extractAuthors(entry: Element): string[] {
  return childElements(entry)
    .filter((element) => isNamed(element, "author"))
    .map((author) => textOf(childNamed(author, "name")))
    .filter((name) => name.length > 0);
}

function extractLanguage(entry: Element): string | undefined {
  for (const element of descendants(entry)) {
    if (element.tagName.toLowerCase().endsWith("language")) {
      const value = textOf(element);
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
}

function extractUpdated(entry: Element): string | undefined {
  const value = textOf(childNamed(entry, "updated"));
  return value.length > 0 ? value : undefined;
}

/** `<br>` 的占位符：稍后与相邻源码换行合并成单个换行。 */
const LINE_BREAK = "\u0000";

/** 递归读取行内文本：文本节点原样保留，`<br>` 记一个换行，其他标签只递归内容。 */
function inlineText(node: Node): string {
  if (node.nodeType === 3) return node.nodeValue ?? "";
  if (!isElement(node)) return "";
  if (nameOf(node) === "br") return LINE_BREAK;

  return Array.from(node.childNodes)
    .map((child) => inlineText(child))
    .join("");
}

function extractSummary(entry: Element): string {
  const content = descendantNamed(entry, "content")[0];
  if (!content) return "";

  const paragraphs = descendantNamed(content, "p");
  const raw =
    paragraphs.length > 0
      ? paragraphs.map((paragraph) => inlineText(paragraph)).join("\n\n")
      : inlineText(content);

  return normalizeSummary(raw);
}

/** 任意标签（含 `script`、`font` 等）：删标签、留文本，不误删 `< b >` 这类比较式。 */
const HTML_TAG_PATTERN = /<[a-zA-Z/!][^>]*>/g;

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
};

/** 解码文本中的字面实体；DOMParser 已处理的真实 XML 实体不会重复出现。 */
function decodeEntities(text: string): string {
  return text.replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (match, name: string) => {
    return NAMED_ENTITIES[name] ?? match;
  });
}

/**
 * 把简介转成纯文本：
 * - 先解码实体，再处理 `&lt;p&gt;` 这类字面标签；
 * - `<br>` 变成单换行（并与紧跟的源码换行合并，避免空行）；
 * - `</p>`/`</div>`/`</h1>`–`</h6>` 变成空行，`</li>`/`</tr>`/`</blockquote>` 变成换行；
 * - 剥离剩余标签（标签内的文字保留），压缩行内空白并限制长度。
 */
function normalizeSummary(raw: string): string {
  let text = raw.replace(/\r\n?/g, "\n");
  text = decodeEntities(text);

  text = text
    .replace(/<br\b[^>]*\/?>/gi, LINE_BREAK)
    .replace(/<\/(?:p|div|h[1-6])\s*>/gi, "\n\n")
    .replace(/<\/(?:li|tr|blockquote)\s*>/gi, "\n")
    // 再剥一次：解码后新出现的字面标签也不能留在简介里。
    .replace(HTML_TAG_PATTERN, "");

  text = text
    .replace(new RegExp(`${LINE_BREAK}[ \\t]*\\n`, "g"), "\n")
    .replace(new RegExp(`\\n[ \\t]*${LINE_BREAK}`, "g"), "\n")
    .replace(new RegExp(`${LINE_BREAK}+`, "g"), "\n")
    .replace(/\u0000/g, "");

  return text
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, SUMMARY_LIMIT);
}

function hrefOf(link: Element): string {
  return link.getAttribute("href")?.trim() ?? "";
}

function relOf(link: Element): string {
  return link.getAttribute("rel")?.trim().toLowerCase() ?? "";
}

function formatFromHref(href: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(href, BASE_URL).pathname;
  } catch {
    pathname = href.split(/[?#]/, 1)[0] ?? href;
  }
  const segment = pathname.split("/").filter((part) => part.length > 0).pop();
  return segment ? segment.toUpperCase() : null;
}

function parseEntry(entry: Element): CalibreBook | null {
  const links = descendantNamed(entry, "link");
  const acquisitionLinks = links.filter((link) => relOf(link).includes("acquisition"));
  if (acquisitionLinks.length === 0) return null;

  let id: number | null = null;
  for (const link of links) {
    const match = BOOK_ID_PATTERN.exec(hrefOf(link));
    if (match) {
      id = Number(match[1]);
      break;
    }
  }
  if (id === null) return null;

  const formats: string[] = [];
  for (const link of acquisitionLinks) {
    const format = formatFromHref(hrefOf(link));
    if (format && !formats.includes(format)) formats.push(format);
  }

  const updated = extractUpdated(entry);

  return {
    id,
    title: extractTitle(entry),
    authors: extractAuthors(entry),
    language: extractLanguage(entry),
    summary: extractSummary(entry),
    formats,
    hasCover: links.some((link) => relOf(link).includes("image")),
    ...(updated === undefined ? {} : { updated }),
  };
}

/** 从 `rel="self"` 链接推断 feed 来源；calibre-web 子路径安装也能识别。 */
function parseSource(feed: Element): CalibreFeed["source"] {
  const self = childElements(feed)
    .filter((element) => isNamed(element, "link"))
    .find((element) => relOf(element) === "self");
  if (!self) return "unknown";

  const href = hrefOf(self);
  if (href === "") return "unknown";

  let pathname: string;
  try {
    pathname = new URL(href, BASE_URL).pathname;
  } catch {
    pathname = href.split(/[?#]/, 1)[0] ?? href;
  }

  if (/(?:^|\/)opds\/new\/?$/.test(pathname)) return "new";
  if (/\/opds\/formats(?:\/|$)/.test(pathname)) return "format";
  if (/\/opds\/search(?:\/|$)/.test(pathname)) return "search";
  if (/\/opds\/books(?:\/|$)/.test(pathname)) return "books";
  return "unknown";
}

function parseNextOffset(feed: Element): number | null {
  for (const link of childElements(feed).filter((element) => isNamed(element, "link"))) {
    if (relOf(link) !== "next") continue;

    const href = hrefOf(link);
    if (!href) return null;

    let offset: string | null;
    try {
      offset = new URL(href, BASE_URL).searchParams.get("offset");
    } catch {
      return null;
    }
    if (offset === null || !/^\d+$/.test(offset)) return null;

    const value = Number(offset);
    return Number.isSafeInteger(value) ? value : null;
  }
  return null;
}

/** 解析 calibre-web 返回的 OPDS (Atom) feed，忽略导航与格式异常的条目。 */
export function parseOpdsFeed(xml: string): CalibreFeed {
  const empty: CalibreFeed = { books: [], nextOffset: null, source: "unknown" };

  let document: Document;
  try {
    document = new DOMParser().parseFromString(xml, "text/xml");
  } catch {
    return empty;
  }

  const root = document.documentElement;
  if (!root || nameOf(root) !== "feed") return empty;
  if (document.getElementsByTagName("parsererror").length > 0) return empty;

  const books: CalibreBook[] = [];
  for (const entry of childElements(root).filter((element) => isNamed(element, "entry"))) {
    const book = parseEntry(entry);
    if (book) books.push(book);
  }

  return { books, nextOffset: parseNextOffset(root), source: parseSource(root) };
}
