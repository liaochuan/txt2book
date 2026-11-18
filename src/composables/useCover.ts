import { markRaw, ref, watch, type Ref } from "vue";
import { ApiError, api } from "../core/api";
import type { CoverAsset } from "../types/book";
import type { BookSession } from "./useBookSession";

export interface ImageSize {
  width: number;
  height: number;
}

export interface UseCover {
  /** 当前封面资源；与 `session.book.cover` 保持同步。 */
  cover: Ref<CoverAsset | null>;
  /** 由后端返回的 PNG 生成的 object URL，未设置封面时为空串。 */
  previewUrl: Ref<string>;
  busy: Ref<boolean>;
  error: Ref<string>;
  /** 从远程地址抓取并转换；返回是否成功。 */
  fromUrl(url: string): Promise<boolean>;
  /** 上传本地文件交给后端转换；返回是否成功。 */
  fromFile(file: File): Promise<boolean>;
  /** 清除封面、预览地址与会话中的封面资源。 */
  clear(): void;
  /** 释放 object URL；组件卸载时调用，不改动会话中的封面。 */
  dispose(): void;
}

const COVER_TIMEOUT_MS = 15_000;
const EMPTY_URL_ERROR = "请输入图片地址";
const INVALID_PNG_ERROR = "服务器返回的封面格式异常";
const NETWORK_ERROR = "网络异常，请检查网络后重试";
const GENERIC_ERROR = "封面处理失败，请稍后重试。";
const PNG_MAGIC = [137, 80, 78, 71, 13, 10, 26, 10];

/** 请求超时：与网络失败共用提示，但保留独立类型便于区分。 */
class CoverTimeoutError extends Error {}
/** 服务端返回了非 PNG 内容。 */
class InvalidCoverError extends Error {}

/** 读取图片宽高。浏览器无法解码或环境不支持时回退到 0×0。 */
export async function measureImageSize(source: Blob): Promise<ImageSize> {
  if (typeof createImageBitmap !== "function") return { width: 0, height: 0 };
  try {
    const bitmap = await createImageBitmap(source);
    const width = Number.isFinite(bitmap.width) ? Math.max(0, Math.round(bitmap.width)) : 0;
    const height = Number.isFinite(bitmap.height) ? Math.max(0, Math.round(bitmap.height)) : 0;
    if (typeof bitmap.close === "function") bitmap.close();
    return { width, height };
  } catch {
    return { width: 0, height: 0 };
  }
}

/** PNG 校验：content-type、魔数与最小长度都必须匹配。 */
function isPngBlob(blob: Blob, bytes: Uint8Array): boolean {
  if (bytes.length < PNG_MAGIC.length) return false;
  if (!blob.type.toLowerCase().includes("image/png")) return false;
  return PNG_MAGIC.every((value, index) => bytes[index] === value);
}

function isChineseMessage(message: string): boolean {
  return /[\u4e00-\u9fa5]/.test(message);
}

/** 与服务端错误码对齐的用户可读文案；未知错误保留中文服务端消息。 */
function coverErrorMessage(cause: unknown): string {
  if (cause instanceof CoverTimeoutError) return NETWORK_ERROR;
  if (cause instanceof InvalidCoverError) return INVALID_PNG_ERROR;
  if (cause instanceof ApiError) {
    if (cause.status === 0 || cause.status === 408 || cause.status === 504) {
      return NETWORK_ERROR;
    }
    if (cause.code === "NETWORK" || cause.name === "AbortError") return NETWORK_ERROR;
    if (cause.status === 401) return "登录已失效，请重新登录";
    if (cause.status === 415) return "图片格式不支持";
    if (cause.status === 429) return "请求过于频繁，请稍后再试";
    return isChineseMessage(cause.message) ? cause.message.trim() : GENERIC_ERROR;
  }
  if (cause instanceof Error && cause.name === "AbortError") return NETWORK_ERROR;
  return GENERIC_ERROR;
}

/** 复制到独立 ArrayBuffer，避免 Blob 持有 SharedArrayBuffer 类型的视图。 */
function pngBlob(asset: CoverAsset): Blob | null {
  if (asset.png.length === 0) return null;
  try {
    const bytes = new Uint8Array(asset.png.length);
    bytes.set(asset.png);
    return new Blob([bytes], { type: "image/png" });
  } catch {
    return null;
  }
}

