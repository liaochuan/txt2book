import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ExportPanel from "../src/components/ExportPanel.vue";
import { listConverters } from "../src/core/converters";
import type { ConverterMeta } from "../src/core/converters/types";

/** 占位格式：验证 UI 不会把未实现的转换器当成可导出选项。 */
const PDF: ConverterMeta = {
  id: "pdf",
  label: "PDF",
  extension: "pdf",
  mimeType: "application/pdf",
  available: false,
};

function mountPanel(props: Record<string, unknown> = {}) {
  return mount(ExportPanel, {
    props: { converters: [...listConverters(), PDF], ...props },
  });
}

describe("ExportPanel", () => {
  it("renders every registered format with its extension", () => {
    const wrapper = mountPanel();

    expect(wrapper.get('[data-test="format-epub"]').text()).toContain("EPUB");
    expect(wrapper.get('[data-test="format-epub"]').text()).toContain(".epub");
    expect(wrapper.get('[data-test="format-pdf"]').text()).toContain("PDF");
  });

  it("disables unavailable formats and marks them 即将支持", () => {
    const wrapper = mountPanel();
    const pdf = wrapper.get('[data-test="format-pdf"]');

    expect(pdf.attributes("disabled")).toBeDefined();
    expect(pdf.text()).toContain("即将支持");
    expect(wrapper.get('[data-test="format-epub"]').attributes("disabled")).toBeUndefined();
  });

  it("emits the default export payload", async () => {
    const wrapper = mountPanel();

    await wrapper.get('[data-test="export"]').trigger("click");

    expect(wrapper.emitted("export")).toEqual([
      [
        {
          format: "epub",
          options: {
            includeTocPage: false,
            includeTitlePage: false,
            includeVolumePages: false,
          },
        },
      ],
    ]);
  });

  it("renders the content options unchecked with an explanation under each one", () => {
    const wrapper = mountPanel();

    for (const key of ["opt-toc", "opt-title", "opt-volume"]) {
      expect((wrapper.get(`[data-test="${key}"]`).element as HTMLInputElement).checked).toBe(false);
    }

    expect(wrapper.get('[data-test="hint-toc"]').text()).toBe(
      "在正文前插入一页可翻阅的目录。关闭后阅读器自带的导航目录仍然可用，只是书里不出现目录页。",
    );
    expect(wrapper.get('[data-test="hint-title"]').text()).toBe(
      "在封面后插入书名与作者页；有简介时仍会单独生成简介页。关闭后直接从正文开始。",
    );
    expect(wrapper.get('[data-test="hint-volume"]').text()).toBe(
      "为每个卷生成独立标题页，并展示卷首文字。关闭后卷首文字会以居中样式并入该卷第一章开头，不会丢失。",
    );

    for (const [option, hint] of [
      ["opt-toc", "hint-toc"],
      ["opt-title", "hint-title"],
      ["opt-volume", "hint-volume"],
    ]) {
      expect(wrapper.get(`[data-test="${option}"]`).attributes("aria-describedby")).toBe(hint);
      expect(wrapper.get(`[data-test="${hint}"]`).attributes("id")).toBe(hint);
    }
  });

  it("reflects the content checkboxes in the payload", async () => {
    const wrapper = mountPanel();

    await wrapper.get('[data-test="opt-toc"]').setValue(true);
    await wrapper.get('[data-test="opt-volume"]').setValue(true);
    await wrapper.get('[data-test="export"]').trigger("click");

    expect(wrapper.emitted("export")).toEqual([
      [
        {
          format: "epub",
          options: {
            includeTocPage: true,
            includeTitlePage: false,
            includeVolumePages: true,
          },
        },
      ],
    ]);
  });

  it("disables export and shows the hint when there is no book", () => {
    const wrapper = mountPanel({ disabled: true, hint: "导入 TXT 后才能导出。" });

    expect(wrapper.get('[data-test="export"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-test="export"]').attributes("aria-describedby")).toBe(
      "export-blocked-hint",
    );
    expect(wrapper.get('[data-test="export-blocked"]').text()).toContain("导入 TXT");
  });

  it("disables export while a conversion is running", () => {
    const wrapper = mountPanel({ busy: true });

    expect(wrapper.get('[data-test="export"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-test="export"]').text()).toContain("正在生成");
  });

  it("does not emit when disabled", async () => {
    const wrapper = mountPanel({ disabled: true });

    await wrapper.get('[data-test="export"]').trigger("click");

    expect(wrapper.emitted("export")).toBeUndefined();
  });

  it("uses no inline styles", () => {
    const wrapper = mountPanel();

    for (const element of wrapper.findAll("*")) {
      expect(element.attributes("style")).toBeUndefined();
    }
  });
});
