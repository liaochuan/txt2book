# 章节检测增强、连续性校验与手动分章 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复以句末标点结尾的章节标题漏检，校验章节编号连续性并在页面提示，同时支持手动分章。

**Architecture:** 解析器只放宽「标题以标点结尾」的判定（要求前一行是空行，避免把正文中的引用当标题）。新增 `src/core/chapterAnalysis.ts` 负责编号提取、缺号/重号/倒序校验与疑似漏检标题扫描；`chapterOps.ts` 新增纯函数分章；UI 用独立警告卡片与分章弹窗，App 负责接线。

**Tech Stack:** Vue 3 + TypeScript + Vitest + `@vue/test-utils`

**Spec:** 无独立设计文档；需求与已确认交互见本次会话（用户选择方案 A：目录内「分章」按钮 + 正文按行选择切分点）。

## Global Constraints

- 所有用户可见文案用中文；代码、路径、API 字段保持英文。
- 纯逻辑放 `src/core/`，组件只做展示与事件转发。
- 样式只用 `src/styles/tokens.css` 的 CSS 变量，不写内联样式。
- 不执行 commit / push；改动只落在 worktree。
- 手动分章必须进入撤销历史，可通过「撤销」恢复。

## Review Focus

- 正文中以句末标点结尾的段落（如「第一章，人体七大魔力节点模型？」）不得被识别为章节：靠「前一行空行」隔离判定覆盖。
- 章节正文为空或只有一行时，分章入口应禁用或操作无效，不能产生空章节。
- 章节标题没有编号（如自定义标题）时，连续性校验应忽略而不是误报缺号。
- 分卷小说每卷重新编号（第 1 章重新开始）时，连续性按卷独立校验，不跨卷报缺号。
- 疑似标题行与真实标题重复显示时，分章后提醒应消失（分析基于当前章节内容计算）。

---

### Task 1: 解析器识别标点结尾标题

**Files:**
- Modify: `src/core/chapterParser.ts:98-119`
- Test: `tests/chapterParser.test.ts`

**Interfaces:**
- Consumes: 现有 `classifyTitle(line, userPatterns)`。
- Produces: `classifyTitle` 增加第二参数 `previousLine: string`（默认 `""`）；对内置 `CHAPTER` / `INDEXED_CHAPTER` 命中且标题以 `TITLE_END` 结尾时，仅当前一行为空（或为首行）才接受。

- [ ] **Step 1: 写失败测试**

在 `tests/chapterParser.test.ts` 的 `parseChapters` describe 中新增：

```ts
it("recognizes headings that end with sentence punctuation when isolated by a blank line", () => {
  const parsed = parseChapters(
    ["第6章 前情", "正文", "", "第7章 啊？神器？", "正文", "", "第9章 爆兵！炎魔异动！", "正文"],
    "zh-CN",
  );
  expect(parsed.chapters.map((c) => c.title)).toEqual([
    "第6章 前情",
    "第7章 啊？神器？",
    "第9章 爆兵！炎魔异动！",
  ]);
});

it("keeps inline chapter references as body text", () => {
  const parsed = parseChapters(
    ["第6章 前情", "比如教材。", "第一章，人体七大魔力节点模型？", "很好，跳过。"],
    "zh-CN",
  );
  expect(parsed.chapters.map((c) => c.title)).toEqual(["第6章 前情"]);
  expect(parsed.chapters[0].lines).toContain("第一章，人体七大魔力节点模型？");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/chapterParser.test.ts`
Expected: 新用例失败，期望标题与实际不一致。

- [ ] **Step 3: 实现**

`classifyTitle` 改为接收 `previousLine`，内置章规则命中逻辑：

```ts
function acceptsPunctuatedTitle(previousLine: string): boolean {
  return previousLine.trim() === "";
}

const isChapter =
  matches(CHAPTER, title) || matches(INDEXED_CHAPTER, title);
if (isChapter) {
  if (!TITLE_END.test(title) || acceptsPunctuatedTitle(previousLine)) {
    return { title, kind: "chapter" };
  }
}
```

