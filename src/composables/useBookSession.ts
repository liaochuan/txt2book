import { computed, markRaw, ref, type ComputedRef, type Ref } from "vue";
import {
  createHistory,
  deleteChapter,
  deleteVolume,
  renameChapter,
  type History,
} from "../core/chapterOps";
import type { ParsedBook } from "../core/chapterParser";
import type { BookMeta, BookModel, Chapter, CoverAsset, Volume } from "../types/book";

export interface BookSession {
  book: Ref<BookModel>;
  selected: ComputedRef<Chapter | null>;
  selectedId: Ref<string | null>;
  /** 当前选中的卷；与章节选中互斥，卷被删除或撤销后自动失效。 */
  selectedVolumeId: Ref<string | null>;
  selectedVolume: ComputedRef<Volume | null>;
  canUndo: ComputedRef<boolean>;
  hasBook: ComputedRef<boolean>;
  /** 每次书籍变更（含撤销、重载、重置）都会 +1，供 Toast 判断能否安全撤销。 */
  version: Ref<number>;
  loadBook(meta: BookMeta, parsed: ParsedBook, title: string): void;
  select(id: string | null): void;
  selectVolume(id: string): void;
  rename(id: string, title: string): void;
  removeChapter(id: string): void;
  removeVolume(id: string): void;
  undo(): void;
  /** 清空书籍、撤销历史与自动书名，退出登录时使用。 */
  reset(): void;
  setCover(cover: CoverAsset | null): void;
  updateMeta(patch: Partial<BookMeta>): void;
}

const HISTORY_LIMIT = 20;

function emptyBook(): BookModel {
  return {
    meta: { title: "", author: "", language: "zh-CN" },
    volumes: [],
    chapters: [],
    cover: null,
  };
}

/** 复制解析结果，避免会话直接持有解析器的数组与正文引用。 */
function toBookModel(
  meta: BookMeta,
  parsed: ParsedBook,
  cover: CoverAsset | null,
): BookModel {
  return {
    meta: { ...meta },
    volumes: parsed.volumes.map((volume) => ({
      ...volume,
      lines: volume.lines ? [...volume.lines] : undefined,
    })),
    chapters: parsed.chapters.map((chapter) => ({ ...chapter, lines: [...chapter.lines] })),
    cover,
  };
}

/** 移除既没有章节归属、也没有卷首正文的空卷，包括空的番外分组。 */
function pruneEmptyVolumes(volumes: BookModel["volumes"], chapters: Chapter[]): BookModel["volumes"] {
  return volumes.filter((volume) => {
    const ownsChapter = chapters.some((chapter) => chapter.volumeId === volume.id);
    const hasLines = (volume.lines ?? []).some((line) => line.trim() !== "");
    return ownsChapter || hasLines;
  });
}

/**
 * 书籍会话：持有不可变书对象、撤销历史与当前选中章节。
 *
 * 所有变更都先压入历史快照，再通过 `chapterOps` 生成新对象；
 * 选中 id 允许暂时失效，读取时回退到第一章，因此删除与撤销后无需额外修复。
 */
