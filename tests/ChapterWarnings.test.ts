import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ChapterWarnings from "../src/components/ChapterWarnings.vue";
import type { Chapter } from "../src/types/book";

function ch(id: string, title: string, lines: string[] = ["正文"]): Chapter {
  return { id, title, kind: "chapter", lines, volumeId: null };
}

describe("ChapterWarnings", () => {
  it("renders nothing when there are no issues", () => {
    const wrapper = mount(ChapterWarnings, {
      props: { chapters: [ch("a", "第1章 一"), ch("b", "第2章 二")] },
    });
    expect(wrapper.find('[data-test="chapter-warnings"]').exists()).toBe(false);
  });

  it("lists continuity issues and selects the chapter on click", async () => {
    const wrapper = mount(ChapterWarnings, {
      props: { chapters: [ch("a", "第1章 一"), ch("b", "第3章 三")] },
    });
    expect(wrapper.text()).toContain("缺少第2章");
    await wrapper.find('[data-test="warning-issue-0"]').trigger("click");
    expect(wrapper.emitted("select-chapter")?.[0]).toEqual(["b"]);
  });

  it("offers manual split for suspected headings", async () => {
    const wrapper = mount(ChapterWarnings, {
      props: { chapters: [ch("a", "第1章 一", ["正文", "", "第2章 二"])] },
    });
    expect(wrapper.text()).toContain("疑似标题");
    await wrapper.find('[data-test="warning-split-0"]').trigger("click");
    expect(wrapper.emitted("split-chapter")?.[0]).toEqual([{ chapterId: "a", lineIndex: 2 }]);
  });

  it("limits long issue lists and expands on demand", async () => {
    const chapters = Array.from({ length: 26 }, (_value, index) =>
      ch(`c${index}`, `第${index * 2 + 1}章 标题`),
    );
    const wrapper = mount(ChapterWarnings, { props: { chapters } });

    expect(wrapper.findAll('[data-test^="warning-issue-"]')).toHaveLength(20);
    expect(wrapper.get('[data-test="warning-more"]').text()).toContain("还有 5 条");

    await wrapper.get('[data-test="warning-more"]').trigger("click");
    expect(wrapper.findAll('[data-test^="warning-issue-"]')).toHaveLength(25);
    expect(wrapper.find('[data-test="warning-more"]').exists()).toBe(false);
  });

  it("gives each split button a distinguishable accessible name", () => {
    const wrapper = mount(ChapterWarnings, {
      props: {
        chapters: [
          ch("a", "第1章 一", ["正文", "", "第2章 漏了", "", "第3章 也漏了"]),
        ],
      },
    });
    const labels = wrapper
      .findAll('[data-test^="warning-split-"]')
      .map((node) => node.attributes("aria-label"));
    expect(labels).toEqual([
      "分章「第1章 一」第 3 行：第2章 漏了",
      "分章「第1章 一」第 5 行：第3章 也漏了",
    ]);
  });

  it("keeps accessible names unique for identical headings in different chapters", () => {
    const wrapper = mount(ChapterWarnings, {
      props: {
        chapters: [
          ch("a", "第1章 一", ["正文", "", "第9章 同名"]),
          ch("b", "第2章 二", ["正文", "", "第9章 同名"]),
        ],
      },
    });
    const labels = wrapper
      .findAll('[data-test^="warning-split-"]')
      .map((node) => node.attributes("aria-label"));
    expect(labels).toHaveLength(2);
    expect(new Set(labels).size).toBe(2);
  });

  it("resets the expansion state when the book changes", async () => {
    const shortBook = [ch("a", "第1章 一"), ch("b", "第3章 三")];
    const longBook = Array.from({ length: 26 }, (_value, index) =>
      ch(`c${index}`, `第${index * 2 + 1}章 标题`),
    );
    const wrapper = mount(ChapterWarnings, { props: { chapters: longBook } });

    await wrapper.get('[data-test="warning-more"]').trigger("click");
    expect(wrapper.findAll('[data-test^="warning-issue-"]')).toHaveLength(25);

    await wrapper.setProps({ chapters: shortBook });
    await wrapper.setProps({ chapters: longBook });
    expect(wrapper.findAll('[data-test^="warning-issue-"]')).toHaveLength(20);
  });

  it("counts hidden continuity and suspected items together", async () => {
    const chapters = Array.from({ length: 26 }, (_value, index) =>
      ch(`c${index}`, `第${index * 2 + 1}章 标题`, ["正文", "", "第999章 疑似"]),
    );
    const wrapper = mount(ChapterWarnings, { props: { chapters } });

    expect(wrapper.findAll('[data-test^="warning-issue-"]')).toHaveLength(20);
    expect(wrapper.findAll('[data-test^="warning-split-"]')).toHaveLength(20);
    expect(wrapper.get('[data-test="warning-more"]').text()).toContain("还有 11 条");

    await wrapper.get('[data-test="warning-more"]').trigger("click");
    expect(wrapper.findAll('[data-test^="warning-issue-"]')).toHaveLength(25);
    expect(wrapper.findAll('[data-test^="warning-split-"]')).toHaveLength(26);
  });

  it("explains which items are clickable", () => {
    const wrapper = mount(ChapterWarnings, {
      props: { chapters: [ch("a", "第1章 一"), ch("b", "第3章 三")] },
    });
    expect(wrapper.text()).toContain("连续性条目可点击跳转");
  });
});
