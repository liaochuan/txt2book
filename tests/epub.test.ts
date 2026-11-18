import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { buildEpub, epubConverter } from "../src/core/converters/epub";
import { DEFAULT_THEME_ID, themes } from "../src/core/render/themes";
import type { ConvertOptions } from "../src/core/converters/types";
import type { BookModel } from "../src/types/book";

const book: BookModel = {
  meta: { title: "测试书", author: "作者", language: "zh-CN", description: "简介" },
  volumes: [{ id: "v1", title: "第一卷", kind: "volume" }],
  chapters: [
    { id: "c1", title: "第一章", kind: "chapter", lines: ["正文一"], volumeId: "v1" },
    { id: "c2", title: "第二章", kind: "chapter", lines: ["正文二"], volumeId: "v1" },
  ],
  cover: { png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), width: 2, height: 2 },
};

const options: ConvertOptions = {
  themeId: "paper",
  includeTocPage: true,
  includeTitlePage: true,
  includeVolumePages: true,
};

/** 生成 EPUB 并解压，返回 zip 与原始字节。 */
async function build(source: BookModel = book, opts: ConvertOptions = options) {
  const bytes = new Uint8Array(await (await buildEpub(source, opts)).arrayBuffer());
  const zip = await JSZip.loadAsync(bytes);
  const text = async (path: string) => {
    const file = zip.file(path);
    if (!file) throw new Error(`missing ${path}: ${Object.keys(zip.files).join(", ")}`);
    return file.async("string");
  };
  return { bytes, zip, text };
}

describe("buildEpub", () => {
  it("writes an uncompressed mimetype first and a valid container", async () => {
    const zip = await JSZip.loadAsync(await (await buildEpub(book, options)).arrayBuffer());
    expect(await zip.file("mimetype")!.async("string")).toBe("application/epub+zip");
    expect(await zip.file("META-INF/container.xml")!.async("string")).toContain("OEBPS/content.opf");
  });

  it("includes one xhtml per chapter and a nested nav", async () => {
    const zip = await JSZip.loadAsync(await (await buildEpub(book, options)).arrayBuffer());
    const nav = await zip.file("OEBPS/nav.xhtml")!.async("string");
    expect(nav).toContain("第一卷");
    expect(nav).toContain("第一章");
    expect(Object.keys(zip.files).filter((f) => /chapter-\d+\.xhtml$/.test(f))).toHaveLength(2);
  });

  it("stores the cover as png and declares it", async () => {
    const zip = await JSZip.loadAsync(await (await buildEpub(book, options)).arrayBuffer());
    const opf = await zip.file("OEBPS/content.opf")!.async("string");
    expect(opf).toContain('media-type="image/png"');
    expect(opf).toContain('properties="cover-image"');
    expect(zip.file("OEBPS/images/cover.png")).toBeTruthy();
  });

  it("links the selected theme stylesheet", async () => {
    const zip = await JSZip.loadAsync(await (await buildEpub(book, options)).arrayBuffer());
    const styles = await zip.file("OEBPS/styles/theme.css")!.async("string");
    expect(styles).toContain(".txt2book");
  });

  it("omits optional pages when disabled", async () => {
    const zip = await JSZip.loadAsync(
      await (
        await buildEpub(book, {
          ...options,
          includeTitlePage: false,
          includeTocPage: false,
          includeVolumePages: false,
        })
      ).arrayBuffer(),
    );
    expect(zip.file("OEBPS/titlepage.xhtml")).toBeNull();
    expect(zip.file("OEBPS/volume-1.xhtml")).toBeNull();
    const opf = await zip.file("OEBPS/content.opf")!.async("string");
    expect(opf).toMatch(/idref="nav"[^>]*linear="no"/);
  });
});

describe("buildEpub entry order", () => {
  it("puts mimetype at offset 0 and stores it without compression", async () => {
    const { bytes } = await build();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // 第一个 local file header 从 0 开始：压缩方法在偏移 8（0 = STORE）
    expect(view.getUint16(8, true)).toBe(0);
    const nameLength = view.getUint16(26, true);
    const name = new TextDecoder().decode(bytes.subarray(30, 30 + nameLength));
    expect(name).toBe("mimetype");
  });
});

