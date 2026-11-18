import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import TypographyPanel from "../src/components/TypographyPanel.vue";
import { defaultLayoutFor } from "../src/core/render/layout";
import type { ThemeId } from "../src/types/book";

function mountPanel(themeId: ThemeId = "paper") {
  return mount(TypographyPanel, { props: { layout: defaultLayoutFor(themeId) } });
}

describe("TypographyPanel", () => {
  it("starts collapsed and shows a summary", () => {
    const wrapper = mountPanel();
    const details = wrapper.get('[data-test="typography-details"]');

    expect(details.element.tagName).toBe("DETAILS");
    expect(details.attributes("open")).toBeUndefined();
    expect(wrapper.text()).toContain("高级排版");
  });

  it("marks every summary with a disclosure caret and keeps them closed", () => {
    const wrapper = mountPanel();
    const details = wrapper.get('[data-test="typography-details"]');

    expect(details.attributes("open")).toBeUndefined();
    expect(details.get("summary").find(".disclosure-caret").exists()).toBe(true);

    for (const key of [
      "chapterTitle",
      "body",
      "volumeTitle",
      "volumeNote",
      "intro",
      "tocTitle",
      "tocItem",
    ]) {
      const group = wrapper.get(`[data-test="type-group-${key}"]`);
      expect(group.attributes("open")).toBeUndefined();
      expect(group.get("summary").find(".disclosure-caret").exists()).toBe(true);
    }
  });

  it("renders one collapsible group per element with Chinese labels", () => {
    const wrapper = mountPanel();

    for (const key of [
      "chapterTitle",
      "body",
      "volumeTitle",
      "volumeNote",
      "intro",
      "tocTitle",
      "tocItem",
    ]) {
      expect(wrapper.find(`[data-test="type-group-${key}"]`).exists()).toBe(true);
    }

    for (const label of [
      "章标题",
      "正文",
      "卷标题",
      "卷首文字",
      "简介",
      "目录标题",
      "目录条目",
    ]) {
      expect(wrapper.text()).toContain(label);
    }
  });

  it("emits the element key and font size patch when the font size changes", async () => {
    const wrapper = mountPanel();

    await wrapper.get('[data-test="type-fontSize-body"]').setValue("1.35");

    expect(wrapper.emitted("update-element")).toEqual([
      [{ key: "body", patch: { fontSize: 1.35 } }],
    ]);
  });

  it("uses the documented min, max and step for number inputs", () => {
    const wrapper = mountPanel();

    expect(wrapper.get('[data-test="type-fontSize-body"]').attributes()).toMatchObject({
      type: "number",
      min: "0.8",
      max: "1.8",
      step: "0.05",
    });
    expect(wrapper.get('[data-test="type-lineHeight-body"]').attributes()).toMatchObject({
      min: "1.2",
      max: "2.6",
      step: "0.05",
    });
    expect(wrapper.get('[data-test="type-paragraphSpacing-body"]').attributes()).toMatchObject({
      min: "0",
      max: "2",
      step: "0.05",
    });
    expect(wrapper.get('[data-test="type-textIndent-body"]').attributes()).toMatchObject({
      min: "0",
      max: "4",
      step: "0.05",
    });
    expect(wrapper.get('[data-test="type-marginTop-body"]').attributes()).toMatchObject({
      min: "0",
      max: "4",
      step: "0.05",
    });
    expect(wrapper.get('[data-test="type-marginBottom-chapterTitle"]').attributes()).toMatchObject({
      min: "0",
      max: "4",
      step: "0.05",
    });
  });

  it("shows paragraph spacing for body and intro, bottom margin for the rest", () => {
    const wrapper = mountPanel();

    for (const key of ["body", "intro"]) {
      expect(wrapper.find(`[data-test="type-paragraphSpacing-${key}"]`).exists()).toBe(true);
      expect(wrapper.find(`[data-test="type-marginBottom-${key}"]`).exists()).toBe(false);
    }

    for (const key of ["chapterTitle", "volumeTitle", "volumeNote", "tocTitle", "tocItem"]) {
      expect(wrapper.find(`[data-test="type-marginBottom-${key}"]`).exists()).toBe(true);
      expect(wrapper.find(`[data-test="type-paragraphSpacing-${key}"]`).exists()).toBe(false);
    }

    expect(wrapper.text()).toContain("段距");
    expect(wrapper.text()).toContain("下留白");
  });

  it("mentions that changes apply on blur or Enter", () => {
    const wrapper = mountPanel();

    expect(wrapper.get('[data-test="typography-details"] summary').text()).toContain(
      "修改后失焦或回车生效",
    );
  });

  it("emits patches for line height, spacing, indent and margins", async () => {
    const wrapper = mountPanel();

    await wrapper.get('[data-test="type-lineHeight-body"]').setValue("2.1");
    await wrapper.get('[data-test="type-paragraphSpacing-body"]').setValue("1.1");
    await wrapper.get('[data-test="type-textIndent-body"]').setValue("3");
    await wrapper.get('[data-test="type-marginTop-chapterTitle"]').setValue("1.5");
    await wrapper.get('[data-test="type-marginBottom-chapterTitle"]').setValue("2.5");

    expect(wrapper.emitted("update-element")).toEqual([
      [{ key: "body", patch: { lineHeight: 2.1 } }],
      [{ key: "body", patch: { paragraphSpacing: 1.1 } }],
      [{ key: "body", patch: { textIndent: 3 } }],
      [{ key: "chapterTitle", patch: { marginTop: 1.5 } }],
      [{ key: "chapterTitle", patch: { marginBottom: 2.5 } }],
    ]);
  });

  it("writes the clamped value back into the number input", async () => {
    const wrapper = mountPanel();
    const input = wrapper.get<HTMLInputElement>('[data-test="type-fontSize-body"]');

    await input.setValue("9");

    expect(input.element.value).toBe("1.8");
    expect(wrapper.emitted("update-element")).toEqual([
      [{ key: "body", patch: { fontSize: 1.8 } }],
    ]);
  });

  it("restores the current value when the number input is emptied", async () => {
    const wrapper = mountPanel();
    const input = wrapper.get<HTMLInputElement>('[data-test="type-fontSize-body"]');
    const original = input.element.value;

    await input.setValue("");

    expect(input.element.value).toBe(original);
    expect(wrapper.emitted("update-element")).toBeUndefined();
  });

  it("emits an align patch for the chapter title", async () => {
    const wrapper = mountPanel();

    await wrapper.get('[data-test="type-align-chapterTitle"]').setValue("right");

    expect(wrapper.emitted("update-element")).toEqual([
      [{ key: "chapterTitle", patch: { align: "right" } }],
    ]);
  });

  it("emits a font family patch from the font select", async () => {
    const wrapper = mountPanel();
    const select = wrapper.get('[data-test="type-fontFamily-body"]');

    expect(select.text()).toContain("宋体");
    expect(select.text()).toContain("黑体");
    expect(select.text()).toContain("楷体");
    expect(select.text()).toContain("衬线");
    expect(select.text()).toContain("无衬线");

    await select.setValue("hei");

    expect(wrapper.emitted("update-element")).toEqual([
      [{ key: "body", patch: { fontFamily: "hei" } }],
    ]);
  });

  it("emits a color patch from the color input", async () => {
    const wrapper = mountPanel();

    await wrapper.get('[data-test="type-color-body"]').setValue("#112233");

    expect(wrapper.emitted("update-element")).toEqual([
      [{ key: "body", patch: { color: "#112233" } }],
    ]);
  });

  it("emits reset when the restore button is clicked", async () => {
    const wrapper = mountPanel();

    await wrapper.get('[data-test="typography-reset"]').trigger("click");

    expect(wrapper.emitted("reset")).toHaveLength(1);
  });

  it("ignores empty numeric input instead of emitting NaN", async () => {
    const wrapper = mountPanel();

    await wrapper.get('[data-test="type-fontSize-body"]').setValue("");

    expect(wrapper.emitted("update-element")).toBeUndefined();
  });

  it("uses no inline styles", () => {
    const wrapper = mountPanel();

    for (const element of wrapper.findAll("*")) {
      expect(element.attributes("style")).toBeUndefined();
    }
  });
});
