import { effectScope, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PERSIST_DELAY_MS,
  useLayoutSettings,
} from "../src/composables/useLayoutSettings";
import { defaultLayoutFor } from "../src/core/render/layout";
import { DEFAULT_THEME_ID } from "../src/core/render/themes";
import type { ThemeId } from "../src/types/book";

const store = new Map<string, string>();

/** 与 useThemePreference 测试一致：用最小 Map 桩代替 happy-dom 的 localStorage。 */
function stubStorage(overrides: Partial<Storage> = {}): void {
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
    ...overrides,
  });
}

function keyFor(themeId: ThemeId): string {
  return `txt2book.layout.${themeId}`;
}

function readStored(themeId: ThemeId): unknown {
  const raw = store.get(keyFor(themeId));
  return raw === undefined ? undefined : (JSON.parse(raw) as unknown);
}

/** 让防抖写盘到期。 */
function advancePersist(): void {
  vi.advanceTimersByTime(PERSIST_DELAY_MS);
}

beforeEach(() => {
  store.clear();
  stubStorage();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useLayoutSettings", () => {
  it("starts from the theme default layout", () => {
    const { layout } = useLayoutSettings(ref<ThemeId>("paper"));

    expect(layout.value).toEqual(defaultLayoutFor("paper"));
  });

  it("debounces writes and then persists element changes under the per-theme key", () => {
    const { setElement } = useLayoutSettings(ref<ThemeId>("paper"));

    setElement("body", { fontSize: 1.4, textIndent: 1 });

    expect(store.has(keyFor("paper"))).toBe(false);

    advancePersist();
    expect(store.has(keyFor("paper"))).toBe(true);

    const restored = useLayoutSettings(ref<ThemeId>("paper"));
    expect(restored.layout.value.typography.elements.body.fontSize).toBe(1.4);
    expect(restored.layout.value.typography.elements.body.textIndent).toBe(1);
    // 未改动的字段保持主题默认值。
    expect(restored.layout.value.typography.elements.body.lineHeight).toBe(
      defaultLayoutFor("paper").typography.elements.body.lineHeight,
    );
  });

  it("collapses rapid changes into one write", () => {
    const { setElement } = useLayoutSettings(ref<ThemeId>("paper"));

    setElement("body", { fontSize: 1.2 });
    vi.advanceTimersByTime(100);
    setElement("body", { fontSize: 1.3 });
    vi.advanceTimersByTime(100);
    expect(store.has(keyFor("paper"))).toBe(false);

    advancePersist();

    expect(readStored("paper")).toMatchObject({
      typography: { elements: { body: { fontSize: 1.3 } } },
    });
  });

  it("normalizes out-of-range and invalid element values", () => {
    const { layout, setElement } = useLayoutSettings(ref<ThemeId>("paper"));

    setElement("chapterTitle", {
      fontSize: 99,
      fontFamily: "missing" as never,
      color: "not-a-color",
    });

    const style = layout.value.typography.elements.chapterTitle;
    expect(style.fontSize).toBe(1.8);
    expect(style.fontFamily).toBe(defaultLayoutFor("paper").typography.elements.chapterTitle.fontFamily);
    expect(style.color).toBe(defaultLayoutFor("paper").typography.elements.chapterTitle.color);
  });

  it("keeps the current value when a patch field is undefined", () => {
    const { layout, setElement } = useLayoutSettings(ref<ThemeId>("paper"));
    setElement("body", { fontSize: 1.4 });

    setElement("body", { fontSize: undefined, lineHeight: 2.2 });

    const style = layout.value.typography.elements.body;
    expect(style.fontSize).toBe(1.4);
    expect(style.lineHeight).toBe(2.2);
  });

  it("ignores unknown element keys", () => {
    const { layout, setElement } = useLayoutSettings(ref<ThemeId>("paper"));
    const before = layout.value;

    expect(() => setElement("unknown" as never, { fontSize: 1.4 })).not.toThrow();

    expect(layout.value).toEqual(before);
    advancePersist();
    expect(store.has(keyFor("paper"))).toBe(false);
  });

  it("loads the matching configuration when the theme changes without mixing themes", async () => {
    const themeId = ref<ThemeId>("paper");
    const { layout, setElement } = useLayoutSettings(themeId);
    setElement("body", { fontSize: 1.5 });

    themeId.value = "night";
    await nextTick();

    expect(layout.value.typography.elements.body.fontSize).toBe(
      defaultLayoutFor("night").typography.elements.body.fontSize,
    );
    // 切换主题会先 flush 上一个主题的待写内容。
    expect(readStored("paper")).toMatchObject({
      typography: { elements: { body: { fontSize: 1.5 } } },
    });

    setElement("body", { fontSize: 1.2 });
    advancePersist();
    expect(readStored("night")).toMatchObject({
      typography: { elements: { body: { fontSize: 1.2 } } },
    });

    themeId.value = "paper";
    await nextTick();

    expect(layout.value.typography.elements.body.fontSize).toBe(1.5);
    expect(readStored("night")).toMatchObject({
      typography: { elements: { body: { fontSize: 1.2 } } },
    });
  });

  it.each(["{not json", "", "null", "42", "[]", '"text"'])(
    "falls back to defaults for the invalid stored payload %j",
    (raw) => {
      store.set(keyFor("paper"), raw);

      const { layout } = useLayoutSettings(ref<ThemeId>("paper"));

      expect(layout.value).toEqual(defaultLayoutFor("paper"));
    },
  );

  it("falls back to the default layout for an unknown theme", () => {
    const { layout } = useLayoutSettings(ref<ThemeId>("missing" as ThemeId));

    expect(layout.value).toEqual(defaultLayoutFor(DEFAULT_THEME_ID));
  });

  it("resets the current theme and removes its stored entry", () => {
    const { layout, setElement, setBackground, reset } = useLayoutSettings(ref<ThemeId>("paper"));
    setElement("body", { fontSize: 1.6 });
    setBackground({ kind: "preset", presetId: "grid" });
    advancePersist();
    expect(store.has(keyFor("paper"))).toBe(true);

    reset();
    advancePersist();

    expect(store.has(keyFor("paper"))).toBe(false);
    expect(layout.value).toEqual(defaultLayoutFor("paper"));
  });

  it("does not resurrect a pending write after reset", () => {
    const { setElement, reset } = useLayoutSettings(ref<ThemeId>("paper"));
    setElement("body", { fontSize: 1.6 });

    reset();
    advancePersist();

    expect(store.has(keyFor("paper"))).toBe(false);
  });

  it("resetTypography restores typography but keeps a custom background", () => {
    const data = new Uint8Array([9, 8, 7, 6]);
    const { layout, setElement, setBackground, resetTypography } = useLayoutSettings(
      ref<ThemeId>("paper"),
    );
    setElement("body", { fontSize: 1.6, textIndent: 3 });
    setBackground({
      kind: "custom",
      custom: { data, mimeType: "image/png", width: 10, height: 20, fileName: "bg.png" },
    });
    advancePersist();

    resetTypography();

    const defaults = defaultLayoutFor("paper");
    expect(layout.value.typography).toEqual(defaults.typography);
    expect(layout.value.background.kind).toBe("custom");
    expect(Array.from(layout.value.background.custom?.data ?? [])).toEqual(Array.from(data));

    advancePersist();
    const restored = useLayoutSettings(ref<ThemeId>("paper")).layout.value;
    expect(restored.typography).toEqual(defaults.typography);
    expect(restored.background.kind).toBe("custom");
    expect(restored.background.custom?.fileName).toBe("bg.png");
  });

  it("writes defaults when removing the stored entry fails", () => {
    stubStorage({
      removeItem: () => {
        throw new Error("SecurityError");
      },
    });
    const { layout, setElement, reset } = useLayoutSettings(ref<ThemeId>("paper"));
    setElement("body", { fontSize: 1.6 });
    advancePersist();

    reset();

    expect(layout.value).toEqual(defaultLayoutFor("paper"));
    expect(readStored("paper")).toMatchObject({
      typography: { elements: { body: { fontSize: defaultLayoutFor("paper").typography.elements.body.fontSize } } },
      background: { kind: "none" },
    });
  });

  it("flushes pending writes when the owning scope is disposed", () => {
    const scope = effectScope();
    const settings = scope.run(() => useLayoutSettings(ref<ThemeId>("paper")));
    if (!settings) throw new Error("effect scope 未返回 composable");

    settings.setElement("body", { fontSize: 1.4 });
    expect(store.has(keyFor("paper"))).toBe(false);

    scope.stop();

    expect(store.has(keyFor("paper"))).toBe(true);
    const restored = useLayoutSettings(ref<ThemeId>("paper"));
    expect(restored.layout.value.typography.elements.body.fontSize).toBe(1.4);
  });

  it("keeps working in memory when writing storage fails", () => {
    stubStorage({
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    const { layout, setElement } = useLayoutSettings(ref<ThemeId>("paper"));

    expect(() => setElement("body", { fontSize: 1.3 })).not.toThrow();
    advancePersist();

    expect(layout.value.typography.elements.body.fontSize).toBe(1.3);
  });

  it("falls back to defaults when reading storage throws", () => {
    stubStorage({
      getItem: () => {
        throw new Error("SecurityError");
      },
    });

    const { layout, setElement } = useLayoutSettings(ref<ThemeId>("paper"));

    expect(layout.value).toEqual(defaultLayoutFor("paper"));
    expect(() => setElement("body", { fontSize: 1.3 })).not.toThrow();
  });

  it("round-trips a custom background through base64 persistence", () => {
    const data = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
    const { setBackground } = useLayoutSettings(ref<ThemeId>("paper"));

    setBackground({
      kind: "custom",
      custom: { data, mimeType: "image/png", width: 1600, height: 900, fileName: "bg.png" },
    });
    advancePersist();

    const stored = readStored("paper") as {
      background: { custom: { data: unknown } };
    };
    expect(typeof stored.background.custom.data).toBe("string");

    const restored = useLayoutSettings(ref<ThemeId>("paper")).layout.value.background;
    expect(restored.kind).toBe("custom");
    expect(restored.custom?.mimeType).toBe("image/png");
    expect(restored.custom?.width).toBe(1600);
    expect(restored.custom?.height).toBe(900);
    expect(restored.custom?.fileName).toBe("bg.png");
    expect(restored.custom?.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(restored.custom?.data ?? [])).toEqual(Array.from(data));
  });

  it("round-trips a 200KB background byte-for-byte", () => {
    const data = new Uint8Array(200 * 1024);
    for (let index = 0; index < data.length; index += 1) data[index] = index % 251;
    const { setBackground } = useLayoutSettings(ref<ThemeId>("paper"));

    setBackground({
      kind: "custom",
      custom: { data, mimeType: "image/jpeg", width: 0, height: 0, fileName: "bg.jpg" },
    });
    advancePersist();

    const restored = useLayoutSettings(ref<ThemeId>("paper")).layout.value.background;
    expect(restored.kind).toBe("custom");
    expect(restored.custom?.mimeType).toBe("image/jpeg");
    expect(restored.custom?.data.length).toBe(data.length);
    expect(restored.custom?.data).toEqual(data);
  });

  it("keeps the background when an element is changed afterwards", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const { setElement, setBackground } = useLayoutSettings(ref<ThemeId>("paper"));
    setBackground({
      kind: "custom",
      custom: { data, mimeType: "image/png", width: 10, height: 20, fileName: "bg.png" },
    });
    advancePersist();

    setElement("body", { fontSize: 1.5 });
    advancePersist();

    const restored = useLayoutSettings(ref<ThemeId>("paper")).layout.value;
    expect(restored.typography.elements.body.fontSize).toBe(1.5);
    expect(Array.from(restored.background.custom?.data ?? [])).toEqual(Array.from(data));
  });

  it("persists preset and none backgrounds", () => {
    const { setBackground } = useLayoutSettings(ref<ThemeId>("classic"));

    setBackground({ kind: "preset", presetId: "dots" });
    advancePersist();
    expect(readStored("classic")).toMatchObject({ background: { kind: "preset", presetId: "dots" } });
    expect(useLayoutSettings(ref<ThemeId>("classic")).layout.value.background).toEqual({
      kind: "preset",
      presetId: "dots",
    });

    setBackground({ kind: "none" });
    advancePersist();
    expect(useLayoutSettings(ref<ThemeId>("classic")).layout.value.background).toEqual({ kind: "none" });
  });
});
