import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import BookMetaPanel from "../src/components/BookMetaPanel.vue";
import type { BookMeta } from "../src/types/book";

const META: BookMeta = {
  title: "旧书名",
  author: "某作者",
  language: "zh-CN",
  description: "一句简介",
};

function mountPanel(meta: BookMeta = META) {
  return mount(BookMetaPanel, { props: { meta } });
}

/** happy-dom 的 KeyboardEvent 构造参数对 isComposing 支持不稳，这里显式覆盖。 */
function dispatchKey(target: Element, key: string, isComposing = false): void {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  Object.defineProperty(event, "isComposing", { value: isComposing });
  target.dispatchEvent(event);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("BookMetaPanel", () => {
  it("renders the current meta", () => {
    const wrapper = mountPanel();

    expect((wrapper.get('[data-test="meta-title"]').element as HTMLInputElement).value).toBe(
      "旧书名",
    );
    expect((wrapper.get('[data-test="meta-author"]').element as HTMLInputElement).value).toBe(
      "某作者",
    );
    expect(
      (wrapper.get('[data-test="meta-language"]').element as HTMLSelectElement).value,
    ).toBe("zh-CN");
    expect(
      (wrapper.get('[data-test="meta-description"]').element as HTMLTextAreaElement).value,
    ).toBe("一句简介");
  });

  it("keeps every character and emits a full meta object on blur", async () => {
    const wrapper = mountPanel();
    const title = wrapper.get('[data-test="meta-title"]');

    await title.setValue("新的书名：第一卷！");
    await title.trigger("blur");

    expect(wrapper.emitted("update:meta")).toHaveLength(1);
    expect(wrapper.emitted("update:meta")?.[0]?.[0]).toEqual({
      title: "新的书名：第一卷！",
      author: "某作者",
      language: "zh-CN",
      description: "一句简介",
    });
  });

  it("debounces typing into one update without dropping characters", async () => {
    vi.useFakeTimers();
    const wrapper = mountPanel();
    const title = wrapper.get('[data-test="meta-title"]');

    await title.setValue("连");
    await title.setValue("连续");
    await title.setValue("连续输入");
    expect(wrapper.emitted("update:meta")).toBeUndefined();

    vi.advanceTimersByTime(299);
    await nextTick();
    expect(wrapper.emitted("update:meta")).toBeUndefined();

    vi.advanceTimersByTime(1);
    await nextTick();
    expect(wrapper.emitted("update:meta")?.[0]?.[0]).toMatchObject({
      title: "连续输入",
      author: "某作者",
      language: "zh-CN",
    });
  });

  it("emits immediately when the language changes and includes pending edits", async () => {
    const wrapper = mountPanel();

    await wrapper.get('[data-test="meta-title"]').setValue("待提交书名");
    await wrapper.get('[data-test="meta-language"]').setValue("en");

    expect(wrapper.emitted("update:meta")?.[0]?.[0]).toEqual({
      title: "待提交书名",
      author: "某作者",
      language: "en",
      description: "一句简介",
    });
  });

  it("clears the description with an explicit undefined value", async () => {
    const wrapper = mountPanel();
    const description = wrapper.get('[data-test="meta-description"]');

    await description.setValue("");
    await description.trigger("blur");

    const emitted = wrapper.emitted("update:meta")?.[0]?.[0] as BookMeta;
    // 父级会做对象合并，必须显式带键才能覆盖掉旧简介。
    expect(Object.keys(emitted)).toContain("description");
    expect(emitted.description).toBeUndefined();
    expect(emitted.title).toBe("旧书名");
  });

  it("adds a description that was previously missing", async () => {
    const wrapper = mountPanel({ title: "书", author: "", language: "zh-CN" });

    await wrapper.get('[data-test="meta-description"]').setValue("新增简介");
    await wrapper.get('[data-test="meta-description"]').trigger("blur");

    expect(wrapper.emitted("update:meta")?.[0]?.[0]).toEqual({
      title: "书",
      author: "",
      language: "zh-CN",
      description: "　　新增简介",
    });
  });

  it("indents every description paragraph on blur", async () => {
    const wrapper = mountPanel({ title: "书", author: "", language: "zh-CN" });
    const description = wrapper.get('[data-test="meta-description"]');

    await description.setValue("第一段\n\n第二段");
    await description.trigger("blur");

    expect(
      (description.element as HTMLTextAreaElement).value,
    ).toBe("　　第一段\n\n　　第二段");
    expect(wrapper.emitted("update:meta")?.[0]?.[0]).toMatchObject({
      description: "　　第一段\n\n　　第二段",
    });
  });

  it("does not emit when the value is unchanged", async () => {
    const wrapper = mountPanel();
    const title = wrapper.get('[data-test="meta-title"]');

    await title.setValue("旧书名");
    await title.trigger("blur");

    expect(wrapper.emitted("update:meta")).toBeUndefined();
  });

  it("syncs external meta changes into the fields", async () => {
    const wrapper = mountPanel();

    await wrapper.setProps({ meta: { ...META, title: "导入后的书名", author: "" } });

    expect((wrapper.get('[data-test="meta-title"]').element as HTMLInputElement).value).toBe(
      "导入后的书名",
    );
    expect((wrapper.get('[data-test="meta-author"]').element as HTMLInputElement).value).toBe("");
  });

  it("discards a dirty draft when the parent swaps books", async () => {
    vi.useFakeTimers();
    const wrapper = mountPanel();
    await wrapper.get('[data-test="meta-title"]').setValue("旧书未提交的草稿");

    await wrapper.setProps({
      meta: { title: "新书", author: "新作者", language: "en", description: "新简介" },
    });
    vi.advanceTimersByTime(1_000);
    await nextTick();

    expect(wrapper.emitted("update:meta")).toBeUndefined();
    expect((wrapper.get('[data-test="meta-title"]').element as HTMLInputElement).value).toBe(
      "新书",
    );
    expect((wrapper.get('[data-test="meta-author"]').element as HTMLInputElement).value).toBe(
      "新作者",
    );
    expect(
      (wrapper.get('[data-test="meta-language"]').element as HTMLSelectElement).value,
    ).toBe("en");
    expect(
      (wrapper.get('[data-test="meta-description"]').element as HTMLTextAreaElement).value,
    ).toBe("新简介");
  });

  it("ignores Enter during IME composition", async () => {
    const wrapper = mountPanel();
    const input = wrapper.get('[data-test="meta-title"]');
    await input.setValue("拼音输入");

    dispatchKey(input.element, "Enter", true);
    await nextTick();
    expect(wrapper.emitted("update:meta")).toBeUndefined();

    dispatchKey(input.element, "Enter", false);
    await nextTick();
    expect(wrapper.emitted("update:meta")).toHaveLength(1);
  });

  it("flushes pending edits when unmounted", async () => {
    // wrapper.unmount() 会清空 VTU 的事件历史，这里直接观察监听器。
    const onUpdate = vi.fn();
    const wrapper = mount(BookMetaPanel, {
      props: { meta: META, "onUpdate:meta": onUpdate },
    });
    await wrapper.get('[data-test="meta-title"]').setValue("卸载前保存");

    wrapper.unmount();

    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ title: "卸载前保存" }),
    );
  });
});
