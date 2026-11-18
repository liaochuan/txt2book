# 墨水屏主题、高级排版与卷扉页预览 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增加第 5 套「墨水屏」主题、按元素自定义排版、内置/自定义背景图、卷扉页预览，并把三个导出内容选项默认改为不勾选且补充说明。

**Architecture:** 新增 `src/core/render/layout.ts` 作为排版的唯一数据源与 CSS 生成器；预览和 EPUB 共用 `layoutCss()`。背景图复用已有封面接口把上传/粘贴图片转成 PNG，存入布局配置并由转换器嵌入 EPUB。卷预览通过 session 的 `selectedVolumeId` 驱动。

**Tech Stack:** Vue 3、TypeScript、Vitest、JSZip、Fastify（无新增依赖）。

**Spec:** `docs/superpowers/specs/2026-11-18-typography-and-eink-design.md`

## Global Constraints

- 不新增依赖；不执行 `git commit`。
- 用户可见文案中文，代码标识符英文。
- 预览与导出必须使用同一份 `layoutCss()` 输出。
- 墨水屏主题忽略背景图与颜色里的低对比取值。
- 三个导出选项默认 `false`。
- 现有 679 个测试必须继续通过（4 主题断言改为 5）。

## Review Focus

- 主题数量变化导致旧断言、ThemePicker、README 漏改。
- 高级排版在预览与 EPUB 中生成的 CSS 不一致。
- 背景图只在前端生效、没进 EPUB manifest。
- 关闭卷扉页后卷首文字丢失或丢失居中样式。
- 卷预览与章节选中状态互相覆盖，删除卷后预览悬空。

---

### Task 1: 墨水屏主题

**Files:**
- Modify: `src/types/book.ts`（`ThemeId` 增加 `"eink"`）
- Modify: `src/core/render/themes.ts`
- Modify: `src/components/ThemePicker.vue`（第 5 张卡片与色块）
- Modify: `src/styles/app.css`（`.theme-swatch-eink`）
- Modify: `tests/render.test.ts`、`tests/ThemePicker.test.ts`
- Modify: `README.md`（主题列表）

**Interfaces:**
- Produces: `themes.eink`，`ThemeId` 共 5 项；`DEFAULT_THEME_ID` 仍为 `paper`。

- [ ] **Step 1: 更新失败测试**

```ts
it("exposes five themes with e-ink last", () => {
  expect(Object.keys(themes)).toEqual(["minimal", "paper", "night", "classic", "eink"]);
});
it("e-ink uses high contrast and no images", () => {
  const css = themes.eink.css;
  expect(css).toContain("#ffffff");
  expect(css).toContain("#111111");
  expect(css).toContain("text-indent: 2em");
  expect(css).not.toContain("@font-face");
  expect(css).not.toContain("background-image");
});
```

- [ ] **Step 2: 实现主题**

按设计 §3 写入 `eink`：纯白底、`#111111` 文字、衬线字体栈、`font-size: 1.05em`、`line-height: 1.85`、`p` 段距 `0.5em`、首行缩进 `2em`、标题无装饰、章标题 `page-break-before: always`、场景分隔符为文本 `* * *`。`sceneBreak` 设为 `* * *`。

- [ ] **Step 3: UI 与文档**

`ThemePicker` 渲染 5 项；`app.css` 增加 `.theme-swatch-eink`（白底黑边）；README 主题列表加一行。

- [ ] **Step 4: 验证**

Run: `npm test -- tests/render.test.ts tests/ThemePicker.test.ts` → 全绿；`npm run typecheck`。

---

### Task 2: 排版模型与 CSS 生成

**Files:**
- Create: `src/core/render/layout.ts`
- Create: `tests/layout.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type FontChoice = "serif" | "sans" | "song" | "hei" | "kai";
  export type ElementKey =
    | "chapterTitle" | "body" | "volumeTitle" | "volumeNote"
    | "intro" | "tocTitle" | "tocItem";
  export type BackgroundPresetId = "paper" | "grid" | "dots" | "linen";
  export interface ElementStyle { ... } // 见设计 §4.1
  export interface TypographyConfig { version: 1; elements: Record<ElementKey, ElementStyle>; }
  export interface BackgroundConfig { ... }
  export interface LayoutSettings { typography: TypographyConfig; background: BackgroundConfig; }
  export function defaultLayoutFor(themeId: ThemeId): LayoutSettings;
  export function normalizeLayout(raw: unknown, themeId: ThemeId): LayoutSettings;
  export function layoutCss(
    themeId: ThemeId,
    layout: LayoutSettings,
    options?: { backgroundSrc?: string },
  ): string;
  ```

