import { describe, expect, it } from "vitest";
import { useBookSession } from "../src/composables/useBookSession";
import { useImport } from "../src/composables/useImport";
import type { ChapterRule } from "../src/core/customRules";

const GB18030_SAMPLE = new Uint8Array([
  0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 0x20, 0xbf, 0xaa, 0xca, 0xbc, 0x0a, 0xd5, 0xfd, 0xce,
  0xc4,
]);

function utf8Bytes(content: string): Uint8Array {
  return new TextEncoder().encode(content);
}

const CUSTOM_RULE: ChapterRule = {
  id: "r1",
  label: "自定义章节",
  pattern: "^自定义.*$",
  enabled: true,
  kind: "chapter",
};

describe("useImport", () => {
  it("imports a utf-8 file and fills the book", async () => {
    const session = useBookSession();
    const imp = useImport(session);
    const file = new File(["第一章 开始\n正文"], "a.txt", { type: "text/plain" });

    await imp.importFile(file, "auto");

    expect(session.book.value.chapters[0].title).toBe("第一章 开始");
    expect(session.book.value.meta.title).toBe("a");
    expect(imp.fileName.value).toBe("a.txt");
    expect(imp.busy.value).toBe(false);
    expect(imp.error.value).toBe("");
  });

  it("re-decodes with a manually selected encoding", async () => {
    const file = new File([GB18030_SAMPLE], "b.txt");
    const imp = useImport(useBookSession());

    await imp.importFile(file, "gb18030");

    expect(imp.usedEncoding.value.toLowerCase()).toContain("gb18030");
    expect(imp.detectedEncoding.value).toBeNull();
  });

  it("records the detected encoding when decoding automatically", async () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8Bytes("第一章 开始\n正文")]);
    const imp = useImport(useBookSession());

    await imp.importFile(new File([bom], "bom.txt"), "auto");

    expect(imp.detectedEncoding.value).toBe("UTF-8");
    expect(imp.usedEncoding.value.toLowerCase()).toBe("utf-8");
  });

  it("keeps the file name without its last extension as the book title", async () => {
    const session = useBookSession();
    const imp = useImport(session);

    await imp.importFile(new File(["正文"], "我的.小说.v2.txt"), "utf-8");

    expect(imp.fileName.value).toBe("我的.小说.v2.txt");
    expect(session.book.value.meta.title).toBe("我的.小说.v2");
  });

  it("uses the current rules when importing", async () => {
    const session = useBookSession();
    const imp = useImport(session);
    imp.rules.value = [CUSTOM_RULE];

    await imp.importFile(new File(["自定义章节\n内容"], "rules.txt"), "utf-8");

    expect(session.book.value.chapters.map((chapter) => chapter.title)).toEqual(["自定义章节"]);
  });

  it("re-decodes the stored bytes and updates chapters without replacing them", async () => {
    const session = useBookSession();
    const imp = useImport(session);
    await imp.importFile(new File([GB18030_SAMPLE], "c.txt"), "utf-8");
    const bytes = imp.rawBytes.value;

    expect(session.book.value.chapters.map((chapter) => chapter.title)).toEqual(["正文"]);

    await imp.reparse("gb18030", []);

    expect(imp.rawBytes.value).toBe(bytes);
    expect(imp.usedEncoding.value.toLowerCase()).toContain("gb18030");
    expect(session.book.value.chapters[0].title).toBe("第一章 开始");
    expect(session.book.value.chapters[0].lines).toEqual(["正文"]);
  });

  it("applies the rules passed to reparse and exposes them", async () => {
    const session = useBookSession();
    const imp = useImport(session);
    await imp.importFile(new File(["自定义章节\n内容"], "d.txt"), "utf-8");

    await imp.reparse("utf-8", [CUSTOM_RULE]);

    expect(imp.rules.value).toEqual([CUSTOM_RULE]);
    expect(session.book.value.chapters.map((chapter) => chapter.title)).toEqual(["自定义章节"]);
  });

  it("keeps a user-edited title across reparse", async () => {
    const session = useBookSession();
    const imp = useImport(session);
    await imp.importFile(new File(["第一章 开始\n正文"], "e.txt"), "utf-8");
    session.updateMeta({ title: "我的书名" });

    await imp.reparse("utf-8", []);

    expect(session.book.value.meta.title).toBe("我的书名");
  });

  it("keeps author, description and language across reparse", async () => {
    const session = useBookSession();
    const imp = useImport(session);
    await imp.importFile(new File(["第一章 开始\n正文"], "g.txt"), "utf-8");
    session.updateMeta({ author: "某作者", description: "一段简介", language: "en" });

    await imp.reparse("utf-8", []);

    expect(session.book.value.meta.author).toBe("某作者");
    expect(session.book.value.meta.description).toBe("一段简介");
    expect(session.book.value.meta.language).toBe("en");
    // 自动书名规则保持不变。
    expect(session.book.value.meta.title).toBe("g");
  });

  it("reports a read failure in Chinese and clears busy", async () => {
    const session = useBookSession();
    const imp = useImport(session);
    const broken = {
      name: "bad.txt",
      arrayBuffer: () => Promise.reject(new Error("boom")),
    } as unknown as File;

    await imp.importFile(broken, "auto");

    expect(imp.error.value).not.toBe("");
    expect(imp.error.value).toMatch(/[\u4e00-\u9fa5]/);
    expect(imp.busy.value).toBe(false);
    expect(session.hasBook.value).toBe(false);
  });

  it("rejects an empty file without replacing the loaded book", async () => {
    const session = useBookSession();
    const imp = useImport(session);
    await imp.importFile(new File(["第一章 开始\n正文"], "f.txt"), "utf-8");

    await imp.importFile(new File([], "empty.txt"), "utf-8");

    expect(imp.error.value).not.toBe("");
    expect(imp.busy.value).toBe(false);
    expect(imp.fileName.value).toBe("f.txt");
    expect(session.book.value.chapters).toHaveLength(1);
    expect(session.book.value.chapters[0].title).toBe("第一章 开始");
  });

  it("asks for a file first when reparsing without bytes", async () => {
    const imp = useImport(useBookSession());

    await imp.reparse("auto", []);

    expect(imp.error.value).not.toBe("");
    expect(imp.busy.value).toBe(false);
    expect(imp.usedEncoding.value).toBe("");
  });

  it("stays busy while reading and ignores a concurrent import", async () => {
    const session = useBookSession();
    const imp = useImport(session);
    let release: (buffer: ArrayBuffer) => void = () => {};
    const gate = new Promise<ArrayBuffer>((resolve) => {
      release = resolve;
    });
    const pending = {
      name: "a.txt",
      arrayBuffer: () => gate,
    } as unknown as File;

    const first = imp.importFile(pending, "utf-8");
    expect(imp.busy.value).toBe(true);

    await imp.importFile(new File(["第二章 其他\n正文"], "other.txt"), "utf-8");
    expect(imp.busy.value).toBe(true);

    release(utf8Bytes("第一章 开始\n正文").buffer as ArrayBuffer);
    await first;

    expect(imp.busy.value).toBe(false);
    expect(imp.fileName.value).toBe("a.txt");
    expect(session.book.value.chapters[0].title).toBe("第一章 开始");
  });
});