`lines.forEach` 调用处传入 `index === 0 ? "" : lines[index - 1]`。卷/番外/楔子/尾声仍保留原 `TITLE_END` 检查（先判空行不再必要）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/chapterParser.test.ts`
Expected: PASS，原有 40 字限制与正文过滤用例保持通过。

---

### Task 2: 章节编号与连续性分析

**Files:**
- Create: `src/core/chapterAnalysis.ts`
- Test: `tests/chapterAnalysis.test.ts`

**Interfaces:**
- Consumes: `Chapter`、`Volume` 类型；`Chapter.kind` 为 `"chapter"` 的章节参与校验。
- Produces:
  - `export function chapterNumberOf(title: string): number | null`
  - `export interface ContinuityIssue { kind: "gap" | "duplicate" | "order"; chapterId: string | null; chapterTitle: string; message: string }`
  - `export interface SuspectedHeading { chapterId: string; chapterTitle: string; lineIndex: number; text: string }`
  - `export interface ChapterReport { continuity: ContinuityIssue[]; suspected: SuspectedHeading[]; issueCount: number }`
  - `export function analyzeContinuity(chapters: Chapter[], volumes: Volume[]): ContinuityIssue[]`
  - `export function findSuspectedHeadings(chapters: Chapter[]): SuspectedHeading[]`
  - `export function analyzeChapters(chapters: Chapter[], volumes: Volume[]): ChapterReport`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import {
  analyzeChapters,
  analyzeContinuity,
  chapterNumberOf,
  findSuspectedHeadings,
} from "../src/core/chapterAnalysis";
import type { Chapter, Volume } from "../src/types/book";

function ch(id: string, title: string, lines: string[] = ["正文"], volumeId: string | null = null): Chapter {
  return { id, title, kind: "chapter", lines, volumeId };
}

describe("chapterNumberOf", () => {
  it("parses arabic and chinese numerals", () => {
    expect(chapterNumberOf("第7章 啊？神器？")).toBe(7);
    expect(chapterNumberOf("第七章 重逢")).toBe(7);
    expect(chapterNumberOf("第147章 大远征")).toBe(147);
    expect(chapterNumberOf("Chapter 12")).toBe(12);
    expect(chapterNumberOf("番外 一")).toBeNull();
    expect(chapterNumberOf("插图")).toBeNull();
  });
});

describe("analyzeContinuity", () => {
  it("reports missing numbers", () => {
    const issues = analyzeContinuity(
      [ch("a", "第1章 一"), ch("b", "第3章 三"), ch("c", "第4章 四")],
      [],
    );
    expect(issues.map((issue) => issue.kind)).toEqual(["gap"]);
    expect(issues[0].message).toContain("第2章");
  });

  it("reports duplicates and out-of-order chapters", () => {
    const issues = analyzeContinuity(
      [ch("a", "第1章 一"), ch("b", "第3章 三"), ch("c", "第2章 二"), ch("d", "第3章 三")],
      [],
    );
    expect(issues.some((issue) => issue.kind === "order")).toBe(true);
    expect(issues.some((issue) => issue.kind === "duplicate")).toBe(true);
  });

  it("checks each volume independently", () => {
    const volumes: Volume[] = [
      { id: "v1", title: "第一卷", kind: "volume" },
      { id: "v2", title: "第二卷", kind: "volume" },
    ];
    const issues = analyzeContinuity(
      [ch("a", "第1章 一", ["x"], "v1"), ch("b", "第2章 二", ["x"], "v1"),
       ch("c", "第1章 一", ["x"], "v2"), ch("d", "第2章 二", ["x"], "v2")],
      volumes,
    );
    expect(issues).toEqual([]);
  });

  it("ignores unnumbered chapters and non-chapter kinds", () => {
    const intro: Chapter = { id: "i", title: "简介", kind: "intro", lines: [], volumeId: null };
    expect(analyzeContinuity([intro, ch("a", "插图"), ch("b", "第2章 二")], [])).toEqual([]);
  });
});

describe("findSuspectedHeadings", () => {
  it("flags chapter-like body lines that were not split", () => {
    const found = findSuspectedHeadings([
      ch("a", "第7章 啊？神器？", ["正文", "第8章 靠谱的银荆", "正文"]),
    ]);
    expect(found).toEqual([
      { chapterId: "a", chapterTitle: "第7章 啊？神器？", lineIndex: 1, text: "第8章 靠谱的银荆" },
    ]);
  });
});

describe("analyzeChapters", () => {
  it("counts both kinds of issues", () => {
    const report = analyzeChapters(
      [ch("a", "第1章 一", ["第2章 漏了"]), ch("b", "第3章 三")],
      [],
    );
    expect(report.issueCount).toBe(2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/chapterAnalysis.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `src/core/chapterAnalysis.ts`**

- `chapterNumberOf` 用正则提取 `第N[章回]` 或 `Chapter N` 中的数字；中文数字走 `parseChineseNumber`（覆盖 `零一二三四五六七八九十百千万两`，`十` 开头按 10 处理）。
- `analyzeContinuity` 按 `volumeId` 分组（保持章节原有顺序），仅处理 `kind === "chapter"` 且有编号的项；逐项比较：
  - 当前编号已出现 → `duplicate`，消息 `「第X章」编号重复（第 N 次出现）`；
  - 当前编号 `<` 前一项编号 → `order`，消息 `「第X章」出现在「第Y章」之后，顺序可能有问题`；
  - 当前编号 `>` 前一项编号 + 1 → `gap`，消息 `第A章与第B章之间缺少第C章`（缺号超过 10 个时写 `缺少 N 章`）。
- `findSuspectedHeadings` 复用 `chapterParser` 导出的 `looksLikeChapterTitle(line)`（新增导出，内部为 `CHAPTER` / `INDEXED_CHAPTER` 的纯正则判断），逐行扫描，排除与章节自身标题相同的行；标题行长超过 60 字跳过。
- `analyzeChapters` 汇总两者，`issueCount = continuity.length + suspected.length`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/chapterAnalysis.test.ts`
Expected: PASS。

