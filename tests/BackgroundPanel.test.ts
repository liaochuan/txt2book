import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import BackgroundPanel from "../src/components/BackgroundPanel.vue";
import type { BackgroundConfig } from "../src/core/render/layout";

interface PanelProps {
  background: BackgroundConfig;
  disabled?: boolean;
  busy?: boolean;
  error?: string;
  previewSrc?: string;
}

function mountPanel(overrides: Partial<PanelProps> = {}) {
  return mount(BackgroundPanel, {
    props: { background: { kind: "none" }, ...overrides },
  });
}

function imageFile(name = "bg.png", type = "image/png"): File {
  return new File([new Uint8Array([137, 80, 78, 71])], name, { type });
}

describe("BackgroundPanel", () => {
  it("renders the four built-in presets", () => {
    const wrapper = mountPanel();

    for (const [id, label] of [
      ["paper", "纸纹"],
      ["grid", "网格"],
      ["dots", "点阵"],
      ["linen", "亚麻"],
    ] as const) {
      const card = wrapper.get(`[data-test="background-preset-${id}"]`);
      expect(card.text()).toContain(label);
      expect(card.attributes("aria-pressed")).toBe("false");
    }
  });

  it("emits select-preset with the preset id", async () => {
    const wrapper = mountPanel();

    await wrapper.get('[data-test="background-preset-grid"]').trigger("click");

    expect(wrapper.emitted("select-preset")).toEqual([["grid"]]);
  });

  it("marks the selected preset", () => {
    const wrapper = mountPanel({ background: { kind: "preset", presetId: "dots" } });

    expect(wrapper.get('[data-test="background-preset-dots"]').attributes("aria-pressed")).toBe(
      "true",
    );
    expect(wrapper.get('[data-test="background-preset-paper"]').attributes("aria-pressed")).toBe(
      "false",
    );
  });

  it("emits the selected file when the upload input changes", async () => {
    const wrapper = mountPanel();
    const input = wrapper.get('[data-test="background-file"]');
    const file = imageFile();

    Object.defineProperty(input.element, "files", {
      configurable: true,
      value: [file],
    });
    await input.trigger("change");

    expect(wrapper.emitted("upload")).toEqual([[file]]);
  });

  it("opens the hidden file picker from the upload button", async () => {
    const wrapper = mountPanel();
    const input = wrapper.get<HTMLInputElement>('[data-test="background-file"]');
    let opened = 0;
    input.element.click = () => {
      opened += 1;
    };

    await wrapper.get('[data-test="background-upload"]').trigger("click");

    expect(opened).toBe(1);
  });

  it("emits a pasted image as a file", async () => {
    const wrapper = mountPanel();
    const file = imageFile("pasted.png");
    const event = new Event("paste", { cancelable: true }) as Event & {
      clipboardData: unknown;
    };
    Object.defineProperty(event, "clipboardData", {
      value: {
        items: [{ type: "image/png", getAsFile: () => file }],
      },
    });
    const zone = wrapper.get('[data-test="background-paste"]');

    zone.element.dispatchEvent(event);
    await wrapper.vm.$nextTick();

    expect(wrapper.emitted("upload")).toEqual([[file]]);
    expect(event.defaultPrevented).toBe(true);
  });

  it("ignores pasted content that is not an image", async () => {
    const wrapper = mountPanel();
    const event = new Event("paste", { cancelable: true }) as Event & {
      clipboardData: unknown;
    };
    Object.defineProperty(event, "clipboardData", {
      value: { items: [{ type: "text/plain", getAsFile: () => null }] },
    });

    wrapper.get('[data-test="background-paste"]').element.dispatchEvent(event);
    await wrapper.vm.$nextTick();

    expect(wrapper.emitted("upload")).toBeUndefined();
    expect(event.defaultPrevented).toBe(false);
  });

  it("shows a thumbnail for a custom background", () => {
    const wrapper = mountPanel({
      background: {
        kind: "custom",
        custom: {
          data: new Uint8Array([1]),
          mimeType: "image/png",
          width: 1,
          height: 1,
          fileName: "bg.png",
        },
      },
      previewSrc: "blob:mock",
    });

    const image = wrapper.get('[data-test="background-preview"]');
    expect(image.attributes("src")).toBe("blob:mock");
    expect(wrapper.find('[data-test="background-selected"]').exists()).toBe(false);
  });

  it("shows a hint when a custom background has no preview source", () => {
    const wrapper = mountPanel({
      background: {
        kind: "custom",
        custom: {
          data: new Uint8Array([1]),
          mimeType: "image/png",
          width: 1,
          height: 1,
          fileName: "bg.png",
        },
      },
    });

    expect(wrapper.get('[data-test="background-selected"]').text()).toContain("已选择背景图");
    expect(wrapper.find('[data-test="background-preview"]').exists()).toBe(false);
  });

  it("emits clear only when a background is active", async () => {
    const empty = mountPanel();
    expect(empty.find('[data-test="background-clear"]').exists()).toBe(false);

    const wrapper = mountPanel({ background: { kind: "preset", presetId: "paper" } });
    await wrapper.get('[data-test="background-clear"]').trigger("click");

    expect(wrapper.emitted("clear")).toHaveLength(1);
  });

  it("keeps clear clickable while an upload is running", async () => {
    const wrapper = mountPanel({
      background: { kind: "preset", presetId: "paper" },
      busy: true,
    });
    const clear = wrapper.get('[data-test="background-clear"]');

    expect(clear.attributes("disabled")).toBeUndefined();

    await clear.trigger("click");

    expect(wrapper.emitted("clear")).toHaveLength(1);
  });

  it("offers clear as a cancel action during the first upload", async () => {
    const wrapper = mountPanel({ background: { kind: "none" }, busy: true });

    await wrapper.get('[data-test="background-clear"]').trigger("click");

    expect(wrapper.emitted("clear")).toHaveLength(1);
  });

  it("disables every control and explains why on e-ink", async () => {
    const wrapper = mountPanel({ background: { kind: "none" }, disabled: true });

    for (const id of ["paper", "grid", "dots", "linen"]) {
      expect(
        wrapper.get(`[data-test="background-preset-${id}"]`).attributes("disabled"),
      ).toBeDefined();
    }
    expect(wrapper.get('[data-test="background-upload"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-test="background-file"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-test="background-disabled-hint"]').text()).toContain(
      "墨水屏主题不使用背景图",
    );
  });

  it("does not emit anything while disabled", async () => {
    const wrapper = mountPanel({ background: { kind: "none" }, disabled: true });

    await wrapper.get('[data-test="background-preset-grid"]').trigger("click");
    await wrapper.get('[data-test="background-upload"]').trigger("click");

    expect(wrapper.emitted("select-preset")).toBeUndefined();
    expect(wrapper.emitted("upload")).toBeUndefined();
  });

  it("shows busy and error states", () => {
    const wrapper = mountPanel({ busy: true, error: "图片不能超过 10MB" });

    expect(wrapper.get('[data-test="background-busy"]').text()).toContain("正在处理背景图");
    expect(wrapper.get('[data-test="background-error"]').text()).toContain("图片不能超过 10MB");
    expect(wrapper.get('[data-test="background-upload"]').attributes("disabled")).toBeDefined();
  });

  it("uses no inline styles", () => {
    const wrapper = mountPanel({ background: { kind: "preset", presetId: "paper" } });

    for (const element of wrapper.findAll("*")) {
      expect(element.attributes("style")).toBeUndefined();
    }
  });
});
