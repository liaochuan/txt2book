import { describe, expect, it } from "vitest";
import { createHistory, deleteChapter, deleteVolume, renameChapter } from "../src/core/chapterOps";
import type { BookModel } from "../src/types/book";

function book(): BookModel {
  return {
    meta: { title: "书", author: "", language: "zh-CN" },
    volumes: [
      { id: "v1", title: "第一卷", kind: "volume" },
      { id: "v2", title: "第二卷", kind: "volume" },
    ],
    chapters: [
      { id: "c1", title: "一", kind: "chapter", lines: ["a"], volumeId: "v1" },
      { id: "c2", title: "二", kind: "chapter", lines: ["b"], volumeId: "v1" },
      { id: "c3", title: "三", kind: "chapter", lines: ["c"], volumeId: "v2" },
      { id: "c4", title: "四", kind: "chapter", lines: ["d"], volumeId: "v2" },
    ],
    cover: null,
  };
}

describe("deleteChapter", () => {
  it("appends the removed body to the previous chapter", () => {
    const next = deleteChapter(book(), "c3");
    expect(next.chapters.map((c) => c.id)).toEqual(["c1", "c2", "c4"]);
    expect(next.chapters[1].lines).toEqual(["b", "", "c"]);
  });

  it("merges the first chapter into the next one", () => {
    const next = deleteChapter(book(), "c1");
    expect(next.chapters[0].lines).toEqual(["a", "", "b"]);
    expect(next.chapters[0].title).toBe("二");
  });

  it("refuses to delete the only chapter", () => {
    const one = book();
    one.chapters = [one.chapters[0]];
    expect(deleteChapter(one, "c1").chapters).toHaveLength(1);
  });

  it("does not mutate the input", () => {
    const original = book();
    const next = deleteChapter(original, "c2");
    expect(original.chapters[0].lines).toEqual(["a"]);
    expect(original.chapters[1].lines).toEqual(["b"]);
    expect(next.chapters).not.toBe(original.chapters);
  });

  it("does not insert a separator when the removed body is empty", () => {
    const original = book();
    original.chapters[1].lines = [];
    const next = deleteChapter(original, "c2");
    expect(next.chapters[0].lines).toEqual(["a"]);
    expect(next.chapters[1].lines).toEqual(["c"]);
  });

  it("does not insert a separator when the previous body is empty", () => {
    const original = book();
    original.chapters[0].lines = [];
    const next = deleteChapter(original, "c2");
    expect(next.chapters[0].lines).toEqual(["b"]);
  });

  it("does not insert a separator when merging the first chapter into an empty next chapter", () => {
    const original = book();
    original.chapters[1].lines = [];
    const next = deleteChapter(original, "c1");
    expect(next.chapters[0].lines).toEqual(["a"]);
  });

  it("returns an equivalent book when the chapter is unknown", () => {
    const original = book();
    const next = deleteChapter(original, "missing");
    expect(next.chapters.map((c) => c.id)).toEqual(["c1", "c2", "c3", "c4"]);
  });
});

describe("deleteVolume", () => {
  it("promotes children and drops the volume", () => {
    const next = deleteVolume(book(), "v1");
    expect(next.volumes.map((v) => v.id)).toEqual(["v2"]);
    expect(next.chapters.slice(0, 2).every((c) => c.volumeId === null)).toBe(true);
  });

  it("prepends the volume lines to the first promoted chapter", () => {
    const original = book();
    original.volumes[0].lines = ["卷首正文"];
    const next = deleteVolume(original, "v1");
    expect(next.chapters[0].lines).toEqual(["卷首正文", "", "a"]);
    expect(next.chapters[1].lines).toEqual(["b"]);
    expect(original.chapters[0].lines).toEqual(["a"]);
  });

  it("prepends the volume lines to the first chapter after a childless volume", () => {
    const original = book();
    original.volumes[0].lines = ["卷首正文"];
    original.chapters = original.chapters.slice(2);
    const next = deleteVolume(original, "v1");
    expect(next.volumes.map((v) => v.id)).toEqual(["v2"]);
    expect(next.chapters.map((c) => c.id)).toEqual(["c3", "c4"]);
    expect(next.chapters[0].lines).toEqual(["卷首正文", "", "c"]);
    expect(next.chapters[1].lines).toEqual(["d"]);
    expect(original.chapters[0].lines).toEqual(["c"]);
  });

  it("appends the volume lines to the last chapter when a childless volume is last", () => {
    const original = book();
    original.volumes[1].lines = ["卷首正文"];
    original.chapters[2].volumeId = "v1";
    original.chapters[3].volumeId = "v1";
    const next = deleteVolume(original, "v2");
    expect(next.volumes.map((v) => v.id)).toEqual(["v1"]);
    expect(next.chapters[1].lines).toEqual(["b"]);
    expect(next.chapters[3].lines).toEqual(["d", "", "卷首正文"]);
  });

  it("creates an intro chapter when deleting the last volume and its text", () => {
    const original = book();
    original.volumes = [{ id: "v1", title: "第一卷", kind: "volume", lines: ["卷首正文"] }];
    original.chapters = [];
    const next = deleteVolume(original, "v1");
    expect(next.volumes).toEqual([]);
    expect(next.chapters).toHaveLength(1);
    expect(next.chapters[0].id).toBeTruthy();
    expect(next.chapters[0].title).toBe("第一卷");
    expect(next.chapters[0].kind).toBe("intro");
    expect(next.chapters[0].lines).toEqual(["卷首正文"]);
    expect(next.chapters[0].volumeId).toBeNull();
  });

  it("does not insert a separator when the first promoted chapter has no body", () => {
    const original = book();
    original.volumes[0].lines = ["卷首正文"];
    original.chapters[0].lines = [];
    const next = deleteVolume(original, "v1");
    expect(next.chapters[0].lines).toEqual(["卷首正文"]);
  });

  it("does not create a chapter when a childless volume has no text", () => {
    const original = book();
    original.volumes = [{ id: "v1", title: "第一卷", kind: "volume" }];
    original.chapters = [];
    const next = deleteVolume(original, "v1");
    expect(next.volumes).toEqual([]);
    expect(next.chapters).toEqual([]);
  });

  it("does not mutate the input", () => {
    const original = book();
    deleteVolume(original, "v2");
    expect(original.volumes.map((v) => v.id)).toEqual(["v1", "v2"]);
    expect(original.chapters.map((c) => c.volumeId)).toEqual(["v1", "v1", "v2", "v2"]);
  });
});

describe("renameChapter", () => {
  it("keeps originalTitle", () => {
    const next = renameChapter(book(), "c1", "新名字");
    expect(next.chapters[0].title).toBe("新名字");
    expect(next.chapters[0].originalTitle).toBe("一");
  });
});

describe("history", () => {
  it("undoes the last snapshot", () => {
    const h = createHistory(20);
    const before = book();
    h.push(before);
    const after = deleteChapter(before, "c2");
    expect(after.chapters).toHaveLength(3);
    expect(h.canUndo()).toBe(true);
    expect(h.undo()).toBe(before);
    expect(h.canUndo()).toBe(false);
  });

  it("caps the number of snapshots", () => {
    const h = createHistory(2);
    const a = book();
    a.meta.title = "A";
    const b = book();
    b.meta.title = "B";
    const c = book();
    c.meta.title = "C";
    h.push(a);
    h.push(b);
    h.push(c);
    expect(h.undo()).toBe(c);
    expect(h.undo()).toBe(b);
    expect(h.undo()).toBeNull();
    expect(h.canUndo()).toBe(false);
  });
});
