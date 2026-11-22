import { describe, expect, it } from "vitest";
import { useBookSession } from "../src/composables/useBookSession";
import type { BookSource, CoverAsset } from "../src/types/book";

const COVER: CoverAsset = {
  png: new Uint8Array([137, 80, 78, 71]),
  width: 1,
  height: 1,
  sourceName: "cover.png",
};

const META = { title: "书", author: "", language: "zh-CN" as const };

const SOURCE: BookSource = {
  kind: "calibre-web",
  origin: "https://calibre.example.com",
  bookId: 42,
  title: "书",
  formats: ["TXT"],
};

const metaA = { title: "A", author: "", language: "zh-CN" as const };
const metaB = { title: "B", author: "", language: "zh-CN" as const };
const parsedA = {
  volumes: [],
  chapters: [{ id: "a1", title: "甲", kind: "chapter" as const, lines: ["a"], volumeId: null }],
};
const parsedB = {
  volumes: [],
  chapters: [{ id: "b1", title: "乙", kind: "chapter" as const, lines: ["b"], volumeId: null }],
};

function seed() {
  const s = useBookSession();
  s.loadBook(
    META,
    {
      volumes: [{ id: "v1", title: "第一卷", kind: "volume" }],
      chapters: [
        { id: "c1", title: "一", kind: "chapter", lines: ["a"], volumeId: "v1" },
        { id: "c2", title: "二", kind: "chapter", lines: ["b"], volumeId: "v1" },
      ],
    },
    "书",
  );
  return s;
}

function seedFour() {
  const s = useBookSession();
  s.loadBook(
    META,
    {
      volumes: [{ id: "v1", title: "第一卷", kind: "volume" }],
      chapters: [
        { id: "c1", title: "一", kind: "chapter", lines: ["a"], volumeId: "v1" },
        { id: "c2", title: "二", kind: "chapter", lines: ["b"], volumeId: "v1" },
        { id: "c3", title: "三", kind: "chapter", lines: ["c"], volumeId: "v1" },
        { id: "c4", title: "四", kind: "chapter", lines: ["d"], volumeId: "v1" },
      ],
    },
    "书",
  );
  return s;
}

function seedSingle() {
  const s = useBookSession();
  s.loadBook(
    META,
    {
      volumes: [],
      chapters: [{ id: "only", title: "唯一章", kind: "chapter", lines: ["正文"], volumeId: null }],
    },
    "书",
  );
  return s;
}

