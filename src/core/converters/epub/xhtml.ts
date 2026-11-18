import type { BookMeta, Chapter, Language, Volume } from "../../../types/book";
import { renderChapterBody } from "../../render/renderChapter";
import type { Theme } from "../../render/themes";

/** 目录树节点：卷节点带 `children`，章节点为叶子。 */
export interface NavEntry {
  title: string;
  href: string;
  children?: NavEntry[];
  /**
   * 当分组节点的落点与首个章节是同一个文件时（未生成卷扉页、番外分组），
   * NCX 需要带锚点，避免同一目标出现两个不同 `playOrder`。
   */
  anchor?: string;
}

/** 一个卷要并入章节顶部的标题与卷首文字。 */
export interface VolumeNote {
  title: string;
  lines: string[];
}

export interface ChapterDocumentOptions {
  /**
   * 关闭卷扉页时，把卷标题与卷首文字放在正文顶部的 `.volume-note-block` 里。
   * 同一章可能承载多个零章卷，按卷顺序逐个渲染。
   */
  volumeNotes?: VolumeNote[];
}

export interface XhtmlOptions {
  /** `<body>` 的 class，默认 `txt2book`（主题 CSS 的作用域）。 */
  bodyClass?: string;
  /** 相对当前文件的样式表路径，正文页用 `../styles/theme.css`，包根页面用 `styles/theme.css`。 */
  stylesheetHref?: string;
  /** 追加到 `<html>` 标签上的属性（如 `xmlns:epub`）。 */
  htmlAttributes?: string;
}

