# 导出简介开关与书名页移除 Implementation Plan

**Goal:** 把“是否生成简介页”做成独立选项（默认不勾选），移除“生成书名页”选项与书名页生成逻辑；排版卡片默认折叠。

**Architecture:** 在 `ConvertOptions` 用 `includeDescription` 替换 `includeTitlePage`，四种转换器与 PDF 服务端统一读取；文案与布局只改 `ExportPanel.vue` 与 `App.vue`。

**Tech Stack:** Vue 3 + TypeScript + Vitest + Fastify/pdfkit。

**Spec:** 用户确认：完全不生成书名页；简介页默认不勾选。

## Global Constraints

- 用户可见文案用中文。
- 书籍元数据中的 `dc:description` 仍保留，仅控制是否生成简介页。
- 不执行 commit / push。

## Tasks

### Task 1: 选项契约

**Files:** `src/core/converters/types.ts`、`src/core/converters/*`、`src/core/api.ts`、`server/lib/pdf/types.ts`、`server/lib/pdf/render.ts`

- [x] `ConvertOptions` / `ResolvedConvertOptions`：删除 `includeTitlePage`，新增 `includeDescription`，默认 `false`。
- [x] EPUB/HTML/TXT/PDF 读取 `includeDescription` 控制简介页；删除所有书名页生成逻辑。
- [x] PDF 请求体与 `PdfOptions` 同步；服务端仅在 `includeDescription` 为 true 时绘制简介页，空书兜底标题页保留。
- [x] 测试：EPUB/HTML/TXT/PDF 默认无书名页；`includeDescription` 为 true 时生成简介页，false 时即使有 description 也不生成。

### Task 2: UI 与布局

**Files:** `src/components/ExportPanel.vue`、`src/App.vue`、`tests/ExportPanel.test.ts`、`tests/App.test.ts`

- [x] 删除书名页复选框与 `opt-title` / `hint-title`；新增“生成简介页”复选框（`data-test="opt-description"`），默认不勾选，提示“关闭后元数据仍保留简介”。
- [x] 导出 payload 带 `includeDescription`，不再带 `includeTitlePage`。
- [x] 排版 `<details>` 去掉 `open`，测试改为默认折叠、点击展开。

### Task 3: 文案与全量验证

**Files:** `README.md`

- [x] README 导出选项表移除书名页、更新简介默认值。
- [x] `npm run typecheck`、`npm test`、`npm run build`。
- [x] 真实 TXT 复验解析结果不变。

