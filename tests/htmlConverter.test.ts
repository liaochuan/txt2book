import { describe, expect, it } from "vitest";
import { buildHtml, htmlConverter } from "../src/core/converters/html";
import { defaultLayoutFor } from "../src/core/render/layout";
import { themes } from "../src/core/render/themes";
import type { BookModel } from "../src/types/book";

const book: BookModel = {
  meta: { title: "测试书", author: "作者", language: "zh-CN", description: "简介" },
  volumes: [{ id: "v1", title: "第一卷", kind: "volume", lines: ["卷首语", "第二行"] }],
  chapters: [
    { id: "c1", title: "第一章", kind: "chapter", lines: ["正文一"], volumeId: "v1" },
    { id: "c2", title: "第二章", kind: "chapter", lines: ["正文二"], volumeId: "v1" },
  ],
  cover: { png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), width: 2, height: 2 },
};

const evilBook: BookModel = {
  meta: {
    title: "<script>alert(1)</script>",
    author: "<b>作者</b>",
    language: "zh-CN",
    description: "<script>alert(1)</script>",
  },
  volumes: [{ id: "v1", title: "<i>第一卷</i>", kind: "volume", lines: ["<script>alert(1)</script>"] }],
  chapters: [
    {
      id: "c1",
      title: "<script>alert(1)</script>",
      kind: "chapter",
      lines: ["<script>alert(1)</script>"],
      volumeId: "v1",
    },
  ],
  cover: null,
};

const options = {
  themeId: "paper" as const,
  includeTocPage: true,
  includeTitlePage: true,
  includeVolumePages: true,
};

