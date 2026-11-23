# PDF 导出 Implementation Plan

**Goal:** 服务端 pdfkit 生成 PDF，支持 A4/A5、页边距、页码、封面、目录与书签，前端注册为可选格式。

**Spec:** `docs/superpowers/specs/2026-11-18-multi-format-export-design.md`

## Global Constraints

- 在 worktree `.worktree/task-20261118-formats` 内工作；不提交。
- 新增依赖仅 `pdfkit`（运行时）与 `@types/pdfkit`（开发）。
- 中文文案、英文标识符；错误不泄露字体路径。
- 现有测试保持通过。

---

### Task 1: PDF 字体解析与排版引擎

**Files:**
- Create: `server/lib/pdf/types.ts`
- Create: `server/lib/pdf/fonts.ts`
- Create: `server/lib/pdf/text.ts`
- Create: `server/lib/pdf/render.ts`
- Create: `tests/server/pdf.test.ts`
- Modify: `package.json`（`pdfkit`、`@types/pdfkit`）

**Interfaces:**
- `server/lib/pdf/types.ts`：与前端结构兼容的最小类型 `PdfBook`、`PdfLayout`、`PdfOptions`、`PdfResult`。服务端不得 import `src/`。
- `fonts.ts`：
  ```ts
  export interface FontFile { path: string; family?: string }
  export interface PdfFonts { serif: FontFile; sans: FontFile; kai: FontFile }
  export function resolvePdfFonts(env?: NodeJS.ProcessEnv): PdfFonts | null;
  ```
  候选：`PDF_FONT_PATH` + `PDF_FONT_FAMILY`；Windows `simsun.ttc`(SimSun)/`simhei.ttf`/`simkai.ttf`；Linux `/usr/share/fonts/noto/NotoSerifCJK-Regular.ttc`(Noto Serif CJK SC)/`NotoSansCJK-Regular.ttc`(Noto Sans CJK SC)；macOS `Songti.ttc`/`PingFang.ttc`。每类取第一个存在文件，缺失回退 serif。
- `text.ts`：`wrapCjkText(text, measure, maxWidth): string[]`，按字符测量，行首禁止 `、。，．！？：；）】》」』…—`，行尾禁止 `（【《「『`。
- `render.ts`：
  ```ts
  export async function renderPdf(book: PdfBook, options: PdfOptions): Promise<PdfResult>;
  ```
  `PdfResult = { buffer: Buffer; pageCount: number; fontFamily: string }`。
  `PdfOptions`：`pageSize: "A4" | "A5"`、`margin: "normal" | "narrow"`、`pageNumbers: boolean`、`includeCover: boolean`、`includeTocPage: boolean`、`includeTitlePage: boolean`、`includeVolumePages: boolean`、`bookmarks: boolean`、`ThemeId`、`layout`（字号/行高/段距/缩进/对齐/颜色）。

要求：
- 结构：封面 → 书名 → 简介 → 目录（两遍排版得到真实页码）→ 卷扉页 → 章节。
- 中文断行与首行缩进；标题上下留白；页码页脚；书签按卷 → 章。
- 自定义背景图 8% 不透明度铺底；预设 CSS 纹理不输出。
- 封面按比例缩放到页面内。
- 找不到中文字体时抛 `PdfFontError`（code `PDF_FONT_MISSING`）。

- [ ] **Step 1: 写失败测试**

```ts
it("renders a multi-page pdf with bookmarks", async () => {
  const result = await renderPdf(book, { pageSize: "A4", margin: "normal", pageNumbers: true, includeCover: true, includeTocPage: true, includeTitlePage: true, includeVolumePages: true, bookmarks: true, themeId: "paper", layout: defaultLayoutForPdf() });
  expect(result.buffer.subarray(0, 5).toString()).toBe("%PDF-");
  expect(result.pageCount).toBeGreaterThanOrEqual(4);
});
it("A5 produces a smaller page box", async () => { /* 解析 MediaBox 字符串断言宽高 */ });
it("throws PdfFontError when no font exists", async () => {
  await expect(renderPdf(book, options, { fonts: null })).rejects.toMatchObject({ code: "PDF_FONT_MISSING" });
});
```
（若本机无中文字体，用 `describe.skipIf(!resolvePdfFonts())` 跳过 CJK 用例，并在报告说明。）

- [ ] **Step 2: 实现并验证**

`npm test -- tests/server/pdf.test.ts`、`npm run typecheck`。

---

### Task 2: PDF 导出接口与限制