export function useBookSession(): BookSession {
  const book = ref<BookModel>(emptyBook());
  let history: History = createHistory(HISTORY_LIMIT);
  const canUndoState = ref(false);
  const version = ref(0);
  const rawSelectedId = ref<string | null>(null);
  const rawSelectedVolumeId = ref<string | null>(null);
  /** 上一次由 `loadBook` 自动填入的书名，用于判断用户是否手动改过书名。 */
  let lastAutoTitle = "";
  /** 与 history 快照一一对应的自动书名记录，撤销时一并回滚。 */
  const autoTitleHistory: string[] = [];

  /**
   * 卷选中与章节选中互斥。读取时校验卷仍然存在，删除卷后无需额外修复；
   * 保留原始 id 可让撤销删除后重新选中该卷。
   */
  const selectedVolumeId = computed<string | null>({
    get(): string | null {
      const id = rawSelectedVolumeId.value;
      if (!id) return null;
      return book.value.volumes.some((volume) => volume.id === id) ? id : null;
    },
    set(value: string | null): void {
      rawSelectedVolumeId.value = value;
      if (value !== null) rawSelectedId.value = null;
    },
  });

  const selectedVolume = computed<Volume | null>(() => {
    const id = selectedVolumeId.value;
    if (!id) return null;
    return book.value.volumes.find((volume) => volume.id === id) ?? null;
  });

  const selectedId = computed<string | null>({
    get(): string | null {
      if (selectedVolumeId.value !== null) return null;
      const chapters = book.value.chapters;
      if (chapters.length === 0) return null;
      const current = rawSelectedId.value;
      if (current && chapters.some((chapter) => chapter.id === current)) return current;
      return chapters[0].id;
    },
    set(value: string | null): void {
      rawSelectedId.value = value;
      if (value !== null) rawSelectedVolumeId.value = null;
    },
  });

  const selected = computed<Chapter | null>(
    () => book.value.chapters.find((chapter) => chapter.id === selectedId.value) ?? null,
  );

  const canUndo = computed<boolean>(() => canUndoState.value);
  const hasBook = computed<boolean>(() => book.value.chapters.length > 0);

  function syncHistory(): void {
    canUndoState.value = history.canUndo();
  }

  /** 压入快照与对应的自动书名，是唯一写入历史的位置。 */
  function pushSnapshot(snapshot: BookModel): void {
    history.push(snapshot);
    autoTitleHistory.push(lastAutoTitle);
    while (autoTitleHistory.length > HISTORY_LIMIT) autoTitleHistory.shift();
    syncHistory();
  }

  /** 压入当前快照并写入新书对象，是唯一修改 `book` 的入口。 */
  function commit(next: BookModel): void {
    pushSnapshot(book.value);
    book.value = next;
    version.value += 1;
  }

  function loadBook(meta: BookMeta, parsed: ParsedBook, title: string): void {
    const current = book.value;
    if (current.chapters.length > 0) pushSnapshot(current);

    const currentTitle = current.meta.title;
    const requestedTitle = title.trim() || meta.title.trim();
    const shouldApplyTitle = currentTitle === "" || currentTitle === lastAutoTitle;
    const nextTitle = shouldApplyTitle ? requestedTitle || currentTitle : currentTitle;
    if (shouldApplyTitle) lastAutoTitle = nextTitle;

    rawSelectedId.value = null;
    rawSelectedVolumeId.value = null;
    book.value = toBookModel({ ...meta, title: nextTitle }, parsed, current.cover);
    version.value += 1;
  }

  /** 传 null 表示放弃显式选择；有章节时读取会回退到第一章。 */
  function select(id: string | null): void {
    rawSelectedId.value = id;
    rawSelectedVolumeId.value = null;
  }

  /** 选中卷扉页并清空章节选中；未知卷 id 不改变当前选中。 */
  function selectVolume(id: string): void {
    if (!book.value.volumes.some((volume) => volume.id === id)) return;
    rawSelectedVolumeId.value = id;
    rawSelectedId.value = null;
  }

  function rename(id: string, title: string): void {
    if (!book.value.chapters.some((chapter) => chapter.id === id)) return;
    commit(renameChapter(book.value, id, title));
  }

  function removeChapter(id: string): void {
    const current = book.value;
    const index = current.chapters.findIndex((chapter) => chapter.id === id);
    if (index < 0) return;
    // `deleteChapter` 会保留全书最后一章及其正文，此时不产生快照。
    if (current.chapters.length <= 1) return;

    const wasSelected = selectedId.value === id;
    const next = deleteChapter(current, id);
    const chapters = next.chapters;
    const volumes = chapters.length === 0 ? [] : pruneEmptyVolumes(next.volumes, chapters);
    commit({ ...next, chapters, volumes });

    if (chapters.length === 0) {
      rawSelectedId.value = null;
      return;
    }
    if (wasSelected) {
      const neighbor = chapters[index] ?? chapters[index - 1] ?? chapters[0];
      rawSelectedId.value = neighbor.id;
    }
  }

  function removeVolume(id: string): void {
    if (!book.value.volumes.some((volume) => volume.id === id)) return;
    commit(deleteVolume(book.value, id));
  }

  function undo(): void {
    const snapshot = history.undo();
    if (snapshot) {
      lastAutoTitle = autoTitleHistory.pop() ?? lastAutoTitle;
      book.value = snapshot;
      version.value += 1;
    }
    syncHistory();
  }

  /** 重置为空白会话；历史与自动书名一并清空，避免登出后残留旧书。 */
  function reset(): void {
    history = createHistory(HISTORY_LIMIT);
    autoTitleHistory.length = 0;
    lastAutoTitle = "";
    rawSelectedId.value = null;
    rawSelectedVolumeId.value = null;
    book.value = emptyBook();
    syncHistory();
    version.value += 1;
  }

  function setCover(cover: CoverAsset | null): void {
    if (book.value.cover === cover) return;
    // 封面是二进制资源，标记为非响应式，避免大数组被深度代理。
    commit({ ...book.value, cover: cover ? markRaw(cover) : null });
  }

  function updateMeta(patch: Partial<BookMeta>): void {
    const keys = Object.keys(patch) as Array<keyof BookMeta>;
    const changed = keys.some((key) => patch[key] !== book.value.meta[key]);
    if (!changed) return;
    commit({ ...book.value, meta: { ...book.value.meta, ...patch } });
  }

  return {
    book,
    selected,
    selectedId,
    selectedVolumeId,
    selectedVolume,
    canUndo,
    hasBook,
    version,
    loadBook,
    select,
    selectVolume,
    rename,
    removeChapter,
    removeVolume,
    undo,
    reset,
    setCover,
    updateMeta,
  };
}