function previewFromAsset(asset: CoverAsset | null): string {
  if (!asset) return "";
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return "";
  const blob = pngBlob(asset);
  if (!blob) return "";
  try {
    return URL.createObjectURL(blob);
  } catch {
    return "";
  }
}

/**
 * 封面抓取、本地转换与预览。
 *
 * 后端始终返回 PNG，因此会话里只保存 PNG 字节；预览用 object URL，
 * 替换封面、撤销或卸载时必须回收，避免长时间编辑时泄漏 Blob。
 */
export function useCover(
  session: Pick<BookSession, "book" | "setCover">,
): UseCover {
  const initial = session.book.value.cover;
  const cover = ref<CoverAsset | null>(initial);
  const previewUrl = ref<string>(previewFromAsset(initial));
  const busy = ref(false);
  const error = ref("");
  /** 请求代号：清除或卸载后，迟到的响应必须被丢弃。 */
  let requestId = 0;
  /** 当前在途请求，用于 clear/dispose 时真正取消下载。 */
  let activeController: AbortController | null = null;

  function releasePreview(): void {
    const url = previewUrl.value;
    previewUrl.value = "";
    if (!url) return;
    try {
      URL.revokeObjectURL(url);
    } catch {
      // 回收失败不影响界面，浏览器最终会随页面释放。
    }
  }

  function replacePreview(blob: Blob): void {
    releasePreview();
    try {
      previewUrl.value = URL.createObjectURL(blob);
    } catch {
      previewUrl.value = "";
    }
  }

  function replacePreviewFromAsset(asset: CoverAsset): void {
    const blob = pngBlob(asset);
    if (!blob) {
      releasePreview();
      return;
    }
    replacePreview(blob);
  }

  function abortActive(): void {
    if (!activeController) return;
    activeController.abort();
    activeController = null;
  }

  // 撤销、导入或外部直接改会话封面时，本地资产与预览地址同步跟随。
  watch(
    () => session.book.value.cover,
    (next) => {
      // 自身写入时引用相同，避免 setCover 与 watch 形成回环。
      if (next === cover.value) return;
      cover.value = next;
      if (!next) {
        releasePreview();
        return;
      }
      replacePreviewFromAsset(next);
    },
  );

  async function run(load: (signal: AbortSignal) => Promise<Blob>, sourceName?: string): Promise<boolean> {
    if (busy.value) return false;

    requestId += 1;
    const id = requestId;
    busy.value = true;
    error.value = "";

    const controller = new AbortController();
    activeController = controller;
    let timer: ReturnType<typeof setTimeout> | null = null;

    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new CoverTimeoutError("timeout"));
        }, COVER_TIMEOUT_MS);
      });

      const blob = await Promise.race([load(controller.signal), timeout]);
      const bytes = new Uint8Array(await blob.arrayBuffer());

      // 期间用户点了清除或组件已卸载，丢弃这次结果。
      if (id !== requestId) return false;
      if (!isPngBlob(blob, bytes)) throw new InvalidCoverError("invalid png");

      const size = await measureImageSize(blob);
      if (id !== requestId) return false;

      const asset = markRaw<CoverAsset>({
        png: bytes,
        width: size.width,
        height: size.height,
        ...(sourceName ? { sourceName } : {}),
      });

      replacePreview(blob);
      cover.value = asset;
      session.setCover(asset);
      return true;
    } catch (cause) {
      if (id === requestId) error.value = coverErrorMessage(cause);
      return false;
    } finally {
      if (timer !== null) clearTimeout(timer);
      if (activeController === controller) activeController = null;
      if (id === requestId) busy.value = false;
    }
  }

  async function fromUrl(url: string): Promise<boolean> {
    const target = url.trim();
    if (!target) {
      error.value = EMPTY_URL_ERROR;
      return false;
    }
    return run((signal) => api.coverFromUrl(target, signal));
  }

  async function fromFile(file: File): Promise<boolean> {
    return run((signal) => api.coverFromFile(file, { signal }), file.name || undefined);
  }

  function clear(): void {
    // 让进行中的请求失效，避免清除后封面又被写回。
    requestId += 1;
    abortActive();
    busy.value = false;
    error.value = "";
    releasePreview();
    cover.value = null;
    session.setCover(null);
  }

  function dispose(): void {
    requestId += 1;
    abortActive();
    busy.value = false;
    releasePreview();
  }

  return {
    cover,
    previewUrl,
    busy,
    error,
    fromUrl,
    fromFile,
    clear,
    dispose,
  };
}
