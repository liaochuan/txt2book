import type { BookModel, Chapter, Volume } from "../../../types/book";
import {
  resolveConvertOptions,
  type BookConverter,
  type ConvertHooks,
  type ConvertOptions,
  type ExportProgress,
} from "../types";

/** 默认输出简介：TXT 里“简介”章是正文的一部分。 */
const DEFAULT_INCLUDE_INTRO = true;
/** 默认输出卷标题，便于在纯文本里保留书的层级。 */
const DEFAULT_INCLUDE_VOLUME_TITLES = true;
/** 番外分组没有标题时的兜底文案。 */
const EXTRA_GROUP_LABEL = "番外";

/** 兼容 `formatOptions` 里可能以字符串形式传入的布尔值。 */
function readBoolean(
  formatOptions: Record<string, boolean | string> | undefined,
  key: string,
  fallback: boolean,
): boolean {
  const value = formatOptions?.[key];
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  const normalized = value.trim().toLowerCase();
  return normalized !== "false" && normalized !== "0" && normalized !== "";
}

/** 只保留行尾内容，正文的行首缩进按原文保留。 */
function trimLineEnd(line: string): string {
  return line.replace(/\s+$/u, "");
}

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

/** 去掉块首尾的空行，避免与相邻块之间出现多余空行。 */
function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && isBlank(lines[start])) start += 1;
  while (end > start && isBlank(lines[end - 1])) end -= 1;
  return lines.slice(start, end);
}

/** 追加一个块；块之间固定隔一个空行，块内空行最后统一折叠。 */
function pushBlock(output: string[], lines: string[]): void {
  const block = trimBlankEdges(lines);
  if (block.length === 0) return;
  if (output.length > 0) output.push("");
  output.push(...block);
}

/** 卷标题块：卷标题独占一行，后接卷首文字（如果有）。 */
function volumeBlock(volume: Volume): string[] {
  const title = volume.title.trim();
  const lines: string[] = [];
  if (title) lines.push(title);
  for (const rawLine of volume.lines ?? []) {
    const line = trimLineEnd(rawLine);
    if (!isBlank(line)) lines.push(line);
  }
  return lines;
}

/** 章标题独占一行，前后各留一个空行（空行由 `pushBlock` 与最终折叠保证）。 */
function chapterBlock(chapter: Chapter): string[] {
  const title = chapter.title.trim();
  const body = chapter.lines.map(trimLineEnd);
  const lines = [...(title ? [title] : []), ...(title ? [""] : []), ...body];
  return lines;
}

/** 书籍简介块：固定“简介”标题，按原行保留段落，空行交由最终折叠处理。 */
function descriptionBlock(description: string): string[] {
  const lines = description.split(/\r\n|\r|\n/).map(trimLineEnd);
  return ["简介", "", ...lines];
}

/**
 * 生成整理版 TXT：UTF-8 无 BOM，`\n` 换行，卷/章标题独占一行，
 * 正文行保留原文、去掉行尾空白，连续空行折叠为最多一个。
 */