/** XML 1.0 不允许的控制字符（NUL、退格、垂直制表等），脏 TXT 里常见。 */
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/** 转义 XHTML 文本节点与属性值的五个特殊字符，并剔除 XML 1.0 非法控制字符。 */
export function escapeXml(value: string): string {
  return value
    .replace(INVALID_XML_CHARS, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function bookTitle(meta: BookMeta): string {
  return meta.title.trim() || "未命名";
}

/** 取中文或英文文案：用户可见字符串随书籍语言切换。 */
export function labelFor(language: Language, zh: string, en: string): string {
  return language === "zh-CN" ? zh : en;
}

/** 生成一个完整的 XHTML 文档；所有标签自闭合、声明命名空间，兼容 XHTML 1.1 解析器。 */
export function xhtmlDocument(
  title: string,
  language: Language,
  body: string,
  options: XhtmlOptions = {},
): string {
  const bodyClass = options.bodyClass ?? "txt2book";
  const stylesheet = options.stylesheetHref ?? "styles/theme.css";
  const htmlAttributes = options.htmlAttributes ? ` ${options.htmlAttributes}` : "";
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<!DOCTYPE html>",
    `<html xmlns="http://www.w3.org/1999/xhtml"${htmlAttributes} xml:lang="${language}" lang="${language}">`,
    "  <head>",
    '    <meta charset="utf-8"/>',
    `    <title>${escapeXml(title)}</title>`,
    `    <link rel="stylesheet" href="${escapeXml(stylesheet)}"/>`,
    "  </head>",
    `  <body class="${bodyClass}">`,
    body,
    "  </body>",
    "</html>",
    "",
  ].join("\n");
}

/**
 * 章节页：隐藏 `<h1>` 供阅读器定位目录锚点，可见标题由 `renderChapterBody` 输出，
 * 这样预览与导出的正文结构完全一致。
 */
export function chapterDocument(
  chapter: Chapter,
  theme: Theme,
  index: number,
  language: Language,
  options: ChapterDocumentOptions = {},
): string {
  const parts = [
    `<section class="chapter" id="chapter-${index}">`,
    `<h1 class="title-anchor" aria-hidden="true">${escapeXml(chapter.title)}</h1>`,
  ];

  for (const note of options.volumeNotes ?? []) {
    const block = [
      '<section class="volume-note-block">',
      // 章节本身已有隐藏的 `<h1>` 作为标题锚点，卷标题降为 `<h2>` 保持层级。
      `<h2 class="volume-title">${escapeXml(note.title)}</h2>`,
    ];
    for (const rawLine of note.lines) {
      const line = rawLine.trim();
      if (!line) continue;
      block.push(`<p class="volume-note">${escapeXml(line)}</p>`);
    }
    block.push("</section>");
    parts.push(block.join("\n"));
  }

  parts.push(renderChapterBody(chapter, theme), "</section>");
  const body = parts.join("\n");
  return xhtmlDocument(chapter.title, language, body, { stylesheetHref: "../styles/theme.css" });
}

/** 封面页：只放整页封面图，样式交给主题 CSS。 */
export function coverDocument(meta: BookMeta): string {
  const title = bookTitle(meta);
  const body = [
    '<section class="cover" id="cover">',
    `<img class="cover-image" src="images/cover.png" alt="${escapeXml(title)} ${labelFor(meta.language, "封面", "cover")}"/>`,
    "</section>",
  ].join("\n");
  return xhtmlDocument(
    `${title} - ${labelFor(meta.language, "封面", "Cover")}`,
    meta.language,
    body,
    { bodyClass: "txt2book cover-page" },
  );
}

/** 书名页：书名与作者。简介单独成页，见 `descriptionDocument`。 */
export function titlePageDocument(meta: BookMeta): string {
  const title = bookTitle(meta);
  const parts: string[] = ['<section class="title-page">', `<h1 class="book-title">${escapeXml(title)}</h1>`];
  const author = meta.author.trim();
  if (author) {
    parts.push(`<p class="book-author">${escapeXml(author)}</p>`);
  }
  parts.push("</section>");
  return xhtmlDocument(title, meta.language, parts.join("\n"));
}

/**
 * 简介页：只在 `meta.description` 非空时生成。
 * 行内除空行外每行一个 `<p>`，空行分隔的段落用 `paragraph-start` 标记，
 * 保留作者原始的分段，不压平成一段。
 */
export function descriptionDocument(meta: BookMeta): string {
  const title = labelFor(meta.language, "简介", "Description");
  const parts: string[] = [
    '<section class="description-page">',
    `<h1 class="description-title">${escapeXml(title)}</h1>`,
  ];

  let inParagraph = false;
  for (const rawLine of (meta.description ?? "").split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (!line) {
      inParagraph = false;
      continue;
    }
    const startsParagraph = !inParagraph && parts.length > 2;
    inParagraph = true;
    const className = startsParagraph ? ' class="paragraph-start"' : "";
    parts.push(`<p${className}>${escapeXml(line)}</p>`);
  }

  parts.push("</section>");
  return xhtmlDocument(
    `${bookTitle(meta)} - ${title}`,
    meta.language,
    parts.join("\n"),
  );
}

/** 卷扉页：卷名居中，卷首文字（`Volume.lines`）作为正文段落。 */
export function volumeDocument(volume: Volume, language: Language): string {
  const parts: string[] = ['<section class="volume-page">', `<h1 class="volume-title">${escapeXml(volume.title)}</h1>`];
  const notes: string[] = [];
  for (const rawLine of volume.lines ?? []) {
    const line = rawLine.trim();
    if (!line) continue;
    notes.push(`<p class="volume-note">${escapeXml(line)}</p>`);
  }
  if (notes.length > 0) {
    parts.push('<section class="volume-note-block">', ...notes, "</section>");
  }
  parts.push("</section>");
  return xhtmlDocument(volume.title, language, parts.join("\n"));
}

function renderNavList(entries: NavEntry[], depth: number): string {
  const pad = "  ".repeat(depth);
  const lines: string[] = [`${pad}<ol>`];
  for (const entry of entries) {
    const href = escapeXml(entry.href);
    const title = escapeXml(entry.title);
    if (entry.children && entry.children.length > 0) {
      lines.push(`${pad}  <li>`);
      lines.push(`${pad}    <a href="${href}">${title}</a>`);
      lines.push(renderNavList(entry.children, depth + 2));
      lines.push(`${pad}  </li>`);
    } else {
      lines.push(`${pad}  <li><a href="${href}">${title}</a></li>`);
    }
  }
  lines.push(`${pad}</ol>`);
  return lines.join("\n");
}

/** EPUB 3 导航文档：卷为一级、其下章节为二级，无卷章节直接在根 `<ol>`。 */
export function navDocument(meta: BookMeta, entries: NavEntry[]): string {
  const body = [
    '<nav epub:type="toc" id="toc" class="toc-page">',
    `  <h1 class="toc-title">${labelFor(meta.language, "目录", "Contents")}</h1>`,
    renderNavList(entries, 1),
    "</nav>",
  ].join("\n");
  return xhtmlDocument(bookTitle(meta), meta.language, body, {
    htmlAttributes: 'xmlns:epub="http://www.idpf.org/2007/ops"',
  });
}

/** 兼容旧阅读器的 NCX 目录；`playOrder` 按文档顺序递增。 */
export function tocNcxDocument(meta: BookMeta, entries: NavEntry[], identifier: string): string {
  let playOrder = 0;
  let maxDepth = 1;

  const renderPoints = (list: NavEntry[], depth: number): string[] => {
    const pad = "  ".repeat(depth + 1);
    maxDepth = Math.max(maxDepth, depth);
    const lines: string[] = [];
    for (const entry of list) {
      playOrder += 1;
      const src = entry.anchor ? `${entry.href}#${entry.anchor}` : entry.href;
      lines.push(`${pad}<navPoint id="navPoint-${playOrder}" playOrder="${playOrder}">`);
      lines.push(`${pad}  <navLabel><text>${escapeXml(entry.title)}</text></navLabel>`);
      lines.push(`${pad}  <content src="${escapeXml(src)}"/>`);
      if (entry.children && entry.children.length > 0) {
        lines.push(...renderPoints(entry.children, depth + 1));
      }
      lines.push(`${pad}</navPoint>`);
    }
    return lines;
  };

  const points = renderPoints(entries, 1);
  const author = meta.author.trim();

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="' +
      escapeXml(meta.language) +
      '">',
    "  <head>",
    `    <meta name="dtb:uid" content="${escapeXml(identifier)}"/>`,
    `    <meta name="dtb:depth" content="${maxDepth}"/>`,
    '    <meta name="dtb:totalPageCount" content="0"/>',
    '    <meta name="dtb:maxPageNumber" content="0"/>',
    "  </head>",
    `  <docTitle><text>${escapeXml(bookTitle(meta))}</text></docTitle>`,
    ...(author ? [`  <docAuthor><text>${escapeXml(author)}</text></docAuthor>`] : []),
    "  <navMap>",
    ...points,
    "  </navMap>",
    "</ncx>",
    "",
  ].join("\n");
}
