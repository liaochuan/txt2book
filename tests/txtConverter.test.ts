import { describe, expect, it } from "vitest";
import { buildTxt, txtConverter } from "../src/core/converters/txt";
import type { BookModel } from "../src/types/book";

const book: BookModel = {
  meta: { title: "测试书", author: "作者甲", language: "zh-CN", description: "简介文字" },
  volumes: [
    { id: "v1", title: "第一卷 风起", kind: "volume", lines: ["卷首语"] },
    { id: "v2", title: "番外", kind: "extra-group" },
  ],
  chapters: [
    { id: "c0", title: "简介", kind: "intro", lines: ["这是简介。"], volumeId: null },
    {
      id: "c1",
      title: "第一章 重逢",
      kind: "chapter",
      lines: ["正文一第一段。", "", "", "正文一第二段。   "],
      volumeId: "v1",
    },
    { id: "c2", title: "第二章 别离", kind: "chapter", lines: ["正文二"], volumeId: "v1" },
    { id: "c3", title: "番外一", kind: "extra", lines: ["正文三"], volumeId: "v2" },
  ],
  cover: null,
};

describe("buildTxt", () => {
  it("writes intro, volumes, chapters and extra group in reading order", async () => {
    const text = await (
      await buildTxt(book, {
        formatOptions: { includeIntro: true, includeVolumeTitles: true },
      })
    ).text();

    const order = ["这是简介。", "第一卷 风起", "第一章 重逢", "第二章 别离", "番外", "番外一"];
    const positions = order.map((item) => text.indexOf(item));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);

    // 番外分组标题只出现一次，且不重复输出章节里的“番外”。
    expect(text.match(/^番外$/gm)).toHaveLength(1);
  });

  it("collapses blank lines, trims line ends and ends with a single newline", async () => {
    const text = await (await buildTxt(book, { formatOptions: { includeIntro: true } })).text();

    expect(text).not.toMatch(/\n{3,}/);
    expect(text).not.toMatch(/[ \t]+\n/);
    expect(text.startsWith("\n")).toBe(false);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(text).toContain("\n第一章 重逢\n\n正文一第一段。\n\n正文一第二段。\n");
  });

  it("omits the intro chapter when includeIntro is false", async () => {
    const text = await (
      await buildTxt(book, {
        formatOptions: {
          includeIntro: false,
          includeVolumeTitles: true,
        },
      })
    ).text();

    expect(text).not.toContain("这是简介。");
    expect(text).not.toMatch(/^简介$/m);
    expect(text).toContain("第一章 重逢");
  });

  it("omits volume titles and the extra group heading when includeVolumeTitles is false", async () => {
    const text = await (
      await buildTxt(book, { formatOptions: { includeIntro: true, includeVolumeTitles: false } })
    ).text();

    expect(text).not.toContain("第一卷 风起");
    expect(text).not.toMatch(/^番外$/m);
    expect(text).toContain("第一章 重逢");
    expect(text).toContain("番外一");
  });

  it("never writes a title page", async () => {
    const text = await (await buildTxt(book)).text();
    expect(text.startsWith("测试书")).toBe(false);
    expect(text).not.toContain("作者甲");
  });

  it("includes intro, volume titles and volume lines by default", async () => {
    const text = await (await buildTxt(book)).text();

    expect(text).toContain("这是简介。");
    expect(text).toContain("第一卷 风起");
    expect(text).toContain("卷首语");
    expect(text.indexOf("这是简介。")).toBeLessThan(text.indexOf("第一卷 风起"));
  });

  it("includes the book description when includeDescription is true", async () => {
    const described: BookModel = {
      ...book,
      meta: { ...book.meta, description: "简介第一段。\n\n\n简介第二段。   " },
    };

    const text = await (await buildTxt(described, { includeDescription: true })).text();

    expect(text).toMatch(/简介\n\n简介第一段。\n\n简介第二段。/);
    expect(text.indexOf("简介第一段。")).toBeLessThan(text.indexOf("第一卷 风起"));
    expect(text).not.toMatch(/\n{3,}/);
  });

  it("omits the book description by default and when includeDescription is false", async () => {
    expect((await (await buildTxt(book)).text())).not.toContain("简介文字");

    const text = await (await buildTxt(book, { includeDescription: false })).text();
    expect(text).not.toContain("简介文字");
  });

  it("writes no description heading when the book has no description", async () => {
    const noDescription: BookModel = {
      meta: { ...book.meta, description: "   " },
      volumes: [book.volumes[0]],
      chapters: [
        { id: "c1", title: "第一章 重逢", kind: "chapter", lines: ["正文一"], volumeId: "v1" },
      ],
      cover: null,
    };

    const text = await (await buildTxt(noDescription, { includeDescription: true })).text();

    expect(text).not.toMatch(/^简介$/m);
    expect(text).toContain("第一章 重逢");
  });

  it("parses string booleans with surrounding whitespace and casing", async () => {
    const text = await (
      await buildTxt(book, {
        formatOptions: { includeIntro: " false ", includeVolumeTitles: "FALSE" },
      })
    ).text();

    expect(text).not.toContain("这是简介。");
    expect(text).not.toContain("第一卷 风起");
    expect(text).not.toContain("卷首语");
  });

  it("keeps zero-chapter volume blocks before the next chapter and at the end", async () => {
    const withEmptyVolumes: BookModel = {
      meta: book.meta,
      volumes: [
        { id: "v0", title: "楔子卷", kind: "volume", lines: ["楔子卷首文字"] },
        { id: "v1", title: "第一卷 风起", kind: "volume" },
        { id: "v2", title: "尾声卷", kind: "volume", lines: ["尾声卷首文字"] },
      ],
      chapters: [
        { id: "c1", title: "第一章 重逢", kind: "chapter", lines: ["正文一"], volumeId: "v1" },
      ],
      cover: null,
    };

    const text = await (await buildTxt(withEmptyVolumes)).text();
    const order = ["楔子卷", "楔子卷首文字", "第一卷 风起", "第一章 重逢", "尾声卷", "尾声卷首文字"];
    const positions = order.map((item) => text.indexOf(item));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(text.match(/^楔子卷$/gm)).toHaveLength(1);
    expect(text.match(/^尾声卷$/gm)).toHaveLength(1);
  });

  it("writes a book without volumes in chapter order", async () => {
    const noVolumes: BookModel = {
      meta: book.meta,
      volumes: [],
      chapters: [
        { id: "n0", title: "简介", kind: "intro", lines: ["无卷简介。"], volumeId: null },
        { id: "n1", title: "第一章", kind: "chapter", lines: ["无卷正文。"], volumeId: null },
      ],
      cover: null,
    };

    const text = await (await buildTxt(noVolumes)).text();

    expect(text).toContain("无卷简介。");
    expect(text.indexOf("无卷简介。")).toBeLessThan(text.indexOf("第一章"));
    expect(text).toContain("无卷正文。");
  });

  it("outputs a single newline for an empty book", async () => {
    const empty: BookModel = {
      meta: { ...book.meta, description: undefined },
      volumes: [],
      chapters: [],
      cover: null,
    };

    const blob = await buildTxt(empty);

    expect(await blob.text()).toBe("\n");
    expect(blob.type).toBe("text/plain;charset=utf-8");
  });

  it("outputs utf-8 text without a BOM", async () => {
    const blob = await buildTxt(book);

    expect(blob.type).toBe("text/plain;charset=utf-8");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(blob.size).toBeGreaterThan(0);
  });

  it("exposes txt converter metadata and defaults", () => {
    expect(txtConverter).toMatchObject({
      id: "txt",
      label: "TXT",
      extension: "txt",
      mimeType: "text/plain;charset=utf-8",
      available: true,
      runtime: "browser",
    });
    expect(txtConverter.options).toEqual([
      expect.objectContaining({ key: "includeIntro", type: "boolean", defaultValue: true }),
      expect.objectContaining({ key: "includeVolumeTitles", type: "boolean", defaultValue: true }),
    ]);

    expect(txtConverter.options?.map((option) => option.key)).toEqual([
      "includeIntro",
      "includeVolumeTitles",
    ]);
    expect(txtConverter.options?.[1]?.hint).toContain("卷标题与卷首文字都不输出");
  });
});
