import { describe, expect, it } from "vitest";
import {
  analyzeChapters,
  analyzeContinuity,
  chapterNumberOf,
  findSuspectedHeadings,
  isSuspectedHeadingLine,
} from "../src/core/chapterAnalysis";
import type { Chapter } from "../src/types/book";

function ch(
  id: string,
  title: string,
  lines: string[] = ["正文"],
  volumeId: string | null = null,
): Chapter {
  return { id, title, kind: "chapter", lines, volumeId };
}

describe("chapterNumberOf", () => {
  it("parses arabic and chinese numerals", () => {
    expect(chapterNumberOf("第7章 啊？神器？")).toBe(7);
    expect(chapterNumberOf("第七章 重逢")).toBe(7);
    expect(chapterNumberOf("第147章 大远征")).toBe(147);
    expect(chapterNumberOf("第十三章 归来")).toBe(13);
    expect(chapterNumberOf("Chapter 12")).toBe(12);
    expect(chapterNumberOf("番外 一")).toBeNull();
    expect(chapterNumberOf("插图")).toBeNull();
  });

  it("parses uppercase hundreds and thousands", () => {
    expect(chapterNumberOf("第壹佰章 开端")).toBe(100);
    expect(chapterNumberOf("第壹仟章 终局")).toBe(1000);
  });
});

describe("analyzeContinuity", () => {
  it("reports missing numbers", () => {
    const issues = analyzeContinuity([
      ch("a", "第1章 一"),
      ch("b", "第3章 三"),
      ch("c", "第4章 四"),
    ]);
    expect(issues.map((issue) => issue.kind)).toEqual(["gap"]);
    expect(issues[0].message).toContain("第2章");
  });

  it("reports duplicates and out-of-order chapters", () => {
    const issues = analyzeContinuity([
      ch("a", "第1章 一"),
      ch("b", "第3章 三"),
      ch("c", "第2章 二"),
      ch("d", "第3章 三"),
    ]);
    expect(issues.some((issue) => issue.kind === "order")).toBe(true);
    expect(issues.some((issue) => issue.kind === "duplicate")).toBe(true);
  });

  it("checks each volume independently", () => {
    const issues = analyzeContinuity([
      ch("a", "第1章 一", ["x"], "v1"),
      ch("b", "第2章 二", ["x"], "v1"),
      ch("c", "第1章 一", ["x"], "v2"),
      ch("d", "第2章 二", ["x"], "v2"),
    ]);
    expect(issues).toEqual([]);
  });

  it("ignores unnumbered chapters and non-chapter kinds", () => {
    const intro: Chapter = { id: "i", title: "简介", kind: "intro", lines: [], volumeId: null };
    expect(analyzeContinuity([intro, ch("a", "插图"), ch("b", "第2章 二")])).toEqual([]);
  });

  it("does not cascade a false gap when the numbering restarts", () => {
    const issues = analyzeContinuity([
      ch("a", "第1章 一"),
      ch("b", "第5章 五"),
      ch("c", "第3章 三"),
      ch("d", "第4章 四"),
      ch("e", "第6章 六"),
    ]);
    expect(issues.map((issue) => issue.kind)).toEqual(["order"]);
  });

  it("does not treat an already-seen number as missing", () => {
    const issues = analyzeContinuity([
      ch("a", "第1章 一"),
      ch("b", "第4章 四"),
      ch("c", "第2章 二"),
      ch("d", "第5章 五"),
    ]);
    const gaps = issues.filter((issue) => issue.kind === "gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0].message).toContain("第3章");
    expect(gaps[0].message).not.toContain("第4章");
  });

  it("reports a trailing gap at the end of the book", () => {
    const issues = analyzeContinuity([ch("a", "第1章 一"), ch("b", "第3章 三")]);
    expect(issues.map((issue) => issue.kind)).toEqual(["gap"]);
    expect(issues[0].message).toContain("第2章");
  });

  it("formats missing ranges without counting already-seen numbers", () => {
    const issues = analyzeContinuity([
      ch("a", "第1章 一"),
      ch("b", "第9章 九"),
      ch("c", "第3章 三"),
      ch("d", "第4章 四"),
      ch("e", "第12章 十二"),
    ]);
    const gap = issues.find((issue) => issue.kind === "gap");
    expect(gap?.message).toContain("第5–8、10–11章");
    expect(gap?.message).not.toContain("第5–11章");
  });

  it("keeps a pending gap when the next chapter repeats the target number", () => {
    const issues = analyzeContinuity([
      ch("a", "第1章 一"),
      ch("b", "第5章 五"),
      ch("c", "第5章 五"),
      ch("d", "第7章 七"),
    ]);
    expect(issues.some((issue) => issue.kind === "duplicate")).toBe(true);
    const gapMessages = issues.filter((issue) => issue.kind === "gap").map((issue) => issue.message);
    expect(gapMessages.some((message) => message.includes("第2–4章"))).toBe(true);
  });
});

describe("isSuspectedHeadingLine", () => {
  it("requires blank-line isolation and a readable title", () => {
    expect(isSuspectedHeadingLine(["正文", "", "第8章 靠谱的银荆"], 2)).toBe(true);
    expect(isSuspectedHeadingLine(["正文", "第8章 靠谱的银荆"], 1)).toBe(false);
    expect(isSuspectedHeadingLine(["正文", "第8章 靠谱的银荆"], 0)).toBe(false);
    expect(
      isSuspectedHeadingLine(["正文", "", `第8章 ${"很长".repeat(30)}`], 2),
    ).toBe(false);
  });

  it("excludes a line identical to the chapter title", () => {
    expect(isSuspectedHeadingLine(["正文", "", "第7章 一"], 2, "第7章 一")).toBe(false);
  });
});

describe("findSuspectedHeadings", () => {
  it("flags chapter-like body lines that were not split", () => {
    const found = findSuspectedHeadings([
      ch("a", "第7章 啊？神器？", ["正文", "", "第8章 靠谱的银荆", "正文"]),
    ]);
    expect(found).toEqual([
      {
        chapterId: "a",
        chapterTitle: "第7章 啊？神器？",
        lineIndex: 2,
        text: "第8章 靠谱的银荆",
      },
    ]);
  });

  it("ignores inline chapter references without blank line isolation", () => {
    expect(
      findSuspectedHeadings([
        ch("a", "第7章 一", ["比如教材。", "第一章，人体七大魔力节点模型？", "很好，跳过。"]),
      ]),
    ).toEqual([]);
  });

  it("does not offer a split point before the chapter body", () => {
    expect(
      findSuspectedHeadings([ch("a", "第6章 前情", ["第7章 啊？神器？", "正文"])]),
    ).toEqual([]);
  });

  it("ignores the chapter's own title repeated in the body", () => {
    expect(findSuspectedHeadings([ch("a", "第7章 一", ["第7章 一", "正文"])]))
      .toEqual([]);
  });
});

describe("analyzeChapters", () => {
  it("counts both kinds of issues", () => {
    const report = analyzeChapters([
      ch("a", "第1章 一", ["正文", "", "第2章 漏了"]),
      ch("b", "第3章 三"),
    ]);
    expect(report.issueCount).toBe(2);
  });
});
