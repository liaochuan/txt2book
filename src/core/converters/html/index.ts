import type { BookMeta, BookModel, Chapter, Language, Volume } from "../../../types/book";
import { bytesToDataUrl } from "../../imageDataUrl";
import { defaultLayoutFor, layoutCss, normalizeLayout } from "../../render/layout";
import { renderChapterBody, renderVolumeBody } from "../../render/renderChapter";
import { themes, type Theme } from "../../render/themes";
import { resolveConvertOptions, type BookConverter, type ConvertOptions } from "../types";

/** 已分配锚点的章节；编号与目录中的 `chapter-N` 一致。 */
interface PlannedChapter {
  chapter: Chapter;
  number: number;
}

/** 阅读顺序中的一块：卷分组（可能有扉页）或章节。 */
type Block =
  | { kind: "volume"; volume: Volume; ordinal: number; hasPage: boolean }
  | { kind: "chapter"; entry: PlannedChapter };

/** 目录树节点：卷/番外分组带 `children`，章节点为叶子。 */
interface TocItem {
  title: string;
  href: string;
  children?: TocItem[];
}

/** 关闭卷扉页时，并入章节顶部的卷标题与卷首文字。 */
interface VolumeNote {
  title: string;
  lines: string[];
}

/** XML 1.0 / HTML 不允许的控制字符（NUL、退格、垂直制表等），脏 TXT 里常见。 */
const INVALID_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/** 转义文本节点与属性值，避免书名、章节名里的标签进入文档结构。 */
function escapeHtml(value: string): string {
  return value
    .replace(INVALID_CONTROL_CHARS, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function bookTitle(meta: BookMeta): string {
  return meta.title.trim() || "未命名";
}

/** 取中文或英文文案：用户可见字符串随书籍语言切换。 */
function labelFor(language: Language, zh: string, en: string): string {
  return language === "zh-CN" ? zh : en;
}

function chapterAnchor(number: number): string {
  return `#chapter-${number}`;
}

/** 按阅读顺序规划卷分组：卷首次出现时生成分组块，扉页只给真正的卷。 */
function planBlocks(
  book: BookModel,
  includeVolumePages: boolean,
  forcedVolumePages: Set<string>,
): Block[] {
  const volumeById = new Map(book.volumes.map((volume) => [volume.id, volume]));
  const volumeOrdinal = new Map(book.volumes.map((volume, index) => [volume.id, index + 1]));
  const planned: PlannedChapter[] = book.chapters.map((chapter, index) => ({
    chapter,
    number: index + 1,
  }));

  const blocks: Block[] = [];
  const emitted = new Set<string>();
  let currentVolumeId: string | null = null;

  for (const entry of planned) {
    const volumeId = entry.chapter.volumeId;
    const volume = volumeId ? volumeById.get(volumeId) : undefined;
    if (!volume) {
      // 无卷或卷已被删除的章节直接挂在根目录下，并打断当前卷分组。
      currentVolumeId = null;
    } else if (volume.id !== currentVolumeId) {
      currentVolumeId = volume.id;
      const firstAppearance = !emitted.has(volume.id);
      emitted.add(volume.id);
      blocks.push({
        kind: "volume",
        volume,
        ordinal: volumeOrdinal.get(volume.id) ?? entry.number,
        hasPage:
          firstAppearance &&
          (forcedVolumePages.has(volume.id) || (includeVolumePages && volume.kind === "volume")),
      });
    }
    blocks.push({ kind: "chapter", entry });
  }

  // 零章卷没有自己的章节承载扉页，插在它后面那个卷之前（没有则放在末尾）。
  // 即使不输出扉页也保留分组块，目录需要为它生成节点。
  book.volumes.forEach((volume, index) => {
    if (emitted.has(volume.id)) return;
    const laterVolumeIds = new Set(book.volumes.slice(index + 1).map((item) => item.id));
    const insertAt = blocks.findIndex((block) => {
      const volumeId = block.kind === "volume" ? block.volume.id : block.entry.chapter.volumeId;
      return volumeId !== null && volumeId !== undefined && laterVolumeIds.has(volumeId);
    });
    blocks.splice(insertAt === -1 ? blocks.length : insertAt, 0, {
      kind: "volume",
      volume,
      ordinal: index + 1,
      hasPage:
        volume.kind === "volume" && (includeVolumePages || forcedVolumePages.has(volume.id)),
    });
  });

  return blocks;
}

/**
 * 关闭卷扉页时按 EPUB 规则为每个有卷首文字的卷寻找承载章节：
 * 该卷首个章节 → 后续第一个章节 → 全书最后一个章节。
 * 同一章可承载多个卷的 note，按卷在 `book.volumes` 中的顺序追加。
 */
function buildVolumeNotes(book: BookModel): Map<string, VolumeNote[]> {
  const notesByChapter = new Map<string, VolumeNote[]>();
  if (book.chapters.length === 0) return notesByChapter;

  const volumeOrder = new Map(book.volumes.map((volume, index) => [volume.id, index]));
  const chapterVolumeOrder = book.chapters.map((chapter) =>
    chapter.volumeId === null ? null : (volumeOrder.get(chapter.volumeId) ?? null),
  );
  const lastChapter = book.chapters[book.chapters.length - 1];

  book.volumes.forEach((volume, index) => {
    if (volume.kind !== "volume" || !volume.lines || volume.lines.length === 0) return;

    const carrier =
      book.chapters.find((_, chapterIndex) => {
        const order = chapterVolumeOrder[chapterIndex];
        return order !== null && order >= index;
      }) ?? lastChapter;
    if (!carrier) return;

    const notes = notesByChapter.get(carrier.id) ?? [];
    notes.push({ title: volume.title, lines: volume.lines });
    notesByChapter.set(carrier.id, notes);
  });

  return notesByChapter;
}

/** 全书没有章节时，即使关闭卷扉页也必须输出扉页，否则卷首文字无处承载。 */
function findForcedVolumePages(book: BookModel, includeVolumePages: boolean): Set<string> {
  const forced = new Set<string>();
  if (includeVolumePages || book.chapters.length > 0) return forced;
  for (const volume of book.volumes) {
    if (volume.kind === "volume") forced.add(volume.id);
  }
  return forced;
}

/** 目录：卷与番外分组为一层，其下章节为二层；根级章节直接放在外层 `<ol>`。 */
function buildTocItems(blocks: Block[], knownVolumeIds: Set<string>): TocItem[] {
  const items: TocItem[] = [];
  let currentGroup: TocItem | null = null;

  const lastChapterNumber = (): number | null => {
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const block = blocks[index];
      if (block.kind === "chapter") return block.entry.number;
    }
    return null;
  };

  blocks.forEach((block, index) => {
    if (block.kind === "volume") {
      let href: string | null = null;
      if (block.hasPage) {
        href = `#volume-${block.ordinal}`;
      } else {
        // 没有扉页时指向本卷首个章节；零章卷退到后续第一个章节或全书最后一章。
        const next = blocks.slice(index + 1).find((item) => item.kind === "chapter");
        if (next && next.kind === "chapter") {
          href = chapterAnchor(next.entry.number);
        } else {
          const last = lastChapterNumber();
          if (last !== null) href = chapterAnchor(last);
        }
      }

      if (!href) {
        // 既没有扉页也没有任何章节落点，跳过该卷。
        currentGroup = null;
        return;
      }

      currentGroup = {
        title: block.volume.title,
        href,
        children: [],
      };
      items.push(currentGroup);
      return;
    }

    const entry = block.entry;
    const volumeId = entry.chapter.volumeId;
    if (volumeId === null || !knownVolumeIds.has(volumeId)) {
      // 根级章节必须断开卷分组，否则会错误地嵌套进上一卷的 <ol>。
      currentGroup = null;
    }
    const item: TocItem = {
      title: entry.chapter.title,
      href: chapterAnchor(entry.number),
    };
    if (currentGroup) {
      currentGroup.children!.push(item);
    } else {
      items.push(item);
    }
  });

  return items;
}

function renderTocList(items: TocItem[]): string {
  const lines: string[] = ["<ol>"];
  for (const item of items) {
    const href = escapeHtml(item.href);
    const title = escapeHtml(item.title);
    if (item.children && item.children.length > 0) {
      lines.push(`<li><a href="${href}">${title}</a>`);
      lines.push(renderTocList(item.children));
      lines.push("</li>");
    } else {
      lines.push(`<li><a href="${href}">${title}</a></li>`);
    }
  }
  lines.push("</ol>");
  return lines.join("\n");
}

function coverPage(book: BookModel): string | null {
  if (!book.cover) return null;
  const title = bookTitle(book.meta);
  const alt = `${title} ${labelFor(book.meta.language, "封面", "cover")}`;
  const src = bytesToDataUrl(book.cover.png, "image/png");
  return [
    '<header class="txt2book cover-page">',
    '<section class="cover" id="cover">',
    `<img class="cover-image" src="${src}" alt="${escapeHtml(alt)}">`,
    "</section>",
    "</header>",
  ].join("\n");
}

function titlePage(meta: BookMeta): string {
  const parts = [
    '<section class="title-page">',
    `<h1 class="book-title">${escapeHtml(bookTitle(meta))}</h1>`,
  ];
  const author = meta.author.trim();
  if (author) {
    parts.push(`<p class="book-author">${escapeHtml(author)}</p>`);
  }
  parts.push("</section>");
  return parts.join("\n");
}

/** 简介页：空行分隔的段落用 `paragraph-start` 标记，保留作者原始分段。 */
function descriptionPage(meta: BookMeta): string | null {
  const description = meta.description?.trim();
  if (!description) return null;

  const title = labelFor(meta.language, "简介", "Description");
  const parts = [
    '<section class="description-page">',
    `<h1 class="description-title">${escapeHtml(title)}</h1>`,
  ];

  let inParagraph = false;
  for (const rawLine of description.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (!line) {
      inParagraph = false;
      continue;
    }
    const startsParagraph = !inParagraph && parts.length > 2;
    inParagraph = true;
    const className = startsParagraph ? ' class="paragraph-start"' : "";
    parts.push(`<p${className}>${escapeHtml(line)}</p>`);
  }

  parts.push("</section>");
  return parts.join("\n");
}

function tocPage(items: TocItem[], language: Language): string {
  return [
    '<nav class="toc-page" id="toc">',
    `<h1 class="toc-title">${labelFor(language, "目录", "Contents")}</h1>`,
    renderTocList(items),
    "</nav>",
  ].join("\n");
}

function volumeNoteBlock(note: VolumeNote): string {
  const parts = [
    '<section class="volume-note-block">',
    `<h2 class="volume-title">${escapeHtml(note.title)}</h2>`,
  ];
  for (const rawLine of note.lines) {
    const line = rawLine.trim();
    if (!line) continue;
    parts.push(`<p class="volume-note">${escapeHtml(line)}</p>`);
  }
  parts.push("</section>");
  return parts.join("\n");
}

function chapterPage(entry: PlannedChapter, theme: Theme, notes: VolumeNote[] = []): string {
  const parts = [`<section class="chapter" id="chapter-${entry.number}">`];
  for (const note of notes) {
    parts.push(volumeNoteBlock(note));
  }
  parts.push(renderChapterBody(entry.chapter, theme), "</section>");
  return parts.join("\n");
}

/**
 * 生成单文件 HTML：主题、排版、封面与背景全部内联，
 * 不引用任何外部 `http(s)` 资源，可离线直接用浏览器打开。
 */
export async function buildHtml(book: BookModel, options: ConvertOptions = {}): Promise<Blob> {
  const opts = resolveConvertOptions(options);
  const theme = themes[opts.themeId];
  const layout = options.layout ?? defaultLayoutFor(opts.themeId);
  const normalizedLayout = normalizeLayout(layout, opts.themeId);

  let backgroundSrc: string | undefined;
  const { background } = normalizedLayout;
  if (background.kind === "custom" && opts.themeId !== "eink") {
    backgroundSrc = bytesToDataUrl(background.custom.data, background.custom.mimeType);
  }

  const css = `${theme.css}\n\n${layoutCss(opts.themeId, normalizedLayout, { backgroundSrc })}`;
  const forcedVolumePages = findForcedVolumePages(book, opts.includeVolumePages);
  const blocks = planBlocks(book, opts.includeVolumePages, forcedVolumePages);
  const volumeNotes = opts.includeVolumePages
    ? new Map<string, VolumeNote[]>()
    : buildVolumeNotes(book);
  const meta = book.meta;

  const body: string[] = [];
  const cover = coverPage(book);
  if (cover) body.push(cover);
  if (opts.includeTitlePage) body.push(titlePage(meta));
  const description = descriptionPage(meta);
  if (description) body.push(description);

  const tocItems = buildTocItems(blocks, new Set(book.volumes.map((volume) => volume.id)));
  if (opts.includeTocPage) body.push(tocPage(tocItems, meta.language));

  for (const block of blocks) {
    if (block.kind === "volume") {
      if (block.hasPage) {
        body.push(renderVolumeBody(block.volume, { id: `volume-${block.ordinal}` }));
      }
      continue;
    }
    body.push(
      chapterPage(block.entry, theme, volumeNotes.get(block.entry.chapter.id) ?? []),
    );
  }

  const html = [
    "<!DOCTYPE html>",
    `<html lang="${escapeHtml(meta.language)}">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(bookTitle(meta))}</title>`,
    "<style>",
    css,
    "</style>",
    "</head>",
    '<body class="txt2book">',
    body.join("\n"),
    "</body>",
    "</html>",
    "",
  ].join("\n");

  return new Blob([html], { type: "text/html" });
}

export const htmlConverter: BookConverter = {
  id: "html",
  label: "HTML",
  extension: "html",
  mimeType: "text/html",
  available: true,
  runtime: "browser",
  convert: buildHtml,
};
