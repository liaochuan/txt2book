import { describe, expect, it } from "vitest";
import type { ThemeId } from "../src/types/book";
import { themes } from "../src/core/render/themes";
import {
  defaultLayoutFor,
  layoutCss,
  normalizeLayout,
  type BackgroundConfig,
  type ElementKey,
  type FontChoice,
  type LayoutSettings,
} from "../src/core/render/layout";

const THEME_IDS: ThemeId[] = ["minimal", "paper", "night", "classic", "eink"];

const CHAPTER_TITLE_SELECTOR = ".txt2book h1.chapter-title";
const INTRO_SELECTOR = ".txt2book .description-page p";

const ELEMENT_KEYS: ElementKey[] = [
  "chapterTitle",
  "body",
  "volumeTitle",
  "volumeNote",
  "intro",
  "tocTitle",
  "tocItem",
];

/** 取出某条选择器对应的规则体，方便对单个元素做精确断言。 */
function rule(css: string, selector: string): string {
  const marker = `${selector} {`;
  const start = css.indexOf(marker);
  if (start < 0) return "";
  const end = css.indexOf("}", start);
  return css.slice(start + marker.length, end);
}

/** 取最后一条匹配规则：用于验证拼接顺序下的实际生效值。 */
function lastRule(css: string, selector: string): string {
  const marker = `${selector} {`;
  const start = css.lastIndexOf(marker);
  if (start < 0) return "";
  const end = css.indexOf("}", start);
  return css.slice(start + marker.length, end);
}

function withBackground(layout: LayoutSettings, background: BackgroundConfig): LayoutSettings {
  return { ...layout, background };
}

describe("defaultLayoutFor", () => {
  it("provides the documented defaults for every theme", () => {
    for (const themeId of THEME_IDS) {
      const layout = defaultLayoutFor(themeId);
      expect(layout.typography.version).toBe(1);
      expect(Object.keys(layout.typography.elements).sort()).toEqual([...ELEMENT_KEYS].sort());
      const body = layout.typography.elements.body;
      expect(body.fontSize).toBeGreaterThanOrEqual(1);
      expect(body.fontSize).toBeLessThanOrEqual(1.2);
      expect(layout.typography.elements.volumeNote.align).toBe("center");
      expect(layout.background.kind).toBe("none");
    }
  });

  it("follows each theme family", () => {
    const minimal = defaultLayoutFor("minimal").typography.elements;
    expect(minimal.chapterTitle.align).toBe("left");
    expect(minimal.chapterTitle.fontFamily).toBe("sans");
    expect(minimal.body.textIndent).toBe(0);

    const paper = defaultLayoutFor("paper").typography.elements;
    expect(paper.chapterTitle.align).toBe("center");
    expect(paper.body.textIndent).toBe(2);
    expect(paper.body.fontFamily).toBe("song");

    const classic = defaultLayoutFor("classic").typography.elements;
    expect(classic.chapterTitle.align).toBe("center");
    expect(classic.body.textIndent).toBe(2);
    expect(classic.body.fontFamily).toBe("kai");

    const night = defaultLayoutFor("night").typography.elements;
    expect(night.chapterTitle.fontFamily).toBe("sans");
    expect(night.body.fontFamily).toBe("sans");
    expect(night.body.paragraphSpacing).toBeCloseTo(0.75);

    const eink = defaultLayoutFor("eink").typography.elements;
    expect(eink.chapterTitle.align).toBe("center");
    expect(eink.body.fontSize).toBeCloseTo(1.05);
    expect(eink.body.lineHeight).toBeCloseTo(1.85);
    expect(eink.body.textIndent).toBe(2);
    expect(eink.body.fontFamily).toBe("serif");
    expect(eink.body.color).toBe("#111111");
    expect(eink.chapterTitle.color).toBe("#111111");
  });

  it("returns a fresh, independent layout each call", () => {
    const first = defaultLayoutFor("paper");
    first.typography.elements.body.fontSize = 1.8;
    first.background = { kind: "preset", presetId: "grid" };
    const second = defaultLayoutFor("paper");
    expect(second.typography.elements.body.fontSize).toBeCloseTo(1.05);
    expect(second.background.kind).toBe("none");
  });

  it("falls back to the default theme for an unknown theme id", () => {
    const fallback = defaultLayoutFor("bogus" as ThemeId);
    expect(fallback).toEqual(defaultLayoutFor("paper"));
    expect(() => layoutCss("bogus" as ThemeId, fallback)).not.toThrow();
  });
});