---

### Task 3: 分章纯函数与会话动作

**Files:**
- Modify: `src/core/chapterOps.ts`
- Modify: `src/composables/useBookSession.ts`
- Test: `tests/chapterOps.test.ts`、`tests/useBookSession.test.ts`

**Interfaces:**
- `export interface SplitChapterOptions { title?: string; dropLine?: boolean }`
- `export function splitChapter(book: BookModel, chapterId: string, lineIndex: number, options?: SplitChapterOptions): BookModel`
- `BookSession.splitChapter(chapterId: string, lineIndex: number, options?: SplitChapterOptions): void`

- [ ] **Step 1: 写失败测试**

`tests/chapterOps.test.ts` 新增：

```ts
import { splitChapter } from "../src/core/chapterOps";

describe("splitChapter", () => {
  const source = (): BookModel => ({
    meta: { title: "书", author: "", language: "zh-CN" },
    volumes: [{ id: "v1", title: "第一卷", kind: "volume" }],
    chapters: [
      { id: "c1", title: "第7章 啊？神器？", kind: "chapter", lines: ["a", "", "第8章 靠谱的银荆", "b"], volumeId: "v1" },
    ],
    cover: null,
  });

  it("moves trailing lines into a new chapter after the source", () => {
    const next = splitChapter(source(), "c1", 2, { title: "第8章 靠谱的银荆", dropLine: true });
    expect(next.chapters).toHaveLength(2);
    expect(next.chapters[0].lines).toEqual(["a", ""]);
    expect(next.chapters[1].title).toBe("第8章 靠谱的银荆");
    expect(next.chapters[1].lines).toEqual(["b"]);
    expect(next.chapters[1].volumeId).toBe("v1");
  });

  it("keeps the selected line when dropLine is false", () => {
    const next = splitChapter(source(), "c1", 2, { title: "新章", dropLine: false });
    expect(next.chapters[1].lines).toEqual(["第8章 靠谱的银荆", "b"]);
  });

  it("rejects invalid split points without changing the book", () => {
    expect(splitChapter(source(), "c1", 0).chapters).toHaveLength(1);
    expect(splitChapter(source(), "c1", 4).chapters).toHaveLength(1);
    expect(splitChapter(source(), "missing", 1).chapters).toHaveLength(1);
  });

  it("does not mutate the source book", () => {
    const original = source();
    splitChapter(original, "c1", 2, { title: "第8章" });
    expect(original.chapters[0].lines).toEqual(["a", "", "第8章 靠谱的银荆", "b"]);
  });
});
```