describe("useBookSession", () => {
  it("starts empty without a loaded book", () => {
    const s = useBookSession();
    expect(s.hasBook.value).toBe(false);
    expect(s.selected.value).toBeNull();
    expect(s.selectedId.value).toBeNull();
    expect(s.canUndo.value).toBe(false);
  });

  it("selects the first chapter after load", () => {
    expect(seed().selected.value?.id).toBe("c1");
  });

  it("falls back to the first chapter when selecting null", () => {
    const s = seed();
    s.select("c2");
    s.select(null);
    expect(s.selected.value?.id).toBe("c1");
  });

  it("moves selection to the previous neighbor after deleting the selected last chapter", () => {
    const s = seed();
    s.select("c2");
    s.removeChapter("c2");
    expect(s.selected.value?.id).toBe("c1");
  });

  it("moves selection to the next neighbor when a middle chapter is deleted", () => {
    const s = seedFour();
    s.select("c2");
    s.removeChapter("c2");
    expect(s.book.value.chapters.map((chapter) => chapter.id)).toEqual(["c1", "c3", "c4"]);
    expect(s.selected.value?.id).toBe("c3");
  });

  it("prefers the previous neighbor when the selected last chapter is deleted", () => {
    const s = seedFour();
    s.select("c4");
    s.removeChapter("c4");
    expect(s.selected.value?.id).toBe("c3");
  });

  it("keeps selection valid after undo", () => {
    const s = seed();
    s.removeChapter("c1");
    s.undo();
    expect(s.book.value.chapters).toHaveLength(2);
    expect(s.selected.value?.id).toBe("c2");
    expect(s.book.value.chapters.some((chapter) => chapter.id === s.selected.value?.id)).toBe(true);
  });

  it("keeps the only chapter and its text when deleting it", () => {
    const s = seedSingle();
    const before = s.book.value;

    s.removeChapter("only");

    expect(s.book.value).toBe(before);
    expect(s.book.value.chapters).toHaveLength(1);
    expect(s.book.value.chapters[0].lines).toEqual(["正文"]);
    expect(s.selected.value?.id).toBe("only");
    expect(s.canUndo.value).toBe(false);
  });

  it("ignores deleting an unknown chapter", () => {
    const s = seed();
    s.removeChapter("missing");
    expect(s.book.value.chapters).toHaveLength(2);
    expect(s.canUndo.value).toBe(false);
  });

  it("removes volumes left without chapters", () => {
    const s = useBookSession();
    s.loadBook(
      META,
      {
        volumes: [
          { id: "v1", title: "第一卷", kind: "volume" },
          { id: "v2", title: "第二卷", kind: "volume" },
        ],
        chapters: [
          { id: "c1", title: "一", kind: "chapter", lines: ["a"], volumeId: "v1" },
          { id: "c2", title: "二", kind: "chapter", lines: ["b"], volumeId: "v1" },
          { id: "c3", title: "三", kind: "chapter", lines: ["c"], volumeId: "v2" },
        ],
      },
      "书",
    );

    s.select("c3");
    s.removeChapter("c3");

    expect(s.book.value.volumes.map((volume) => volume.id)).toEqual(["v1"]);
    expect(s.selected.value?.id).toBe("c2");
  });

  it("keeps a volume that still has volume lines", () => {
    const s = useBookSession();
    s.loadBook(
      META,
      {
        volumes: [{ id: "v1", title: "第一卷", kind: "volume", lines: ["卷首正文"] }],
        chapters: [
          { id: "c1", title: "一", kind: "chapter", lines: ["a"], volumeId: "v1" },
          { id: "c2", title: "二", kind: "chapter", lines: ["b"], volumeId: null },
        ],
      },
      "书",
    );

    s.select("c1");
    s.removeChapter("c1");

    expect(s.book.value.volumes.map((volume) => volume.id)).toEqual(["v1"]);
    expect(s.book.value.volumes[0].lines).toEqual(["卷首正文"]);
  });

  it("prunes a volume that has neither chapters nor non-empty lines", () => {
    const s = useBookSession();
    s.loadBook(
      META,
      {
        volumes: [
          { id: "v1", title: "第一卷", kind: "volume", lines: ["", "  "] },
          { id: "v2", title: "第二卷", kind: "volume", lines: ["保留"] },
        ],
        chapters: [
          { id: "c1", title: "一", kind: "chapter", lines: ["a"], volumeId: "v1" },
          { id: "c2", title: "二", kind: "chapter", lines: ["b"], volumeId: "v2" },
          { id: "c3", title: "三", kind: "chapter", lines: ["c"], volumeId: null },
        ],
      },
      "书",
    );

    s.select("c1");
    s.removeChapter("c1");

    expect(s.book.value.volumes.map((volume) => volume.id)).toEqual(["v2"]);
  });

  it("renames a chapter and records the original title", () => {
    const s = seed();
    s.rename("c1", "新的第一章");
    expect(s.book.value.chapters[0].title).toBe("新的第一章");
    expect(s.book.value.chapters[0].originalTitle).toBe("一");
    expect(s.canUndo.value).toBe(true);
  });

  it("ignores renaming an unknown chapter", () => {
    const s = seed();
    s.rename("missing", "无效");
    expect(s.canUndo.value).toBe(false);
    expect(s.book.value.chapters[0].title).toBe("一");
  });

  it("selects a volume and clears the chapter selection", () => {
    const s = seed();
    expect(s.selectedVolumeId.value).toBeNull();

    s.selectVolume("v1");

    expect(s.selectedVolumeId.value).toBe("v1");
    expect(s.selectedVolume.value?.id).toBe("v1");
    expect(s.selectedId.value).toBeNull();
    expect(s.selected.value).toBeNull();
  });

  it("clears the volume selection when a chapter is selected", () => {
    const s = seed();
    s.selectVolume("v1");

    s.select("c2");

    expect(s.selectedVolumeId.value).toBeNull();
    expect(s.selectedVolume.value).toBeNull();
    expect(s.selected.value?.id).toBe("c2");
  });

  it("clears the volume selection when selecting null", () => {
    const s = seed();
    s.selectVolume("v1");

    s.select(null);

    expect(s.selectedVolumeId.value).toBeNull();
    expect(s.selectedVolume.value).toBeNull();
    expect(s.selectedId.value).toBe("c1");
  });

  it("ignores selecting an unknown volume", () => {
    const s = seed();
    s.select("c2");

    s.selectVolume("missing");

    expect(s.selectedVolumeId.value).toBeNull();
    expect(s.selected.value?.id).toBe("c2");
  });

  it("clears the selected volume after it is deleted and selects a chapter", () => {
    const s = seed();
    s.selectVolume("v1");

    s.removeVolume("v1");

    expect(s.selectedVolume.value).toBeNull();
    expect(s.selectedVolumeId.value).toBeNull();
    expect(s.selected.value?.id).toBe("c1");
  });

  it("restores the volume selection when its deletion is undone", () => {
    const s = seed();
    s.selectVolume("v1");
    s.removeVolume("v1");

    s.undo();

    expect(s.book.value.volumes.map((volume) => volume.id)).toEqual(["v1"]);
    expect(s.selectedVolume.value?.id).toBe("v1");
  });

  it("removes a volume and promotes its chapters", () => {
    const s = seed();
    s.removeVolume("v1");
    expect(s.book.value.volumes).toHaveLength(0);
    expect(s.book.value.chapters.map((chapter) => chapter.volumeId)).toEqual([null, null]);
    expect(s.canUndo.value).toBe(true);
  });

  it("ignores removing an unknown volume", () => {
    const s = seed();
    s.removeVolume("missing");
    expect(s.book.value.volumes).toHaveLength(1);
    expect(s.canUndo.value).toBe(false);
  });

  it("sets and clears the cover", () => {
    const s = seed();
    s.setCover(COVER);
    expect(s.book.value.cover).toBe(COVER);
    s.setCover(null);
    expect(s.book.value.cover).toBeNull();
  });

  it("does not snapshot setting the same cover", () => {
    const s = seed();
    s.setCover(COVER);
    s.setCover(COVER);
    s.undo();
    expect(s.book.value.cover).toBeNull();
    expect(s.canUndo.value).toBe(false);
  });

  it("updates metadata without touching chapters", () => {
    const s = seed();
    s.updateMeta({ author: "作者" });
    expect(s.book.value.meta.author).toBe("作者");
    expect(s.book.value.chapters).toHaveLength(2);
  });

  it("does not snapshot an empty metadata patch", () => {
    const s = seed();
    s.updateMeta({});
    expect(s.canUndo.value).toBe(false);
  });

  it("keeps history, cover and a user-edited title across loadBook", () => {
    const s = seed();
    s.updateMeta({ title: "我的书名" });
    s.setCover(COVER);

    s.loadBook(
      { title: "新书", author: "新作者", language: "zh-CN" },
      {
        volumes: [],
        chapters: [{ id: "n1", title: "新章", kind: "chapter", lines: ["新"], volumeId: null }],
      },
      "新书",
    );

    expect(s.book.value.meta.title).toBe("我的书名");
    expect(s.book.value.meta.author).toBe("新作者");
    expect(s.book.value.cover).toBe(COVER);
    expect(s.canUndo.value).toBe(true);

    s.undo();
    expect(s.book.value.meta.title).toBe("我的书名");
    expect(s.book.value.chapters[0].id).toBe("c1");
  });

  it("applies a new title until the user edits it", () => {
    const s = seed();
    s.loadBook(
      META,
      {
        volumes: [],
        chapters: [{ id: "n1", title: "新章", kind: "chapter", lines: ["新"], volumeId: null }],
      },
      "第二本",
    );
    expect(s.book.value.meta.title).toBe("第二本");

    s.updateMeta({ title: "自定义书名" });
    s.loadBook(
      META,
      {
        volumes: [],
        chapters: [{ id: "n2", title: "新章", kind: "chapter", lines: ["新"], volumeId: null }],
      },
      "第三本",
    );
    expect(s.book.value.meta.title).toBe("自定义书名");
  });

  it("restores the auto-title tracker on undo", () => {
    const s = seed();
    s.loadBook(
      META,
      {
        volumes: [],
        chapters: [{ id: "n1", title: "新章", kind: "chapter", lines: ["新"], volumeId: null }],
      },
      "第二本",
    );
    expect(s.book.value.meta.title).toBe("第二本");

    s.undo();
    expect(s.book.value.meta.title).toBe("书");

    s.loadBook(
      META,
      {
        volumes: [],
        chapters: [{ id: "n2", title: "新章", kind: "chapter", lines: ["新"], volumeId: null }],
      },
      "第三本",
    );
    expect(s.book.value.meta.title).toBe("第三本");
  });

  it("keeps at most 20 undo snapshots", () => {
    const s = seed();
    for (let index = 1; index <= 21; index += 1) {
      s.updateMeta({ author: `作者${index}` });
    }

    for (let index = 0; index < 20; index += 1) s.undo();

    expect(s.canUndo.value).toBe(false);
    expect(s.book.value.meta.author).toBe("作者1");
  });

  it("increments version on every committed change and undo", () => {
    const s = seed();
    const base = s.version.value;

    s.rename("c1", "改名");
    expect(s.version.value).toBe(base + 1);

    s.undo();
    expect(s.version.value).toBe(base + 2);

    // 找不到目标或删除唯一章节都不产生变更，也不应推进版本。
    const before = s.version.value;
    s.rename("missing", "无");
    expect(s.version.value).toBe(before);
  });

  it("keeps version stable when undo has no snapshot", () => {
    const s = seed();
    const before = s.version.value;

    s.undo();

    expect(s.version.value).toBe(before);
  });

  it("resets the book, history and selection while advancing version", () => {
    const s = seed();
    s.removeChapter("c1");
    expect(s.canUndo.value).toBe(true);
    const before = s.version.value;

    s.reset();

    expect(s.book.value.chapters).toEqual([]);
    expect(s.book.value.volumes).toEqual([]);
    expect(s.book.value.meta.title).toBe("");
    expect(s.selectedId.value).toBeNull();
    expect(s.canUndo.value).toBe(false);
    expect(s.version.value).toBe(before + 1);
  });

  it("stores and restores the book source with undo", () => {
    const session = useBookSession();
    session.loadBook(metaA, parsedA, "A");
    session.loadBook(metaB, parsedB, "B", { source: SOURCE });
    expect(session.book.value.source).toEqual(SOURCE);
    session.undo();
    expect(session.book.value.source).toBeNull();
  });

  it("clears the cover when cover: null is passed", () => {
    const session = useBookSession();
    session.loadBook(metaA, parsedA, "A", { cover: COVER });
    session.loadBook(metaB, parsedB, "B", { cover: null });
    expect(session.book.value.cover).toBeNull();
  });

  it("forceTitle overrides a user-edited title", () => {
    const session = useBookSession();
    session.loadBook(metaA, parsedA, "A");
    session.updateMeta({ title: "手改" });
    session.loadBook(metaB, parsedB, "calibre 标题", { forceTitle: true });
    expect(session.book.value.meta.title).toBe("calibre 标题");
  });

  it("addSourceFormat updates formats without a new undo entry", () => {
    const session = useBookSession();
    session.loadBook(metaA, parsedA, "A", { source: { ...SOURCE, formats: ["TXT"] } });
    const undoBefore = session.canUndo.value;
    session.addSourceFormat("EPUB");
    expect(session.book.value.source?.formats).toEqual(["TXT", "EPUB"]);
    expect(session.canUndo.value).toBe(undoBefore);
  });

  it("splits a chapter and undoes it", () => {
    const session = useBookSession();
    session.loadBook(
      META,
      {
        volumes: [],
        chapters: [
          { id: "c1", title: "第1章", kind: "chapter", lines: ["a", "b"], volumeId: null },
        ],
      },
      "书",
    );
    expect(session.splitChapter("c1", 1, { title: "第2章", dropLine: false })).toBe(true);
    expect(session.book.value.chapters).toHaveLength(2);
    expect(session.book.value.chapters[1].lines).toEqual(["b"]);
    expect(session.canUndo.value).toBe(true);
    session.undo();
    expect(session.book.value.chapters).toHaveLength(1);
  });

  it("rejects an invalid split without creating an undo entry", () => {
    const session = useBookSession();
    session.loadBook(
      META,
      {
        volumes: [],
        chapters: [
          { id: "c1", title: "第1章", kind: "chapter", lines: ["a", "b"], volumeId: null },
        ],
      },
      "书",
    );
    expect(session.splitChapter("c1", 0)).toBe(false);
    expect(session.book.value.chapters).toHaveLength(1);
    expect(session.canUndo.value).toBe(false);
  });
});
