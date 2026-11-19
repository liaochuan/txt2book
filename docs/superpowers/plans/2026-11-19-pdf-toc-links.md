# PDF 目录链接 Implementation Plan

**Goal:** 目录页的每一行可点击，跳转到对应章节/卷页。

## Global Constraints

- 不改变两遍排版、页码、书签、字体逻辑。
- 只链接标题行区域；页码仍为纯文本。
- 目标名 ASCII 唯一。

---

### Task 1: 命名目标与目录链接

**Files:**
- Modify: `server/lib/pdf/render.ts`
- Modify: `tests/server/pdf.test.ts`

**Interfaces:**
- 内部新增 `destinationName(kind: "chapter" | "volume", index: number): string`。
- 章节/卷页开始时调用 `doc.addNamedDestination(name, "XYZ", x, y, null)`。
- 目录行使用 `doc.text(title, x, y, { width, goTo: name, ... })`（或先 `doc.text` 再 `doc.goTo`，以实际渲染宽度为准）。
- 仅当 `includeTocPage === true` 时生成链接。

- [ ] **Step 1: 写失败测试**

```ts
it("adds link annotations from the toc to chapters", async () => {
  const result = await renderPdf(bookWithToc, { ...options, includeTocPage: true });
  const pdf = result.buffer.toString("latin1");
  expect(pdf).toContain("/Annots");
  expect(pdf).toContain("/S /GoTo");
  expect(pdf).toContain("/D (chapter-1)");
  const links = pdf.match(/\/S \/GoTo/g)?.length ?? 0;
  expect(links).toBeGreaterThanOrEqual(bookWithToc.chapters.length);
});
it("does not add toc links when includeTocPage is false", async () => {
  const pdf = (await renderPdf(bookWithToc, { ...options, includeTocPage: false })).buffer.toString("latin1");
  expect(pdf).not.toContain("/S /GoTo");
});
```

- [ ] **Step 2: 实现**

在章节页/卷页绘制标题前注册命名目标；在目录页绘制标题时附带 `goTo`。目标名与现有书签逻辑解耦，不要复用书签内部对象。

- [ ] **Step 3: 验证**

Run: `npm test -- tests/server/pdf.test.ts`；然后用生成的 PDF 在阅读器中人工点击一次目录（记入报告）。

## 完成标准

- 目录页每章/每卷可点击跳转。
- 关闭目录页时不产生多余链接。
- 现有页码、书签、分页测试全绿。
