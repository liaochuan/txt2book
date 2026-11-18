import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { buildEpub } from "../src/core/converters/epub";
import type { ConvertOptions } from "../src/core/converters/types";
import {
  defaultLayoutFor,
  layoutCss,
  type BackgroundConfig,
  type LayoutSettings,
} from "../src/core/render/layout";
import { themes } from "../src/core/render/themes";
import type { BookModel } from "../src/types/book";

const book: BookModel = {
  meta: { title: "排版测试", author: "作者", language: "zh-CN" },
  volumes: [{ id: "v1", title: "第一卷", kind: "volume" }],
  chapters: [{ id: "c1", title: "第一章", kind: "chapter", lines: ["正文一"], volumeId: "v1" }],
  cover: null,
};

/** 在主题默认排版上替换背景，保证其余字段仍经过归一化。 */
function withBackground(themeId: "paper" | "eink", background: BackgroundConfig): LayoutSettings {
  return { ...defaultLayoutFor(themeId), background };
}

function customBackground(
  mimeType: "image/jpeg" | "image/png",
  data: number[],
): BackgroundConfig {
  return {
    kind: "custom",
    custom: { data: new Uint8Array(data), mimeType, width: 2, height: 2, fileName: "bg" },
  };
}

async function build(opts: ConvertOptions) {
  const bytes = new Uint8Array(await (await buildEpub(book, opts)).arrayBuffer());
  const zip = await JSZip.loadAsync(bytes);
  const text = async (path: string) => {
    const file = zip.file(path);
    if (!file) throw new Error(`missing ${path}: ${Object.keys(zip.files).join(", ")}`);
    return file.async("string");
  };
  return { zip, text };
}

const baseOptions: ConvertOptions = { themeId: "paper" };

describe("buildEpub layout integration", () => {
  it("writes a custom JPEG background and references it from the stylesheet", async () => {
    const { zip, text } = await build({
      ...baseOptions,
      layout: withBackground("paper", customBackground("image/jpeg", [0xff, 0xd8, 0xff])),
    });

    expect(zip.file("OEBPS/images/background.jpg")).toBeTruthy();
    expect(zip.file("OEBPS/images/background.png")).toBeNull();

    const opf = await text("OEBPS/content.opf");
    expect(opf).toMatch(
      /<item id="background-image" href="images\/background\.jpg" media-type="image\/jpeg"\/>/,
    );

    const css = await text("OEBPS/styles/theme.css");
    expect(css).toContain('background-image: url("../images/background.jpg")');
  });

  it("writes a custom PNG background with the png extension", async () => {
    const { zip, text } = await build({
      ...baseOptions,
      layout: withBackground("paper", customBackground("image/png", [0x89, 0x50, 0x4e, 0x47])),
    });

    expect(zip.file("OEBPS/images/background.png")).toBeTruthy();
    expect(zip.file("OEBPS/images/background.jpg")).toBeNull();

    const opf = await text("OEBPS/content.opf");
    expect(opf).toMatch(
      /<item id="background-image" href="images\/background\.png" media-type="image\/png"\/>/,
    );

    const css = await text("OEBPS/styles/theme.css");
    expect(css).toContain('background-image: url("../images/background.png")');
  });

  it("renders a preset background as css only", async () => {
    const { zip, text } = await build({
      ...baseOptions,
      layout: withBackground("paper", { kind: "preset", presetId: "grid" }),
    });

    expect(Object.keys(zip.files).filter((path) => path.includes("background"))).toEqual([]);
    const opf = await text("OEBPS/content.opf");
    expect(opf).not.toContain("background-image");
    const css = await text("OEBPS/styles/theme.css");
    expect(css).toContain("repeating-linear-gradient");
  });

  it("ignores a custom background on the e-ink theme", async () => {
    const { zip, text } = await build({
      themeId: "eink",
      layout: withBackground("eink", customBackground("image/png", [0x89, 0x50, 0x4e, 0x47])),
    });

    expect(Object.keys(zip.files).filter((path) => path.includes("background"))).toEqual([]);
    const opf = await text("OEBPS/content.opf");
    expect(opf).not.toContain("background-image");
    const css = await text("OEBPS/styles/theme.css");
    expect(css).not.toContain("background-image");
  });

  it("appends typography overrides after the theme stylesheet", async () => {
    const layout = defaultLayoutFor("paper");
    layout.typography.elements.body.fontSize = 1.3;
    const { text } = await build({ ...baseOptions, layout });

    const css = await text("OEBPS/styles/theme.css");
    expect(css).toContain(".txt2book p {");
    expect(css).toContain("font-size: 1.3em;");
    // 精确匹配：主题样式整体在前，排版 CSS 整体在后。
    expect(css).toBe(`${themes.paper.css}\n\n${layoutCss("paper", layout)}`);
    expect(css.startsWith(themes.paper.css)).toBe(true);
    // 主题本身也定义了 `.txt2book p`，因此用最后一次出现判断覆盖位置。
    expect(css.lastIndexOf(".txt2book p {")).toBeGreaterThan(themes.paper.css.length);
  });

  it("falls back to the theme default layout when none is provided", async () => {
    const { text } = await build(baseOptions);

    const css = await text("OEBPS/styles/theme.css");
    expect(css).toBe(`${themes.paper.css}\n\n${layoutCss("paper", defaultLayoutFor("paper"))}`);
    expect(css.startsWith(themes.paper.css)).toBe(true);
    expect(css).toContain(".txt2book h1.chapter-title {");
    expect(css).toContain("/* 高级排版");
  });
});

describe("buildEpub background safety", () => {
  it("drops a custom background whose mime type is not an allowed image", async () => {
    const { zip, text } = await build({
      ...baseOptions,
      layout: withBackground("paper", {
        kind: "custom",
        custom: {
          // 归一化层拒绝非图片 MIME，转换器不得把任意字节写进包内。
          data: new Uint8Array([1, 2, 3]),
          mimeType: "text/html" as never,
          width: 1,
          height: 1,
          fileName: "evil.html",
        },
      }),
    });

    expect(Object.keys(zip.files).filter((path) => path.includes("images/background"))).toEqual([]);
    const opf = await text("OEBPS/content.opf");
    expect(opf).not.toContain("background-image");
    const css = await text("OEBPS/styles/theme.css");
    expect(css).not.toContain("background-image");
  });

  it("never uses the original file name as a zip path", async () => {
    const { zip } = await build({
      ...baseOptions,
      layout: withBackground("paper", {
        kind: "custom",
        custom: {
          data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
          mimeType: "image/png",
          width: 2,
          height: 2,
          fileName: "../../evil.png",
        },
      }),
    });

    // 路径由 MIME 推导，文件名只作为元信息，不参与 zip 条目路径。
    expect(zip.file("OEBPS/images/background.png")).toBeTruthy();
    const paths = Object.keys(zip.files);
    expect(paths.some((path) => path.includes(".."))).toBe(false);
    expect(paths.filter((path) => /^OEBPS\/images\/.+\.(png|jpe?g)$/.test(path))).toEqual([
      "OEBPS/images/background.png",
    ]);
  });

  it("stores the background bytes unchanged", async () => {
    const bytes = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x80, 0xaa, 0x7f,
    ]);
    const { zip } = await build({
      ...baseOptions,
      layout: withBackground("paper", {
        kind: "custom",
        custom: { data: bytes, mimeType: "image/jpeg", width: 2, height: 2, fileName: "bg.jpg" },
      }),
    });

    const stored = await zip.file("OEBPS/images/background.jpg")!.async("uint8array");
    expect(Array.from(stored)).toEqual(Array.from(bytes));
  });
});
