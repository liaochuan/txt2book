import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import PreviewPane from "../src/components/PreviewPane.vue";
import { defaultLayoutFor, type LayoutSettings } from "../src/core/render/layout";
import { themes } from "../src/core/render/themes";
import type { Chapter, ThemeId, Volume } from "../src/types/book";

const chapters: Chapter[] = [
  {
    id: "c1",
    title: "第一章 重逢",
    kind: "chapter",
    lines: ["第一段的正文。"],
    volumeId: null,
  },
  {
    id: "c2",
    title: "第二章 启程",
    kind: "chapter",
    lines: ["第二段的正文。"],
    volumeId: null,
  },
  {
    id: "c3",
    title: "第三章 归途",
    kind: "chapter",
    lines: ["第三段的正文。"],
    volumeId: null,
  },
];

function mountPane(
  overrides: Partial<{
    chapter: Chapter | null;
    allChapters: Chapter[];
    themeId: ThemeId;
    volumes: Volume[];
    layout: LayoutSettings;
    backgroundSrc: string;
    volume: Volume | null;
    volumeFirstChapterId: string | null;
  }> = {},
) {
  const themeId = overrides.themeId ?? "paper";
  return mount(PreviewPane, {
    props: {
      chapter: chapters[0]!,
      allChapters: chapters,
      themeId,
      layout: defaultLayoutFor(themeId),
      ...overrides,
    },
  });
}