describe("normalizeLayout", () => {
  it("fills missing data with theme defaults", () => {
    expect(normalizeLayout({}, "paper")).toEqual(defaultLayoutFor("paper"));
    expect(normalizeLayout(null, "eink")).toEqual(defaultLayoutFor("eink"));
    expect(normalizeLayout("nope", "night")).toEqual(defaultLayoutFor("night"));
  });

  it("keeps valid partial overrides", () => {
    const layout = normalizeLayout(
      { typography: { elements: { body: { fontSize: 1.2, textIndent: 3 } } } },
      "paper",
    );
    expect(layout.typography.elements.body.fontSize).toBeCloseTo(1.2);
    expect(layout.typography.elements.body.textIndent).toBe(3);
    expect(layout.typography.elements.body.lineHeight).toBeCloseTo(
      defaultLayoutFor("paper").typography.elements.body.lineHeight,
    );
  });

  it("clamps numeric fields into the documented ranges", () => {
    const layout = normalizeLayout(
      {
        typography: {
          elements: {
            body: {
              fontSize: 99,
              lineHeight: 9,
              paragraphSpacing: -1,
              textIndent: 99,
              marginTop: 99,
              marginBottom: -3,
            },
            chapterTitle: { fontSize: 0.1, lineHeight: 0.2 },
          },
        },
      },
      "paper",
    );
    const body = layout.typography.elements.body;
    expect(body.fontSize).toBe(1.8);
    expect(body.lineHeight).toBe(2.6);
    expect(body.paragraphSpacing).toBe(0);
    expect(body.textIndent).toBe(4);
    expect(body.marginTop).toBe(4);
    expect(body.marginBottom).toBe(0);
    expect(layout.typography.elements.chapterTitle.fontSize).toBe(0.8);
    expect(layout.typography.elements.chapterTitle.lineHeight).toBe(1.2);
  });

  it("falls back to defaults for invalid field values", () => {
    const defaults = defaultLayoutFor("paper").typography.elements;
    const layout = normalizeLayout(
      {
        typography: {
          elements: {
            body: {
              fontSize: "big",
              lineHeight: null,
              paragraphSpacing: Number.NaN,
              textIndent: Number.POSITIVE_INFINITY,
              align: "middle",
              fontFamily: "comic",
              color: "red",
              marginTop: {},
            },
          },
        },
      },
      "paper",
    );
    const body = layout.typography.elements.body;
    expect(body.fontSize).toBeCloseTo(defaults.body.fontSize);
    expect(body.lineHeight).toBeCloseTo(defaults.body.lineHeight);
    expect(body.paragraphSpacing).toBeCloseTo(defaults.body.paragraphSpacing);
    expect(body.textIndent).toBe(defaults.body.textIndent);
    expect(body.align).toBe(defaults.body.align);
    expect(body.fontFamily).toBe(defaults.body.fontFamily);
    expect(body.color).toBe(defaults.body.color);
    expect(body.marginTop).toBe(defaults.body.marginTop);
  });

  it("normalizes hex colors", () => {
    const layout = normalizeLayout(
      { typography: { elements: { body: { color: "#ABC" }, chapterTitle: { color: "#112233" } } } },
      "minimal",
    );
    expect(layout.typography.elements.body.color).toBe("#aabbcc");
    expect(layout.typography.elements.chapterTitle.color).toBe("#112233");
  });

  it("ignores unknown element keys", () => {
    const layout = normalizeLayout(
      { typography: { elements: { nonsense: { fontSize: 1.8 }, body: { fontSize: 1.1 } } } },
      "minimal",
    );
    expect(Object.keys(layout.typography.elements).sort()).toEqual([...ELEMENT_KEYS].sort());
    expect(layout.typography.elements.body.fontSize).toBeCloseTo(1.1);
    expect("nonsense" in layout.typography.elements).toBe(false);
  });

  it("validates the background configuration", () => {
    expect(normalizeLayout({ background: { kind: "preset", presetId: "grid" } }, "paper").background)
      .toEqual({ kind: "preset", presetId: "grid" });
    expect(normalizeLayout({ background: { kind: "preset", presetId: "bogus" } }, "paper").background)
      .toEqual({ kind: "preset", presetId: "paper" });
    expect(normalizeLayout({ background: { kind: "weird" } }, "paper").background)
      .toEqual({ kind: "none" });
    expect(normalizeLayout({ background: { kind: "custom" } }, "paper").background)
      .toEqual({ kind: "none" });
  });

  it("keeps a complete custom background", () => {
    const custom = {
      data: new Uint8Array([1, 2, 3]),
      mimeType: "image/png" as const,
      width: 1600,
      height: 900,
      fileName: "paper.png",
    };
    const layout = normalizeLayout({ background: { kind: "custom", custom } }, "paper");
    expect(layout.background).toEqual({ kind: "custom", custom });
  });

  it("restores custom background bytes after a JSON round trip", () => {
    const layout = defaultLayoutFor("paper");
    layout.background = {
      kind: "custom",
      custom: {
        data: new Uint8Array([1, 2, 3]),
        mimeType: "image/png",
        width: 1600,
        height: 900,
        fileName: "paper.png",
      },
    };
    const roundTripped: unknown = JSON.parse(JSON.stringify(layout));
    const normalized = normalizeLayout(roundTripped, "paper");
    expect(normalized.background.kind).toBe("custom");
    const custom = normalized.background.custom;
    expect(custom?.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(custom?.data ?? [])).toEqual([1, 2, 3]);
    expect(custom?.fileName).toBe("paper.png");
  });

  it("restores large numeric-keyed objects without a stack overflow", () => {
    const data: Record<string, number> = {};
    for (let index = 0; index < 130_000; index += 1) {
      data[String(index)] = index % 256;
    }

    const normalized = normalizeLayout(
      {
        background: {
          kind: "custom",
          custom: { data, mimeType: "image/png", width: 1, height: 1, fileName: "big.png" },
        },
      },
      "paper",
    );

    const custom = normalized.background.custom;
    expect(custom?.data).toBeInstanceOf(Uint8Array);
    expect(custom?.data.length).toBe(130_000);
    expect(custom?.data[0]).toBe(0);
    expect(custom?.data[130_000 - 1]).toBe((130_000 - 1) % 256);
  });

  it("accepts byte arrays, numeric-keyed objects and base64 custom data", () => {
    const base = { mimeType: "image/png" as const, width: 10, height: 10, fileName: "a.png" };
    const fromArray = normalizeLayout(
      { background: { kind: "custom", custom: { ...base, data: [1, 2, 3] } } },
      "paper",
    );
    expect(Array.from(fromArray.background.custom?.data ?? [])).toEqual([1, 2, 3]);

    const fromKeys = normalizeLayout(
      { background: { kind: "custom", custom: { ...base, data: { 0: 4, 1: 5, 2: 6 } } } },
      "paper",
    );
    expect(Array.from(fromKeys.background.custom?.data ?? [])).toEqual([4, 5, 6]);

    const fromBase64 = normalizeLayout(
      { background: { kind: "custom", custom: { ...base, data: "AQID" } } },
      "paper",
    );
    expect(Array.from(fromBase64.background.custom?.data ?? [])).toEqual([1, 2, 3]);
  });

  it("rejects invalid custom background bytes", () => {
    const base = { mimeType: "image/png" as const, width: 10, height: 10, fileName: "a.png" };
    for (const data of [[], [1, 999], ["x"], { 0: 1, 2: 2 }, "not base64!", 42, null]) {
      const layout = normalizeLayout(
        { background: { kind: "custom", custom: { ...base, data } } },
        "paper",
      );
      expect(layout.background.kind).toBe("none");
    }
  });
});

