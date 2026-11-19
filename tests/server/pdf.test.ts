// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { resolvePdfFonts } from "../../server/lib/pdf/fonts";
import {
  buildPdfVolumeNotes,
  defaultPdfLayoutFor,
  planPdfBlocks,
  renderPdf,
} from "../../server/lib/pdf/render";
import { wrapCjkText } from "../../server/lib/pdf/text";
import type { PdfBook, PdfOptions } from "../../server/lib/pdf/types";

/** 行首禁止的标点（避头），与 `text.ts` 的规则一致。 */
const NO_LINE_START = "、。，．！？：；）】》」』…—”’";
/** 行尾禁止的标点（避尾）。 */
const NO_LINE_END = "（【《「『“";

const availableFonts = resolvePdfFonts();
const describeCjk = describe.skipIf(!availableFonts);

async function makeCover(): Promise<Uint8Array> {
  const png = await sharp({
    create: { width: 300, height: 400, channels: 3, background: "#b5651d" },
  })
    .png()
    .toBuffer();
  return new Uint8Array(png);
}

function makeBook(chapterCount: number, cover: Uint8Array | null = null): PdfBook {
  const paragraphs = [
    "夜色沉沉，风从山坳里吹过来，卷起地上的落叶。",
    "他站在路口，望着远处的灯火，心里忽然安静下来。",
    "“走吧。”她说，“再晚就赶不上最后一班车了。”",
  ];
  return {
    meta: {
      title: "测试之书",
      author: "测试作者",
      language: "zh-CN",
      description: "这是一本用于验证 PDF 排版与分页的测试书籍。\n第二段简介文字。",
    },
    volumes: [{ id: "v1", title: "第一卷 风起", kind: "volume", lines: ["卷首语：一切从这里开始。"] }],
    chapters: Array.from({ length: chapterCount }, (_, index) => ({
      id: `c${index + 1}`,
      title: `第 ${index + 1} 章 夜行`,
      kind: "chapter",
      volumeId: "v1",
      lines: paragraphs,
    })),
    cover: cover ? { png: cover, width: 300, height: 400 } : null,
  };
}

function fullOptions(overrides: Partial<PdfOptions> = {}): PdfOptions {
  return {
    pageSize: "A4",
    margin: "normal",
    pageNumbers: true,
    includeCover: true,
    includeTocPage: true,
    includeTitlePage: true,
    includeVolumePages: true,
    bookmarks: true,
    themeId: "paper",
    ...overrides,
  };
}

/** 读取首个 `/MediaBox [x0 y0 x1 y1]` 的宽高。 */
function firstMediaBox(buffer: Buffer): { width: number; height: number } {
  const match = /\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(
    buffer.toString("latin1"),
  );
  if (!match) throw new Error("没有找到 MediaBox");
  return {
    width: Number(match[3]) - Number(match[1]),
    height: Number(match[4]) - Number(match[2]),
  };
}

/** PDF 内 `/Type /Page` 对象数量（排除 `/Pages`）。 */
function countPageObjects(buffer: Buffer): number {
  return (buffer.toString("latin1").match(/\/Type\s*\/Page(?![s])/g) ?? []).length;
}

/** 解压所有页面内容流（含 BT/ET 的 FlateDecode 流）。 */
function decodedContentStreams(buffer: Buffer): string[] {
  const streamMarker = Buffer.from("stream");
  const endMarker = Buffer.from("endstream");
  const chunks: string[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    const start = buffer.indexOf(streamMarker, offset);
    if (start === -1) break;
    let dataStart = start + streamMarker.length;
    if (buffer[dataStart] === 0x0d) dataStart += 1;
    if (buffer[dataStart] === 0x0a) dataStart += 1;
    const end = buffer.indexOf(endMarker, dataStart);
    if (end === -1) break;
    const raw = buffer.subarray(dataStart, end);
    let text = "";
    try {
      text = inflateSync(raw).toString("latin1");
    } catch {
      text = raw.toString("latin1");
    }
    if (/\bBT\b/.test(text) && /\bET\b/.test(text) && !text.includes("begincmap")) {
      chunks.push(text);
    }
    offset = end + endMarker.length;
  }

  return chunks;
}