- [ ] **Step 1: 写失败测试**

- 每个主题默认值：`body.fontSize` 在 1–1.2、`chapterTitle.align === "center"`（minimal 为 left）、`volumeNote.align === "center"`。
- `normalizeLayout({}, "paper")` 返回完整默认；非法 `fontSize: 99` 回退默认；未知元素键忽略。
- `layoutCss("paper", defaults)` 含 `.txt2book p`、`.txt2book .chapter-title`、`.txt2book .volume-note`、`.txt2book .description-page p`、`.txt2book .toc-page`。
- 修改某元素后 CSS 反映新值（如 `text-align: right`、`text-indent: 3em`）。
- `layoutCss("eink", layoutWithCustomPaper)` 不含 `background-image`。
- `layoutCss(..., { backgroundSrc: "x.png" })`（非 eink）含 `background-image: url("x.png")`。
- 预设 `grid` 生成 `repeating-linear-gradient`。

- [ ] **Step 2: 实现**

实现 5 套主题的默认 `ElementStyle`（ink 主题字号略大、颜色 `#111111`）。CSS 生成函数输出固定字符串，选择器前缀 `.txt2book`。预设背景用 `repeating-linear-gradient`/`radial-gradient`，自定义用 `options.backgroundSrc`。

- [ ] **Step 3: 验证** → `npm test -- tests/layout.test.ts`。

---

### Task 3: 布局持久化与背景图获取

**Files:**
- Create: `src/composables/useLayoutSettings.ts`
- Create: `src/composables/useBackgroundImage.ts`
- Create: `tests/useLayoutSettings.test.ts`
- Create: `tests/useBackgroundImage.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function useLayoutSettings(themeId: Ref<ThemeId>): {
    layout: Ref<LayoutSettings>;
    setElement(key: ElementKey, patch: Partial<ElementStyle>): void;
    setBackground(background: BackgroundConfig): void;
    reset(): void;
  };
  export function useBackgroundImage(setBackground: (bg: BackgroundConfig) => void): {
    busy: Ref<boolean>; error: Ref<string>;
    fromFile(file: File): Promise<boolean>;
    fromBlob(blob: Blob, fileName?: string): Promise<boolean>;
    clear(): void;
  };
  ```

- [ ] **Step 1: 写失败测试**

- 存储 key 为 `txt2book.layout.paper`；写入后重新创建 composable 能读回。
- 损坏 JSON / 未知主题 / 非对象 → 默认值，不抛错。
- 切换 `themeId` 时读取对应主题配置，互不串联。
- `reset()` 删除该 key 并恢复默认。
- 背景：`fromFile` 调用 `api.coverFromFile`，成功写入 `kind:"custom"`、PNG 字节与尺寸；失败设置中文错误；`busy` 复位。禁止非 `image/*`。

- [ ] **Step 2: 实现**

`useLayoutSettings` 用 `watch(themeId, immediate)` 读取 `localStorage`；写回时忽略配额错误。`useBackgroundImage` 校验 `file.type.startsWith("image/")` 与 10MB，调用 `api.coverFromFile`，从 PNG 头解析宽高（复用 `useCover` 里的方式或简单读取 IHDR），`setBackground` 写入；`clear()` 置 `none`。

- [ ] **Step 3: 验证** → `npm test -- tests/useLayoutSettings.test.ts tests/useBackgroundImage.test.ts`。

---

### Task 4: 高级排版面板与背景面板

**Files:**
- Create: `src/components/TypographyPanel.vue`
- Create: `src/components/BackgroundPanel.vue`
- Modify: `src/App.vue`
- Modify: `src/components/PreviewPane.vue`
- Modify: `src/styles/app.css`
- Create: `tests/TypographyPanel.test.ts`
- Create: `tests/BackgroundPanel.test.ts`

