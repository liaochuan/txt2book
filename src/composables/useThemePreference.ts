import { ref, type Ref } from "vue";
import { DEFAULT_THEME_ID, themes } from "../core/render/themes";
import type { ThemeId } from "../types/book";

export const THEME_STORAGE_KEY = "txt2book.theme";

/** 只接受已注册的主题 id；`toString` 之类的原型键也不能通过。 */
export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(themes, value);
}

/** 存储内容不可信：缺失、非法值或读取异常一律回退默认主题。 */
function readTheme(): ThemeId {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeId(raw) ? raw : DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

export interface ThemePreference {
  themeId: Ref<ThemeId>;
  /** 切换主题并写入 localStorage；写入失败只影响持久化，不影响当前会话。 */
  setTheme(id: ThemeId): void;
}

/** 排版主题偏好：初始化时恢复，切换时持久化。 */
export function useThemePreference(): ThemePreference {
  const themeId = ref<ThemeId>(readTheme());

  function setTheme(id: ThemeId): void {
    if (!isThemeId(id)) return;
    themeId.value = id;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, id);
    } catch {
      // 隐私模式或配额不足时无法持久化，本次会话内仍然生效。
    }
  }

  return { themeId, setTheme };
}
