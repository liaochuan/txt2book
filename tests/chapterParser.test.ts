import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseChapters } from "../src/core/chapterParser";
import type { ChapterRule } from "../src/core/customRules";

const lines = readFileSync(join(__dirname, "fixtures/structured.txt"), "utf8").split(/\r?\n/);

function rule(overrides: Partial<ChapterRule> = {}): ChapterRule {
  return {
    id: "rule-1",
    label: "自定义规则",
    pattern: "^自定义",
    enabled: true,
    kind: "chapter",
    ...overrides,
  };
}

describe("parseChapters", () => {
  const book = parseChapters(lines, "zh-CN");

  it("creates an intro chapter before the first title", () => {
    expect(book.chapters[0].kind).toBe("intro");
    expect(book.chapters[0].title).toBe("简介");
  });

  it("recognizes volumes and assigns chapters to them", () => {
    expect(book.volumes.map((v) => v.title)).toEqual(["第一卷 风起", "第二卷 云涌", "番外"]);
    const ch = book.chapters.find((c) => c.title === "第一章 重逢")!;
    expect(ch.volumeId).toBe(book.volumes[0].id);
  });

  it("moves extras into a trailing extra group", () => {
    const extras = book.chapters.filter((c) => c.kind === "extra");
    expect(extras.map((c) => c.title)).toEqual(["番外篇 小满"]);
    expect(extras[0].volumeId).toBe(book.volumes.at(-1)!.id);
    expect(book.volumes.at(-1)!.kind).toBe("extra-group");
  });

  it("does not treat prose lines as titles", () => {
    const titles = book.chapters.map((c) => c.title);
    expect(titles.some((t) => t.startsWith("卷顊佹"))).toBe(false);
    expect(titles.some((t) => t.startsWith("序辦腊"))).toBe(false);
    expect(titles.some((t) => t.startsWith("番外篇的正文"))).toBe(false);
  });

  it("marks prologue and epilogue kinds", () => {
    expect(book.chapters.find((c) => c.title === "楔子")!.kind).toBe("prologue");
    expect(book.chapters.find((c) => c.title === "尾声")!.kind).toBe("epilogue");
  });

  it("falls back to a single chapter when nothing matches", () => {
    const single = parseChapters(["只有正文", "没有标题"], "zh-CN");
    expect(single.chapters).toHaveLength(1);
    expect(single.chapters[0].title).toBe("正文");
  });

  it("recognizes numbered extras and side-story aliases", () => {
    const parsed = parseChapters(["番外一", "正文甲", "外传：某某", "正文乙"], "zh-CN");
    expect(parsed.chapters.filter((c) => c.kind === "extra").map((c) => c.title)).toEqual([
      "番外一",
      "外传：某某",
    ]);
  });

  it("recognizes 上部/中部/下部 as volumes", () => {
    const parsed = parseChapters(["上部 少年", "第一章 一", "正文"], "zh-CN");
    expect(parsed.volumes.map((v) => v.title)).toEqual(["上部 少年"]);
    expect(parsed.chapters[0].volumeId).toBe(parsed.volumes[0].id);
  });

  it("still parses the two legacy fixtures", () => {
    for (const name of ["测试小说_001.txt", "测试小说_002.txt"]) {
      const text = readFileSync(join(__dirname, "fixtures", name), "utf8");
      const parsed = parseChapters(text.split(/\r?\n/), "zh-CN");
      expect(parsed.chapters.length).toBeGreaterThan(1);
    }
  });

  it("keeps extras at the very end of chapters", () => {
    expect(book.chapters.at(-1)!.kind).toBe("extra");
  });

  it("stores volume preamble lines on the volume", () => {
    const parsed = parseChapters(["第一卷 风起", "本卷讲述……", "第一章 重逢", "正文"], "zh-CN");
    expect(parsed.volumes[0].lines).toEqual(["本卷讲述……"]);
    expect(parsed.chapters.find((c) => c.title === "第一章 重逢")!.lines).toEqual(["正文"]);
  });

  it("omits volume.lines when the volume has no preamble", () => {
    const parsed = parseChapters(["第一卷 风起", "第一章 重逢", "正文"], "zh-CN");
    expect(parsed.volumes[0].lines).toBeUndefined();
  });

  it("accepts 40-char titles and rejects 41-char titles", () => {
    const at40 = "第一章 " + "字".repeat(36);
    const at41 = "第一章 " + "字".repeat(37);
    expect(parseChapters([at40, "正文"], "zh-CN").chapters.map((c) => c.title)).toEqual([at40]);
    const fallback = parseChapters([at41, "正文"], "zh-CN");
    expect(fallback.chapters).toHaveLength(1);
    expect(fallback.chapters[0].title).toBe("正文");
  });

  it("returns nothing for blank input", () => {
    expect(parseChapters([], "zh-CN")).toEqual({ volumes: [], chapters: [] });
    expect(parseChapters(["", "  ", "\u3000"], "zh-CN")).toEqual({ volumes: [], chapters: [] });
  });

  it("recognizes compact and alternate chapter forms", () => {
    const titles = ["第一章重逢", "第一章——重逢", "第壹章 开端", "第一回 甄士隐梦幻识通灵"];
    for (const title of titles) {
      expect(parseChapters([title, "正文"], "zh-CN").chapters.map((c) => c.title)).toEqual([title]);
    }
  });
});

