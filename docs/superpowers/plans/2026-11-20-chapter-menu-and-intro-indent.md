# 章节操作菜单与简介首行缩进 Implementation Plan

**Goal:** 修复新增操作按钮挤压章节标题导致只显示“第”的问题；把重命名/分章/删除收进三点菜单；简介按段落补齐两个全角空格的首行缩进。

**Architecture:** 只改展示层与文本格式化：`ChapterRow.vue` 负责菜单交互，纯格式化函数 `indentParagraphs` 放 `core/preprocess.ts`，calibre 导入与书籍信息面板共用。

**Tech Stack:** Vue 3 + TypeScript + Vitest。

## Global Constraints

- 用户可见文案用中文；样式走 tokens。
- 不执行 commit / push。
- 章节标题必须获得整行剩余宽度，操作按钮不得再参与网格列宽计算。

## Tasks

### Task 1: 章节操作三点菜单

**Files:** `src/components/ChapterRow.vue`、`src/styles/app.css`、`tests/ChapterTree.test.ts`、`tests/App.test.ts`

- [x] 先更新测试：操作按钮默认不渲染；点击 `chapter-menu` 后出现三个 `menuitem`；删除/分章事件、禁用态、Escape 关闭沿用原断言。
- [x] 输出 RED：用旧版 ChapterRow 跑“hides row actions”，确认失败。
- [x] 实现：`chapter-menu` 按钮 + 绝对定位菜单；行外 mousedown 与 Escape 关闭；网格改回 `minmax(0,1fr) auto auto`。
- [x] App 测试通过 `openChapterMenu` 辅助函数先展开菜单。
- [x] 跑 `npx vitest run tests/ChapterTree.test.ts tests/App.test.ts`，期望全绿。

### Task 2: 简介段落首行缩进

**Files:** `src/core/preprocess.ts`、`src/components/BookMetaPanel.vue`、`src/composables/useCalibre.ts`、`tests/preprocess.test.ts`、`tests/BookMetaPanel.test.ts`、`tests/useCalibre.test.ts`

- [x] 先写测试：`indentParagraphs` 覆盖多段、已有缩进归一、空行与 CRLF；面板失焦提交缩进后的简介；calibre 导入 meta 带缩进。
- [x] 输出 RED：3 个 `indentParagraphs` 用例失败。
- [x] 实现：`indentParagraphs` 去前导空白后补 `　　`，裁剪首尾空行；`useCalibre` 导入时格式化；`BookMetaPanel` 简介失焦时格式化再提交。
- [x] 跑 `npx vitest run tests/preprocess.test.ts tests/BookMetaPanel.test.ts tests/useCalibre.test.ts`，期望全绿。

### Task 3: 全量验证

- [x] `npm run typecheck`
- [x] 相关 5 个测试文件 162/162 通过
- [x] 回流主工作区后跑 `npm test`、`npm run build`、真实 TXT 复验（1378/1378，build 通过，859 章/连续性 0/疑似 0）
