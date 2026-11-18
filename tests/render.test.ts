import { describe, expect, it } from "vitest";
import { themes } from "../src/core/render/themes";
import {
  detectSceneBreak,
  renderChapterBody,
  renderPreviewDocument,
  renderVolumePreviewDocument,
} from "../src/core/render/renderChapter";

const chapter = {
  id: "c1", title: "第一章 <重逢> & \"开始\"", kind: "chapter" as const,
  lines: ["第一段", "", "***", "第二段 & <b>"], volumeId: null,
};

describe("renderChapterBody", () => {
  it("escapes xml special characters", () => {
    const html = renderChapterBody(chapter, themes.paper);
    expect(html).toContain("&lt;重逢&gt; &amp; &quot;开始&quot;");
    expect(html).toContain("第二段 &amp; &lt;b&gt;");
    expect(html).not.toContain("<b>");
  });
  it("renders scene breaks as hr", () => {
    const html = renderChapterBody(chapter, themes.paper);
    expect(html).toContain('<hr class="scene-break"/>');
  });
  it("omits the visible title when asked", () => {
    const html = renderChapterBody(chapter, themes.paper, { showTitle: false });
    expect(html).not.toContain("<h1");
  });
  it("exposes all five themes with scoped css", () => {
    expect(Object.keys(themes)).toEqual(["minimal", "paper", "night", "classic", "eink"]);
    for (const theme of Object.values(themes)) {
      expect(theme.css).toContain(".txt2book");
    }
  });
  it("e-ink uses high contrast and no images", () => {
    const css = themes.eink.css;
    expect(css).toContain("#ffffff");
    expect(css).toContain("#111111");
    expect(css).toContain("text-indent: 2em");
    expect(css).not.toContain("@font-face");
    expect(css).not.toContain("background-image");
  });
  it("e-ink locks the typography spec values", () => {
    const css = themes.eink.css;
    expect(css).toContain("font-size: 1.05em");
    expect(css).toContain("line-height: 1.85");
    expect(css).toContain("margin: 0 0 0.5em");
    expect(css).toContain("page-break-before: always");
    expect(css).toContain("p.scene-break");
    expect(css).toContain("border-bottom: 0");
    expect(css.indexOf("border-bottom: 0")).toBeGreaterThan(
      css.indexOf("border-bottom: 1px"),
    );
    expect(css).not.toContain("border-bottom: 3px");
    expect(css).not.toContain("background-image");
    expect(css).not.toContain("box-shadow");
  });
  it("renders e-ink scene breaks as plain text instead of hr", () => {
    const eink = renderChapterBody(chapter, themes.eink);
    expect(eink).toContain('<p class="scene-break">* * *</p>');
    expect(eink).not.toContain("<hr");

    const paper = renderChapterBody(chapter, themes.paper);
    expect(paper).toContain('<hr class="scene-break"/>');
    expect(paper).not.toContain('<p class="scene-break"');
  });
  it("wraps preview in a full html document", () => {
    const doc = renderPreviewDocument(chapter, themes.night);
    expect(doc.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(doc).toContain(themes.night.css);
  });
  it("styles the continuous preview chapter separator in every theme", () => {
    for (const theme of Object.values(themes)) {
      expect(theme.css).toContain(".txt2book hr.chapter-sep");
    }
  });
});

describe("renderChapterBody details", () => {
  it("skips empty lines instead of emitting empty paragraphs", () => {
    const html = renderChapterBody(chapter, themes.minimal, { showTitle: false });
    expect(html).not.toContain("<p></p>");
    expect(html).toBe("<p>第一段</p>\n<hr class=\"scene-break\"/>\n<p>第二段 &amp; &lt;b&gt;</p>");
  });

  it("escapes single quotes and trims line whitespace", () => {
    const html = renderChapterBody(
      { ...chapter, title: "t", lines: ["  他说：'走 & <吧>'  "] },
      themes.classic,
      { showTitle: false },
    );
    expect(html).toBe("<p>他说：&apos;走 &amp; &lt;吧&gt;&apos;</p>");
  });

  it("wraps the body with the theme class", () => {
    const doc = renderPreviewDocument(chapter, themes.classic);
    expect(doc).toContain('<body class="txt2book">');
    expect(doc).toContain("<style>");
  });

  it("strips XML-invalid control characters before escaping", () => {
    const dirty = {
      ...chapter,
      title: "标\u0000题",
      lines: ["\u0000文\u0001本", "第二\u000b行"],
    };
    const html = renderChapterBody(dirty, themes.paper);
    expect(html).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
    expect(html).toContain("<p>文本</p>");
    expect(html).toContain("<p>第二行</p>");

    const doc = renderPreviewDocument(dirty, themes.paper);
    expect(doc).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
    expect(doc).toContain("<title>标题</title>");
  });
});

describe("renderVolumePreviewDocument", () => {
  const volume = {
    id: "v1",
    title: "第一卷 风起",
    kind: "volume" as const,
    lines: ["卷首文字。"],
  };

  it("renders only the volume title and its opening lines", () => {
    const doc = renderVolumePreviewDocument(volume, themes.paper);

    expect(doc).toContain('<h1 class="volume-title">第一卷 风起</h1>');
    expect(doc).toContain("卷首文字。");
    expect(doc).not.toContain("本卷");
    expect(doc).not.toContain("volume-count-note");
    expect(doc).not.toContain('<h1 class="chapter-title">');
  });

  it("keeps the shared document shell and extra layout css", () => {
    const doc = renderVolumePreviewDocument(volume, themes.night, {
      extraCss: "/* 高级排版 */\n.txt2book p { letter-spacing: 0; }",
    });

    expect(doc.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(doc).toContain('<body class="txt2book">');
    expect(doc).toContain(themes.night.css);
    expect(doc).toContain("/* 高级排版 */");
  });
});

describe("detectSceneBreak", () => {
  it("accepts the documented marker variants", () => {
    for (const line of ["***", "* * *", "＊ ＊ ＊", "———", "---", "◇◇◇", "◆◆◆", "❖❖❖"]) {
      expect(detectSceneBreak(line)).toBe(true);
    }
  });

  it("rejects ordinary text and short markers", () => {
    for (const line of ["", "  ", "**", "第***章", "他要走了"]) {
      expect(detectSceneBreak(line)).toBe(false);
    }
  });
});
