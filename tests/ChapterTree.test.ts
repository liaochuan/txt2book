import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";import ChapterTree from "../src/components/ChapterTree.vue";
import type { Chapter, Volume } from "../src/types/book";

function chapter(
  id: string,
  title: string,
  volumeId: string | null = null,
  lines: string[] = ["正文"],
): Chapter {
  return { id, title, kind: "chapter", lines, volumeId };
}

function volume(id: string, title: string, kind: Volume["kind"] = "volume"): Volume {
  return { id, title, kind };
}

const c1 = chapter("c1", "第一章 起始", null, ["你好", "世界"]);
const c2 = chapter("c2", "第二章 远方", "v1", ["第二", "章"]);
const c3 = chapter("c3", "第三章 归途", "v1", ["第三"]);
const c4 = chapter("c4", "番外 一", "v2", ["番外", "内容"]);

function mountTree(
  props: Partial<{
    volumes: Volume[];
    chapters: Chapter[];
    selectedId: string | null;
    selectedVolumeId: string | null;
    canUndo: boolean;
  }> = {},
) {
  return mount(ChapterTree, {
    props: {
      volumes: [volume("v1", "第一卷"), volume("v2", "番外合集", "extra-group")],
      chapters: [c1, c2, c3, c4],
      selectedId: "c1",
      selectedVolumeId: null,
      canUndo: false,
      ...props,
    },
  });
}

const store = new Map<string, string>();
const scrollIntoView = vi.fn();

beforeEach(() => {
  store.clear();
  scrollIntoView.mockClear();
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: scrollIntoView,
    configurable: true,
    writable: true,
  });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (Element.prototype as Partial<Element>).scrollIntoView;
});

/** happy-dom 的 KeyboardEvent 构造参数对 isComposing 支持不稳，这里显式覆盖。 */
function dispatchKey(target: Element, key: string, isComposing = false): void {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  Object.defineProperty(event, "isComposing", { value: isComposing });
  target.dispatchEvent(event);
}