describe("buildEpub structure", () => {
  it("renders cover page, title page and volume page", async () => {
    const { zip, text } = await build();
    const cover = await text("OEBPS/cover.xhtml");
    expect(cover).toContain('src="images/cover.png"');
    expect(cover).toContain('<body class="txt2book cover-page">');

    const titlepage = await text("OEBPS/titlepage.xhtml");
    expect(titlepage).toContain('<h1 class="book-title">测试书</h1>');
    expect(titlepage).toContain('<p class="book-author">作者</p>');
    expect(zip.file("OEBPS/volume-1.xhtml")).toBeTruthy();
    const volume = await text("OEBPS/volume-1.xhtml");
    expect(volume).toContain('<h1 class="volume-title">第一卷</h1>');
  });

  it("emits a standalone description page even without a title page", async () => {
    const { zip, text } = await build(book, { ...options, includeTitlePage: false });
    expect(zip.file("OEBPS/titlepage.xhtml")).toBeNull();
    expect(zip.file("OEBPS/description.xhtml")).toBeTruthy();

    const page = await text("OEBPS/description.xhtml");
    expect(page).toContain('<section class="description-page">');
    expect(page).toContain('<h1 class="description-title">简介</h1>');
    expect(page).toContain("<p>简介</p>");

    const opf = await text("OEBPS/content.opf");
    expect(opf).toMatch(/<itemref idref="description"\/>/);
    expect(opf.indexOf('idref="description"')).toBeLessThan(opf.indexOf('idref="nav"'));
  });

  it("keeps paragraph breaks in the description page", async () => {
    const { text } = await build({
      ...book,
      meta: { ...book.meta, description: "第一段第一行\n第一段第二行\n\n第二段" },
    });
    const page = await text("OEBPS/description.xhtml");
    expect(page).toContain(
      '<p>第一段第一行</p>\n<p>第一段第二行</p>\n<p class="paragraph-start">第二段</p>',
    );
  });

  it("skips the description page when there is no description", async () => {
    const { zip } = await build({ ...book, meta: { ...book.meta, description: undefined } });
    expect(zip.file("OEBPS/description.xhtml")).toBeNull();
  });

  it("renders a volume page for a volume without chapters", async () => {
    const { zip, text } = await build({
      ...book,
      volumes: [
        { id: "v1", title: "空卷", kind: "volume", lines: ["空卷卷首"] },
        { id: "v2", title: "第二卷", kind: "volume" },
      ],
      chapters: [{ id: "c1", title: "第一章", kind: "chapter", lines: ["正文"], volumeId: "v2" }],
    });
    expect(zip.file("OEBPS/volume-1.xhtml")).toBeTruthy();
    expect(await text("OEBPS/volume-1.xhtml")).toContain('<p class="volume-note">空卷卷首</p>');
    const nav = await text("OEBPS/nav.xhtml");
    expect(nav).toContain('<a href="volume-1.xhtml">空卷</a>');
    const ncx = await text("OEBPS/toc.ncx");
    expect(ncx).toContain('src="volume-1.xhtml"');
    const opf = await text("OEBPS/content.opf");
    expect(opf).toMatch(/<itemref idref="volume-1"\/>\s*<itemref idref="volume-2"\/>/);
  });

  it("keeps the cover bytes untouched (no transcode)", async () => {
    const { zip } = await build();
    const png = await zip.file("OEBPS/images/cover.png")!.async("uint8array");
    expect(Array.from(png)).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("declares metadata, dcterms:modified and the ncx", async () => {
    const { text } = await build();
    const opf = await text("OEBPS/content.opf");
    expect(opf).toContain('<dc:identifier id="bookid">urn:uuid:');
    expect(opf).toContain("<dc:title>测试书</dc:title>");
    expect(opf).toContain("<dc:creator>作者</dc:creator>");
    expect(opf).toContain("<dc:language>zh-CN</dc:language>");
    expect(opf).toContain("<dc:description>简介</dc:description>");
    expect(opf).toMatch(/<meta property="dcterms:modified">\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z<\/meta>/);
    expect(opf).toContain('href="toc.ncx" media-type="application/x-dtbncx+xml"');
    expect(opf).toContain('properties="nav"');

    const ncx = await text("OEBPS/toc.ncx");
    expect(ncx).toContain('<navPoint id="navPoint-1"');
    expect(ncx).toContain("第一卷");
    expect(ncx).toContain("第一章");
    expect(ncx).toContain('src="volume-1.xhtml"');
  });

  it("orders the spine cover → title → description → nav → volume → chapters", async () => {
    const { text } = await build();
    const opf = await text("OEBPS/content.opf");
    expect(opf).toMatch(
      /<itemref idref="cover-page"\/>\s*<itemref idref="titlepage"\/>\s*<itemref idref="description"\/>\s*<itemref idref="nav"\/>\s*<itemref idref="volume-1"\/>\s*<itemref idref="chapter-1"\/>\s*<itemref idref="chapter-2"\/>/,
    );
  });

  it("writes chapters in text/ with the shared theme link and hidden title", async () => {
    const { zip, text } = await build();
    expect(zip.file("OEBPS/text/chapter-1.xhtml")).toBeTruthy();
    const chapter = await text("OEBPS/text/chapter-1.xhtml");
    expect(chapter).toContain('<html xmlns="http://www.w3.org/1999/xhtml"');
    expect(chapter).toContain('<link rel="stylesheet" href="../styles/theme.css"/>');
    expect(chapter).toContain('<h1 class="title-anchor" aria-hidden="true">第一章</h1>');
    expect(chapter).toContain('<h1 class="chapter-title">第一章</h1>');
    expect(chapter).toContain("<p>正文一</p>");
    expect(chapter).toContain('<body class="txt2book">');
  });

  it("nests chapters under their volume in nav", async () => {
    const { text } = await build();
    const nav = await text("OEBPS/nav.xhtml");
    expect(nav).toMatch(/<a href="volume-1\.xhtml">第一卷<\/a>\s*<ol>/);
    expect(nav).toContain('<a href="text/chapter-1.xhtml">第一章</a>');
    expect(nav).toContain('<a href="text/chapter-2.xhtml">第二章</a>');
  });

  it("nests the extra group in nav without a volume page", async () => {
    const { zip, text } = await build({
      ...book,
      volumes: [
        { id: "v1", title: "第一卷", kind: "volume" },
        { id: "v2", title: "番外", kind: "extra-group" },
      ],
      chapters: [
        { id: "c1", title: "第一章", kind: "chapter", lines: ["正文一"], volumeId: "v1" },
        { id: "c2", title: "番外一", kind: "extra", lines: ["番外正文"], volumeId: "v2" },
      ],
    });
    expect(zip.file("OEBPS/volume-2.xhtml")).toBeNull();
    const nav = await text("OEBPS/nav.xhtml");
    expect(nav).toMatch(/<a href="text\/chapter-2\.xhtml">番外<\/a>\s*<ol>/);
    expect(nav).toContain('<a href="text/chapter-2.xhtml">番外一</a>');
    const ncx = await text("OEBPS/toc.ncx");
    // 分组节点与首个章节同文件时用锚点区分，避免 NCX 目标重复。
    expect(ncx).toContain('src="text/chapter-2.xhtml#chapter-2"');
    expect(ncx).toContain('src="text/chapter-2.xhtml"/>');
  });

  it("keeps volume-less chapters at the root of the nav list", async () => {
    const { text } = await build({
      ...book,
      volumes: [],
      chapters: [
        { id: "c1", title: "第一章", kind: "chapter", lines: ["正文一"], volumeId: null },
        { id: "c2", title: "第二章", kind: "chapter", lines: ["正文二"], volumeId: null },
      ],
    });
    const nav = await text("OEBPS/nav.xhtml");
    expect(nav).toMatch(/<ol>\s*<li><a href="text\/chapter-1\.xhtml">第一章<\/a><\/li>/);
  });

  it("escapes xml in every generated page", async () => {
    const { text } = await build({
      ...book,
      meta: { ...book.meta, title: "书 & <名>", author: "甲 & 乙" },
      chapters: [
        { id: "c1", title: "第一章 \"引\" & <号>", kind: "chapter", lines: ["a & b"], volumeId: null },
      ],
    });
    const nav = await text("OEBPS/nav.xhtml");
    expect(nav).toContain("书 &amp; &lt;名&gt;");
    expect(nav).toContain("第一章 &quot;引&quot; &amp; &lt;号&gt;");
    const titlepage = await text("OEBPS/titlepage.xhtml");
    expect(titlepage).toContain("<h1 class=\"book-title\">书 &amp; &lt;名&gt;</h1>");
    expect(titlepage).toContain("甲 &amp; 乙");
    const chapter = await text("OEBPS/text/chapter-1.xhtml");
    expect(chapter).toContain("<p>a &amp; b</p>");
  });

  it("skips the cover page when the book has no cover", async () => {
    const { zip, text } = await build({ ...book, cover: null });
    expect(zip.file("OEBPS/cover.xhtml")).toBeNull();
    expect(zip.file("OEBPS/images/cover.png")).toBeNull();
    const opf = await text("OEBPS/content.opf");
    expect(opf).not.toContain('properties="cover-image"');
    expect(zip.file("OEBPS/nav.xhtml")).toBeTruthy();
  });

  it("falls back to one blank chapter for an empty book", async () => {
    const { text } = await build({
      meta: { title: "空书", author: "", language: "zh-CN" },
      volumes: [],
      chapters: [],
      cover: null,
    });
    const nav = await text("OEBPS/nav.xhtml");
    expect(nav).toContain('<a href="text/chapter-1.xhtml">正文</a>');
    const opf = await text("OEBPS/content.opf");
    expect(opf).toContain('href="text/chapter-1.xhtml"');
  });

  it("applies the default options when none are given", async () => {
    const { zip, text } = await build(book, {});
    expect(zip.file("OEBPS/titlepage.xhtml")).toBeNull();
    expect(zip.file("OEBPS/volume-1.xhtml")).toBeNull();
    const opf = await text("OEBPS/content.opf");
    expect(opf).toMatch(/idref="nav"[^>]*linear="no"/);

    // 默认关闭卷扉页时，卷标题与卷首文字以区块形式并入该卷第一章。
    const chapter = await text("OEBPS/text/chapter-1.xhtml");
    expect(chapter).toContain('<section class="volume-note-block">');
    expect(chapter).toContain('<h2 class="volume-title">第一卷</h2>');
  });

  it("localizes the empty-book fallback title", async () => {
    const { text } = await build({
      meta: { title: "Empty", author: "", language: "en" },
      volumes: [],
      chapters: [],
      cover: null,
    });
    const nav = await text("OEBPS/nav.xhtml");
    expect(nav).toContain('<a href="text/chapter-1.xhtml">Content</a>');
  });

  it("gives intro chapters their own file in the spine", async () => {
    const { zip, text } = await build({
      ...book,
      chapters: [{ id: "i1", title: "简介", kind: "intro", lines: ["开场"], volumeId: null }],
    });
    expect(zip.file("OEBPS/text/chapter-1.xhtml")).toBeTruthy();
    expect(await text("OEBPS/text/chapter-1.xhtml")).toContain("<p>开场</p>");
    const opf = await text("OEBPS/content.opf");
    expect(opf).toMatch(/<itemref idref="chapter-1"\/>/);
    const nav = await text("OEBPS/nav.xhtml");
    expect(nav).toContain('<a href="text/chapter-1.xhtml">简介</a>');
  });

  it("resolves every spine idref against the manifest", async () => {
    const { text } = await build();
    const opf = await text("OEBPS/content.opf");
    const manifestIds = new Set(
      [...opf.matchAll(/<item id="([^"]+)"/g)].map((match) => match[1]),
    );
    const spineIdrefs = [...opf.matchAll(/<itemref idref="([^"]+)"/g)].map((match) => match[1]);
    expect(spineIdrefs.length).toBeGreaterThan(0);
    for (const idref of spineIdrefs) {
      expect(manifestIds.has(idref)).toBe(true);
    }
  });

  it("keeps nav and ncx entries in the same order", async () => {
    const { text } = await build();
    const nav = await text("OEBPS/nav.xhtml");
    const navHrefs = [...nav.matchAll(/<a href="([^"]+)"/g)].map((match) => match[1]);
    const ncx = await text("OEBPS/toc.ncx");
    const ncxHrefs = [...ncx.matchAll(/<content src="([^"]+)"/g)].map(
      (match) => match[1].split("#")[0],
    );
    expect(navHrefs.length).toBe(3);
    expect(ncxHrefs).toEqual(navHrefs);
  });

  it("does not nest a chapter under a deleted volume in nav", async () => {
    for (const deletedVolumeId of [null, "v2"]) {
      const { text } = await build({
        ...book,
        cover: null,
        volumes: [{ id: "v1", title: "第一卷", kind: "volume" }],
        chapters: [
          { id: "c1", title: "章A", kind: "chapter", lines: ["A"], volumeId: "v1" },
          { id: "c2", title: "章B", kind: "chapter", lines: ["B"], volumeId: deletedVolumeId },
        ],
      });
      const nav = await text("OEBPS/nav.xhtml");
      const volumeList =
        /<a href="volume-1\.xhtml">第一卷<\/a>\s*<ol>([\s\S]*?)<\/ol>/.exec(nav)?.[1] ?? "";

      expect(volumeList).toContain("章A");
      expect(volumeList).not.toContain("章B");
      expect(nav).toMatch(/<li><a href="text\/chapter-2\.xhtml">章B<\/a><\/li>/);
    }
  });

  it("strips XML-invalid control characters from every page", async () => {
    const { text } = await build({
      ...book,
      cover: null,
      volumes: [],
      meta: { ...book.meta, title: "书\u0000名", description: "简\u0001介" },
      chapters: [
        {
          id: "c1",
          title: "章\u0001节",
          kind: "chapter",
          lines: ["正\u0000文", "第二\u000b行"],
          volumeId: null,
        },
      ],
    });
    const invalid = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;
    const chapter = await text("OEBPS/text/chapter-1.xhtml");
    expect(chapter).not.toMatch(invalid);
    expect(chapter).toContain("<p>正文</p>");
    expect(chapter).toContain("<p>第二行</p>");

    const nav = await text("OEBPS/nav.xhtml");
    expect(nav).not.toMatch(invalid);
    expect(nav).toContain("书名");
    expect(nav).toContain("章节");

    const titlepage = await text("OEBPS/titlepage.xhtml");
    expect(titlepage).not.toMatch(invalid);
    const description = await text("OEBPS/description.xhtml");
    expect(description).not.toMatch(invalid);
    const opf = await text("OEBPS/content.opf");
    expect(opf).not.toMatch(invalid);
  });
});

describe("volume lines", () => {
  const volumeBook: BookModel = {
    meta: { title: "卷首测试", author: "", language: "zh-CN" },
    volumes: [
      { id: "v1", title: "第一卷", kind: "volume", lines: ["卷首一", "", "卷首二"] },
    ],
    chapters: [
      { id: "c1", title: "第一章", kind: "chapter", lines: ["正文一"], volumeId: "v1" },
      { id: "c2", title: "第二章", kind: "chapter", lines: ["正文二"], volumeId: "v1" },
    ],
    cover: null,
  };

  it("renders volume lines as a volume-note block in the first chapter when volume pages are off", async () => {
    const snapshot = JSON.stringify(volumeBook);
    const { zip, text } = await build(volumeBook, { ...options, includeVolumePages: false });

    expect(zip.file("OEBPS/volume-1.xhtml")).toBeNull();
    const chapter = await text("OEBPS/text/chapter-1.xhtml");
    expect(chapter).toContain('<section class="volume-note-block">');
    expect(chapter).toContain('<h2 class="volume-title">第一卷</h2>');
    expect(chapter).toContain('<p class="volume-note">卷首一</p>');
    expect(chapter).toContain('<p class="volume-note">卷首二</p>');
    expect(chapter.indexOf("卷首一")).toBeLessThan(chapter.indexOf("正文一"));
    expect(chapter.match(/class="volume-note-block"/g) ?? []).toHaveLength(1);

    const second = await text("OEBPS/text/chapter-2.xhtml");
    expect(second).not.toContain("volume-note-block");
    expect(second).not.toContain("卷首一");
    // 生成过程不得改动调用方的 BookModel。
    expect(JSON.stringify(volumeBook)).toBe(snapshot);
  });

  it("keeps volume lines on the volume page when volume pages are on", async () => {
    const snapshot = JSON.stringify(volumeBook);
    const { text } = await build(volumeBook, { ...options, includeVolumePages: true });

    const page = await text("OEBPS/volume-1.xhtml");
    expect(page).toContain('<section class="volume-note-block">');
    expect(page).toContain('<p class="volume-note">卷首一</p>');

    // 卷扉页已经展示卷首文字，章节顶部不再重复同一区块。
    const chapter = await text("OEBPS/text/chapter-1.xhtml");
    expect(chapter).not.toContain("volume-note-block");
    expect(chapter.match(/class="volume-note-block"/g) ?? []).toHaveLength(0);
    expect(chapter).not.toContain("卷首一");
    expect(JSON.stringify(volumeBook)).toBe(snapshot);
  });

  it("carries a zero-chapter volume into the next chapter when volume pages are off", async () => {
    const source: BookModel = {
      meta: { title: "零章卷", author: "", language: "zh-CN" },
      volumes: [
        { id: "v1", title: "第一卷", kind: "volume" },
        { id: "v2", title: "空卷", kind: "volume", lines: ["空卷卷首"] },
        { id: "v3", title: "第三卷", kind: "volume" },
      ],
      chapters: [
        { id: "c1", title: "第一章", kind: "chapter", lines: ["正文一"], volumeId: "v1" },
        { id: "c2", title: "第二章", kind: "chapter", lines: ["正文二"], volumeId: "v3" },
      ],
      cover: null,
    };

    const { text } = await build(source, { ...options, includeVolumePages: false });
    const chapter = await text("OEBPS/text/chapter-2.xhtml");

    expect(chapter).toContain('<h2 class="volume-title">空卷</h2>');
    expect(chapter).toContain('<p class="volume-note">空卷卷首</p>');
    expect(chapter.indexOf("空卷卷首")).toBeLessThan(chapter.indexOf("正文二"));
  });

  it("keeps every zero-chapter volume block when several share one chapter", async () => {
    const source: BookModel = {
      meta: { title: "双空卷", author: "", language: "zh-CN" },
      volumes: [
        { id: "v1", title: "空卷一", kind: "volume", lines: ["卷一文字"] },
        { id: "v2", title: "空卷二", kind: "volume", lines: ["卷二文字"] },
      ],
      chapters: [
        { id: "c1", title: "唯一章", kind: "chapter", lines: ["正文"], volumeId: null },
      ],
      cover: null,
    };

    const { text } = await build(source, { ...options, includeVolumePages: false });
    const chapter = await text("OEBPS/text/chapter-1.xhtml");

    expect(chapter).toContain('<h2 class="volume-title">空卷一</h2>');
    expect(chapter).toContain('<h2 class="volume-title">空卷二</h2>');
    expect(chapter).toContain('<p class="volume-note">卷一文字</p>');
    expect(chapter).toContain('<p class="volume-note">卷二文字</p>');
    expect(chapter.indexOf("空卷一")).toBeLessThan(chapter.indexOf("空卷二"));
    expect(chapter.match(/class="volume-note-block"/g) ?? []).toHaveLength(2);
  });

  it("renders volume pages for an empty book even when volume pages are off", async () => {
    const source: BookModel = {
      meta: { title: "空书", author: "", language: "zh-CN" },
      volumes: [
        { id: "v1", title: "空书卷", kind: "volume", lines: ["空书卷首"] },
        { id: "v2", title: "第二空卷", kind: "volume" },
      ],
      chapters: [],
      cover: null,
    };

    const { zip, text } = await build(source, {
      ...options,
      includeTocPage: false,
      includeTitlePage: false,
      includeVolumePages: false,
    });

    expect(zip.file("OEBPS/volume-1.xhtml")).toBeTruthy();
    expect(zip.file("OEBPS/volume-2.xhtml")).toBeTruthy();
    const page = await text("OEBPS/volume-1.xhtml");
    expect(page).toContain('<h1 class="volume-title">空书卷</h1>');
    expect(page).toContain('<p class="volume-note">空书卷首</p>');
    expect(await text("OEBPS/text/chapter-1.xhtml")).not.toContain("空书卷首");
  });
});


describe("theme coverage", () => {
  it("exposes a default theme id", () => {
    expect(DEFAULT_THEME_ID).toBe("paper");
    expect(themes[DEFAULT_THEME_ID].label).toBe("纸墨");
  });

  it("styles the structural pages in every theme", () => {
    for (const theme of Object.values(themes)) {
      for (const selector of [
        ".cover-page",
        ".cover-image",
        ".book-title",
        ".book-author",
        ".volume-page",
        ".volume-title",
        ".volume-note-block",
        ".description-page",
        ".description-title",
        ".toc-page",
        ".title-anchor",
      ]) {
        expect(theme.css).toContain(selector);
      }
    }
  });

  it("writes the selected theme css into the epub", async () => {
    const { text } = await build(book, { ...options, themeId: "night" });
    const css = await text("OEBPS/styles/theme.css");
    // 主题样式在前，高级排版 CSS 追加在后。
    expect(css.startsWith(themes.night.css)).toBe(true);
  });
});

describe("epubConverter", () => {
  it("advertises the epub format", () => {
    expect(epubConverter.id).toBe("epub");
    expect(epubConverter.label).toBe("EPUB");
    expect(epubConverter.extension).toBe("epub");
    expect(epubConverter.mimeType).toBe("application/epub+zip");
    expect(epubConverter.available).toBe(true);
  });

  it("converts through the shared interface", async () => {
    const blob = await epubConverter.convert(book, options);
    expect(blob.type).toBe("application/epub+zip");
    expect(blob.size).toBeGreaterThan(0);
  });
});
