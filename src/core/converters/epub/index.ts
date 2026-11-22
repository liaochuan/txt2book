import JSZip from "jszip";
import type { BookModel, Chapter, Volume } from "../../../types/book";
import { defaultLayoutFor, layoutCss, normalizeLayout } from "../../render/layout";
import { themes } from "../../render/themes";
import {
  resolveConvertOptions,
  type BookConverter,
  type ConvertHooks,
  type ConvertOptions,
  type ExportProgress,
} from "../types";
import { buildOpf, containerXml, NCX_MEDIA_TYPE, type OpfManifestItem, type OpfSpineItem } from "./opf";
import {
  chapterDocument,
  coverDocument,
  descriptionDocument,
  labelFor,
  navDocument,
  tocNcxDocument,
  volumeDocument,
  type NavEntry,
  type VolumeNote,
} from "./xhtml";

/** 已分配好文件序号与路径的章节。 */
interface PlannedChapter {
  chapter: Chapter;
  number: number;
  id: string;
  href: string;
}

/** 阅读顺序中的一块：卷扉页（可能只是目录分组）或章节。 */
type Block =
  | { kind: "volume"; volume: Volume; ordinal: number; hasPage: boolean }
  | { kind: "chapter"; entry: PlannedChapter };

/** 章节文件统一放在 `OEBPS/text/`，因此样式表用 `../styles/theme.css`。 */
function chapterHref(number: number): string {
  return `text/chapter-${number}.xhtml`;
}

function makeIdentifier(): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `urn:uuid:${random}`;
}

/** EPUB 3 要求 `dcterms:modified` 为 `YYYY-MM-DDTHH:MM:SSZ`。 */
function isoTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d+Z$/, "Z");
}

/**
 * 生成 EPUB 3 字节流。
 *
 * 目录结构：
 *   mimetype                      （第一个条目，不压缩）
 *   META-INF/container.xml
 *   OEBPS/content.opf
 *   OEBPS/nav.xhtml               （root，导航文档兼目录页）
 *   OEBPS/toc.ncx                 （旧阅读器兼容）
 *   OEBPS/styles/theme.css
 *   OEBPS/images/cover.png
 *   OEBPS/cover.xhtml / description.xhtml / volume-N.xhtml
 *   OEBPS/text/chapter-N.xhtml
 */
