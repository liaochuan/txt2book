import type { BookModel, Chapter } from "../types/book";

export interface History {
  push(snapshot: BookModel): void;
  undo(): BookModel | null;
  canUndo(): boolean;
}

/** 返回内容等价的新书对象，保证调用方拿到的对象与入参不共享集合。 */
function copyBook(book: BookModel): BookModel {
  return {
    ...book,
    volumes: [...book.volumes],
    chapters: [...book.chapters],
  };
}

/** 拼接两段正文：仅当两侧都非空时插入一个空行分隔，避免出现悬空空行。 */
function mergeLines(base: string[], extra: string[]): string[] {
  if (base.length === 0) return [...extra];
  if (extra.length === 0) return [...base];
  return [...base, "", ...extra];
}

function createChapterId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `chapter-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** 修改章节标题，首次改名时把原标题记入 `originalTitle`。 */
export function renameChapter(book: BookModel, chapterId: string, title: string): BookModel {
  const index = book.chapters.findIndex((chapter) => chapter.id === chapterId);
  if (index < 0) return copyBook(book);

  const current = book.chapters[index];
  const nextTitle = title.trim() || current.title;
  const chapters = [...book.chapters];
  chapters[index] = {
    ...current,
    title: nextTitle,
    originalTitle: current.originalTitle ?? current.title,
  };
  return { ...copyBook(book), chapters };
}

/**
 * 删除章节，正文不丢失：
 * - 有上一章时追加到上一章末尾（跨卷也追加到全局上一章）；
 * - 是第一章时并入下一章开头；
 * - 全书仅剩一章时保持原样返回。
 */
export function deleteChapter(book: BookModel, chapterId: string): BookModel {
  const index = book.chapters.findIndex((chapter) => chapter.id === chapterId);
  if (index < 0 || book.chapters.length <= 1) return copyBook(book);

  const removed = book.chapters[index];
  const chapters = [...book.chapters];
  chapters.splice(index, 1);

  if (index === 0) {
    const next = chapters[0] as Chapter;
    chapters[0] = { ...next, lines: mergeLines(removed.lines, next.lines) };
  } else {
    const prev = chapters[index - 1] as Chapter;
    chapters[index - 1] = { ...prev, lines: mergeLines(prev.lines, removed.lines) };
  }

  return { ...copyBook(book), chapters };
}

/**
 * 删除卷：该卷下章节提升为无卷（`volumeId = null`），其余章节不动。
 * 卷首正文按卷的位置并入相邻章节，保证文字不丢：
 * - 有子章节时并入第一个子章节开头；
 * - 没有子章节时并入原卷位置之后的第一个章节；卷在末尾则追加到全书最后一章；
 * - 删除后全书没有章节时，用卷首正文新建一个根级“简介”章。
 */
export function deleteVolume(book: BookModel, volumeId: string): BookModel {
  const volume = book.volumes.find((item) => item.id === volumeId);
  if (!volume) return copyBook(book);

  const volumeIndex = book.volumes.indexOf(volume);
  const volumes = book.volumes.filter((item) => item.id !== volumeId);
  const volumeLines = volume.lines ?? [];
  const childIndices = book.chapters.reduce<number[]>((indices, chapter, index) => {
    if (chapter.volumeId === volumeId) indices.push(index);
    return indices;
  }, []);

  let chapters: Chapter[] = book.chapters.map((chapter) =>
    chapter.volumeId === volumeId ? { ...chapter, volumeId: null } : chapter,
  );

  if (volumeLines.length === 0) {
    return { ...copyBook(book), volumes, chapters };
  }

  if (childIndices.length > 0) {
    const firstChild = childIndices[0];
    chapters = chapters.map((chapter, index) =>
      index === firstChild
        ? { ...chapter, lines: mergeLines(volumeLines, chapter.lines) }
        : chapter,
    );
  } else if (chapters.length > 0) {
    const laterVolumeIds = new Set(
      book.volumes.slice(volumeIndex + 1).map((item) => item.id),
    );
    const nextIndex = chapters.findIndex(
      (chapter) => chapter.volumeId !== null && laterVolumeIds.has(chapter.volumeId),
    );
    if (nextIndex >= 0) {
      chapters = chapters.map((chapter, index) =>
        index === nextIndex
          ? { ...chapter, lines: mergeLines(volumeLines, chapter.lines) }
          : chapter,
      );
    } else {
      const lastIndex = chapters.length - 1;
      chapters = chapters.map((chapter, index) =>
        index === lastIndex
          ? { ...chapter, lines: mergeLines(chapter.lines, volumeLines) }
          : chapter,
      );
    }
  } else {
    chapters = [
      {
        id: createChapterId(),
        title: volume.title,
        originalTitle: volume.title,
        kind: "intro",
        lines: [...volumeLines],
        volumeId: null,
      },
    ];
  }

  return { ...copyBook(book), volumes, chapters };
}

/** 撤销历史：保存快照引用（书对象不可变，引用共享是安全的），超出上限时丢弃最旧快照。 */
export function createHistory(limit = 20): History {
  const snapshots: BookModel[] = [];
  const max = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 20;

  return {
    push(snapshot: BookModel): void {
      snapshots.push(snapshot);
      while (snapshots.length > max) snapshots.shift();
    },
    undo(): BookModel | null {
      return snapshots.pop() ?? null;
    },
    canUndo(): boolean {
      return snapshots.length > 0;
    },
  };
}
