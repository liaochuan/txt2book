import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ThemePicker from "../src/components/ThemePicker.vue";
import type { ThemeId } from "../src/types/book";

function mountPicker(modelValue: ThemeId = "paper") {
  return mount(ThemePicker, { props: { modelValue } });
}

describe("ThemePicker", () => {
  it("renders the five themes with name and description", () => {
    const wrapper = mountPicker();
    const options = wrapper.findAll('[role="radio"]');

    expect(options).toHaveLength(5);
    expect(wrapper.text()).toContain("素白");
    expect(wrapper.text()).toContain("纸墨");
    expect(wrapper.text()).toContain("夜读");
    expect(wrapper.text()).toContain("古卷");
    expect(wrapper.text()).toContain("墨水屏");
    expect(wrapper.get('[data-test="theme-paper"]').text()).toContain(
      "米黄纸色、宋体、首行缩进，接近纸质书",
    );
    expect(wrapper.get('[data-test="theme-eink"]').text()).toContain(
      "高对比、无背景图、适合电纸书",
    );
  });

  it("exposes radio semantics and marks the current theme", () => {
    const wrapper = mountPicker("night");

    expect(wrapper.get('[role="radiogroup"]').attributes("aria-label")).toBe("排版主题");
    expect(wrapper.get('[data-test="theme-night"]').attributes("aria-checked")).toBe("true");
    expect(wrapper.get('[data-test="theme-paper"]').attributes("aria-checked")).toBe("false");
    expect(wrapper.get('[data-test="theme-night"]').attributes("tabindex")).toBe("0");
    expect(wrapper.get('[data-test="theme-paper"]').attributes("tabindex")).toBe("-1");
  });

  it("renders a themed swatch for every option", () => {
    const wrapper = mountPicker();

    for (const id of ["minimal", "paper", "night", "classic", "eink"]) {
      const swatch = wrapper.get(`[data-test="theme-${id}"] .theme-swatch`);
      expect(swatch.classes()).toContain(`theme-swatch-${id}`);
      expect(swatch.attributes("aria-hidden")).toBe("true");
    }
  });

  it("emits update:modelValue when an option is clicked", async () => {
    const wrapper = mountPicker("paper");

    await wrapper.get('[data-test="theme-classic"]').trigger("click");

    expect(wrapper.emitted("update:modelValue")).toEqual([["classic"]]);
  });

  it("selects an option with Enter and Space", async () => {
    const wrapper = mountPicker("paper");

    await wrapper.get('[data-test="theme-minimal"]').trigger("keydown", { key: "Enter" });
    await wrapper.get('[data-test="theme-night"]').trigger("keydown", { key: " " });

    expect(wrapper.emitted("update:modelValue")).toEqual([["minimal"], ["night"]]);
  });

  it("moves the selection with arrow keys and wraps around", async () => {
    const wrapper = mountPicker("paper");
    const group = wrapper.get('[role="radiogroup"]');

    await group.trigger("keydown", { key: "ArrowRight" });
    await wrapper.setProps({ modelValue: "night" });
    await group.trigger("keydown", { key: "ArrowDown" });
    await wrapper.setProps({ modelValue: "classic" });
    await group.trigger("keydown", { key: "ArrowLeft" });
    await wrapper.setProps({ modelValue: "night" });
    await group.trigger("keydown", { key: "ArrowLeft" });

    expect(wrapper.emitted("update:modelValue")).toEqual([
      ["night"],
      ["classic"],
      ["night"],
      ["paper"],
    ]);
  });

  it("supports Home and End for the first and last theme", async () => {
    const wrapper = mountPicker("night");
    const group = wrapper.get('[role="radiogroup"]');

    await group.trigger("keydown", { key: "End" });
    await group.trigger("keydown", { key: "Home" });

    expect(wrapper.emitted("update:modelValue")).toEqual([["eink"], ["minimal"]]);
  });

  it("ignores unrelated keys", async () => {
    const wrapper = mountPicker("paper");

    await wrapper.get('[data-test="theme-minimal"]').trigger("keydown", { key: "a" });

    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  });

  it("uses no inline styles", () => {
    const wrapper = mountPicker();

    for (const element of wrapper.findAll("*")) {
      expect(element.attributes("style")).toBeUndefined();
    }
  });
});
