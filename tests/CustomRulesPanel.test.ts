import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CustomRulesPanel from "../src/components/CustomRulesPanel.vue";
import { STORAGE_KEY, loadRules, type ChapterRule } from "../src/core/customRules";

function makeRule(overrides: Partial<ChapterRule> = {}): ChapterRule {
  return {
    id: "rule-1",
    label: "序章",
    pattern: "^序章",
    flags: "",
    capture: 0,
    enabled: true,
    kind: "chapter",
    ...overrides,
  };
}

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  });
});

describe("CustomRulesPanel", () => {
  it("lists rules with their kind and pattern", () => {
    const wrapper = mount(CustomRulesPanel, {
      props: { rules: [makeRule({ kind: "volume" })] },
    });

    expect(wrapper.text()).toContain("序章");
    expect(wrapper.text()).toContain("卷标题");
    expect(wrapper.text()).toContain("/^序章/");
  });

  it("leaves reparse to UploadPanel", () => {
    const wrapper = mount(CustomRulesPanel, { props: { rules: [] } });

    expect(wrapper.text()).not.toContain("重新解析");
  });

  it("adds a rule with the chosen kind and persists it", async () => {
    const wrapper = mount(CustomRulesPanel, { props: { rules: [] } });
    expect(wrapper.find('[data-test="add-rule"]').exists()).toBe(false);

    await wrapper.get('[data-test="toggle-rules"]').trigger("click");
    await wrapper.get('[data-test="add-rule"]').trigger("click");

    await wrapper.get('[data-test="rule-label"]').setValue("后记");
    await wrapper.get('[data-test="rule-kind"]').setValue("epilogue");
    await wrapper.get('[data-test="rule-pattern"]').setValue("^后记");
    await wrapper.get('[data-test="rule-draft"]').trigger("submit");

    const emitted = wrapper.emitted("update:rules");
    expect(emitted).toBeTruthy();
    const next = emitted?.[0]?.[0] as ChapterRule[];
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ label: "后记", kind: "epilogue", pattern: "^后记" });
    expect(loadRules()).toHaveLength(1);
    expect(loadRules()[0]?.kind).toBe("epilogue");
  });

  it("shows Chinese validation for an invalid pattern", async () => {
    const wrapper = mount(CustomRulesPanel, { props: { rules: [makeRule()] } });

    await wrapper.get('[data-test="rule-edit"]').trigger("click");
    await wrapper.get('[data-test="rule-pattern"]').setValue("(");

    expect(wrapper.get('[data-test="rule-error"]').text()).toContain("正则表达式无效");
    expect(wrapper.get('[data-test="rule-save"]').attributes("disabled")).toBeDefined();
  });

  it("does not show errors before the draft is touched", async () => {
    const wrapper = mount(CustomRulesPanel, { props: { rules: [] } });

    await wrapper.get('[data-test="toggle-rules"]').trigger("click");
    await wrapper.get('[data-test="add-rule"]').trigger("click");

    expect(wrapper.find('[data-test="rule-error"]').exists()).toBe(false);
  });

  it("toggles enabled and persists the change", async () => {
    const wrapper = mount(CustomRulesPanel, { props: { rules: [makeRule()] } });

    await wrapper.get('[data-test="rule-enabled"]').trigger("change");

    const next = wrapper.emitted("update:rules")?.[0]?.[0] as ChapterRule[];
    expect(next[0]?.enabled).toBe(false);
    expect(loadRules()[0]?.enabled).toBe(false);
  });

  it("removes a rule after confirmation", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const wrapper = mount(CustomRulesPanel, { props: { rules: [makeRule()] } });

    await wrapper.get('[data-test="rule-remove"]').trigger("click");

    expect(wrapper.emitted("update:rules")).toEqual([[[]]]);
    expect(loadRules()).toEqual([]);
  });

  it("uses no inline styles", () => {
    const wrapper = mount(CustomRulesPanel, { props: { rules: [makeRule()] } });

    for (const element of wrapper.findAll("*")) {
      expect(element.attributes("style")).toBeUndefined();
    }
  });
});
