import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import SplitChapterDialog from "../src/components/SplitChapterDialog.vue";
import type { Chapter } from "../src/types/book";

const chapter: Chapter = {
  id: "c1",
  title: "第7章 啊？神器？",
  kind: "chapter",
  lines: ["正文一", "", "第8章 靠谱的银荆", "正文二"],
  volumeId: null,
};

const mountOptions = { global: { stubs: { teleport: true } } };

describe("SplitChapterDialog", () => {
  it("lists lines and splits at the selected line", async () => {
    const wrapper = mount(SplitChapterDialog, {
      props: { open: true, chapter, initialLineIndex: 2 },
      ...mountOptions,
    });
    expect(wrapper.text()).toContain("第8章 靠谱的银荆");
    await wrapper.find('[data-test="split-confirm"]').trigger("click");
    expect(wrapper.emitted("split")?.[0]?.[0]).toEqual({
      chapterId: "c1",
      lineIndex: 2,
      title: "第8章 靠谱的银荆",
      dropLine: true,
    });
  });

  it("disables confirm until a line is selected", async () => {
    const wrapper = mount(SplitChapterDialog, {
      props: { open: true, chapter },
      ...mountOptions,
    });
    expect(wrapper.find('[data-test="split-confirm"]').attributes("disabled")).toBeDefined();
    await wrapper.find('[data-test="split-line-1"]').trigger("click");
    expect(wrapper.find('[data-test="split-confirm"]').attributes("disabled")).toBeUndefined();
  });

  it("emits close when cancelled", async () => {
    const wrapper = mount(SplitChapterDialog, {
      props: { open: true, chapter },
      ...mountOptions,
    });
    await wrapper.find('[data-test="split-cancel"]').trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("does not offer the first line as a split point", () => {
    const wrapper = mount(SplitChapterDialog, {
      props: { open: true, chapter },
      ...mountOptions,
    });
    expect(wrapper.find('[data-test="split-line-0"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="split-line-3"]').exists()).toBe(true);
  });

  it("limits the rendered line list for very long chapters", async () => {
    const longChapter: Chapter = {
      ...chapter,
      lines: Array.from({ length: 500 }, (_value, index) => `第${index + 1}行`),
    };
    const wrapper = mount(SplitChapterDialog, {
      props: { open: true, chapter: longChapter },
      ...mountOptions,
    });

    expect(wrapper.findAll('[data-test^="split-line-"]')).toHaveLength(200);
    expect(wrapper.find('[data-test="split-more"]').exists()).toBe(true);

    await wrapper.get('[data-test="split-more"]').trigger("click");
    expect(wrapper.findAll('[data-test^="split-line-"]')).toHaveLength(400);
  });

  it("keeps a preset split point visible even when it is far down the chapter", () => {
    const longChapter: Chapter = {
      ...chapter,
      lines: Array.from({ length: 500 }, (_value, index) => `第${index + 1}行`),
    };
    const wrapper = mount(SplitChapterDialog, {
      props: { open: true, chapter: longChapter, initialLineIndex: 350 },
      ...mountOptions,
    });

    expect(wrapper.find('[data-test="split-line-350"]').exists()).toBe(true);
    expect(wrapper.get('[data-test="split-line-350"]').attributes("aria-pressed")).toBe("true");
  });

  it("resets the selection when the chapter changes", async () => {
    const wrapper = mount(SplitChapterDialog, {
      props: { open: true, chapter, initialLineIndex: 2 },
      ...mountOptions,
    });
    expect(wrapper.get('[data-test="split-line-2"]').attributes("aria-pressed")).toBe("true");

    const other: Chapter = { ...chapter, id: "c2", lines: ["新正文", "新段落"] };
    await wrapper.setProps({ chapter: other, initialLineIndex: undefined });

    expect(wrapper.find('[data-test="split-line-2"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="split-confirm"]').attributes("disabled")).toBeDefined();
    expect((wrapper.get('[data-test="split-title"]').element as HTMLInputElement).value).toBe("");
  });

  it("keeps an edited title when the same line is clicked again", async () => {
    const wrapper = mount(SplitChapterDialog, {
      props: { open: true, chapter, initialLineIndex: 2 },
      ...mountOptions,
    });
    await wrapper.get('[data-test="split-title"]').setValue("手改标题");
    await wrapper.get('[data-test="split-line-2"]').trigger("click");
    expect((wrapper.get('[data-test="split-title"]').element as HTMLInputElement).value).toBe(
      "手改标题",
    );
  });

  it("does not preselect drop-line for an inline chapter reference", () => {
    const inlineChapter: Chapter = {
      ...chapter,
      lines: ["正文", "第一章，人体七大魔力节点模型？", "很好，跳过。"],
    };
    const wrapper = mount(SplitChapterDialog, {
      props: { open: true, chapter: inlineChapter, initialLineIndex: 1 },
      ...mountOptions,
    });
    expect(
      (wrapper.get('[data-test="split-drop-line"]').element as HTMLInputElement).checked,
    ).toBe(false);
  });

  it("disables confirm when dropping the final line would leave no body", async () => {
    const shortChapter: Chapter = { ...chapter, lines: ["正文", "第8章 靠谱的银荆"] };
    const wrapper = mount(SplitChapterDialog, {
      props: { open: true, chapter: shortChapter, initialLineIndex: 1 },
      ...mountOptions,
    });
    await wrapper.get('[data-test="split-drop-line"]').setValue(true);

    expect(wrapper.find('[data-test="split-confirm"]').attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("最后一行");
  });

  it("disables confirm when the new body would be blank", () => {
    const blankTail: Chapter = { ...chapter, lines: ["正文", "", "   "] };
    const wrapper = mount(SplitChapterDialog, {
      props: { open: true, chapter: blankTail, initialLineIndex: 2 },
      ...mountOptions,
    });
    expect(wrapper.find('[data-test="split-confirm"]').attributes("disabled")).toBeDefined();
  });

  it("does not preselect drop-line for an oversized heading", () => {
    const longHeading: Chapter = {
      ...chapter,
      lines: ["正文", "", `第9章 ${"很长".repeat(40)}`],
    };
    const wrapper = mount(SplitChapterDialog, {
      props: { open: true, chapter: longHeading, initialLineIndex: 2 },
      ...mountOptions,
    });
    expect(
      (wrapper.get('[data-test="split-drop-line"]').element as HTMLInputElement).checked,
    ).toBe(false);
  });
});
