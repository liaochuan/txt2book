import { getCurrentScope, onScopeDispose, ref, watch, type Ref } from "vue";
import {
  defaultLayoutFor,
  normalizeLayout,
  type BackgroundConfig,
  type ElementKey,
  type ElementStyle,
  type LayoutSettings,
} from "../core/render/layout";
import type { ThemeId } from "../types/book";

export const LAYOUT_STORAGE_PREFIX = "txt2book.layout";

/** 连续改动合并为一次写盘，避免拖动滑块时反复序列化背景图。 */
export const PERSIST_DELAY_MS = 250;

export interface UseLayoutSettings {
  /** 当前主题的排版配置，改动后立即反映到预览。 */
  layout: Ref<LayoutSettings>;
  /** 合并单个元素的样式；越界或非法值按 `normalizeLayout` 规则回退。 */
  setElement(key: ElementKey, patch: Partial<ElementStyle>): void;
  setBackground(background: BackgroundConfig): void;
  /** 清除当前主题的覆盖并恢复默认值（含背景）。 */
  reset(): void;
  /** 只恢复排版默认值，保留当前背景。 */
  resetTypography(): void;
}

/** 每个主题一份配置，key 形如 `txt2book.layout.paper`。 */
export function layoutStorageKey(themeId: ThemeId): string {
  return `${LAYOUT_STORAGE_PREFIX}.${themeId}`;
}

/**
 * 存储内容不可信：缺失、损坏 JSON、非对象或越界字段都交给 `normalizeLayout`，
 * 读取本身抛错时直接回退默认值。
 */
function readLayout(themeId: ThemeId): LayoutSettings {
  try {
    const raw = localStorage.getItem(layoutStorageKey(themeId));
    if (!raw) return defaultLayoutFor(themeId);
    return normalizeLayout(JSON.parse(raw) as unknown, themeId);
  } catch {
    return defaultLayoutFor(themeId);
  }
}

/** 分块编码，避免 `String.fromCharCode(...bytes)` 在 200KB 以上触发参数上限。 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(offset, offset + CHUNK)));
  }
  return btoa(binary);
}

/**
 * 写盘前把自定义背景的字节投影成 base64。
 * `JSON.stringify(Uint8Array)` 会得到数字键对象，体积约为原始字节的 6–8 倍，
 * 很容易撑爆 localStorage 配额；base64 只有约 1.33 倍。
 */
function toStoredValue(layout: LayoutSettings): unknown {
  const { background } = layout;
  if (background.kind !== "custom" || background.custom === undefined) return layout;
  return {
    typography: layout.typography,
    background: {
      kind: "custom",
      custom: { ...background.custom, data: bytesToBase64(background.custom.data) },
    },
  };
}

/** 写入失败（隐私模式、配额不足）只影响持久化，本次会话内仍然生效。 */
function writeLayout(themeId: ThemeId, layout: LayoutSettings): void {
  try {
    localStorage.setItem(layoutStorageKey(themeId), JSON.stringify(toStoredValue(layout)));
  } catch {
    // 忽略写入错误。
  }
}

/**
 * 高级排版的按主题持久化。
 *
 * - 切换主题时先 flush 上一个主题的待写内容，再读取新主题；
 * - 写盘 250ms 防抖，组件卸载（effect scope 销毁）时立即 flush；
 * - 所有改动都经过 `normalizeLayout`，内存与读回结果保持一致。
 */
export function useLayoutSettings(themeId: Ref<ThemeId>): UseLayoutSettings {
  const layout = ref<LayoutSettings>(defaultLayoutFor(themeId.value));

  let pending: { themeId: ThemeId; layout: LayoutSettings } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function cancelPending(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pending = null;
  }

  /** 立即写入尚未落盘的内容；没有待写内容时为空操作。 */
  function flush(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const item = pending;
    pending = null;
    if (item !== null) writeLayout(item.themeId, item.layout);
  }

  function schedulePersistence(next: LayoutSettings): void {
    // 记录写入时的主题，避免防抖期间切换主题把旧配置写到新 key。
    pending = { themeId: themeId.value, layout: next };
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const item = pending;
      pending = null;
      if (item !== null) writeLayout(item.themeId, item.layout);
    }, PERSIST_DELAY_MS);
  }

  // 同步读取，切换主题后同一 tick 内即可拿到新配置。
  watch(
    themeId,
    (next) => {
      flush();
      layout.value = readLayout(next);
    },
    { immediate: true, flush: "sync" },
  );

  // 直接调用（没有组件作用域）时 `onScopeDispose` 会告警，因此先检查。
  if (getCurrentScope() !== undefined) {
    onScopeDispose(flush);
  }

  function replace(next: LayoutSettings): void {
    layout.value = next;
    schedulePersistence(next);
  }

  function setElement(key: ElementKey, patch: Partial<ElementStyle>): void {
    const current = layout.value;
    if (!Object.prototype.hasOwnProperty.call(current.typography.elements, key)) return;
    // `undefined` 不能覆盖已有值，否则会被归一化成主题默认值。
    const cleaned = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ) as Partial<ElementStyle>;
    const merged: ElementStyle = { ...current.typography.elements[key], ...cleaned };
    replace(
      normalizeLayout(
        {
          typography: {
            ...current.typography,
            elements: { ...current.typography.elements, [key]: merged },
          },
          background: current.background,
        },
        themeId.value,
      ),
    );
  }

  function setBackground(background: BackgroundConfig): void {
    replace(
      normalizeLayout(
        { typography: layout.value.typography, background },
        themeId.value,
      ),
    );
  }

  function reset(): void {
    cancelPending();
    const defaults = defaultLayoutFor(themeId.value);
    try {
      localStorage.removeItem(layoutStorageKey(themeId.value));
    } catch {
      // 删除失败时退回写入默认值，至少保证下次启动不会读到旧覆盖。
      writeLayout(themeId.value, defaults);
    }
    layout.value = defaults;
  }

  /**
   * 只重置排版：保留背景（尤其是自定义图片字节），避免「恢复默认排版」误删背景。
   * 仍需写盘，因为存储里是整份 `LayoutSettings`。
   */
  function resetTypography(): void {
    const defaults = defaultLayoutFor(themeId.value);
    replace({
      typography: defaults.typography,
      background: layout.value.background,
    });
  }

  return { layout, setElement, setBackground, reset, resetTypography };
}
