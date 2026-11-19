# 格式抽象、HTML 与 TXT Implementation Plan

**Goal:** 扩展转换器抽象，新增单文件 HTML 与整理版 TXT。

**Spec:** `docs/superpowers/specs/2026-11-18-multi-format-export-design.md`

## Global Constraints

- 在 worktree `E:\Code\txt-epub\txt2book\.worktree\task-20261118-formats` 内工作。
- 不提交；用户可见文案中文；现有测试保持通过。
- 新增文件遵守 `src/core/converters/<format>/` 目录约定。

---

### Task 1: 转换器选项抽象与导出面板

**Files:**
- Modify: `src/core/converters/types.ts`
- Modify: `src/components/ExportPanel.vue`
- Modify: `src/App.vue`（仅在需要时）
- Modify: `tests/ExportPanel.test.ts`、`tests/registry.test.ts`

**Interfaces:**
- 按索引文档扩展 `ConverterMeta`（`runtime`、`options`）、`FormatOption`、`ConvertOptions.formatOptions`。
- `resolveConvertOptions` 保留并透传 `formatOptions`，不改三个内容选项默认值（仍 false）。
- `ExportPanel` 根据 `selected.options` 渲染 `data-test="format-opt-<key>"` 控件；切换格式时重置为该格式默认值；最终 payload 为 `{ format, options: { ...includes, formatOptions } }`。
- `App` 把 `request.options` 原样传给 `converter.convert`。

- [ ] **Step 1: 写失败测试**

```ts
it("renders per-format options and resets on format change", async () => {
  const converters = [
    { id: "a", label: "A", extension: "a", mimeType: "x/a", available: true, runtime: "browser" },
    { id: "b", label: "B", extension: "b", mimeType: "x/b", available: true, runtime: "browser",
      options: [
        { key: "mode", label: "模式", type: "select", defaultValue: "x", choices: [{ value: "x", label: "X" }, { value: "y", label: "Y" }] },
        { key: "flag", label: "开关", type: "boolean", defaultValue: true },
      ] },
  ];
  const wrapper = mount(ExportPanel, { props: { converters } });
  await wrapper.find('[data-test="format-b"]').trigger("click");
  expect(wrapper.find('[data-test="format-opt-mode"]').exists()).toBe(true);
  await wrapper.find('[data-test="format-opt-mode"]').setValue("y");
  await wrapper.find('[data-test="format-opt-flag"]').setValue(false);
  await wrapper.find('[data-test="export"]').trigger("click");
  expect(wrapper.emitted("export")![0][0].options.formatOptions).toEqual({ mode: "y", flag: false });
});
```

- [ ] **Step 2: 实现类型与面板**

`runtime` 默认 `"browser"`（测试/旧注册项不写也能用）。`options` 可缺省。面板用 `v-for` 渲染 select/checkbox，label + hint。

- [ ] **Step 3: 验证**

`npm test -- tests/ExportPanel.test.ts tests/registry.test.ts`、`npm run typecheck`。

---

### Task 2: 单文件 HTML 转换器

**Files:**
- Create: `src/core/converters/html/index.ts`
- Modify: `src/core/converters/index.ts`（注册）
- Create: `tests/htmlConverter.test.ts`

**Interfaces:**
- `buildHtml(book: BookModel, options?: ConvertOptions): Promise<Blob>`。
- `htmlConverter: BookConverter`，`id: "html"`、`extension: "html"`、`mimeType: "text/html"`、`runtime: "browser"`。

要求：
- 单文件，无任何外部 `http(s)` 引用；封面与自定义背景转 `data:` URL（复用 `bytesToDataUrl`）。
- 主题 CSS + `layoutCss` 内联；背景预设由 CSS 生成。
- 书名页（`includeTitlePage`）、简介、目录页（`includeTocPage`，锚点 `<a href="#chapter-N">`）、卷扉页（`includeVolumePages`）、章节。
- 章节/卷/标题全部转义；目录嵌套：卷 → 章，根级章在根 `ol`，番外分组同样嵌套。
- `<meta charset="utf-8">`、`<title>` 用书名。

