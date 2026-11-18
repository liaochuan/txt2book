import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  THEME_STORAGE_KEY,
  useThemePreference,
} from "../src/composables/useThemePreference";
import { DEFAULT_THEME_ID } from "../src/core/render/themes";

const store = new Map<string, string>();

/** 与 ChapterTree 测试一致：用最小 Map 桩代替 happy-dom 的 localStorage。 */
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

beforeEach(() => {
  store.clear();
  stubStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useThemePreference", () => {
  it("falls back to the default theme when nothing is stored", () => {
    const { themeId } = useThemePreference();

    expect(themeId.value).toBe(DEFAULT_THEME_ID);
  });

  it("restores a valid stored theme", () => {
    store.set(THEME_STORAGE_KEY, "night");

    const { themeId } = useThemePreference();

    expect(themeId.value).toBe("night");
  });

  it.each(["", "missing", "toString", "PAPER", " paper"])(
    "falls back to the default for the invalid stored value %j",
    (value) => {
      store.set(THEME_STORAGE_KEY, value);

      const { themeId } = useThemePreference();

      expect(themeId.value).toBe(DEFAULT_THEME_ID);
    },
  );

  it("persists the theme when it changes", () => {
    const { themeId, setTheme } = useThemePreference();

    setTheme("classic");

    expect(themeId.value).toBe("classic");
    expect(store.get(THEME_STORAGE_KEY)).toBe("classic");
  });

  it("keeps working when reading storage throws", () => {
    stubStorage({
      getItem: () => {
        throw new Error("SecurityError");
      },
    });

    const { themeId } = useThemePreference();

    expect(themeId.value).toBe(DEFAULT_THEME_ID);
    expect(() => useThemePreference().setTheme("night")).not.toThrow();
  });

  it("keeps the in-memory selection when writing storage fails", () => {
    stubStorage({
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    const { themeId, setTheme } = useThemePreference();

    expect(() => setTheme("minimal")).not.toThrow();

    expect(themeId.value).toBe("minimal");
  });

  it("ignores unknown ids passed to setTheme", () => {
    const { themeId, setTheme } = useThemePreference();

    setTheme("missing" as "paper");

    expect(themeId.value).toBe(DEFAULT_THEME_ID);
    expect(store.has(THEME_STORAGE_KEY)).toBe(false);
  });
});