**Files:**
- Create: `server/routes/export.ts`
- Modify: `server/app.ts`
- Create: `tests/server/export.test.ts`

**Interfaces:**
- `registerExportRoutes(app, config, deps?)`；`deps.renderPdf` 可注入以便测试。
- `POST /api/export/pdf`，`bodyLimit: 20 * 1024 * 1024`。
- 校验：章节 ≤ 2000、单章字符 ≤ 2,000,000、总字符 ≤ 20,000,000；失败 400 `EXPORT_TOO_LARGE`。
- 并发 1：占用中返回 429 `EXPORT_BUSY`；60s 超时返回 504 `EXPORT_TIMEOUT`。
- 限流：按 IP 6 次/分钟，429 `RATE_LIMITED`。
- 成功：`application/pdf` + `Cache-Control: no-store`。
- 需要登录（全局守卫已覆盖，不在白名单）。

- [ ] **Step 1: 写失败测试**

```ts
it("requires auth", async () => { const res = await app.inject({ method: "POST", url: "/api/export/pdf", payload: {} }); expect(res.statusCode).toBe(401); });
it("rejects oversized books", async () => { /* 2001 章 */ expect(res.statusCode).toBe(400); });
it("returns 429 while another export runs", async () => { /* 注入挂起的 renderPdf */ });
it("returns pdf bytes", async () => { /* 注入返回 PDF buffer */ });
```

- [ ] **Step 2: 实现并验证**

`npm test -- tests/server/export.test.ts`、`npm test -- tests/server`。

---

### Task 3: 前端 PDF 转换器接入

**Files:**
- Modify: `src/core/api.ts`
- Create: `src/core/converters/pdf/index.ts`
- Modify: `src/core/converters/index.ts`
- Modify: `src/components/ExportPanel.vue`（如选项提示需要）
- Modify: `src/App.vue`（loading 文案）
- Create: `tests/pdfConverter.test.ts`

**Interfaces:**
- `api.exportPdf(payload, signal?): Promise<Blob>` → `POST /api/export/pdf`，`accept: application/pdf`。
- `pdfConverter`：`id: "pdf"`、`extension: "pdf"`、`mimeType: "application/pdf"`、`runtime: "server"`，选项：
  - `pageSize`：A4/A5（默认 A4）
  - `margin`：normal/narrow（默认 normal）
  - `pageNumbers`：true
  - `includeCover`：true
  - `includeToc`：true
  - `bookmarks`：true
- `convert(book, options)` 组装 `{ book, layout, options: { ...includes, themeId, formatOptions } }` 调用接口。

- [ ] **Step 1: 写失败测试**

- `api.exportPdf` 的路径、method、JSON body、响应 blob。
- `pdfConverter.convert` 调用的 payload 含 `book`、`layout`、`formatOptions`。
- 注册表包含 pdf 且 `runtime === "server"`；ExportPanel 选中 PDF 显示 6 个选项。

- [ ] **Step 2: 实现并验证**

`npm test -- tests/pdfConverter.test.ts tests/ExportPanel.test.ts`、`npm run typecheck`、`npm run build:web`。

---

### Task 4: Docker 字体与文档

**Files:**
- Modify: `Dockerfile`
- Modify: `README.md`
- Modify: `.env.example`（`PDF_FONT_PATH` / `PDF_FONT_FAMILY`）

要求：
- 运行镜像 `apk add --no-cache font-noto-cjk`。
- README 增加：PDF 格式、A4/A5、字体说明、`PDF_FONT_PATH`、PDF 不还原 CSS 渐变背景、容器内存建议 `mem_limit: 1g`、超时/并发/限流行为。
- `.env.example` 增加可选的 `PDF_FONT_PATH`、`PDF_FONT_FAMILY` 注释。

验证：
- `npm test`、`npm run typecheck`、`npm run build`。
- `docker compose build` 后 `docker compose run --rm -T txt2book node -e "console.log(require('fs').existsSync('/usr/share/fonts/noto/NotoSerifCJK-Regular.ttc'))"` 为 true（如果 Docker 可用）。
- 可选：容器内 curl 登录后导出 PDF，检查 `%PDF-`。

---

## 完成标准

- 格式下拉包含 EPUB / HTML / PDF / TXT。
- PDF 在 A4/A5 下中文正常、页码/目录/书签可用。
- 未登录 401；超限 400；并发 429；限流 429；超时 504。
- Docker 镜像内置中文字体，部署后可直接导出 PDF。