describe("buildHtml", () => {
  it("builds a self-contained html document", async () => {
    const blob = await buildHtml(book, options);
    const text = await blob.text();

    expect(blob.type).toBe("text/html");
    expect(text.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(text).toContain(themes.paper.css);
    expect(text).toContain('id="chapter-1"');
    expect(text).toContain('href="#chapter-1"');
    expect(text).toContain("data:image/png;base64,");
    expect(text).toContain('<header class="txt2book cover-page">');
    expect(text).toContain('<html lang="zh-CN">');
    expect(text).toContain("<title>测试书</title>");
    expect(text).not.toMatch(/src="https?:/);
    expect(text).not.toMatch(/href="https?:/);
  });

  it("escapes titles and omits optional pages", async () => {
    const text = await (
      await buildHtml(evilBook, {
        includeTocPage: false,
        includeTitlePage: false,
        includeVolumePages: false,
      })
    ).text();

    expect(text).toContain("&lt;script&gt;");
    // 只允许生成器自己的内联侧栏脚本；书名/正文里的 script 必须保持转义文本。
    expect(text.match(/<script/gi) ?? []).toHaveLength(1);
    expect(text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(text).not.toContain('class="title-page"');
    expect(text).not.toContain('class="toc-page"');
    expect(text).not.toContain('class="volume-page"');
  });

  it("renders volume pages with their lines and anchors", async () => {
    const text = await (await buildHtml(book, options)).text();

    expect(text).toContain('<section class="volume-page" id="volume-1">');
    expect(text).toContain('<h1 class="volume-title">第一卷</h1>');
    expect(text).toContain('<p class="volume-note">卷首语</p>');
    expect(text).toContain('<p class="volume-note">第二行</p>');

    const firstChapter = text.slice(text.indexOf('id="chapter-1"'), text.indexOf('id="chapter-2"'));
    expect(firstChapter).not.toContain("volume-note-block");
  });

  it("moves volume lines into the first chapter when volume pages are off", async () => {
    const text = await (await buildHtml(book, { ...options, includeVolumePages: false })).text();

    expect(text).not.toContain('class="volume-page"');
    expect(text).toContain('<section class="volume-note-block">');
    expect(text).toContain('<h2 class="volume-title">第一卷</h2>');
    expect(text).toContain('<p class="volume-note">卷首语</p>');

    const firstChapter = text.slice(text.indexOf('id="chapter-1"'), text.indexOf('id="chapter-2"'));
    expect(firstChapter).toContain('class="volume-note-block"');
    expect(firstChapter).toContain("卷首语");
  });

  it("keeps volume pages when the book has no chapters and pages are off", async () => {
    const empty: BookModel = { ...book, chapters: [], cover: null };
    const text = await (
      await buildHtml(empty, { ...options, includeVolumePages: false })
    ).text();

    expect(text).toContain('<section class="volume-page" id="volume-1">');
    expect(text).toContain("卷首语");
  });

  it("attaches multiple volume notes to the same chapter in volume order", async () => {
    const multi: BookModel = {
      meta: book.meta,
      volumes: [
        { id: "v1", title: "前卷", kind: "volume", lines: ["前卷序"] },
        { id: "v2", title: "后卷", kind: "volume", lines: ["后卷序"] },
      ],
      chapters: [{ id: "c1", title: "唯一章", kind: "chapter", lines: ["正文"], volumeId: "v2" }],
      cover: null,
    };

    const text = await (
      await buildHtml(multi, { ...options, includeVolumePages: false })
    ).text();

    expect(text.match(/class="volume-note-block"/g)).toHaveLength(2);
    expect(text).toContain('<h2 class="volume-title">前卷</h2>');
    expect(text).toContain('<h2 class="volume-title">后卷</h2>');
    expect(text.indexOf("前卷序")).toBeLessThan(text.indexOf("后卷序"));
  });

  it("lists zero-chapter volumes pointing at their page anchor", async () => {
    const withEmptyVolume: BookModel = {
      ...book,
      volumes: [book.volumes[0], { id: "v2", title: "零章卷", kind: "volume" }],
      chapters: [book.chapters[0]],
      cover: null,
    };

    const text = await (await buildHtml(withEmptyVolume, options)).text();

    expect(text).toContain('<li><a href="#volume-2">零章卷</a></li>');
    expect(text).toContain('id="volume-2"');
  });

  it("inlines a custom background as a jpeg data url", async () => {
    const layout = defaultLayoutFor("paper");
    layout.background = {
      kind: "custom",
      custom: {
        data: new Uint8Array([0xff, 0xd8, 0xff]),
        mimeType: "image/jpeg",
        width: 1,
        height: 1,
        fileName: "background.jpg",
      },
    };

    const text = await (await buildHtml({ ...book, cover: null }, { ...options, layout })).text();

    expect(text).toContain("data:image/jpeg;base64,");
    expect(text).toContain('background-image: url("data:image/jpeg;base64,');
  });

  it("renders preset backgrounds with css gradients", async () => {
    const layout = defaultLayoutFor("paper");
    layout.background = { kind: "preset", presetId: "paper" };

    const text = await (await buildHtml({ ...book, cover: null }, { ...options, layout })).text();

    expect(text).toContain("repeating-linear-gradient");
  });

  it("nests toc entries under their volume or extra group", async () => {
    const grouped: BookModel = {
      ...book,
      volumes: [
        { id: "v1", title: "第一卷", kind: "volume" },
        { id: "v2", title: "番外", kind: "extra-group" },
      ],
      chapters: [
        { id: "c1", title: "第一章", kind: "chapter", lines: ["正文一"], volumeId: "v1" },
        { id: "c2", title: "第二章", kind: "chapter", lines: ["正文二"], volumeId: "v1" },
        { id: "c3", title: "独立章", kind: "chapter", lines: ["正文三"], volumeId: null },
        { id: "c4", title: "番外一", kind: "extra", lines: ["正文四"], volumeId: "v2" },
      ],
    };

    const text = await (await buildHtml(grouped, options)).text();

    expect(text).toMatch(
      /<li><a href="#volume-1">第一卷<\/a>\s*<ol>[\s\S]*href="#chapter-2"[\s\S]*<\/ol>\s*<\/li>/,
    );
    expect(text).toMatch(
      /<li><a href="#chapter-4">番外<\/a>\s*<ol>[\s\S]*href="#chapter-4"[\s\S]*<\/ol>\s*<\/li>/,
    );
    expect(text).toContain('<li><a href="#chapter-3">独立章</a></li>');
    // 番外分组只是目录分组，不生成卷扉页。
    expect(text.match(/class="volume-page"/g)).toHaveLength(1);
  });

  it("exposes html converter metadata", () => {
    expect(htmlConverter).toMatchObject({
      id: "html",
      label: "HTML",
      extension: "html",
      mimeType: "text/html",
      available: true,
      runtime: "browser",
    });
  });
});