- [ ] **Step 1: 写失败测试**

```ts
it("builds a self-contained html document", async () => {
  const blob = await buildHtml(book, { themeId: "paper", includeTocPage: true, includeTitlePage: true, includeVolumePages: true });
  const text = await blob.text();
  expect(text.startsWith("<!DOCTYPE html>")).toBe(true);
  expect(text).toContain(themes.paper.css);
  expect(text).toContain('id="chapter-1"');
  expect(text).toContain('href="#chapter-1"');
  expect(text).toContain("data:image/png;base64,");
  expect(text).not.toMatch(/src="https?:/);
  expect(text).not.toMatch(/href="https?:/);
});
it("escapes titles and omits optional pages", async () => {
  const text = await (await buildHtml(bookWithEvilTitle, { includeTocPage: false, includeTitlePage: false, includeVolumePages: false })).text();
  expect(text).toContain("&lt;script&gt;");
  expect(text).not.toContain('class="title-page"');
  expect(text).not.toContain('class="toc-page"');
  expect(text).not.toContain('class="volume-page"');
});
```

- [ ] **Step 2: 实现**

复用 `themes`、`layoutCss`、`renderChapterBody`、`renderVolumeBody`、`bytesToDataUrl`。卷页只在 `kind === "volume"` 且开关开启时输出。目录页码不需要（HTML 用锚点）。

- [ ] **Step 3: 验证**

`npm test -- tests/htmlConverter.test.ts tests/registry.test.ts`，并确认 `listConverters()` 包含 `html`。

---

### Task 3: 整理版 TXT 转换器

**Files:**
- Create: `src/core/converters/txt/index.ts`
- Modify: `src/core/converters/index.ts`
- Create: `tests/txtConverter.test.ts`

**Interfaces:**
- `buildTxt(book, options): Promise<Blob>`；`txtConverter`：`id: "txt"`、`extension: "txt"`、`mimeType: "text/plain;charset=utf-8"`、`runtime: "browser"`、选项 `includeIntro`（默认 true）、`includeVolumeTitles`（默认 true）。

格式规则：
- 开头可选（`includeTitlePage`）输出书名、作者，各占一行，后接空行。
- 卷标题独占一行（`includeVolumeTitles` 为 true）；章标题独占一行；正文原样，行尾 trim；连续空行折叠为一个。
- 简介章（`kind === "intro"`）在 `includeIntro` 为 false 时跳过；番外分组输出“番外”标题（若开启卷标题）。
- 输出以 `\n` 结尾，无 BOM。

- [ ] **Step 1: 写失败测试**

```ts
it("writes volumes, chapters and collapses blank lines", async () => {
  const text = await (await buildTxt(book, { formatOptions: { includeIntro: true, includeVolumeTitles: true } })).text();
  expect(text).toContain("第一卷 风起");
  expect(text).toContain("第一章 重逢");
  expect(text).not.toMatch(/\n{3,}/);
  expect(text.endsWith("\n")).toBe(true);
});
it("can omit intro and volume titles", async () => {
  const text = await (await buildTxt(book, { formatOptions: { includeIntro: false, includeVolumeTitles: false } })).text();
  expect(text).not.toContain("简介");
  expect(text).not.toContain("第一卷 风起");
});
```

- [ ] **Step 2: 实现**

注意跳过空章节正文，避免出现连续空行；番外分组标题只输出一次。

- [ ] **Step 3: 验证**

`npm test`、`npm run typecheck`、`npm run build:web`。

---

## 完成标准

- 注册表包含 epub/html/txt 三种可用格式。
- HTML 单文件可离线打开，主题、封面、卷页、目录与预览一致。
- TXT 无 BOM、结构清晰、空行稳定。
- 全量测试与构建通过。