/** 解析 PDF outline 项的标题与父节点对象号，用于验证书签层级。 */
interface OutlineItem {
  id: number;
  title: string;
  parent: number | null;
}

function parseOutlineItems(buffer: Buffer): OutlineItem[] {
  const text = buffer.toString("latin1");
  const items: OutlineItem[] = [];
  const objectPattern = /(\d+)\s+0\s+obj\b([\s\S]*?)endobj/g;

  for (const match of text.matchAll(objectPattern)) {
    const body = match[2];
    if (!body.includes("/Title")) continue;
    const titleMatch = /\/Title\s*(?:<([0-9A-Fa-f]+)>|\(((?:\\.|[^\\()])*)\))/.exec(body);
    if (!titleMatch) continue;

    let title: string;
    if (titleMatch[1]) {
      const bytes = Buffer.from(titleMatch[1], "hex");
      title =
        bytes.length % 2 === 0
          ? bytes.swap16().toString("utf16le").replace(/^\uFEFF/, "")
          : bytes.toString("latin1");
    } else {
      const raw = (titleMatch[2] ?? "").replace(/\\([()\\])/g, "$1");
      // PDFKit 的 outline 标题使用带 BOM 的 UTF-16BE 字面量。
      if (raw.startsWith("\xFE\xFF")) {
        const bytes = Buffer.from(raw.slice(2), "latin1");
        title =
          bytes.length % 2 === 0
            ? bytes.swap16().toString("utf16le")
            : raw;
      } else {
        title = raw;
      }
    }

    const parentMatch = /\/Parent\s+(\d+)\s+0\s+R/.exec(body);
    items.push({
      id: Number(match[1]),
      title,
      parent: parentMatch ? Number(parentMatch[1]) : null,
    });
  }

  return items;
}
function tocPageNumbers(buffer: Buffer): number[] {
  const numbers: number[] = [];
  for (const stream of decodedContentStreams(buffer)) {
    for (const match of stream.matchAll(/<([0-9a-fA-F]+)>/g)) {
      const hex = match[1];
      if (hex.length % 2 !== 0) continue;
      let text = "";
      for (let index = 0; index < hex.length; index += 2) {
        text += String.fromCharCode(Number.parseInt(hex.slice(index, index + 2), 16));
      }
      // 纯数字 token 只可能来自目录页码；字形码不会全部落在 0x30–0x39。
      if (/^\d+$/.test(text)) numbers.push(Number(text));
    }
  }
  return numbers;
}