export async function buildTxt(
  book: BookModel,
  options: ConvertOptions = {},
  hooks?: ConvertHooks,
): Promise<Blob> {
  const report = (progress: ExportProgress): void => {
    hooks?.onProgress?.(progress);
  };
  report({ phase: "preparing", percent: 10, message: "正在准备 TXT 内容…" });

  const opts = resolveConvertOptions(options);
  const includeIntro = readBoolean(opts.formatOptions, "includeIntro", DEFAULT_INCLUDE_INTRO);
  const includeVolumeTitles = readBoolean(
    opts.formatOptions,
    "includeVolumeTitles",
    DEFAULT_INCLUDE_VOLUME_TITLES,
  );

  const output: string[] = [];

  const chapters = book.chapters.filter(
    (chapter) => includeIntro || chapter.kind !== "intro",
  );

  const description = book.meta.description?.trim();
  if (opts.includeDescription && description) {
    pushBlock(output, descriptionBlock(description));
  }

  const volumeById = new Map(book.volumes.map((volume) => [volume.id, volume]));
  const volumeOrder = new Map(book.volumes.map((volume, index) => [volume.id, index]));
  const emittedVolumeIds = new Set<string>();
  let currentVolumeId: string | null = null;

  /** 输出卷块；关闭卷标题时卷标题与卷首文字都不输出。 */
  const emitVolume = (volume: Volume): void => {
    if (!includeVolumeTitles || emittedVolumeIds.has(volume.id)) return;
    emittedVolumeIds.add(volume.id);
    if (volume.kind === "extra-group") {
      // 番外分组只输出一次分组标题，不重复每个番外章。
      pushBlock(output, [volume.title.trim() || EXTRA_GROUP_LABEL]);
    } else {
      pushBlock(output, volumeBlock(volume));
    }
  };

  // 没有任何章节落点的卷（零章卷）按 book.volumes 顺序补发：
  // 插到它后方第一个章节之前；后面没有章节的留在全书末尾补发。
  const volumesWithChapters = new Set(
    chapters.map((chapter) => chapter.volumeId).filter((id): id is string => id !== null),
  );
  const zeroChapterVolumesBefore = new Map<number, Volume[]>();
  book.volumes.forEach((volume, volumeIndex) => {
    if (volumesWithChapters.has(volume.id)) return;
    let insertAt = chapters.length;
    for (let chapterIndex = 0; chapterIndex < chapters.length; chapterIndex += 1) {
      const chapterVolumeId = chapters[chapterIndex].volumeId;
      const chapterVolumeOrder =
        chapterVolumeId === null ? undefined : volumeOrder.get(chapterVolumeId);
      if (chapterVolumeOrder !== undefined && chapterVolumeOrder > volumeIndex) {
        insertAt = chapterIndex;
        break;
      }
    }
    const pending = zeroChapterVolumesBefore.get(insertAt) ?? [];
    pending.push(volume);
    zeroChapterVolumesBefore.set(insertAt, pending);
  });

  for (let chapterIndex = 0; chapterIndex <= chapters.length; chapterIndex += 1) {
    for (const volume of zeroChapterVolumesBefore.get(chapterIndex) ?? []) {
      emitVolume(volume);
    }
    const chapter = chapters[chapterIndex];
    if (!chapter) break;

    const volume = chapter.volumeId ? volumeById.get(chapter.volumeId) : undefined;
    if (!volume) {
      // 无卷或卷已被删除的章节直接顺排，并打断当前卷分组。
      currentVolumeId = null;
    } else if (volume.id !== currentVolumeId) {
      currentVolumeId = volume.id;
      emitVolume(volume);
    }

    pushBlock(output, chapterBlock(chapter));
  }

  report({ phase: "writing", percent: 80, message: "正在生成 TXT 文件…" });

  const text = `${output.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "")}\n`;

  // Blob 直接由字符串构造：浏览器与 Node 都按 UTF-8 编码，不加 BOM。
  report({ phase: "writing", percent: 100, message: "正在准备下载…" });
  return new Blob([text], { type: "text/plain;charset=utf-8" });
}

export const txtConverter: BookConverter = {
  id: "txt",
  label: "TXT",
  extension: "txt",
  mimeType: "text/plain;charset=utf-8",
  available: true,
  runtime: "browser",
  options: [
    {
      key: "includeIntro",
      label: "包含简介",
      type: "boolean",
      defaultValue: true,
      hint: "输出书籍简介章节。",
    },
    {
      key: "includeVolumeTitles",
      label: "包含卷标题",
      type: "boolean",
      defaultValue: true,
      hint: "在正文中输出分卷标题与番外分组标题；关闭后卷标题与卷首文字都不输出。",
    },
  ],
  convert: buildTxt,
};