describe("parseChapters with user rules", () => {
  it("lets user rules win over built-in patterns", () => {
    const parsed = parseChapters(["楔子", "正文"], "zh-CN", [
      rule({ pattern: "^楔子$", kind: "chapter" }),
    ]);
    expect(parsed.chapters).toHaveLength(1);
    expect(parsed.chapters[0].kind).toBe("chapter");
  });

  it("uses the rule kind for extras", () => {
    const parsed = parseChapters(["番外 小满", "正文"], "zh-CN", [
      rule({ pattern: "^番外", kind: "extra" }),
    ]);
    expect(parsed.chapters[0].kind).toBe("extra");
    expect(parsed.volumes.at(-1)!.kind).toBe("extra-group");
    expect(parsed.chapters[0].volumeId).toBe(parsed.volumes.at(-1)!.id);
  });

  it("skips disabled rules", () => {
    const parsed = parseChapters(["自定义标题", "正文"], "zh-CN", [
      rule({ enabled: false }),
    ]);
    expect(parsed.chapters).toHaveLength(1);
    expect(parsed.chapters[0].title).toBe("正文");
  });

  it("ignores rules with an invalid regex", () => {
    const parsed = parseChapters(["第一章 开端", "正文"], "zh-CN", [
      rule({ pattern: "(", kind: "extra" }),
    ]);
    expect(parsed.chapters).toHaveLength(1);
    expect(parsed.chapters[0].kind).toBe("chapter");
  });

  it("creates a volume when a user rule declares kind volume", () => {
    const parsed = parseChapters(["Book One", "第一章 一", "正文"], "zh-CN", [
      rule({ pattern: "^Book One$", kind: "volume" }),
    ]);
    expect(parsed.volumes.map((v) => v.title)).toEqual(["Book One"]);
    expect(parsed.chapters[0].volumeId).toBe(parsed.volumes[0].id);
  });

  it("uses the configured capture group as the title", () => {
    const parsed = parseChapters(["第1章 开端", "正文"], "zh-CN", [
      rule({ pattern: "^第(\\d+)章\\s*(.*)$", capture: 2 }),
    ]);
    expect(parsed.chapters[0].title).toBe("开端");
  });

  it("falls back to the whole line when the capture group is missing", () => {
    const parsed = parseChapters(["第1章 开端", "正文"], "zh-CN", [
      rule({ pattern: "^(第\\d+章)", capture: 2 }),
    ]);
    expect(parsed.chapters[0].title).toBe("第1章 开端");
  });
});