`tests/useBookSession.test.ts` 新增：

```ts
it("splits a chapter and undoes it", () => {
  const session = useBookSession();
  session.loadBook(
    { title: "书", author: "", language: "zh-CN" },
    { volumes: [], chapters: [{ id: "c1", title: "第1章", kind: "chapter", lines: ["a", "b"], volumeId: null }] },
    "书",
  );
  session.splitChapter("c1", 1, { title: "第2章", dropLine: false });
  expect(session.book.value.chapters).toHaveLength(2);
  session.undo();
  expect(session.book.value.chapters).toHaveLength(1);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/chapterOps.test.ts tests/useBookSession.test.ts`
Expected: FAIL，`splitChapter` 不存在。

- [ ] **Step 3: 实现**

- `chapterOps.splitChapter`：定位章节，校验 `lineIndex` 为 `1..lines.length-1`；`title` 取 `options.title.trim() || "新章节"`；`dropLine === true` 时新章正文从 `lineIndex + 1` 开始。返回 `copyBook` 后的新对象，新章节用 `createChapterId()`，`kind: "chapter"`，`volumeId` 沿用原章。
- `useBookSession` 从 `chapterOps` 引入并暴露 `splitChapter`，内部 `commit(splitChapter(book.value, ...))`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/chapterOps.test.ts tests/useBookSession.test.ts`
Expected: PASS。

---

### Task 4: 分章弹窗与目录入口

**Files:**
- Create: `src/components/SplitChapterDialog.vue`
- Modify: `src/components/ChapterRow.vue`
- Modify: `src/components/ChapterTree.vue`
- Modify: `src/styles/app.css`
- Test: `tests/SplitChapterDialog.test.ts`、`tests/ChapterTree.test.ts`

**Interfaces:**
- `ChapterRow` 新增 emit `split: [id: string]`，新增「分章」按钮（`data-test="split-chapter"`，正文不足 2 行时禁用）。
- `ChapterTree` 新增 emit `"split-chapter": [id: string]`，透传 `ChapterRow` 的 `split`。
- `SplitChapterDialog` props `{ open: boolean; chapter: Chapter | null; initialLineIndex?: number }`；emits `close: []`、`split: [{ chapterId: string; lineIndex: number; title: string; dropLine: boolean }]`。

- [ ] **Step 1: 写失败测试**

`tests/SplitChapterDialog.test.ts`：

```ts
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import SplitChapterDialog from "../src/components/SplitChapterDialog.vue";
import type { Chapter } from "../src/types/book";

const chapter: Chapter = {
  id: "c1",
  title: "第7章 啊？神器？",
  kind: "chapter",
  lines: ["正文一", "", "第8章 靠谱的银荆", "正文二"],
  volumeId: null,
};