describe("layoutCss", () => {
  it("emits the shared selectors with theme defaults", () => {
    const css = layoutCss("paper", defaultLayoutFor("paper"));
    for (const selector of [
      CHAPTER_TITLE_SELECTOR,
      ".txt2book p",
      ".txt2book .volume-title",
      ".txt2book .volume-note",
      INTRO_SELECTOR,
      ".txt2book .toc-page .toc-title",
      ".txt2book .toc-page li",
    ]) {
      expect(css).toContain(`${selector} {`);
    }
    expect(rule(css, CHAPTER_TITLE_SELECTOR)).toContain("text-align: center");
    expect(rule(css, ".txt2book p")).toContain("text-indent: 2em");
    expect(rule(css, ".txt2book .volume-note")).toContain("text-align: center");
    expect(css).not.toContain("var(--");
    expect(css).not.toContain("@font-face");
  });

  it("targets only the description page with intro styles", () => {
    const css = layoutCss("paper", defaultLayoutFor("paper"));
    expect(css).toContain(INTRO_SELECTOR);
    expect(css).not.toContain(".title-page");
  });

  it("matches the theme baseline for key default values", () => {
    const chapterTitleSizes: Record<ThemeId, string> = {
      minimal: "1.5em",
      paper: "1.6em",
      night: "1.35em",
      classic: "1.6em",
      eink: "1.5em",
    };

    for (const themeId of THEME_IDS) {
      const css = layoutCss(themeId, defaultLayoutFor(themeId));
      const chapterSize = chapterTitleSizes[themeId];

      expect(rule(css, CHAPTER_TITLE_SELECTOR)).toContain(`font-size: ${chapterSize}`);
      expect(themes[themeId].css).toContain(`font-size: ${chapterSize}`);

      expect(rule(css, ".txt2book .volume-title")).toContain("font-size: 1.8em");
      expect(rule(css, ".txt2book .toc-page .toc-title")).toContain("font-size: 1.6em");
      expect(rule(css, ".txt2book .toc-page li")).toContain("margin: 0.4em 0 0.4em");

      expect(defaultLayoutFor(themeId).typography.elements.volumeTitle.fontSize).toBeCloseTo(1.8);
      expect(defaultLayoutFor(themeId).typography.elements.tocTitle.fontSize).toBeCloseTo(1.6);
      expect(defaultLayoutFor(themeId).typography.elements.tocItem.marginBottom).toBeCloseTo(0.4);
    }
  });

  it("lets the layout override the concatenated theme chapter title", () => {
    const layout = defaultLayoutFor("paper");
    layout.typography.elements.chapterTitle.fontSize = 1.7;

    const combined = `${themes.paper.css}\n${layoutCss("paper", layout)}`;
    expect(combined).toContain(CHAPTER_TITLE_SELECTOR);
    // 同特异度下最后一条规则生效：layout 必须排在 theme.css 之后。
    expect(lastRule(combined, CHAPTER_TITLE_SELECTOR)).toContain("font-size: 1.7em");
    expect(rule(themes.paper.css, CHAPTER_TITLE_SELECTOR)).toContain("font-size: 1.6em");
  });

  it("reflects edited element styles", () => {
    const layout = defaultLayoutFor("paper");
    layout.typography.elements.chapterTitle.align = "right";
    layout.typography.elements.body.textIndent = 3;
    layout.typography.elements.body.paragraphSpacing = 1.2;
    layout.typography.elements.volumeNote.color = "#123456";
    const css = layoutCss("paper", layout);
    expect(rule(css, CHAPTER_TITLE_SELECTOR)).toContain("text-align: right");
    expect(rule(css, ".txt2book p")).toContain("text-indent: 3em");
    expect(rule(css, ".txt2book p")).toContain("margin: 0em 0 1.2em");
    expect(rule(css, ".txt2book .volume-note")).toContain("color: #123456");
  });

  it("falls back to theme colors for invalid color values", () => {
    const layout = defaultLayoutFor("eink");
    layout.typography.elements.body.color = "#zzzzzz";
    const css = layoutCss("eink", layout);
    expect(rule(css, ".txt2book p")).toContain("color: #111111");
    expect(css).not.toContain("#zzzzzz");
  });

  it("maps font choices to CJK font stacks", () => {
    const expectations: Array<[FontChoice, string]> = [
      ["serif", "Noto Serif CJK SC"],
      ["song", "SimSun"],
      ["kai", "KaiTi"],
      ["sans", "PingFang SC"],
      ["hei", "Heiti SC"],
    ];
    for (const [fontFamily, marker] of expectations) {
      const layout = defaultLayoutFor("paper");
      layout.typography.elements.body.fontFamily = fontFamily;
      expect(rule(layoutCss("paper", layout), ".txt2book p")).toContain(marker);
    }
  });

  it("emits nothing for a disabled background", () => {
    const css = layoutCss("paper", defaultLayoutFor("paper"));
    expect(css).not.toContain("background-image");
  });

  it("renders preset backgrounds as gradients", () => {
    const paper = defaultLayoutFor("paper");
    expect(layoutCss("paper", withBackground(paper, { kind: "preset", presetId: "paper" })))
      .toContain("repeating-linear-gradient");

    const gridCss = layoutCss("paper", withBackground(paper, { kind: "preset", presetId: "grid" }));
    expect(gridCss).toContain("repeating-linear-gradient");
    expect(rule(gridCss, ".txt2book").match(/repeating-linear-gradient/g)?.length).toBe(2);

    const dotsCss = layoutCss("paper", withBackground(paper, { kind: "preset", presetId: "dots" }));
    expect(dotsCss).toContain("radial-gradient");

    const linenCss = layoutCss("paper", withBackground(paper, { kind: "preset", presetId: "linen" }));
    expect(linenCss).toContain("repeating-linear-gradient");
  });

  it("renders a custom background only when a source is provided", () => {
    const layout = defaultLayoutFor("paper");
    const background: BackgroundConfig = {
      kind: "custom",
      custom: {
        data: new Uint8Array([1]),
        mimeType: "image/jpeg",
        width: 800,
        height: 600,
        fileName: "bg.jpg",
      },
    };
    const withSrc = layoutCss("paper", withBackground(layout, background), { backgroundSrc: "x.png" });
    expect(rule(withSrc, ".txt2book")).toContain('background-image: url("x.png")');
    expect(rule(withSrc, ".txt2book")).toContain("background-size: cover");
    expect(rule(withSrc, ".txt2book")).toContain("background-repeat: no-repeat");
    expect(withSrc).not.toContain("background-attachment");

    const withoutSrc = layoutCss("paper", withBackground(layout, background));
    expect(withoutSrc).not.toContain("background-image");
  });

  it("accepts data, blob and relative background sources", () => {
    const layout = defaultLayoutFor("paper");
    layout.background = {
      kind: "custom",
      custom: {
        data: new Uint8Array([1]),
        mimeType: "image/png",
        width: 10,
        height: 10,
        fileName: "bg.png",
      },
    };
    const sources = [
      "data:image/png;base64,iVBORw0KGgo=",
      "data:image/jpeg;base64,/9j/4AAQ",
      "data:image/webp;base64,UklGRg==",
      "blob:http://localhost/abc-123",
      "images/bg.png",
      "./bg.png",
      "/assets/bg.png",
    ];
    for (const backgroundSrc of sources) {
      expect(layoutCss("paper", layout, { backgroundSrc })).toContain("background-image");
    }
  });

  it("rejects unsafe background sources", () => {
    const layout = defaultLayoutFor("paper");
    layout.background = {
      kind: "custom",
      custom: {
        data: new Uint8Array([1]),
        mimeType: "image/png",
        width: 10,
        height: 10,
        fileName: "bg.png",
      },
    };
    const sources = [
      "javascript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "</style><script>alert(1)</script>",
      'x" ); } body{',
      "x.png\nbody { color: red }",
      "x\\y.png",
      "  ",
    ];
    for (const backgroundSrc of sources) {
      const css = layoutCss("paper", layout, { backgroundSrc });
      expect(css).not.toContain("background-image");
      expect(css).not.toContain("url(");
    }
  });

  it("never emits a background image for the e-ink theme", () => {
    const layout = defaultLayoutFor("eink");
    layout.background = { kind: "preset", presetId: "grid" };
    const presetCss = layoutCss("eink", layout, { backgroundSrc: "x.png" });
    expect(presetCss).not.toContain("background-image");
    expect(presetCss).not.toContain("gradient");

    const customCss = layoutCss(
      "eink",
      withBackground(layout, {
        kind: "custom",
        custom: {
          data: new Uint8Array([1]),
          mimeType: "image/png",
          width: 10,
          height: 10,
          fileName: "bg.png",
        },
      }),
      { backgroundSrc: "x.png" },
    );
    expect(customCss).not.toContain("background-image");
    expect(customCss).not.toContain("url(");
  });

  it("does not leak background rules into element typography", () => {
    const css = layoutCss(
      "paper",
      withBackground(defaultLayoutFor("paper"), { kind: "preset", presetId: "dots" }),
    );
    expect(rule(css, ".txt2book p")).not.toContain("radial-gradient");
  });
});
