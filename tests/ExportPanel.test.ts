import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import ExportPanel from "../src/components/ExportPanel.vue";
import { listConverters } from "../src/core/converters";
import type { ConverterMeta } from "../src/core/converters/types";

/** 占位格式：验证 UI 不会把未实现的转换器当成可导出选项。 */
const UNAVAILABLE: ConverterMeta = {
  id: "mobi",
  label: "MOBI",
  extension: "mobi",
  mimeType: "application/x-mobipocket-ebook",
  available: false,
};

/** 带动态选项的占位格式：key 与 brief 一致，便于断言 payload。 */
const WITH_OPTIONS: ConverterMeta = {
  id: "b",
  label: "B",
  extension: "b",
  mimeType: "x/b",
  available: true,
  runtime: "browser",
  options: [
    {
      key: "mode",
      label: "模式",
      type: "select",
      defaultValue: "x",
      hint: "选择输出模式。",
      choices: [
        { value: "x", label: "X" },
        { value: "y", label: "Y" },
      ],
    },
    { key: "flag", label: "开关", type: "boolean", defaultValue: true },
  ],
};

/** 无动态选项的占位格式，用于验证切换格式后状态不串。 */
const WITHOUT_OPTIONS: ConverterMeta = {
  id: "a",
  label: "A",
  extension: "a",
  mimeType: "x/a",
  available: true,
  runtime: "browser",
};

type ExportPayload = {
  format: string;
  options: {
    includeTocPage: boolean;
    includeTitlePage: boolean;
    includeVolumePages: boolean;
    formatOptions?: Record<string, boolean | string>;
  };
};

function lastPayload(wrapper: ReturnType<typeof mount>): ExportPayload {
  const events = wrapper.emitted("export");
  if (!events?.length) throw new Error("未触发 export 事件");
  return events[events.length - 1][0] as ExportPayload;
}

function mountPanel(props: Record<string, unknown> = {}) {
  return mount(ExportPanel, {
    props: { converters: [...listConverters(), UNAVAILABLE], ...props },
  });
}

