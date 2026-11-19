import { describe, expect, it } from "vitest";
import { buildHtml } from "../src/core/converters/html";
import type { BookModel } from "../src/types/book";

const book: BookModel = {
  meta: { title: "测试书", author: "作者", language: "zh-CN", description: "简介" },
  volumes: [{ id: "v1", title: "第一卷", kind: "volume", lines: ["卷首语"] }],
  chapters: [
    { id: "c1", title: "第一章", kind: "chapter", lines: ["正文一"], volumeId: "v1" },
    { id: "c2", title: "第二章", kind: "chapter", lines: ["正文二"], volumeId: "v1" },
  ],
  cover: null,
};

const options = {
  themeId: "paper" as const,
  includeTocPage: false,
  includeTitlePage: true,
  includeVolumePages: true,
};

const evilBook: BookModel = {
  meta: { title: "安全测试", author: "作者", language: "zh-CN" },
  volumes: [],
  chapters: [
    {
      id: "c1",
      title: "<script>alert(1)</script>",
      kind: "chapter",
      lines: ["<script>alert(2)</script>"],
      volumeId: null,
    },
  ],
  cover: null,
};

describe("html sidebar", () => {
  it("always renders sidebar controls and reuses chapter anchors", async () => {
    const html = await (await buildHtml(book, options)).text();

    expect(html).toContain('id="book-sidebar"');
    expect(html).toContain('id="book-sidebar-toggle"');
    expect(html).toContain('aria-controls="book-sidebar"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('class="book-sidebar-close"');
    expect(html).toContain('aria-label="关闭目录"');
    expect(html).toContain('for="book-search"');
    expect(html).toContain('id="book-search"');
    expect(html).toContain('type="search"');
    expect(html).toContain('id="book-search-results"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('<nav class="book-toc" aria-label="章节目录">');
    expect(html).toContain('href="#chapter-1"');
    expect(html).toContain('href="#chapter-2"');
    expect(html).toContain('href="#volume-1"');
    // 侧栏始终生成，正文目录页仍由 includeTocPage 控制。
    expect(html).not.toContain('class="toc-page"');
  });

  it("renders the body toc page only when includeTocPage is enabled", async () => {
    const withPage = await (await buildHtml(book, { ...options, includeTocPage: true })).text();
    const withSidebar = await (await buildHtml(book, options)).text();

    expect(withPage).toContain('class="toc-page"');
    expect(withSidebar).not.toContain('class="toc-page"');
    expect(withPage).toContain('<nav class="book-toc" aria-label="章节目录">');
  });

  it("contains responsive drawer and print styles", async () => {
    const html = await (await buildHtml(book, options)).text();

    expect(html).toContain("body.nav-open");
    expect(html).toContain(".book-sidebar-overlay");
    expect(html).toContain("body.nav-open .book-sidebar-toggle");
    expect(html).toContain("visibility: hidden");
    expect(html).toContain("transition: transform 0.2s ease, visibility 0s linear 0.2s");
    expect(html).toContain("@media (max-width: 900px)");
    expect(html).toContain("@media print");
    expect(html).toContain("margin-left: 280px");
    expect(html).toContain("overflow: visible !important");
  });

  it("localizes sidebar text from the book language", async () => {
    const english: BookModel = {
      ...book,
      meta: { ...book.meta, language: "en" },
    };
    const html = await (await buildHtml(english, options)).text();

    expect(html).toContain('aria-expanded="false">Contents</button>');
    expect(html).toContain('aria-label="Sidebar"');
    expect(html).toContain('aria-label="Close contents"');
    expect(html).toContain('for="book-search">Search</label>');
    expect(html).toContain('placeholder="Search chapters or text"');
    expect(html).toContain('data-empty-label="No results found"');
    expect(html).toContain('<nav class="book-toc" aria-label="Contents">');
  });

  it("stays self-contained with no external references or inline style attributes", async () => {
    const html = await (await buildHtml(book, options)).text();

    expect(html).not.toMatch(/(src|href)="https?:/i);
    expect(html).not.toMatch(/<(aside|button|input|nav|div|ul|li)[^>]*\sstyle=/i);
    expect(html).not.toContain("@import");
    expect(html).not.toContain("@font-face");
  });

  it("escapes script tags in book content and only emits the sidebar script", async () => {
    const html = await (await buildHtml(evilBook, options)).text();
    const scripts = html.match(/<script/gi) ?? [];

    expect(scripts).toHaveLength(1);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");

    const script = /<script>([\s\S]*?)<\/script>/i.exec(html)?.[1] ?? "";
    expect(script).toContain('addEventListener("input"');
    expect(script).toContain("textContent");
    expect(script).not.toMatch(/innerHTML\s*=/);
  });
});