describe("resolvePdfFonts", () => {
  it("uses PDF_FONT_PATH with PDF_FONT_FAMILY for every role", () => {
    const dir = mkdtempSync(join(tmpdir(), "txt2book-pdf-font-"));
    const file = join(dir, "custom.ttf");
    writeFileSync(file, "");
    try {
      const fonts = resolvePdfFonts({
        PDF_FONT_PATH: file,
        PDF_FONT_FAMILY: "Test Family",
      } as NodeJS.ProcessEnv);
      expect(fonts).not.toBeNull();
      expect(fonts?.serif).toEqual({ path: file, family: "Test Family" });
      expect(fonts?.sans).toEqual({ path: file, family: "Test Family" });
      expect(fonts?.kai).toEqual({ path: file, family: "Test Family" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pdf volume planning", () => {
  function twoVolumeBook(): PdfBook {
    return {
      meta: { title: "卷顺序", author: "作者", language: "zh-CN" },
      volumes: [
        { id: "empty", title: "空卷", kind: "volume", lines: ["空卷的卷首文字。"] },
        { id: "v1", title: "第一卷 风起", kind: "volume", lines: ["第一卷卷首。"] },
      ],
      chapters: [
        { id: "c1", title: "第 1 章", kind: "chapter", volumeId: "v1", lines: ["正文。"] },
      ],
      cover: null,
    };
  }

  it("inserts a zero-chapter volume before the next chaptered volume", () => {
    const blocks = planPdfBlocks(twoVolumeBook(), true);

    const order = blocks.map((block) =>
      block.kind === "volume" ? block.volume.id : block.entry.chapter.id,
    );
    expect(order).toEqual(["empty", "v1", "c1"]);
    const empty = blocks[0];
    expect(empty.kind === "volume" ? empty.hasPage : false).toBe(true);
  });

  it("carries zero-chapter volume notes into the next chapter when volume pages are off", () => {
    const notes = buildPdfVolumeNotes(twoVolumeBook());
    const carried = notes.get("c1")?.map((volume) => volume.id) ?? [];

    // 同一章可承载多个卷 note：空卷排在其后卷之前。
    expect(carried).toContain("empty");
    expect(carried.indexOf("empty")).toBeLessThan(carried.indexOf("v1"));
  });

  it("forces a volume page when the book has no chapters", () => {
    const book: PdfBook = {
      meta: { title: "空书", author: "", language: "zh-CN" },
      volumes: [{ id: "only", title: "唯一的卷", kind: "volume", lines: ["卷首文字。"] }],
      chapters: [],
      cover: null,
    };

    const blocks = planPdfBlocks(book, false);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "volume", hasPage: true });
  });
});

describe("wrapCjkText", () => {
  it("keeps punctuation off the forbidden line starts and respects width", () => {
    const text =
      "他说：“今天天气不错，我们一起去看电影吧。”然后他笑了笑，转身走进了人群（没有回头）。";
    const lines = wrapCjkText(text, (value) => value.length, 10);

    expect(lines.join("")).toBe(text);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(10);
      expect(NO_LINE_START.includes(line[0] ?? "")).toBe(false);
      expect(NO_LINE_END.includes(line[line.length - 1] ?? "")).toBe(false);
    }
  });

  it("returns a single line for short text and no lines for empty text", () => {
    expect(wrapCjkText("短句", (value) => value.length, 10)).toEqual(["短句"]);
    expect(wrapCjkText("", (value) => value.length, 10)).toEqual([]);
  });

  it("falls back to one line when maxWidth is not positive", () => {
    expect(wrapCjkText("无法测量", (value) => value.length, 0)).toEqual(["无法测量"]);
  });

  it("keeps closing quotes off the line start and opening quotes off the line end", () => {
    const closing = wrapCjkText("一二三四五”六", (value) => value.length, 5);
    expect(closing[0]).toBe("一二三四");
    expect(closing[1]?.[0]).not.toBe("”");

    const opening = wrapCjkText("一二三四“五六", (value) => value.length, 5);
    expect(opening[0]).not.toMatch(/[“]$/);
  });
});

describe("renderPdf", () => {
  it("throws PDF_FONT_MISSING when no font is available", async () => {
    await expect(
      renderPdf(makeBook(1), fullOptions(), { fonts: null }),
    ).rejects.toMatchObject({ code: "PDF_FONT_MISSING" });
  });

  it("throws PDF_FONT_MISSING when the configured font files cannot be loaded", async () => {
    const missing = { path: join(tmpdir(), `txt2book-missing-${Date.now()}.ttf`) };
    await expect(
      renderPdf(makeBook(1), fullOptions(), {
        fonts: { serif: missing, sans: missing, kai: missing },
      }),
    ).rejects.toMatchObject({ code: "PDF_FONT_MISSING" });
  });

  describeCjk("with a CJK font installed", () => {
    it("renders a multi-page pdf with bookmarks and a safe font label", async () => {
      const cover = await makeCover();
      const result = await renderPdf(makeBook(2, cover), fullOptions());

      expect(result.buffer.subarray(0, 5).toString()).toBe("%PDF-");
      expect(result.pageCount).toBeGreaterThanOrEqual(4);
      expect(result.pageCount).toBe(countPageObjects(result.buffer));
      expect(result.buffer.toString("latin1")).toContain("/Outlines");
      expect(result.fontFamily).not.toBe("");
      expect(result.fontFamily).toMatch(/^[a-z]+$/);
      expect(result.fontFamily).not.toContain("\\");
      expect(result.fontFamily).not.toContain("/");
    });

    it.each(["minimal", "paper", "night", "classic", "eink"])(
      "renders the %s theme",
      async (themeId) => {
        const result = await renderPdf(makeBook(1), fullOptions({ themeId, includeCover: false }));

        expect(result.buffer.subarray(0, 5).toString()).toBe("%PDF-");
        expect(result.pageCount).toBeGreaterThan(0);
        expect(result.pageCount).toBe(countPageObjects(result.buffer));
        expect(result.fontFamily).toMatch(/^(serif|sans|kai)$/);
      },
    );

    it("skips a damaged cover without failing or adding a cover page", async () => {
      const broken = makeBook(1, Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x11]));
      const without = makeBook(1, null);

      const damaged = await renderPdf(broken, fullOptions());
      const plain = await renderPdf(without, fullOptions());

      expect(damaged.buffer.subarray(0, 5).toString()).toBe("%PDF-");
      expect(damaged.pageCount).toBe(plain.pageCount);
      expect(damaged.pageCount).toBe(countPageObjects(damaged.buffer));
    });

    it("skips a truncated PNG cover even though the magic bytes are valid", async () => {
      const cover = await makeCover();
      const truncated = cover.subarray(0, 40);
      expect(Buffer.from(truncated.subarray(1, 4)).toString()).toBe("PNG");

      const options = fullOptions({ includeCover: true, includeTocPage: false });
      const damaged = await renderPdf(makeBook(1, truncated), options);
      const plain = await renderPdf(makeBook(1, null), options);

      expect(damaged.buffer.subarray(0, 5).toString()).toBe("%PDF-");
      expect(damaged.pageCount).toBe(plain.pageCount);
    });

    it("skips an oversized cover image", async () => {
      // 7000×6000 = 42MP，超过 4000 万像素上限。
      const huge = new Uint8Array(
        await sharp({
          create: { width: 7000, height: 6000, channels: 3, background: "#335577" },
        })
          .png()
          .toBuffer(),
      );

      const options = fullOptions({ includeCover: true, includeTocPage: false });
      const result = await renderPdf(makeBook(1, huge), options);
      const plain = await renderPdf(makeBook(1, null), options);

      expect(result.buffer.subarray(0, 5).toString()).toBe("%PDF-");
      expect(result.pageCount).toBe(plain.pageCount);
    });

    it("skips a damaged custom background without failing", async () => {
      const cover = await makeCover();
      const layout = defaultPdfLayoutFor("paper");
      layout.background = {
        kind: "custom",
        custom: { data: cover.subarray(0, 40), mimeType: "image/png" },
      };

      const result = await renderPdf(
        makeBook(1),
        fullOptions({ layout, includeCover: false, includeTocPage: false }),
      );

      expect(result.buffer.subarray(0, 5).toString()).toBe("%PDF-");
      expect(result.pageCount).toBe(countPageObjects(result.buffer));
    });

    it("does not paint a custom background for the eink theme", async () => {
      const background = await makeCover();
      const makeLayout = (themeId: string) => {
        const layout = defaultPdfLayoutFor(themeId);
        layout.background = {
          kind: "custom",
          custom: { data: background, mimeType: "image/png" },
        };
        return layout;
      };

      const eink = await renderPdf(
        makeBook(1),
        fullOptions({
          themeId: "eink",
          layout: makeLayout("eink"),
          includeCover: false,
          includeTocPage: false,
        }),
      );
      const paper = await renderPdf(
        makeBook(1),
        fullOptions({
          themeId: "paper",
          layout: makeLayout("paper"),
          includeCover: false,
          includeTocPage: false,
        }),
      );

      expect(eink.buffer.toString("latin1")).not.toMatch(/\/ca\s+0\.08/);
      expect(paper.buffer.toString("latin1")).toMatch(/\/ca\s+0\.08/);
    });

    it("nests chapter bookmarks under their volume when volume pages are off", async () => {
      const result = await renderPdf(
        makeBook(2),
        fullOptions({
          includeVolumePages: false,
          includeCover: false,
          includeTocPage: false,
          includeTitlePage: false,
        }),
      );
      const items = parseOutlineItems(result.buffer);
      const volume = items.find((item) => item.title === "第一卷 风起");
      const chapters = items.filter((item) => item.title.startsWith("第 "));

      expect(volume).toBeDefined();
      expect(chapters).toHaveLength(2);
      for (const chapter of chapters) {
        expect(chapter.parent).toBe(volume?.id);
      }
    });

    it("still emits a volume page for an empty book with volume notes", async () => {
      const book: PdfBook = {
        meta: { title: "空书", author: "", language: "zh-CN" },
        volumes: [{ id: "only", title: "唯一的卷", kind: "volume", lines: ["卷首文字。"] }],
        chapters: [],
        cover: null,
      };

      const result = await renderPdf(
        book,
        fullOptions({
          includeCover: false,
          includeTocPage: false,
          includeTitlePage: false,
          includeVolumePages: false,
        }),
      );

      expect(result.buffer.subarray(0, 5).toString()).toBe("%PDF-");
      expect(result.pageCount).toBe(1);
    });

    it("keeps a 60+ character toc title on one line without auto pagination", async () => {
      const longBook = makeBook(3);
      longBook.chapters[0].title = `第 1 章 ${"很长的章节标题".repeat(12)}`;
      expect(longBook.chapters[0].title.length).toBeGreaterThan(60);

      const options = fullOptions({ includeCover: false });
      const withLongTitle = await renderPdf(longBook, options);
      const baseline = await renderPdf(makeBook(3), options);

      expect(withLongTitle.pageCount).toBe(baseline.pageCount);
      expect(withLongTitle.pageCount).toBe(countPageObjects(withLongTitle.buffer));
    });

    it("writes real page numbers into the toc instead of placeholders", async () => {
      const result = await renderPdf(makeBook(12), fullOptions({ includeCover: false }));
      const numbers = tocPageNumbers(result.buffer);

      // 占位符 `0000` 会被解析成 0。
      expect(numbers.length).toBeGreaterThan(0);
      expect(numbers).not.toContain(0);
      expect(new Set(numbers).size).toBeGreaterThan(1);
      for (const page of numbers) {
        expect(page).toBeGreaterThanOrEqual(1);
        expect(page).toBeLessThanOrEqual(result.pageCount);
      }
    });

    it("reports the actual role after a broken font falls back", async () => {
      if (!availableFonts) throw new Error("测试需要可用字体");
      const fallback = availableFonts.sans;
      const result = await renderPdf(
        makeBook(1),
        fullOptions({ themeId: "eink", includeCover: false }),
        {
          fonts: {
            serif: { path: join(tmpdir(), `txt2book-broken-${Date.now()}.ttf`) },
            sans: fallback,
            kai: fallback,
          },
        },
      );

      // eink 正文请求 serif，但 serif 文件不可用，实际回退到 sans。
      expect(result.fontFamily).toBe("sans");
      expect(result.buffer.subarray(0, 5).toString()).toBe("%PDF-");
    });

    it("produces a smaller page box for A5 than A4", async () => {
      const book = makeBook(2);
      const a4 = await renderPdf(book, fullOptions({ pageSize: "A4", includeCover: false }));
      const a5 = await renderPdf(book, fullOptions({ pageSize: "A5", includeCover: false }));

      const a4Box = firstMediaBox(a4.buffer);
      const a5Box = firstMediaBox(a5.buffer);

      expect(a4Box.width).toBeGreaterThan(a5Box.width);
      expect(a4Box.height).toBeGreaterThan(a5Box.height);
      expect(a5Box.width).toBeGreaterThan(400);
      expect(a5Box.width).toBeLessThan(430);
    });

    it("increases page count with more chapters", async () => {
      const few = await renderPdf(makeBook(2), fullOptions({ includeCover: false }));
      const many = await renderPdf(makeBook(10), fullOptions({ includeCover: false }));

      expect(many.pageCount).toBeGreaterThan(few.pageCount);
    });
  });
});

describe("renderPdf limits", () => {
  it("rejects more than 500 volumes with EXPORT_TOO_LARGE", async () => {
    const book = makeBook(1);
    book.volumes = Array.from({ length: 501 }, (_, index) => ({
      id: `v${index}`,
      title: `卷 ${index}`,
      kind: "volume",
    }));

    await expect(renderPdf(book, fullOptions())).rejects.toMatchObject({
      code: "EXPORT_TOO_LARGE",
    });
  });

  it("rejects more than 20 million characters with EXPORT_TOO_LARGE", async () => {
    const book = makeBook(1);
    book.meta.description = "字".repeat(20_000_001);

    await expect(renderPdf(book, fullOptions())).rejects.toMatchObject({
      code: "EXPORT_TOO_LARGE",
    });
  });
});