describe("SplitChapterDialog", () => {
  it("lists lines and splits at the selected line", async () => {
    const wrapper = mount(SplitChapterDialog, {
      props: { open: true, chapter, initialLineIndex: 2 },
    });
    expect(wrapper.text()).toContain("第8章 靠谱的银荆");
    await wrapper.find('[data-test="split-confirm"]').trigger("click");
    expect(wrapper.emitted("split")?.[0]?.[0]).toEqual({
      chapterId: "c1",
      lineIndex: 2,
      title: "第8章 靠谱的银荆",
      dropLine: true,
    });
  });

  it("disables confirm until a line is selected", async () => {
    const wrapper = mount(SplitChapterDialog, { props: { open: true, chapter } });
    expect(wrapper.find('[data-test="split-confirm"]').attributes("disabled")).toBeDefined();
    await wrapper.find('[data-test="split-line-1"]').trigger("click");
    expect(wrapper.find('[data-test="split-confirm"]').attributes("disabled")).toBeUndefined();
  });

  it("emits close when cancelled", async () => {
    const wrapper = mount(SplitChapterDialog, { props: { open: true, chapter } });
    await wrapper.find('[data-test="split-cancel"]').trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
  });
});
```

`tests/ChapterTree.test.ts` 新增：

```ts
it("emits split-chapter from the row button", async () => {
  const wrapper = mountTree();
  await wrapper.findAll('[data-test="split-chapter"]')[0].trigger("click");
  expect(wrapper.emitted("split-chapter")?.[0]).toEqual(["c1"]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/SplitChapterDialog.test.ts tests/ChapterTree.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现组件**

- `SplitChapterDialog` 使用 `AppDialog`；选中行按钮列表 `data-test="split-line-{index}"`（index 从 1 开始，0 行不可选），每行显示行号与文本（CSS 截断）。选中行默认：`initialLineIndex` 合法时用它，否则 `null`。
- 标题输入 `data-test="split-title"`，默认选中行 trim 后截断 40 字；`dropLine` 复选框 `data-test="split-drop-line"`，默认选中行匹配 `第X章` 时为 true。
- 确认按钮 `data-test="split-confirm"`，未选行时禁用；点击 emit `split`。取消按钮 emit `close`。
- `open` 或 `chapter.id` 变化时重置选中与标题。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/SplitChapterDialog.test.ts tests/ChapterTree.test.ts`
Expected: PASS。

---

### Task 5: 页面警告卡片与 App 接线

**Files:**
- Create: `src/components/ChapterWarnings.vue`
- Modify: `src/App.vue`
- Modify: `src/styles/app.css`
- Test: `tests/ChapterWarnings.test.ts`、`tests/App.test.ts`

**Interfaces:**
- `ChapterWarnings` props `{ chapters: Chapter[]; volumes: Volume[] }`；emits `select-chapter: [id: string]`、`split-chapter: [{ chapterId: string; lineIndex: number }]`。
- App 新增 `splitTarget = ref<{ chapterId: string; lineIndex?: number } | null>(null)`，渲染 `SplitChapterDialog`，确认后调用 `session.splitChapter` 并 toast 提示（带「撤销」）。
- `SplitChapterDialog` props 增加可选 `initialLineIndex`（Task 4 已定义）。

- [ ] **Step 1: 写失败测试**

`tests/ChapterWarnings.test.ts`：

```ts
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ChapterWarnings from "../src/components/ChapterWarnings.vue";
import type { Chapter } from "../src/types/book";

function ch(id: string, title: string, lines: string[] = ["正文"]): Chapter {
  return { id, title, kind: "chapter", lines, volumeId: null };
}

describe("ChapterWarnings", () => {
  it("renders nothing when there are no issues", () => {
    const wrapper = mount(ChapterWarnings, {
      props: { chapters: [ch("a", "第1章 一"), ch("b", "第2章 二")], volumes: [] },
    });
    expect(wrapper.find('[data-test="chapter-warnings"]').exists()).toBe(false);
  });

  it("lists continuity issues and selects the chapter on click", async () => {
    const wrapper = mount(ChapterWarnings, {
      props: { chapters: [ch("a", "第1章 一"), ch("b", "第3章 三")], volumes: [] },
    });
    expect(wrapper.text()).toContain("缺少第2章");
    await wrapper.find('[data-test="warning-issue-0"]').trigger("click");
    expect(wrapper.emitted("select-chapter")?.[0]).toEqual(["b"]);
  });

  it("offers manual split for suspected headings", async () => {
    const wrapper = mount(ChapterWarnings, {
      props: { chapters: [ch("a", "第1章 一", ["正文", "第2章 二"])], volumes: [] },
    });
    await wrapper.find('[data-test="warning-split-0"]').trigger("click");
    expect(wrapper.emitted("split-chapter")?.[0]).toEqual([{ chapterId: "a", lineIndex: 1 }]);
  });
});
```

`tests/App.test.ts` 新增（沿用文件内已有挂载辅助）：

```ts
it("shows chapter warnings and opens the split dialog from a row", async () => {
  // 用现成 helper 导入含缺号的章节，断言 [data-test="chapter-warnings"] 存在
  // 再点击 [data-test="split-chapter"]，断言 [data-test="split-dialog"] 存在
});
```

实际断言使用该文件已有的 `loadBook`/`mountApp` 辅助函数；如果辅助不可复用，则单独 mount `ChapterWarnings` 并断言 App 模板接线通过静态渲染检查。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ChapterWarnings.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 `ChapterWarnings.vue` 与接线**

- 卡片 `data-test="chapter-warnings"`，无问题时 `v-if` 不渲染。
- 连续性条目 `data-test="warning-issue-{i}"`，点击 emit `select-chapter`（`chapterId` 非空时）；无 `chapterId` 的条目渲染为纯文本。
- 疑似标题条目 `data-test="warning-split-{i}"`，显示「第X章正文第 N 行疑似标题」，按钮 emit `split-chapter`。
- `App.vue` 在 `ChapterTree` 上方渲染 `<ChapterWarnings :chapters="book.chapters" :volumes="book.volumes" @select-chapter="select" @split-chapter="openSplit" />`。
- `ChapterTree` 增加 `@split-chapter="openSplit"`，`openSplit(payload)` 兼容字符串 id 与 `{ chapterId, lineIndex }`。
- 新增 `onSplit(payload)`：调用 `session.splitChapter`，`pushToast` 文案「已拆分出新章节「标题」」，带撤销 action（`undoIfCurrent`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/ChapterWarnings.test.ts tests/ChapterTree.test.ts`
Expected: PASS。

---

### Task 6: 全量验证与自查

**Files:**
- 无新增；检查全部改动。

- [ ] **Step 1: 类型检查**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 2: 全量测试**

Run: `npm test`
Expected: 全部通过。

- [ ] **Step 3: 用真实文件验证**

用 `第 7 章「啊？神器？」` 所在 TXT 的解析结果断言：章节标题包含「第7章 啊？神器？」，且连续性警告中不再出现第 7、8 章缺号（可作为一次性脚本验证，不落盘）。

- [ ] **Step 4: 自审 diff**

Run: `git diff --stat`、`git diff`
逐块检查：无调试残留、无误伤无关代码、文案为中文、样式走 token。

## Self-Review

- 需求覆盖：检测增强（Task 1）、连续性校验与页面提醒（Task 2、5）、手动分章（Task 3、4、5）、真实文件验证（Task 6）。
- 类型一致性：`splitChapter` 在 chapterOps / useBookSession / SplitChapterDialog / App 中签名一致；`ChapterReport` 字段与组件使用一致。
- 测试：每个任务先写失败测试再实现；最终跑全量。
- 安全：改动只涉及本地文本处理与 DOM 渲染，新增文本用 Vue 插值输出（自动转义），不引入 HTML 注入面。