export async function buildEpub(
  book: BookModel,
  options: ConvertOptions = {},
  hooks?: ConvertHooks,
): Promise<Blob> {
  const report = (progress: ExportProgress): void => {
    hooks?.onProgress?.(progress);
  };
  report({ phase: "preparing", percent: 0, message: "正在准备 EPUB 内容…" });

  const opts = resolveConvertOptions(options);
  const theme = themes[opts.themeId];
  const meta = book.meta;
  const language = meta.language;
  const identifier = makeIdentifier();
  const modified = isoTimestamp(new Date());

  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", containerXml);
  const oebps = zip.folder("OEBPS");
  if (!oebps) {
    throw new Error("无法创建 EPUB 目录结构");
  }

  const manifest: OpfManifestItem[] = [
    { id: "nav", href: "nav.xhtml", mediaType: "application/xhtml+xml", properties: "nav" },
    { id: "ncx", href: "toc.ncx", mediaType: NCX_MEDIA_TYPE },
    { id: "theme-css", href: "styles/theme.css", mediaType: "text/css" },
  ];
  const spine: OpfSpineItem[] = [];

  // 高级排版：未传入时回退主题默认值；背景按归一化后的结果决定是否落盘。
  const layout = options.layout ?? defaultLayoutFor(opts.themeId);
  const normalizedLayout = normalizeLayout(layout, opts.themeId);
  const { background } = normalizedLayout;
  const backgroundImages: OpfManifestItem[] = [];
  let backgroundSrc: string | undefined;
  if (background.kind === "custom" && opts.themeId !== "eink") {
    // 墨水屏不写图片；图片扩展名由 MIME 决定，字节原样写入，不做转码。
    const custom = background.custom;
    const extension = custom.mimeType === "image/jpeg" ? "jpg" : "png";
    const href = `images/background.${extension}`;
    oebps.file(href, custom.data);
    backgroundSrc = `../${href}`;
    backgroundImages.push({
      id: "background-image",
      href,
      mediaType: custom.mimeType,
    });
  }

  if (book.cover) {
    oebps.file("images/cover.png", book.cover.png);
    oebps.file("cover.xhtml", coverDocument(meta));
    manifest.push({
      id: "cover-image",
      href: "images/cover.png",
      mediaType: "image/png",
      properties: "cover-image",
    });
    manifest.push({ id: "cover-page", href: "cover.xhtml", mediaType: "application/xhtml+xml" });
    spine.push({ idref: "cover-page" });
  }

  // 简介页由独立选项控制；关闭后元数据中的 dc:description 仍然保留。
  if (opts.includeDescription && meta.description?.trim()) {
    oebps.file("description.xhtml", descriptionDocument(meta));
    manifest.push({ id: "description", href: "description.xhtml", mediaType: "application/xhtml+xml" });
    spine.push({ idref: "description" });
  }

  // 关闭目录页时不把 nav 排进 spine：EPUB 3 只要求在 manifest 中声明导航文档，
  // 而阅读 / 多看等阅读器会忽略 linear="no"，把整页目录当成第一章正文排出来。
  if (opts.includeTocPage) {
    spine.push({ idref: "nav" });
  }

  const volumeById = new Map(book.volumes.map((volume) => [volume.id, volume]));
  const volumeOrdinal = new Map(book.volumes.map((volume, index) => [volume.id, index + 1]));

  // 空书补一张空白正文页：EPUB 要求 nav / ncx 至少有一个条目，否则文件不合法。
  const chapters: Chapter[] =
    book.chapters.length > 0
      ? book.chapters
      : [
          {
            id: "empty-book",
            title: labelFor(language, "正文", "Content"),
            kind: "chapter",
            lines: [],
            volumeId: null,
          },
        ];

  const planned: PlannedChapter[] = chapters.map((chapter, index) => {
    const number = index + 1;
    return { chapter, number, id: `chapter-${number}`, href: chapterHref(number) };
  });

  // 关闭卷扉页时卷标题与卷首文字仍需出现在正文里：按卷顺序为每个卷寻找承载章节，
  // 以 `.volume-note-block` 渲染，保留专属样式，且不改动章节正文行。
  // 零章卷没有自己的第一章，优先并入其后出现的第一个章节；若后面也没有章节，
  // 则并入全书最后一个章节。全书没有章节时只能保留卷扉页，见下方 forcedVolumePages。
  const volumeNotesByChapter = new Map<string, VolumeNote[]>();
  const forcedVolumePages = new Set<string>();
  if (!opts.includeVolumePages) {
    const volumeOrder = new Map(book.volumes.map((volume, index) => [volume.id, index]));
    const chapterVolumeOrder = book.chapters.map((chapter) =>
      chapter.volumeId === null ? null : (volumeOrder.get(chapter.volumeId) ?? null),
    );
    const lastChapter = book.chapters[book.chapters.length - 1];

    book.volumes.forEach((volume, index) => {
      if (volume.kind !== "volume") return;

      // 包含本卷自己的第一章，以及排在其后的任何卷的第一章。
      const carrier =
        book.chapters.find((_, chapterIndex) => {
          const order = chapterVolumeOrder[chapterIndex];
          return order !== null && order >= index;
        }) ?? lastChapter;
      if (!carrier) {
        forcedVolumePages.add(volume.id);
        return;
      }

      const notes = volumeNotesByChapter.get(carrier.id) ?? [];
      notes.push({ title: volume.title, lines: volume.lines ?? [] });
      volumeNotesByChapter.set(carrier.id, notes);
    });
  }

  // 阅读顺序：章节保持 book.chapters 的顺序，卷扉页插在该卷首次出现的位置之前。
  const emittedVolumePages = new Set<string>();
  const blocks: Block[] = [];
  let currentVolumeId: string | null = null;

  for (const entry of planned) {
    const volume = entry.chapter.volumeId ? volumeById.get(entry.chapter.volumeId) : undefined;
    if (!volume) {
      // 无卷章节直接挂在根目录下，且打断当前卷分组。
      currentVolumeId = null;
    } else if (volume.id !== currentVolumeId) {
      currentVolumeId = volume.id;
      const firstAppearance = !emittedVolumePages.has(volume.id);
      emittedVolumePages.add(volume.id);
      // 番外分组只是目录分组，不生成“卷扉页”，避免多出一张空白页。
      blocks.push({
        kind: "volume",
        volume,
        ordinal: volumeOrdinal.get(volume.id) ?? entry.number,
        hasPage: firstAppearance && opts.includeVolumePages && volume.kind === "volume",
      });
    }
    blocks.push({ kind: "chapter", entry });
  }

  // 零章卷在开启卷扉页时保留扉页与目录节点，插在它后面那个卷之前（没有则放在末尾）。
  // 全书没有任何章节时，关闭选项也必须生成扉页，否则卷首文字无处承载。
  if (opts.includeVolumePages || forcedVolumePages.size > 0) {
    book.volumes.forEach((volume, index) => {
      if (volume.kind !== "volume" || emittedVolumePages.has(volume.id)) return;
      if (!opts.includeVolumePages && !forcedVolumePages.has(volume.id)) return;
      const laterVolumeIds = new Set(book.volumes.slice(index + 1).map((item) => item.id));
      const insertAt = blocks.findIndex((block) => {
        const volumeId = block.kind === "volume" ? block.volume.id : block.entry.chapter.volumeId;
        return volumeId !== null && volumeId !== undefined && laterVolumeIds.has(volumeId);
      });
      blocks.splice(insertAt === -1 ? blocks.length : insertAt, 0, {
        kind: "volume",
        volume,
        ordinal: index + 1,
        hasPage: true,
      });
    });
  }

  const navEntries: NavEntry[] = [];
  let currentVolumeNav: NavEntry | null = null;

  blocks.forEach((block, index) => {
    if (block.kind === "volume") {
      const pageHref = `volume-${block.ordinal}.xhtml`;
      const next = blocks[index + 1];
      const firstChapterHref = next && next.kind === "chapter" ? next.entry.href : null;
      const href = block.hasPage ? pageHref : firstChapterHref;
      if (href === null) {
        // 既没有扉页也没有后续章节，无法形成可点击的目录节点。
        currentVolumeNav = null;
        return;
      }

      if (block.hasPage) {
        oebps.file(pageHref, volumeDocument(block.volume, language));
        manifest.push({
          id: `volume-${block.ordinal}`,
          href: pageHref,
          mediaType: "application/xhtml+xml",
        });
        spine.push({ idref: `volume-${block.ordinal}` });
      }

      currentVolumeNav = {
        title: block.volume.title,
        href,
        children: [],
        // 落点是章节文件时，NCX 用锚点与本章导航点区分开。
        ...(block.hasPage || !next || next.kind !== "chapter"
          ? {}
          : { anchor: `chapter-${next.entry.number}` }),
      };
      navEntries.push(currentVolumeNav);
      return;
    }

    const entry = block.entry;
    // 根级章节（无卷或卷已被删除）必须断开当前卷分组，
    // 否则会错误地嵌套到上一卷的 <ol> 里。
    const entryVolumeId = entry.chapter.volumeId;
    if (entryVolumeId === null || !volumeById.has(entryVolumeId)) {
      currentVolumeNav = null;
    }

    oebps.file(
      entry.href,
      chapterDocument(entry.chapter, theme, entry.number, language, {
        volumeNotes: volumeNotesByChapter.get(entry.chapter.id),
      }),
    );
    manifest.push({ id: entry.id, href: entry.href, mediaType: "application/xhtml+xml" });
    spine.push({ idref: entry.id });

    if (currentVolumeNav) {
      currentVolumeNav.children!.push({ title: entry.chapter.title, href: entry.href });
    } else {
      navEntries.push({ title: entry.chapter.title, href: entry.href });
    }
  });

  oebps.file(
    "styles/theme.css",
    `${theme.css}\n\n${layoutCss(opts.themeId, normalizedLayout, { backgroundSrc })}`,
  );
  oebps.file("nav.xhtml", navDocument(meta, navEntries));
  oebps.file("toc.ncx", tocNcxDocument(meta, navEntries, identifier));
  oebps.file(
    "content.opf",
    buildOpf(meta, manifest, spine, {
      identifier,
      modified,
      coverImageId: book.cover ? "cover-image" : undefined,
      ncxId: "ncx",
      images: backgroundImages,
    }),
  );

  // JSZip 的 `metadata.percent` 是压缩打包的总体百分比；夹紧到 0–100 并保证单调，
  // 避免不同 JSZip 版本偶发的回退让进度条倒退。
  let lastPercent = 0;
  const data = await zip.generateAsync(
    {
      type: "arraybuffer",
      mimeType: "application/epub+zip",
      compression: "DEFLATE",
    },
    (metadata) => {
      const percent = Math.min(100, Math.max(lastPercent, Math.round(metadata.percent)));
      lastPercent = percent;
      report({ phase: "generating", percent, message: `正在打包 EPUB ${percent}%` });
    },
  );
  report({ phase: "writing", percent: 100, message: "正在准备下载…" });
  return new Blob([data], { type: "application/epub+zip" });
}

export const epubConverter: BookConverter = {
  id: "epub",
  label: "EPUB",
  extension: "epub",
  mimeType: "application/epub+zip",
  available: true,
  convert: buildEpub,
};