describe("ChapterTree", () => {
  it("renders groups in reading order", () => {
    const wrapper = mountTree();

    const titles = wrapper
      .findAll('[data-test="chapter-row"] .chapter-title')
      .map((node) => node.text());

    expect(titles).toEqual(["第一章 起始", "第二章 远方", "第三章 归途", "番外 一"]);
    expect(wrapper.findAll('[data-test="volume"]')).toHaveLength(2);
  });

  it("labels extra-group volumes as 番外", () => {
    const wrapper = mountTree();

    const sections = wrapper.findAll('[data-test="volume"]');
    expect(sections[0].text()).toContain("第一卷");
    expect(sections[1].text()).toContain("番外");
  });

  it("moves extra-group volumes after normal volumes regardless of input order", () => {
    const wrapper = mountTree({
      volumes: [volume("v2", "番外合集", "extra-group"), volume("v1", "第一卷")],
    });

    const labels = wrapper
      .findAll('[data-test="volume"] .volume-title')
      .map((node) => node.text());
    expect(labels).toEqual(["第一卷", "番外"]);

    const titles = wrapper
      .findAll('[data-test="chapter-row"] .chapter-title')
      .map((node) => node.text());
    expect(titles).toEqual(["第一章 起始", "第二章 远方", "第三章 归途", "番外 一"]);
  });

  it("keeps group order aligned with chapter order", () => {
    const wrapper = mountTree({
      volumes: [volume("v1", "第一卷")],
      chapters: [chapter("a", "章A", "v1"), chapter("b", "章B", null)],
    });

    const titles = wrapper
      .findAll('[data-test="chapter-row"] .chapter-title')
      .map((node) => node.text());
    expect(titles).toEqual(["章A", "章B"]);

    // 根级章节出现在卷组之后，且不嵌在卷的列表里。
    const root = wrapper.get("ul.tree-root");
    expect(root.text()).toContain("章B");
    expect(root.text()).not.toContain("章A");
  });

  it("appends volumes without chapters at the end as empty groups", () => {
    const wrapper = mountTree({
      volumes: [
        { id: "v0", title: "只有卷首", kind: "volume", lines: ["卷首文字"] },
        volume("v1", "第一卷"),
      ],
      chapters: [chapter("a", "章A", "v1")],
    });

    const labels = wrapper
      .findAll('[data-test="volume"] .volume-title')
      .map((node) => node.text());
    expect(labels).toEqual(["第一卷", "只有卷首"]);
    expect(wrapper.findAll('[data-test="volume"]')[1].text()).toContain("本卷暂无章节");
  });

  it("emits select when the title is activated", async () => {
    const wrapper = mountTree();
    const title = wrapper.findAll('[data-test="chapter-row"] .chapter-title')[1];

    expect(title.element.tagName).toBe("BUTTON");
    await title.trigger("click");

    expect(wrapper.emitted("select")?.[0]).toEqual(["c2"]);
  });

  it("marks the selected row on the title button", () => {
    const wrapper = mountTree({ selectedId: "c2" });
    const rows = wrapper.findAll('[data-test="chapter-row"]');

    expect(rows[0].classes()).not.toContain("chapter-row-selected");
    expect(rows[1].classes()).toContain("chapter-row-selected");
    expect(rows[1].attributes("aria-current")).toBeUndefined();
    expect(rows[1].get(".chapter-title").attributes("aria-current")).toBe("true");
  });

  it("shows the word count from joined lines", () => {
    const wrapper = mountTree();
    const row = wrapper.findAll('[data-test="chapter-row"]')[0];

    expect(row.get(".chapter-words").text()).toBe("4 字");
  });

  it("emits remove-chapter from the row delete button", async () => {
    const wrapper = mountTree();
    const row = wrapper.findAll('[data-test="chapter-row"]')[0];
    await row.get('[data-test="chapter-menu"]').trigger("click");
    const button = row.get('[data-test="delete-chapter"]');

    expect(button.attributes("aria-label")).toContain("第一章 起始");
    await button.trigger("click");

    expect(wrapper.emitted("remove-chapter")?.[0]).toEqual(["c1"]);
  });

  it("disables chapter deletion when only one chapter remains", async () => {
    const wrapper = mountTree({ chapters: [c1], volumes: [] });
    const row = wrapper.get('[data-test="chapter-row"]');
    await row.get('[data-test="chapter-menu"]').trigger("click");
    const button = row.get('[data-test="delete-chapter"]');

    expect(button.attributes("disabled")).toBeDefined();
    expect(button.attributes("title")).toBe("全书至少保留一章");
  });

  it("keeps chapter deletion enabled when more than one chapter exists", async () => {
    const wrapper = mountTree({ chapters: [c1, c2] });
    const row = wrapper.findAll('[data-test="chapter-row"]')[0];
    await row.get('[data-test="chapter-menu"]').trigger("click");

    expect(row.get('[data-test="delete-chapter"]').attributes("disabled")).toBeUndefined();
  });

  it("emits remove-volume from the volume header", async () => {
    const wrapper = mountTree();
    const button = wrapper.findAll('[data-test="delete-volume"]')[0];

    expect(button.attributes("aria-label")).toContain("第一卷");
    await button.trigger("click");

    expect(wrapper.emitted("remove-volume")?.[0]).toEqual(["v1"]);
  });

  it("emits select-volume when the volume name is clicked", async () => {
    const wrapper = mountTree();
    const name = wrapper.findAll('[data-test="volume"]')[0].get(".volume-name");

    expect(name.attributes("aria-label")).toBe("选中卷 第一卷（2 章）");
    await name.trigger("click");

    expect(wrapper.emitted("select-volume")?.[0]).toEqual(["v1"]);
  });

  it("toggles the extra group from its name instead of selecting it", async () => {
    const wrapper = mountTree({ selectedVolumeId: "v2" });
    const section = wrapper.findAll('[data-test="volume"]')[1];
    const name = section.get(".volume-name");
    const toggle = section.get(".volume-toggle");

    // 番外分组没有独立扉页，不能进入卷预览，也不显示选中态。
    expect(name.attributes("aria-current")).toBeUndefined();
    expect(name.classes()).not.toContain("volume-name-selected");
    expect(toggle.attributes("aria-expanded")).toBe("true");

    await name.trigger("click");

    expect(wrapper.emitted("select-volume")).toBeUndefined();
    expect(toggle.attributes("aria-expanded")).toBe("false");
    expect(wrapper.findAll('[data-test="chapter-row"]')).toHaveLength(3);
  });

  it("toggles collapse from the caret without selecting the volume", async () => {
    const wrapper = mountTree();
    const section = wrapper.findAll('[data-test="volume"]')[0];
    const toggle = section.get(".volume-toggle");

    expect(toggle.attributes("aria-label")).toContain("第一卷");
    await toggle.trigger("click");

    expect(wrapper.emitted("select-volume")).toBeUndefined();
    expect(toggle.attributes("aria-expanded")).toBe("false");
  });

  it("marks the selected volume on the name button", () => {
    const wrapper = mountTree({ selectedVolumeId: "v1" });
    const names = wrapper.findAll('[data-test="volume"] .volume-name');

    expect(names[0].attributes("aria-current")).toBe("true");
    expect(names[0].classes()).toContain("volume-name-selected");
    expect(names[1].attributes("aria-current")).toBeUndefined();
  });

  it("filters by title and reports the match count", async () => {
    const wrapper = mountTree();

    await wrapper.get('[data-test="search"]').setValue("第二章");

    expect(wrapper.findAll('[data-test="chapter-row"]')).toHaveLength(1);
    expect(wrapper.get('[data-test="chapter-count"]').text()).toContain("1");
    expect(wrapper.get('[data-test="chapter-count"]').text()).toContain("4");
  });

  it("ignores whitespace (including full-width) when filtering", async () => {
    const wrapper = mountTree();

    await wrapper.get('[data-test="search"]').setValue("　第 二 章　");

    const rows = wrapper.findAll('[data-test="chapter-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0].text()).toContain("第二章 远方");
  });

  it("hides volume groups without matches", async () => {
    const wrapper = mountTree();

    await wrapper.get('[data-test="search"]').setValue("第二章");

    const sections = wrapper.findAll('[data-test="volume"]');
    expect(sections).toHaveLength(1);
    expect(sections[0].text()).toContain("第一卷");
  });

  it("shows an empty result message when nothing matches", async () => {
    const wrapper = mountTree();

    await wrapper.get('[data-test="search"]').setValue("不存在的章节");

    expect(wrapper.findAll('[data-test="chapter-row"]')).toHaveLength(0);
    expect(wrapper.get('[data-test="empty-result"]').text()).toContain("没有匹配");
  });

  it("collapses a volume and persists the state", async () => {
    const wrapper = mountTree();
    const toolbar = wrapper.findAll('[data-test="volume"]')[0].get(".volume-toggle");

    expect(toolbar.attributes("aria-expanded")).toBe("true");
    expect(toolbar.attributes("aria-controls")).toBe("chapter-list-v1");
    expect(wrapper.find("#chapter-list-v1").exists()).toBe(true);

    await toolbar.trigger("click");

    expect(toolbar.attributes("aria-expanded")).toBe("false");
    expect(toolbar.attributes("aria-controls")).toBeUndefined();
    expect(wrapper.find("#chapter-list-v1").exists()).toBe(false);
    expect(wrapper.findAll('[data-test="chapter-row"]')).toHaveLength(2);
    expect(JSON.parse(localStorage.getItem("txt2book.collapsed") ?? "[]")).toEqual(["v1"]);

    wrapper.unmount();
    const restored = mountTree();
    expect(restored.findAll('[data-test="volume"]')[0].get(".volume-toggle").attributes("aria-expanded")).toBe(
      "false",
    );
    expect(restored.findAll('[data-test="chapter-row"]')).toHaveLength(2);
  });

  it("keeps unknown collapsed ids instead of dropping them", async () => {
    localStorage.setItem("txt2book.collapsed", JSON.stringify(["ghost"]));
    const wrapper = mountTree();

    expect(wrapper.findAll('[data-test="chapter-row"]')).toHaveLength(4);
    const toggle = wrapper.findAll('[data-test="volume"]')[0].get(".volume-toggle");
    expect(toggle.attributes("aria-expanded")).toBe("true");

    await toggle.trigger("click");

    expect(JSON.parse(localStorage.getItem("txt2book.collapsed") ?? "[]")).toEqual(["ghost", "v1"]);
  });

  it("restores the full list and collapse state after clearing the search", async () => {
    localStorage.setItem("txt2book.collapsed", JSON.stringify(["v1"]));
    const wrapper = mountTree();
    const search = wrapper.get('[data-test="search"]');

    expect(wrapper.findAll('[data-test="chapter-row"]')).toHaveLength(2);

    await search.setValue("第三章");
    expect(wrapper.findAll('[data-test="chapter-row"]')).toHaveLength(1);

    await search.setValue("");
    expect(wrapper.findAll('[data-test="chapter-row"]')).toHaveLength(2);
    expect(wrapper.get('[data-test="chapter-count"]').text()).toBe("共 4 章");
    expect(
      wrapper.findAll('[data-test="volume"]')[0].get(".volume-toggle").attributes("aria-expanded"),
    ).toBe("false");
  });

  it("disables the extra group name while searching", async () => {
    const wrapper = mountTree();

    await wrapper.get('[data-test="search"]').setValue("番外");

    const name = wrapper.get('[data-test="volume"] .volume-name');
    expect(name.text()).toContain("番外");
    expect(name.attributes("disabled")).toBeDefined();
  });

  it("disables collapsing while searching", async () => {
    const wrapper = mountTree();
    await wrapper.get('[data-test="search"]').setValue("第二章");

    const toggle = wrapper.findAll('[data-test="volume"]')[0].get(".volume-toggle");
    expect(toggle.attributes("disabled")).toBeDefined();
    expect(toggle.attributes("aria-expanded")).toBe("true");

    await toggle.trigger("click");

    expect(toggle.attributes("aria-expanded")).toBe("true");
    expect(localStorage.getItem("txt2book.collapsed")).toBeNull();
  });

  it("ignores an unreadable collapsed state", () => {
    localStorage.setItem("txt2book.collapsed", "{not json");

    const wrapper = mountTree();

    expect(wrapper.findAll('[data-test="chapter-row"]')).toHaveLength(4);
  });

  it("expands collapsed volumes while searching", async () => {
    localStorage.setItem("txt2book.collapsed", JSON.stringify(["v1"]));
    const wrapper = mountTree();

    await wrapper.get('[data-test="search"]').setValue("第三章");

    expect(wrapper.findAll('[data-test="chapter-row"]')).toHaveLength(1);
  });

  it("renames inline with Enter", async () => {
    const wrapper = mountTree();
    const row = wrapper.findAll('[data-test="chapter-row"]')[0];

    await row.get(".chapter-title").trigger("dblclick");
    const input = row.get('[data-test="rename-input"]');
    expect((input.element as HTMLInputElement).value).toBe("第一章 起始");

    await input.setValue("  新标题  ");
    await input.trigger("keydown.enter");

    expect(wrapper.emitted("rename")?.[0]).toEqual([{ id: "c1", title: "新标题" }]);
    expect(row.find('[data-test="rename-input"]').exists()).toBe(false);
  });

  it("cancels rename with Escape", async () => {
    const wrapper = mountTree();
    const row = wrapper.findAll('[data-test="chapter-row"]')[0];

    await row.get(".chapter-title").trigger("dblclick");
    const input = row.get('[data-test="rename-input"]');
    await input.setValue("不要保存");
    await input.trigger("keydown.esc");

    expect(wrapper.emitted("rename")).toBeUndefined();
    expect(row.get(".chapter-title").text()).toBe("第一章 起始");
  });

  it("saves rename on blur", async () => {
    const wrapper = mountTree();
    const row = wrapper.findAll('[data-test="chapter-row"]')[0];

    await row.get(".chapter-title").trigger("dblclick");
    const input = row.get('[data-test="rename-input"]');
    await input.setValue("模糊保存");
    await input.trigger("blur");

    expect(wrapper.emitted("rename")?.[0]).toEqual([{ id: "c1", title: "模糊保存" }]);
  });

  it("does not save when the blur follows Escape", async () => {
    const wrapper = mountTree();
    const row = wrapper.findAll('[data-test="chapter-row"]')[0];

    await row.get(".chapter-title").trigger("dblclick");
    const input = row.get('[data-test="rename-input"]');
    const inputEl = input.element as HTMLInputElement;
    await input.setValue("不要保存");
    dispatchKey(inputEl, "Escape");
    await wrapper.vm.$nextTick();

    expect(row.find('[data-test="rename-input"]').exists()).toBe(false);
    inputEl.dispatchEvent(new Event("blur"));
    await wrapper.vm.$nextTick();

    expect(wrapper.emitted("rename")).toBeUndefined();
  });

  it("ignores Enter and Escape during IME composition", async () => {
    const wrapper = mountTree();
    const row = wrapper.findAll('[data-test="chapter-row"]')[0];

    await row.get(".chapter-title").trigger("dblclick");
    const input = row.get('[data-test="rename-input"]');
    const inputEl = input.element as HTMLInputElement;
    await input.setValue("拼音");

    dispatchKey(inputEl, "Enter", true);
    await wrapper.vm.$nextTick();

    expect(wrapper.emitted("rename")).toBeUndefined();
    expect(row.find('[data-test="rename-input"]').exists()).toBe(true);

    dispatchKey(inputEl, "Escape", true);
    await wrapper.vm.$nextTick();

    expect(row.find('[data-test="rename-input"]').exists()).toBe(true);
  });

  it("starts renaming with F2", async () => {
    const wrapper = mountTree();
    const row = wrapper.findAll('[data-test="chapter-row"]')[0];

    await row.get(".chapter-title").trigger("keydown", { key: "F2" });

    expect(row.find('[data-test="rename-input"]').exists()).toBe(true);
  });

  it("opens the rename editor from the menu", async () => {
    const wrapper = mountTree();
    const row = wrapper.findAll('[data-test="chapter-row"]')[0];
    await row.get('[data-test="chapter-menu"]').trigger("click");
    const button = row.get('[data-test="rename-chapter"]');

    expect(button.text()).toContain("重命名");
    expect(button.attributes("aria-label")).toContain("第一章 起始");

    await button.trigger("click");

    expect(row.find('[data-test="rename-input"]').exists()).toBe(true);
  });

  it("cancels editing before deleting the chapter", async () => {
    const wrapper = mountTree();
    const row = wrapper.findAll('[data-test="chapter-row"]')[0];

    await row.get(".chapter-title").trigger("dblclick");
    await row.get('[data-test="rename-input"]').setValue("未保存的标题");

    await row.get('[data-test="chapter-menu"]').trigger("click");
    const remove = row.get('[data-test="delete-chapter"]');
    await remove.trigger("mousedown");
    await remove.trigger("click");

    expect(wrapper.emitted("rename")).toBeUndefined();
    expect(wrapper.emitted("remove-chapter")?.[0]).toEqual(["c1"]);
    expect(row.find('[data-test="rename-input"]').exists()).toBe(false);
  });

  it("does not emit rename when the title is unchanged or empty", async () => {
    const wrapper = mountTree();
    const row = wrapper.findAll('[data-test="chapter-row"]')[0];

    await row.get(".chapter-title").trigger("dblclick");
    await row.get('[data-test="rename-input"]').trigger("keydown.enter");

    await row.get(".chapter-title").trigger("dblclick");
    const input = row.get('[data-test="rename-input"]');
    await input.setValue("   ");
    await input.trigger("keydown.enter");

    expect(wrapper.emitted("rename")).toBeUndefined();
  });

  it("shows the undo button only when canUndo is true", async () => {
    const withoutUndo = mountTree({ canUndo: false });
    expect(withoutUndo.find('[data-test="undo"]').exists()).toBe(false);

    const withUndo = mountTree({ canUndo: true });
    const button = withUndo.get('[data-test="undo"]');
    expect(button.text()).toContain("撤销");

    await button.trigger("click");
    expect(withUndo.emitted("undo")).toHaveLength(1);
  });

  it("shows a hint when the book has no chapters", () => {
    const wrapper = mountTree({ volumes: [], chapters: [] });

    expect(wrapper.findAll('[data-test="chapter-row"]')).toHaveLength(0);
    expect(wrapper.get('[data-test="empty-tree"]').text()).toContain("还没有章节");
  });

  it("emits split-chapter from the row button", async () => {
    const wrapper = mountTree();
    const row = wrapper.findAll('[data-test="chapter-row"]')[0];
    await row.get('[data-test="chapter-menu"]').trigger("click");
    await row.get('[data-test="split-chapter"]').trigger("click");
    expect(wrapper.emitted("split-chapter")?.[0]).toEqual(["c1"]);
  });

  it("disables split for chapters with fewer than two lines", async () => {
    const wrapper = mountTree({
      volumes: [],
      chapters: [chapter("only", "只有一行", null, ["正文"])],
    });
    const row = wrapper.get('[data-test="chapter-row"]');
    await row.get('[data-test="chapter-menu"]').trigger("click");
    expect(row.get('[data-test="split-chapter"]').attributes("disabled")).toBeDefined();
  });

  it("hides row actions until the menu is opened", async () => {
    const wrapper = mountTree();
    const row = wrapper.findAll('[data-test="chapter-row"]')[0];
    const menuButton = row.get('[data-test="chapter-menu"]');

    expect(row.find('[data-test="rename-chapter"]').exists()).toBe(false);
    expect(row.find('[data-test="split-chapter"]').exists()).toBe(false);
    expect(row.find('[data-test="delete-chapter"]').exists()).toBe(false);
    expect(menuButton.attributes("aria-expanded")).toBe("false");

    await menuButton.trigger("click");

    expect(menuButton.attributes("aria-expanded")).toBe("true");
    expect(menuButton.attributes("aria-controls")).toBe(
      row.get('[data-test="chapter-menu-panel"]').attributes("id"),
    );
    expect(row.find('[data-test="chapter-menu-panel"]').exists()).toBe(true);
    expect(row.findAll(".chapter-menu-item")).toHaveLength(3);
    expect(row.get('[data-test="chapter-menu-panel"]').attributes("style")).toContain("right:");
  });

  it("closes the menu when clicking outside the row", async () => {
    const wrapper = mountTree();
    const row = wrapper.findAll('[data-test="chapter-row"]')[0];
    await row.get('[data-test="chapter-menu"]').trigger("click");
    expect(row.find('[data-test="chapter-menu-panel"]').exists()).toBe(true);

    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await wrapper.vm.$nextTick();

    expect(row.find('[data-test="chapter-menu-panel"]').exists()).toBe(false);
  });

  it("returns focus to the menu trigger after Escape", async () => {
    const wrapper = mountTree();
    const row = wrapper.findAll('[data-test="chapter-row"]')[0];
    const menuButton = row.get('[data-test="chapter-menu"]');
    await menuButton.trigger("click");
    const focus = vi.spyOn(menuButton.element as HTMLButtonElement, "focus");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await wrapper.vm.$nextTick();

    expect(row.find('[data-test="chapter-menu-panel"]').exists()).toBe(false);
    expect(focus).toHaveBeenCalled();
  });

  it("closes the menu after choosing an action", async () => {
    const wrapper = mountTree();
    const row = wrapper.findAll('[data-test="chapter-row"]')[0];
    await row.get('[data-test="chapter-menu"]').trigger("click");

    await row.get('[data-test="rename-chapter"]').trigger("click");

    expect(row.find('[data-test="chapter-menu-panel"]').exists()).toBe(false);
    expect(row.find('[data-test="rename-input"]').exists()).toBe(true);
  });

  it("keeps only one chapter menu open at a time", async () => {
    const wrapper = mountTree();
    const rows = wrapper.findAll('[data-test="chapter-row"]');

    await rows[0].get('[data-test="chapter-menu"]').trigger("click");
    await rows[1].get('[data-test="chapter-menu"]').trigger("click");

    expect(rows[0].find('[data-test="chapter-menu-panel"]').exists()).toBe(false);
    expect(rows[1].find('[data-test="chapter-menu-panel"]').exists()).toBe(true);
  });

  it("scrolls the selected chapter into view and highlights it", async () => {
    const chapters = Array.from({ length: 40 }, (_value, index) =>
      chapter(`c${index}`, `第${index + 1}章`, null, ["正文"]),
    );
    const wrapper = mountTree({ chapters, volumes: [] });

    await wrapper.setProps({ selectedId: "c30" });

    await vi.waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", behavior: "smooth" });
    expect(wrapper.get('[data-chapter-id="c30"]').classes()).toContain("chapter-row-located");
  });

  it("expands a collapsed volume before locating its chapter", async () => {
    store.set("txt2book.collapsed", JSON.stringify(["v1"]));
    const wrapper = mountTree({ selectedId: null });
    expect(wrapper.find('[data-chapter-id="c2"]').exists()).toBe(false);

    await wrapper.setProps({ selectedId: "c2" });

    await vi.waitFor(() => expect(wrapper.find('[data-chapter-id="c2"]').exists()).toBe(true));
    expect(scrollIntoView).toHaveBeenCalled();
    expect(JSON.parse(store.get("txt2book.collapsed") ?? "[]")).not.toContain("v1");
  });

  it("clears a search that hides the located chapter", async () => {
    const wrapper = mountTree();
    await wrapper.get('[data-test="search"]').setValue("不存在的标题");

    await wrapper.setProps({ selectedId: "c2" });

    await vi.waitFor(() =>
      expect((wrapper.get('[data-test="search"]').element as HTMLInputElement).value).toBe(""),
    );
    expect(wrapper.find('[data-chapter-id="c2"]').exists()).toBe(true);
    expect(scrollIntoView).toHaveBeenCalled();
  });
});