describe("ExportPanel", () => {
  it("renders every registered format with its extension", () => {
    const wrapper = mountPanel();

    expect(wrapper.get('[data-test="format-epub"]').text()).toContain("EPUB");
    expect(wrapper.get('[data-test="format-epub"]').text()).toContain(".epub");
    expect(wrapper.get('[data-test="format-pdf"]').text()).toContain("PDF");
    expect(wrapper.get('[data-test="format-pdf"]').text()).toContain(".pdf");
  });

  it("disables unavailable formats and marks them 即将支持", () => {
    const wrapper = mountPanel();
    const unavailable = wrapper.get('[data-test="format-mobi"]');

    expect(unavailable.attributes("disabled")).toBeDefined();
    expect(unavailable.text()).toContain("即将支持");
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

  it("renders per-format options and resets on format change", async () => {
    const converters = [WITHOUT_OPTIONS, WITH_OPTIONS];
    const wrapper = mount(ExportPanel, { props: { converters } });

    expect(wrapper.find('[data-test="format-opt-mode"]').exists()).toBe(false);

    await wrapper.get('[data-test="format-b"]').trigger("click");
    expect(wrapper.find('[data-test="format-opt-mode"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="format-opt-flag"]').exists()).toBe(true);

    await wrapper.get('[data-test="format-opt-mode"]').setValue("y");
    await wrapper.get('[data-test="format-opt-flag"]').setValue(false);
    await wrapper.get('[data-test="export"]').trigger("click");

    expect(lastPayload(wrapper).options.formatOptions).toEqual({ mode: "y", flag: false });
  });

  it("uses each format's defaults and does not leak values across formats", async () => {
    const wrapper = mount(ExportPanel, {
      props: { converters: [WITHOUT_OPTIONS, WITH_OPTIONS] },
    });

    await wrapper.get('[data-test="format-b"]').trigger("click");
    await wrapper.get('[data-test="format-opt-mode"]').setValue("y");
    await wrapper.get('[data-test="format-opt-flag"]').setValue(false);

    await wrapper.get('[data-test="format-a"]').trigger("click");
    expect(wrapper.find('[data-test="format-opt-mode"]').exists()).toBe(false);
    await wrapper.get('[data-test="export"]').trigger("click");
    expect(lastPayload(wrapper).options.formatOptions).toBeUndefined();

    await wrapper.get('[data-test="format-b"]').trigger("click");
    const mode = wrapper.get('[data-test="format-opt-mode"]').element as HTMLSelectElement;
    const flag = wrapper.get('[data-test="format-opt-flag"]').element as HTMLInputElement;
    expect(mode.value).toBe("x");
    expect(flag.checked).toBe(true);
  });

  it("emits the selected format's default options without user edits", async () => {
    const wrapper = mount(ExportPanel, { props: { converters: [WITH_OPTIONS] } });

    await wrapper.get('[data-test="export"]').trigger("click");

    expect(lastPayload(wrapper).options.formatOptions).toEqual({ mode: "x", flag: true });
  });

  it("renders option labels with hints and without inline styles", () => {
    const wrapper = mount(ExportPanel, { props: { converters: [WITH_OPTIONS] } });

    expect(wrapper.get('[data-test="format-opt-mode"]').element.closest("label")).not.toBeNull();
    expect(wrapper.text()).toContain("模式");
    expect(wrapper.text()).toContain("开关");
    expect(wrapper.get('[data-test="format-opt-hint-mode"]').text()).toBe("选择输出模式。");
    expect(
      wrapper.get('[data-test="format-opt-mode"]').attributes("aria-describedby"),
    ).toBe("format-opt-hint-mode");

    for (const element of wrapper.findAll("*")) {
      expect(element.attributes("style")).toBeUndefined();
    }
  });

  it("shows the numeric percent on a native progress bar while busy", () => {
    const wrapper = mountPanel({
      busy: true,
      progress: { phase: "generating", percent: 40, message: "正在打包 EPUB 40%" },
    });

    const container = wrapper.get('[data-test="export-progress"]');
    expect(container.attributes("aria-live")).toBeUndefined();
    expect(container.get("progress").attributes("aria-label")).toBe("导出进度");
    expect(container.get("progress").attributes("value")).toBe("40");
    expect(wrapper.get('[data-test="export-progress-message"]').attributes("aria-live")).toBe(
      "polite",
    );
    expect(wrapper.get('[data-test="export-progress-message"]').text()).toBe(
      "正在打包 EPUB 40%",
    );
    expect(wrapper.get('[data-test="export-progress-elapsed"]').attributes("aria-hidden")).toBe(
      "true",
    );
  });

  it("renders value 0 for a zero percent progress", () => {
    const wrapper = mountPanel({
      busy: true,
      progress: { phase: "preparing", percent: 0, message: "正在准备导出…" },
    });

    expect(wrapper.get('[data-test="export-progress"] progress').attributes("value")).toBe("0");
  });

  it("omits the value attribute for indeterminate progress", () => {
    const wrapper = mountPanel({
      busy: true,
      progress: { phase: "generating", percent: null, message: "正在生成 PDF…" },
    });

    expect(wrapper.get('[data-test="export-progress"] progress').attributes("value")).toBeUndefined();
  });

  it("updates the message and elapsed seconds with fake timers", async () => {
    vi.useFakeTimers();
    const wrapper = mountPanel({
      busy: true,
      progress: { phase: "preparing", percent: 0, message: "正在准备导出…" },
    });

    try {
      expect(wrapper.get('[data-test="export-progress-elapsed"]').text()).toBe("已用 0s");

      await vi.advanceTimersByTimeAsync(2000);
      await wrapper.vm.$nextTick();
      expect(wrapper.get('[data-test="export-progress-elapsed"]').text()).toBe("已用 2s");

      await wrapper.setProps({
        progress: { phase: "generating", percent: 60, message: "正在打包 EPUB 60%" },
      });
      expect(wrapper.get('[data-test="export-progress-message"]').text()).toBe(
        "正在打包 EPUB 60%",
      );
      expect(wrapper.get('[data-test="export-progress"] progress').attributes("value")).toBe("60");
    } finally {
      wrapper.unmount();
      vi.useRealTimers();
    }
  });

  it("removes the progress bar and stops the timer when busy turns false", async () => {
    vi.useFakeTimers();
    const wrapper = mountPanel({
      busy: true,
      progress: { phase: "generating", percent: 40, message: "正在打包 EPUB 40%" },
    });

    try {
      expect(wrapper.find('[data-test="export-progress"]').exists()).toBe(true);
      expect(vi.getTimerCount()).toBe(1);

      await wrapper.setProps({ busy: false });

      expect(wrapper.find('[data-test="export-progress"]').exists()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      wrapper.unmount();
      vi.useRealTimers();
    }
  });

  it("clears the elapsed timer on unmount", () => {
    vi.useFakeTimers();
    const wrapper = mountPanel({
      busy: true,
      progress: { phase: "generating", percent: 40, message: "正在打包 EPUB 40%" },
    });

    try {
      expect(vi.getTimerCount()).toBe(1);

      wrapper.unmount();

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders the busy progress without inline styles", () => {
    const wrapper = mountPanel({
      busy: true,
      progress: { phase: "generating", percent: 40, message: "正在打包 EPUB 40%" },
    });

    for (const element of wrapper.findAll("*")) {
      expect(element.attributes("style")).toBeUndefined();
    }
  });
});
