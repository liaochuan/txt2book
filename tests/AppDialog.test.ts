import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import AppDialog from "../src/components/AppDialog.vue";

enableAutoUnmount(afterEach);

afterEach(() => {
  document.body.innerHTML = "";
  document.body.style.overflow = "";
});

function dialog(): HTMLElement {
  const element = document.body.querySelector<HTMLElement>('[data-test="dialog"]');
  if (!element) throw new Error("弹窗未渲染");
  return element;
}

function backdrop(): HTMLElement {
  const element = document.body.querySelector<HTMLElement>('[data-test="dialog-backdrop"]');
  if (!element) throw new Error("遮罩未渲染");
  return element;
}

describe("AppDialog", () => {
  it("renders nothing while closed", () => {
    mount(AppDialog, { props: { open: false, title: "设置" } });

    expect(document.body.querySelector('[data-test="dialog"]')).toBeNull();
  });

  it("renders an accessible dialog with the title association", () => {
    mount(AppDialog, { props: { open: true, title: "Calibre-Web 设置" } });

    const panel = dialog();
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-modal")).toBe("true");
    const titleId = panel.getAttribute("aria-labelledby");
    expect(titleId).toBeTruthy();
    const title = document.getElementById(titleId!);
    expect(title?.textContent).toContain("Calibre-Web 设置");
    expect(panel.querySelector("h2")?.id).toBe(titleId);

    const close = document.body.querySelector('[data-test="dialog-close"]');
    expect(close?.getAttribute("aria-label")).toBe("关闭");
  });

  it("closes on Escape", async () => {
    const wrapper = mount(AppDialog, { props: { open: true, title: "设置" } });
    await flushPromises();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("closes on a backdrop click but not on clicks inside the panel", async () => {
    const wrapper = mount(AppDialog, { props: { open: true, title: "设置" } });
    await flushPromises();

    dialog().click();
    expect(wrapper.emitted("close")).toBeUndefined();

    backdrop().click();
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("moves focus into the panel and returns it when closed", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();

    const wrapper = mount(AppDialog, { props: { open: false, title: "设置" } });
    await wrapper.setProps({ open: true });
    await flushPromises();

    expect(document.activeElement).toBe(dialog());

    await wrapper.setProps({ open: false });
    await flushPromises();

    expect(document.activeElement).toBe(trigger);
  });

  it("locks body scrolling while open and restores it on close", async () => {
    document.body.style.overflow = "scroll";
    const wrapper = mount(AppDialog, { props: { open: false, title: "设置" } });

    await wrapper.setProps({ open: true });
    await flushPromises();
    expect(document.body.style.overflow).toBe("hidden");

    await wrapper.setProps({ open: false });
    await flushPromises();
    expect(document.body.style.overflow).toBe("scroll");
  });

  it("restores body scrolling when unmounted while open", async () => {
    const wrapper = mount(AppDialog, { props: { open: true, title: "设置" } });
    await flushPromises();
    expect(document.body.style.overflow).toBe("hidden");

    wrapper.unmount();

    expect(document.body.style.overflow).toBe("");
  });

  it("keeps the scroll lock while switching between open dialogs", async () => {
    const first = mount(AppDialog, { props: { open: true, title: "设置" } });
    await flushPromises();
    const second = mount(AppDialog, { props: { open: true, title: "书库" } });
    await flushPromises();
    expect(document.body.style.overflow).toBe("hidden");

    // 旧弹窗先关闭、新弹窗仍打开：不能提前恢复页面滚动。
    await first.setProps({ open: false });
    await flushPromises();
    expect(document.body.style.overflow).toBe("hidden");

    await second.setProps({ open: false });
    await flushPromises();
    expect(document.body.style.overflow).toBe("");
  });

  it("gives each dialog a unique title id", async () => {
    mount(AppDialog, { props: { open: true, title: "设置" } });
    mount(AppDialog, { props: { open: true, title: "书库" } });
    await flushPromises();

    const ids = [...document.body.querySelectorAll('[data-test="dialog"]')].map((element) =>
      element.getAttribute("aria-labelledby"),
    );
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});