**Interfaces:**
- `TypographyPanel` props `{ layout: LayoutSettings }`，emits `update-element`、`reset`；每个元素一组折叠表单（字体、字号、行高、段距、缩进、对齐、颜色、上下留白），控件用 `<input type="number" step="0.05">`/`<select>`/`<input type="color">`。
- `BackgroundPanel` props `{ background: BackgroundConfig; disabled?: boolean }`，emits `select-preset`、`upload`、`paste`、`clear`；提供 4 个预设卡片、上传按钮、可粘贴区域与预览缩略图。
- `PreviewPane` 新增 props `{ layout: LayoutSettings; backgroundSrc?: string }`；文档注入 `layoutCss(...)`。

- [ ] **Step 1: 写失败测试**

- 修改字号触发 `update-element`（payload 含 `body` 与 `fontSize`）。
- 点「恢复默认」触发 `reset`。
- 背景面板点击预设触发 `select-preset("grid")`。
- 墨水屏时 `disabled` 为真、预设按钮禁用、显示「墨水屏主题不使用背景图」。
- 预览面板：给定 layout 后 srcdoc 含 `text-align: right` 等覆盖值。

- [ ] **Step 2: 实现并接线**

App：`const { layout, setElement, setBackground, reset } = useLayoutSettings(themeId)`；`backgroundSrc` 由自定义背景 PNG 生成 object URL（变化时 revoke），预设不生成 URL。`ThemePicker` 与两个新面板放右栏「排版」卡片，默认折叠。墨水屏下把 `disabled` 传给背景面板。

- [ ] **Step 3: 验证** → 相关测试 + `npm run typecheck`。

---

### Task 5: EPUB 应用排版与背景

**Files:**
- Modify: `src/core/converters/types.ts`（`ConvertOptions` 增加 `layout?: LayoutSettings`）
- Modify: `src/core/converters/epub/index.ts`
- Modify: `src/core/converters/epub/opf.ts`（背景图 manifest）
- Create: `tests/epubLayout.test.ts`

**Interfaces:**
- `buildEpub` 读取 `options.layout ?? defaultLayoutFor(themeId)`；`theme.css` = `theme.css + "\n" + layoutCss(themeId, layout, { backgroundSrc })`。
- 自定义背景写入 `OEBPS/images/background.png`，manifest `id="background-image"`、`media-type="image/png"`，CSS 引用 `../images/background.png`。
- 预设背景不写文件，CSS 直接用渐变。
- 墨水屏即使传入自定义背景也不写图片、不输出 `background-image`。

- [ ] **Step 1: 写失败测试**

- 带自定义背景导出：zip 含 `OEBPS/images/background.png`、`content.opf` 含 `background-image`、`theme.css` 含 `url("../images/background.png")`。
- 预设 `grid`：无图片文件、CSS 含 `repeating-linear-gradient`。
- e-ink + 自定义背景：无图片、CSS 无 `background-image`。
- 排版覆盖：`body.fontSize=1.3` 时 `theme.css` 含 `font-size: 1.3em`。

- [ ] **Step 2: 实现**

`buildEpub` 内生成 `layout` 与 `backgroundSrc`；写入文件与 manifest；`opf.ts` 的 `buildOpf` 接收可选背景项。保持 mimetype、顺序与现有断言不变。

- [ ] **Step 3: 验证** → `npm test -- tests/epub.test.ts tests/epubLayout.test.ts`。

---

### Task 6: 卷扉页预览

**Files:**
- Modify: `src/composables/useBookSession.ts`
- Modify: `src/components/ChapterTree.vue`
- Modify: `src/components/PreviewPane.vue`
- Modify: `src/App.vue`
- Modify: `tests/useBookSession.test.ts`、`tests/ChapterTree.test.ts`、`tests/PreviewPane.test.ts`、`tests/App.test.ts`

