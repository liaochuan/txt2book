import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  STORAGE_KEY,
  compileRule,
  loadRules,
  saveRules,
  type ChapterRule,
} from "../src/core/customRules";

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  });
});

function rule(overrides: Partial<ChapterRule> = {}): ChapterRule {
  return {
    id: "rule-1",
    label: "自定义规则",
    pattern: "^第.+回",
    enabled: true,
    kind: "chapter",
    ...overrides,
  };
}

describe("customRules", () => {
  it("compiles a regex rule and defaults capture to 0", () => {
    const compiled = compileRule(rule({ flags: "i" }));
    expect(compiled.regex.test("第一章 开端")).toBe(false);
    expect(compiled.regex.test("第1回 开端")).toBe(true);
    expect(compiled.capture).toBe(0);
  });

  it("keeps an explicit capture group index", () => {
    const compiled = compileRule(rule({ pattern: "^(第.+回)", capture: 1 }));
    expect(compiled.capture).toBe(1);
    expect(compiled.regex.exec("第1回 开端")?.[1]).toBe("第1回");
  });

  it("defaults kind to chapter for rules saved without it", () => {
    store.set(
      STORAGE_KEY,
      JSON.stringify([{ id: "old", label: "旧规则", pattern: "^第.+回", enabled: true }]),
    );
    expect(loadRules()).toEqual([
      { id: "old", label: "旧规则", pattern: "^第.+回", enabled: true, kind: "chapter" },
    ]);
  });

  it("round-trips rules through saveRules and loadRules", () => {
    const rules = [rule({ kind: "extra" }), rule({ id: "rule-2", kind: "prologue" })];
    saveRules(rules);
    expect(loadRules()).toEqual(rules);
  });

  it("returns an empty list for corrupt storage", () => {
    store.set(STORAGE_KEY, "{not json");
    expect(loadRules()).toEqual([]);
  });

  it("filters malformed entries", () => {
    store.set(
      STORAGE_KEY,
      JSON.stringify([null, 42, "text", { label: "缺 pattern" }, { pattern: "^x" }]),
    );
    expect(loadRules()).toEqual([]);
  });

  it("strips g and y flags", () => {
    const compiled = compileRule(rule({ flags: "giy" }));
    expect(compiled.regex.flags).toBe("i");
    expect(compiled.regex.test("第1回 开端")).toBe(true);
    expect(compiled.regex.test("第1回 开端")).toBe(true);
  });

  it("keeps volume kind and falls back to chapter for illegal kinds", () => {
    store.set(
      STORAGE_KEY,
      JSON.stringify([
        { id: "v", label: "卷规则", pattern: "^Book", kind: "volume", enabled: true },
        { id: "x", label: "坏类型", pattern: "^X", kind: "bogus", enabled: true },
        { id: "m", label: "缺类型", pattern: "^Y", enabled: true },
      ]),
    );
    expect(loadRules().map((item) => item.kind)).toEqual(["volume", "chapter", "chapter"]);
  });

  it("migrates legacy keyword rules to equivalent regex", () => {
    store.set(
      STORAGE_KEY,
      JSON.stringify([
        {
          id: "k1",
          name: "序",
          mode: "keyword",
          pattern: "序",
          keywordTemplate: "prefix",
          enabled: true,
        },
        {
          id: "k2",
          name: "多词",
          mode: "keyword",
          pattern: "序\n楔子",
          keywordTemplate: "prefix",
          enabled: true,
        },
        {
          id: "k3",
          name: "任意位置",
          mode: "keyword",
          pattern: "序",
          keywordTemplate: "anywhere",
          enabled: true,
        },
      ]),
    );
    const rules = loadRules();
    expect(rules[0].pattern).toBe("^序.*$");
    const prefix = compileRule(rules[0]).regex;
    expect(prefix.test("序")).toBe(true);
    expect(prefix.test("他翻开秩序册")).toBe(false);
    const multi = compileRule(rules[1]).regex;
    expect(multi.test("序章开始")).toBe(true);
    expect(multi.test("楔子")).toBe(true);
    expect(rules[2].pattern).toBe("^.*序.*$");
  });
});
