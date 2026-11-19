# HTML 侧栏目录与搜索 Implementation Plan

**Goal:** 单文件 HTML 增加固定侧栏目录、全文搜索、移动端折叠；保持无外链。

## Global Constraints

- 仍是单文件 HTML，无 `http(s)` 外链。
- 书内容只能通过 `textContent` 进入 DOM，禁止 `innerHTML` 插入书名/标题/正文。
- 搜索最多 50 条、输入防抖 200ms、片段 60 字。
- 正文目录页（`includeTocPage`）行为不变；侧栏始终生成。

---

### Task 1: 侧栏结构、样式与目录

**Files:**
- Modify: `src/core/converters/html/index.ts`
- Create: `tests/htmlSidebar.test.ts`

**Interfaces:**
- 生成：
  ```html
  <button id="book-sidebar-toggle" class="book-sidebar-toggle" aria-controls="book-sidebar" aria-expanded="false">目录</button>
  <aside id="book-sidebar" class="book-sidebar">
    <div class="book-sidebar-head">
      <strong>目录</strong>
      <button type="button" class="book-sidebar-close" aria-label="关闭目录">×</button>
    </div>
    <label class="book-search-label" for="book-search">搜索</label>
    <input id="book-search" type="search" placeholder="搜索章节或正文" autocomplete="off" />
    <ul id="book-search-results" class="book-search-results" aria-live="polite"></ul>
    <nav class="book-toc" aria-label="章节目录">…复用卷/章锚点…</nav>
  </aside>
  ```
- 章节 `<section>` 需要 `data-title`（纯文本标题）供搜索使用，或脚本读取内部 `<h1>`；优先读取现有标题元素，不加冗余属性。
- 样式内联：桌面左侧 280px 固定；正文加左边距；≤900px 侧栏变为抽屉，默认隐藏，`body.nav-open` 时显示遮罩；打印时隐藏侧栏与按钮。
- 无 JS 时侧栏仍可显示目录（桌面），移动端按钮无效但不影响正文阅读。

- [ ] **Step 1: 写失败测试**

```ts
it("includes a sidebar toc with search controls", async () => {
  const html = await (await buildHtml(book, options)).text();
  expect(html).toContain('id="book-sidebar"');
  expect(html).toContain('id="book-search"');
  expect(html).toContain('id="book-search-results"');
  expect(html).toContain('id="book-sidebar-toggle"');
  expect(html).toContain('aria-label="章节目录"');
  expect(html).toContain('href="#chapter-1"');
});
it("keeps the file self-contained", async () => {
  const html = await (await buildHtml(book, options)).text();
  expect(html).not.toMatch(/(src|href)="https?:/);
});
```

- [ ] **Step 2: 实现**，样式与正文布局以内联 CSS 写入。

---

### Task 2: 内联搜索脚本与交互

**Files:**
- Modify: `src/core/converters/html/index.ts`
- Create: `tests/htmlSearch.test.ts`

**行为：**
- 页面加载时收集所有 `section.chapter`：`id`、标题（首个 `h1` 的 textContent）、正文 `textContent`。
- 输入变化 200ms 防抖后搜索：标题命中优先，其次正文；不区分大小写；最多 50 条。
- 结果项为 `<button>`，显示章节标题 + 上下文片段（命中词前后各 30 字）；点击 `scrollIntoView` 并更新 `location.hash`，关闭移动端抽屉。
- 片段高亮用 `document.createElement("mark")` + `textContent`，不使用 `innerHTML`。
- `Escape` 关闭抽屉；点击遮罩关闭；`#book-sidebar-toggle` 切换 `body.nav-open` 与 `aria-expanded`。
- 滚动时用 `IntersectionObserver`（可用时）给当前章节目录项加 `aria-current="true"`，不可用时跳过。
- 脚本包在 IIFE 中，`"use strict"`，不依赖外部库。

- [ ] **Step 1: 写失败测试**

用 `happy-dom` 的 `Window` 加载生成的 HTML 并执行脚本：
```ts
const window = new Window({ url: "file:///book.html" });
window.document.write(html);
window.document.close();
// 若 happy-dom 不自动执行内联脚本，则提取 <script> 文本并 window.eval(script)
const input = window.document.getElementById("book-search") as HTMLInputElement;
input.value = "关键词";
input.dispatchEvent(new window.Event("input"));
await new Promise((r) => setTimeout(r, 250));
expect(window.document.querySelectorAll("#book-search-results li").length).toBeGreaterThan(0);
```
若无法执行脚本，至少断言脚本包含 `addEventListener("input"`、`textContent`，并在报告中注明需浏览器手工验收。

- [ ] **Step 2: 实现并验证**

Run: `npm test -- tests/htmlSidebar.test.ts tests/htmlSearch.test.ts`、`npm run typecheck`、`npm run build:web`。

## 完成标准

- 桌面端左侧目录固定，点击跳转正确。
- 搜索能找到标题与正文，结果显示片段并可跳转。
- 移动端抽屉可开关、Esc 可关闭。
- 单文件无外链，书内容未进入 innerHTML。
- 目录页选项与预览/EPUB 行为不受影响。