**Interfaces:**
- session 增加 `selectedVolumeId: Ref<string | null>`、`selectedVolume: ComputedRef<Volume | null>`、`selectVolume(id)`；`select(chapterId)` 清空卷选中；删除卷/撤销后若卷不存在则清空。
- `ChapterTree` props 增加 `selectedVolumeId`，emits 增加 `select-volume`；卷箭头只折叠，卷名按钮 emit `select-volume`，选中卷高亮。
- `PreviewPane` props 增加 `volume: Volume | null` 与 `chapterCount?: number`；`volume` 非空时渲染卷页（标题 + 卷首文字 + 「本卷 N 章」），工具栏显示「卷 · 名称」与「回到章节」按钮，按钮 emit `select-chapter(firstChapterId)`（由 App 提供 `volumeFirstChapterId`）。
- App 接线：点卷 → `session.selectVolume`；点章 → `session.select`；`PreviewPane` 的 `select-chapter` 同时用于翻页与回到章节。

- [ ] **Step 1: 写失败测试**

- `selectVolume("v1")` 后 `selectedVolume.id === "v1"`，`selectedChapterId` 为 null；`select("c1")` 清空卷。
- 删除已选中的卷后 `selectedVolume` 为 null。
- ChapterTree：点卷名 emit `select-volume`；点箭头不 emit `select-volume`，只切换折叠；选中卷有 `aria-current`。
- PreviewPane：传 `volume` 时 srcdoc 含卷标题与卷首文字，且不含章节正文；点「回到章节」emit 正确章节 id。
- App 集成：点卷名后预览区出现卷标题；点章节后回到正文。

- [ ] **Step 2: 实现**

- [ ] **Step 3: 验证** → 相关测试 + `npm run typecheck`。

---

### Task 7: 导出默认值、选项说明与卷首文字样式

**Files:**
- Modify: `src/core/converters/types.ts`（三个 include 默认 `false`）
- Modify: `src/components/ExportPanel.vue`（默认值 + 说明 + 布局）
- Modify: `src/core/converters/epub/index.ts`（关闭卷扉页时卷首文字用 `.volume-note` 区块）
- Modify: `src/core/converters/epub/xhtml.ts`（`volumeNoteBlock`）
- Modify: `src/App.vue`（导出默认选项）
- Modify: `README.md`
- Modify: `tests/ExportPanel.test.ts`、`tests/epub.test.ts`、`tests/App.test.ts`

**Interfaces:**
- `resolveConvertOptions({})` → `{ themeId: "paper", includeTocPage: false, includeTitlePage: false, includeVolumePages: false }`。
- `chapterDocument` 增加可选 `volumeNote?: { title: string; lines: string[] }`，渲染在正文顶部：
  ```html
  <section class="volume-note-block">
    <h2 class="volume-title">卷名</h2>
    <p class="volume-note">...</p>
  </section>
  ```
- 三个复选框下方 `<p class="option-hint" data-test="hint-...">`，文案按设计 §6.2。

- [ ] **Step 1: 写失败测试**

- `resolveConvertOptions({})` 三个 `false`。
- ExportPanel 默认渲染三个未勾选复选框，每个都有说明文本。
- 关闭卷扉页导出：`volume-1.xhtml` 不存在；第一章 XHTML 同时含 `class="volume-note-block"`、卷名与卷首文字；开启时第一章不含 `volume-note-block`。
- App 默认导出 payload 三个 false。

- [ ] **Step 2: 实现**

把现有「前置到第一章 lines」改为 `volumeNote` 区块，保留旧测试中“卷首文字出现在第一章”的断言，同时新增 class 断言。

- [ ] **Step 3: 更新 README**

主题 5 套、高级排版、背景图、卷预览、三选项默认关闭及说明。

- [ ] **Step 4: 验证**

Run: `npm test`、`npm run typecheck`、`npm run build:web`、`npm run build:server`。

---

## 完成标准

- 5 套主题可选，墨水屏在预览与 EPUB 中均为高对比、无背景。
- 高级排版 7 类元素可调，预览即时生效，导出 CSS 一致。
- 内置纹理与自定义背景在预览显示，自定义背景进入 EPUB。
- 点卷名预览卷扉页，箭头只折叠；删除卷后预览回退正常。
- 三个导出选项默认不勾选，每项有说明；关闭卷扉页时卷首文字以居中样式保留。
- 全量测试、typecheck、构建全绿。