describe("PreviewPane", () => {
  it("writes the rendered document into the iframe srcdoc", () => {
    const wrapper = mountPane();
    const iframe = wrapper.get("iframe");

    expect(iframe.attributes("srcdoc")).toContain("第一章 重逢");
    expect(iframe.attributes("srcdoc")).toContain("第一段的正文。");
    // 无脚本、无需 same-origin：空 sandbox 即可隔离 srcdoc。
    expect(iframe.attributes("sandbox")).toBe("");
    expect(iframe.attributes("title")).toBeTruthy();
  });

  it("does not expose script execution in the iframe sandbox", () => {
    const wrapper = mountPane();

    expect(wrapper.get("iframe").attributes("sandbox")).not.toContain("allow-scripts");
  });

  it("exposes an anchor id for the narrow-screen jump link", () => {
    const wrapper = mountPane();

    expect(wrapper.get('[data-test="preview-pane"]').attributes("id")).toBe("preview-pane");
    expect(wrapper.get('[data-test="preview-pane"]').classes()).toContain("preview-pane");
  });

  it("shows the position of the current chapter", () => {
    const wrapper = mountPane();

    expect(wrapper.get('[data-test="preview-position"]').text()).toBe("第 1 / 3 章");
  });

  it("moves to the next and previous chapter and clamps at both ends", async () => {
    const wrapper = mountPane();
    const prev = wrapper.get('[data-test="preview-prev"]');
    const next = wrapper.get('[data-test="preview-next"]');

    expect(prev.attributes("disabled")).toBeDefined();
    expect(next.attributes("disabled")).toBeUndefined();

    await next.trigger("click");
    expect(wrapper.get('[data-test="preview-position"]').text()).toBe("第 2 / 3 章");
    expect(wrapper.get("iframe").attributes("srcdoc")).toContain("第二章 启程");
    expect(wrapper.get("iframe").attributes("srcdoc")).not.toContain("第一章 重逢");

    await next.trigger("click");
    expect(wrapper.get('[data-test="preview-position"]').text()).toBe("第 3 / 3 章");
    expect(wrapper.get("iframe").attributes("srcdoc")).toContain("第三章 归途");
    expect(next.attributes("disabled")).toBeDefined();

    await next.trigger("click");
    expect(wrapper.get('[data-test="preview-position"]').text()).toBe("第 3 / 3 章");
    expect(wrapper.get("iframe").attributes("srcdoc")).toContain("第三章 归途");

    await prev.trigger("click");
    expect(wrapper.get('[data-test="preview-position"]').text()).toBe("第 2 / 3 章");
    expect(wrapper.get("iframe").attributes("srcdoc")).toContain("第二章 启程");
  });

  it("emits select-chapter so the parent can own the selection", async () => {
    const wrapper = mountPane();
    const prev = wrapper.get('[data-test="preview-prev"]');
    const next = wrapper.get('[data-test="preview-next"]');

    await next.trigger("click");
    await next.trigger("click");
    await next.trigger("click");
    await prev.trigger("click");

    expect(wrapper.emitted("select-chapter")).toEqual([["c2"], ["c3"], ["c2"]]);
  });

  it("regenerates the srcdoc when the chapter prop changes", async () => {
    const wrapper = mountPane();

    await wrapper.setProps({ chapter: chapters[2]! });

    expect(wrapper.get('[data-test="preview-position"]').text()).toBe("第 3 / 3 章");
    expect(wrapper.get("iframe").attributes("srcdoc")).toContain("第三章 归途");
  });

  it("regenerates the srcdoc when the theme changes", async () => {
    const wrapper = mountPane();
    expect(wrapper.get("iframe").attributes("srcdoc")).toContain("#f7f1e3");

    await wrapper.setProps({ themeId: "night" });

    const srcdoc = wrapper.get("iframe").attributes("srcdoc") ?? "";
    expect(srcdoc).toContain("#23262b");
    expect(srcdoc).not.toContain("#f7f1e3");
  });

  it("switches to continuous mode and joins every chapter with a separator", async () => {
    const wrapper = mountPane();

    await wrapper.get('[data-test="preview-continuous"]').trigger("click");

    const srcdoc = wrapper.get("iframe").attributes("srcdoc") ?? "";
    expect(srcdoc).toContain("第一章 重逢");
    expect(srcdoc).toContain("第二章 启程");
    expect(srcdoc).toContain("第三章 归途");
    expect(srcdoc).toContain('<hr class="chapter-sep">');
    expect(wrapper.get('[data-test="preview-continuous"]').attributes("aria-pressed")).toBe("true");
    expect(wrapper.find('[data-test="preview-prev"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="preview-next"]').exists()).toBe(false);

    await wrapper.get('[data-test="preview-continuous"]').trigger("click");

    const single = wrapper.get("iframe").attributes("srcdoc") ?? "";
    expect(single).toContain("第一章 重逢");
    expect(single).not.toContain("第二章 启程");
    expect(single).not.toContain('<hr class="chapter-sep">');
    expect(wrapper.get('[data-test="preview-continuous"]').attributes("aria-pressed")).toBe("false");
  });

  it("keeps continuous mode in sync with theme changes", async () => {
    const wrapper = mountPane();
    await wrapper.get('[data-test="preview-continuous"]').trigger("click");

    await wrapper.setProps({ themeId: "classic" });

    expect(wrapper.get("iframe").attributes("srcdoc")).toContain("#f3e6d0");
  });

  it("builds continuous mode with a single document shell", async () => {
    const wrapper = mountPane();
    await wrapper.get('[data-test="preview-continuous"]').trigger("click");

    const srcdoc = wrapper.get("iframe").attributes("srcdoc") ?? "";
    expect(srcdoc.match(/<html>/g)).toHaveLength(1);
    expect(srcdoc.match(/<\/html>/g)).toHaveLength(1);
    expect(srcdoc.match(/<body class="txt2book">/g)).toHaveLength(1);
    expect(srcdoc.match(/<\/body>/g)).toHaveLength(1);
    expect(srcdoc.match(/<hr class="chapter-sep">/g)).toHaveLength(2);
  });

  it("inserts volume pages before their first chapter in continuous mode", async () => {
    const volumes: Volume[] = [
      { id: "v1", title: "第一卷 风起", kind: "volume", lines: ["卷首文字。"] },
    ];
    const withVolume: Chapter[] = [
      {
        id: "v1c1",
        title: "第一章 入卷",
        kind: "chapter",
        lines: ["入卷正文。"],
        volumeId: "v1",
      },
      {
        id: "v1c2",
        title: "第二章 同行",
        kind: "chapter",
        lines: ["同行正文。"],
        volumeId: "v1",
      },
    ];
    const wrapper = mountPane({ chapter: withVolume[0]!, allChapters: withVolume, volumes });

    const single = wrapper.get("iframe").attributes("srcdoc") ?? "";
    expect(single).not.toContain('class="volume-title"');

    await wrapper.get('[data-test="preview-continuous"]').trigger("click");

    const srcdoc = wrapper.get("iframe").attributes("srcdoc") ?? "";
    expect(srcdoc).toContain('<section class="volume-page">');
    expect(srcdoc).toContain('<h1 class="volume-title">第一卷 风起</h1>');
    expect(srcdoc).toContain("卷首文字。");
    expect(srcdoc.indexOf("第一卷 风起")).toBeGreaterThan(-1);
    expect(srcdoc.indexOf("第一卷 风起")).toBeLessThan(
      srcdoc.indexOf('<h1 class="chapter-title">第一章 入卷</h1>'),
    );
    // 卷扉页只在首次出现时插入一次。
    expect(srcdoc.match(/class="volume-title"/g)).toHaveLength(1);
  });

  it("renders a volume page instead of a chapter when a volume is selected", () => {
    const volume: Volume = {
      id: "v1",
      title: "第一卷 风起",
      kind: "volume",
      lines: ["卷首文字。"],
    };
    const wrapper = mountPane({
      chapter: null,
      volume,
      volumeFirstChapterId: "c1",
    });

    const srcdoc = wrapper.get("iframe").attributes("srcdoc") ?? "";
    expect(srcdoc).toContain('<h1 class="volume-title">第一卷 风起</h1>');
    expect(srcdoc).toContain("卷首文字。");
    // 卷扉页只保留卷标题与卷首文字，不再追加章节数提示。
    expect(srcdoc).not.toContain("本卷");
    expect(srcdoc).not.toContain('class="volume-note volume-count-note"');
    expect(srcdoc).not.toContain("第一段的正文。");
    expect(srcdoc).toContain('<body class="txt2book">');
    // 卷页与章节页共用同一份主题 CSS。
    expect(srcdoc).toContain(themes.paper.css);
  });

  it("shows the volume title in the toolbar and returns to the first chapter", async () => {
    const volume: Volume = {
      id: "v1",
      title: "第一卷 风起",
      kind: "volume",
      lines: ["卷首文字。"],
    };
    const wrapper = mountPane({
      chapter: null,
      volume,
      volumeFirstChapterId: "c1",
    });

    expect(wrapper.get('[data-test="preview-volume-label"]').text()).toBe("卷 · 第一卷 风起");
    expect(wrapper.find('[data-test="preview-prev"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="preview-next"]').exists()).toBe(false);

    await wrapper.get('[data-test="preview-back-chapter"]').trigger("click");

    expect(wrapper.emitted("select-chapter")?.[0]).toEqual(["c1"]);
  });

  it("hides the back button when the volume has no chapter", () => {
    const volume: Volume = { id: "v1", title: "空卷", kind: "volume" };
    const wrapper = mountPane({
      chapter: null,
      volume,
      volumeFirstChapterId: null,
    });

    expect(wrapper.find('[data-test="preview-back-chapter"]').exists()).toBe(false);
  });

  it("returns to the chapter preview when the volume is cleared", async () => {
    const volume: Volume = { id: "v1", title: "第一卷 风起", kind: "volume", lines: ["卷首文字。"] };
    const wrapper = mountPane({ chapter: chapters[0]!, volume });

    expect(wrapper.get("iframe").attributes("srcdoc")).toContain("卷首文字。");
    expect(wrapper.get("iframe").attributes("srcdoc")).not.toContain("第一段的正文。");

    await wrapper.setProps({ volume: null });

    const srcdoc = wrapper.get("iframe").attributes("srcdoc") ?? "";
    expect(srcdoc).toContain("第一章 重逢");
    expect(srcdoc).not.toContain("卷首文字。");
  });

  it("escapes chapter titles so no executable script reaches the srcdoc", () => {
    const unsafe: Chapter = {
      ...chapters[0]!,
      id: "unsafe",
      title: '第一章 <script>alert("x")</script>',
    };
    const wrapper = mountPane({ chapter: unsafe, allChapters: [unsafe] });

    const srcdoc = wrapper.get("iframe").attributes("srcdoc") ?? "";
    expect(srcdoc).not.toContain("<script");
    expect(srcdoc).toContain("&lt;script&gt;");
  });

  it("shows an empty state when no chapter is selected", () => {
    const wrapper = mountPane({ chapter: null, allChapters: [] });

    expect(wrapper.find("iframe").exists()).toBe(false);
    expect(wrapper.get('[data-test="preview-empty"]').text()).toContain("还没有可预览的章节");
  });

  it("falls back to the default theme for an unknown theme id", () => {
    const wrapper = mount(PreviewPane, {
      props: {
        chapter: chapters[0]!,
        allChapters: chapters,
        themeId: "missing" as "paper",
        layout: defaultLayoutFor("paper"),
      },
    });

    expect(wrapper.get("iframe").attributes("srcdoc")).toContain("#f7f1e3");
  });

  it("injects layout overrides after the theme CSS", () => {
    const layout = defaultLayoutFor("paper");
    layout.typography.elements.chapterTitle.align = "right";
    layout.typography.elements.body.fontSize = 1.35;

    const wrapper = mountPane({ layout });
    const srcdoc = wrapper.get("iframe").attributes("srcdoc") ?? "";

    expect(srcdoc).toContain("text-align: right");
    expect(srcdoc).toContain("font-size: 1.35em");

    const themeIndex = srcdoc.indexOf(themes.paper.css);
    const overrideIndex = srcdoc.indexOf("/* 高级排版");
    expect(themeIndex).toBeGreaterThan(-1);
    expect(overrideIndex).toBeGreaterThan(themeIndex);
  });

  it("embeds a custom background source when one is provided", () => {
    const layout = defaultLayoutFor("paper");
    layout.background = {
      kind: "custom",
      custom: {
        data: new Uint8Array([1, 2, 3]),
        mimeType: "image/png",
        width: 1,
        height: 1,
        fileName: "bg.png",
      },
    };

    const wrapper = mountPane({ layout, backgroundSrc: "blob:mock" });

    expect(wrapper.get("iframe").attributes("srcdoc")).toContain(
      'background-image: url("blob:mock")',
    );
  });

  it("ignores background images on the e-ink theme", () => {
    const layout = defaultLayoutFor("eink");
    layout.background = {
      kind: "custom",
      custom: {
        data: new Uint8Array([1, 2, 3]),
        mimeType: "image/png",
        width: 1,
        height: 1,
        fileName: "bg.png",
      },
    };

    const wrapper = mountPane({ themeId: "eink", layout, backgroundSrc: "blob:mock" });

    expect(wrapper.get("iframe").attributes("srcdoc")).not.toContain("background-image");
  });

  it("regenerates the srcdoc when the layout changes", async () => {
    const wrapper = mountPane();
    const layout = defaultLayoutFor("paper");
    layout.typography.elements.chapterTitle.marginTop = 2.5;
    expect(wrapper.get("iframe").attributes("srcdoc")).not.toContain("margin: 2.5em 0 1.8em");

    await wrapper.setProps({ layout });

    expect(wrapper.get("iframe").attributes("srcdoc")).toContain("margin: 2.5em 0 1.8em");
  });

  it("uses no inline styles", () => {
    const wrapper = mountPane();

    for (const element of wrapper.findAll("*")) {
      expect(element.attributes("style")).toBeUndefined();
    }
  });
});
