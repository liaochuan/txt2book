# 章节功能 Minor 修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修掉上一轮代码审查中记录的全部 deferred minors，不改变已确认的主交互。

**Architecture:** 保持现有分层：`core/chapterAnalysis.ts` 负责校验，`core/chapterOps.ts` 负责纯数据操作，session 负责历史，组件只展示。所有修复先用失败测试锁定，再实现。

**Tech Stack:** Vue 3 + TypeScript + Vitest。

**Spec:** 上一轮计划 `docs/superpowers/plans/2026-11-20-chapter-detection-split.md` 与审查报告中的 deferred minors 列表。

## Global Constraints

- 用户可见文案用中文；代码、路径、字段保持英文。
- 纯逻辑放 `src/core/`；样式只用 tokens 变量。
- 不执行 commit / push。
- 不新增依赖。

## Review Focus

- 编号级联误报：`[1,5,3,4,6]` 不应同时报“缺少 2–4”和“缺少 5”。
- 分章边界：最后一行、空行、全空正文不能产生空章节或成功假象。
- 超长章节与大量警告不能撑爆 UI。
- 移除 `analyzeChapters` 的 `volumes` 参数后，所有调用方与测试同步更新。

---

### Task 1: 分析 API 收敛与编号级联修复

**Files:** `src/core/chapterAnalysis.ts`、`src/components/ChapterWarnings.vue`、`tests/chapterAnalysis.test.ts`、`tests/ChapterWarnings.test.ts`

**Interfaces:**
- `analyzeContinuity(chapters: Chapter[]): ContinuityIssue[]`
- `analyzeChapters(chapters: Chapter[]): ChapterReport`
- `ContinuityIssue.chapterId: string`（不再可空）

- [ ] 新增失败测试：`analyzeChapters([ch("a","第1章",["正文"])])` 只接受一个参数；`[第1,第5,第3,第4,第6]` 不出现 `gap`，只出现 `order`；已出现过的编号不再计入缺号范围。
- [ ] 实现：去掉 `volumes` 参数；gap 改为“待确认”：大跳后若下一章编号更小则丢弃候选；缺号只列未出现过的编号；倒序仍报 `order`。
- [ ] 更新 `ChapterWarnings.vue` 调用与 `chapterId` 非空分支，删除 v-else 死代码；组件 props 移除 `volumes`。
- [ ] 跑 `npx vitest run tests/chapterAnalysis.test.ts tests/ChapterWarnings.test.ts`，期望全绿。

### Task 2: 分章边界与成功反馈

**Files:** `src/core/chapterOps.ts`、`src/composables/useBookSession.ts`、`src/App.vue`、`tests/chapterOps.test.ts`、`tests/useBookSession.test.ts`、`tests/App.test.ts`

**Interfaces:**
- `splitChapter(...): BookModel | null`（无效切分返回 `null`）
- `BookSession.splitChapter(...): boolean`

- [ ] 新增失败测试：最后一行 `dropLine: true` 返回 `null`；全空白新正文返回 `null`；原章节尾部空行与新章节头部空行被裁掉；拆分 `intro` 得到 `chapter`，拆分 `extra` 仍为 `extra`；session 无效切分返回 `false` 且不产生撤销点；App 无效时不弹成功 toast。
- [ ] 实现：`splitChapter` 返回 `null`；`slice` 后裁剪首尾空白行；`kind` 继承（`intro` → `chapter`）；session 校验并返回布尔值；App 仅在 `true` 时 toast。
- [ ] 跑相关测试，期望全绿。

### Task 3: 提醒卡片上限与可访问性

**Files:** `src/components/ChapterWarnings.vue`、`src/styles/app.css`、`tests/ChapterWarnings.test.ts`

- [ ] 新增失败测试：超过 20 条时只渲染 20 条并显示“显示全部”；点击后全量渲染；每条分章按钮的 `aria-label` 含目标标题。
- [ ] 实现：`EXPAND_LIMIT = 20`、`expanded` 状态、`visibleX` 计算属性、`remaining` 文案；提示文案改为“连续性条目可点击跳转”。
- [ ] 跑测试，期望全绿。

### Task 4: 分章弹窗细化

**Files:** `src/components/SplitChapterDialog.vue`、`tests/SplitChapterDialog.test.ts`

- [ ] 新增失败测试：重复点击同一行不覆盖已改标题；正文中的 `第一章，…` 在非空行隔离时默认不勾选“作为标题移除”；`dropLine` 后无正文时确认按钮禁用。
- [ ] 实现：选中同一行直接返回；`dropLine` 默认复用“疑似标题”判定（空行隔离）；新增 `canConfirm` 计算属性并在最后一行 + dropLine 时禁用，附提示文案。
- [ ] 跑测试，期望全绿。

### Task 5: 行内细节、编号与全量验证

**Files:** `src/components/ChapterRow.vue`、`src/core/chapterAnalysis.ts`、`src/core/chapterParser.ts`、`src/styles/app.css`、`tests/ChapterTree.test.ts`、`tests/chapterAnalysis.test.ts`、`tests/chapterParser.test.ts`

- [ ] 新增失败测试：`第壹佰章` / `第壹仟章` 可解析编号；`第壹佰章 开端` 可识别为章节。
- [ ] 实现：补齐 `佰`/`仟` 的字符类与单位；移除 `ChapterRow` 分章按钮上无效的 `mousedown.prevent`；`.chapter-delete` 固定到最后一列。
- [ ] 跑 `npm run typecheck`、`npm test`，期望全绿；用真实 TXT 复验第 7 章与连续性 0 问题。
