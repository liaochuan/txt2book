import { ref, type Ref } from "vue";
import { ApiError, api } from "../core/api";
import type { BackgroundConfig } from "../core/render/layout";

export interface PngSize {
  width: number;
  height: number;
}

export interface UseBackgroundImage {
  busy: Ref<boolean>;
  error: Ref<string>;
  /** 上传本地文件并转换为背景图；返回是否成功。 */
  fromFile(file: File): Promise<boolean>;
  /** 处理剪贴板等来源的图片数据；`fileName` 仅用于展示与 EPUB 文件名。 */
  fromBlob(blob: Blob, fileName?: string): Promise<boolean>;
  /** 中止在途上传并复位 `busy`，不改变当前背景。 */
  cancel(): void;
  /** 丢弃在途请求并清除背景图。 */
  clear(): void;
}

type CustomBackground = NonNullable<BackgroundConfig["custom"]>;

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const TYPE_ERROR = "请选择图片文件";
const SIZE_ERROR = "图片不能超过 10MB";
const INVALID_IMAGE_ERROR = "服务器返回的图片格式异常";
const NETWORK_ERROR = "网络异常，请检查网络后重试";
const GENERIC_ERROR = "背景图处理失败，请稍后重试。";
const PNG_MAGIC = [137, 80, 78, 71, 13, 10, 26, 10];

const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/bmp": "bmp",
};

/** 服务端返回了无法识别的图片内容。 */
class InvalidImageError extends Error {}

/** 上传超时；与网络失败共用提示，但保留独立类型便于区分。 */
class BackgroundTimeoutError extends Error {}

/**
 * 从 PNG 头部解析宽高：签名 8 字节，随后是长度与 `IHDR`，
 * 宽高为第 16–23 字节的大端 uint32（不依赖 `createImageBitmap`）。
 */
export function readPngSize(bytes: Uint8Array): PngSize | null {
  if (bytes.length < 24) return null;
  if (!PNG_MAGIC.every((value, index) => bytes[index] === value)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/** 输入校验：必须是图片且不超过 10MB；返回错误文案或 `null`。 */
function validateImage(source: Blob): string | null {
  if (!source.type.startsWith("image/")) return TYPE_ERROR;
  if (source.size > MAX_IMAGE_BYTES) return SIZE_ERROR;
  return null;
}

function isChineseMessage(message: string): boolean {
  return /[\u4e00-\u9fa5]/.test(message);
}

/** 与服务端错误码对齐的用户可读文案；未知错误保留中文服务端消息。 */
function backgroundErrorMessage(cause: unknown): string {
  if (cause instanceof InvalidImageError) return INVALID_IMAGE_ERROR;
  if (cause instanceof BackgroundTimeoutError) return NETWORK_ERROR;
  if (cause instanceof ApiError) {
    if (cause.status === 0 || cause.status === 408 || cause.status === 504) {
      return NETWORK_ERROR;
    }
    if (cause.code === "NETWORK" || cause.name === "AbortError") return NETWORK_ERROR;
    if (cause.status === 401) return "登录已失效，请重新登录";
    if (cause.status === 413) return SIZE_ERROR;
    if (cause.status === 415) return "图片格式不支持";
    if (cause.status === 429) return "请求过于频繁，请稍后再试";
    return isChineseMessage(cause.message) ? cause.message.trim() : GENERIC_ERROR;
  }
  if (cause instanceof Error && cause.name === "AbortError") return NETWORK_ERROR;
  return GENERIC_ERROR;
}

function extensionFor(mimeType: string): string {
  return MIME_EXTENSIONS[mimeType.toLowerCase()] ?? "png";
}

/** 丢弃路径分隔符与 `..`，避免把用户提供的名字当成路径使用。 */
function sanitizeFileName(raw: string): string {
  const base = raw.replace(/[\\/]+/g, "/").split("/").pop() ?? "";
  return base
    .replace(/\.\./g, "")
    .replace(/[\u0000-\u001f]/g, "")
    .trim();
}

function resolveFileName(source: Blob, fileName?: string): string {
  const provided = fileName === undefined ? "" : sanitizeFileName(fileName);
  if (provided !== "") return provided;
  return `background.${extensionFor(source.type)}`;
}

/**
 * 把服务端返回的图片转成 `BackgroundConfig.custom`。
 * JPEG 不解析尺寸（允许 0×0）；PNG 仍读 IHDR，兼容透明图回退。
 */
function toCustomBackground(png: Blob, bytes: Uint8Array, fileName: string): CustomBackground {
  const type = png.type.toLowerCase();
  if (type.includes("image/jpeg")) {
    return { data: bytes, mimeType: "image/jpeg", width: 0, height: 0, fileName };
  }
  if (type.includes("image/png")) {
    const size = readPngSize(bytes);
    if (!size) throw new InvalidImageError("invalid png");
    return {
      data: bytes,
      mimeType: "image/png",
      width: size.width,
      height: size.height,
      fileName,
    };
  }
  throw new InvalidImageError("unexpected mime type");
}

/**
 * 背景图获取：本地文件或剪贴板图片交给服务端统一转成 JPEG（透明图回退 PNG），
 * 再写入排版配置。
 *
 * - `requestId` 保证 `clear()` 之后迟到的响应不会写回背景；
 * - 15 秒超时会 abort 在途请求；
 * - 同一时刻只允许一个上传。
 */
export function useBackgroundImage(
  setBackground: (background: BackgroundConfig) => void,
): UseBackgroundImage {
  const busy = ref(false);
  const error = ref("");
  /** 请求代号：清除后，迟到的响应必须被丢弃。 */
  let requestId = 0;
  let activeController: AbortController | null = null;

  function abortActive(): void {
    if (!activeController) return;
    activeController.abort();
    activeController = null;
  }

  async function run(
    load: (signal: AbortSignal) => Promise<Blob>,
    fileName: string,
  ): Promise<boolean> {
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
          reject(new BackgroundTimeoutError("timeout"));
        }, TIMEOUT_MS);
      });

      const image = await Promise.race([load(controller.signal), timeout]);
      const bytes = new Uint8Array(await image.arrayBuffer());

      // 期间用户点了清除，丢弃这次结果。
      if (id !== requestId) return false;

      const custom = toCustomBackground(image, bytes, fileName);
      setBackground({ kind: "custom", custom });
      return true;
    } catch (cause) {
      if (id === requestId) error.value = backgroundErrorMessage(cause);
      return false;
    } finally {
      if (timer !== null) clearTimeout(timer);
      if (activeController === controller) activeController = null;
      if (id === requestId) busy.value = false;
    }
  }

  async function fromFile(file: File): Promise<boolean> {
    if (busy.value) return false;
    const problem = validateImage(file);
    if (problem !== null) {
      error.value = problem;
      return false;
    }
    return run(
      (signal) => api.coverFromFile(file, { format: "jpeg", signal }),
      resolveFileName(file, file.name),
    );
  }

  async function fromBlob(blob: Blob, fileName?: string): Promise<boolean> {
    if (busy.value) return false;
    const problem = validateImage(blob);
    if (problem !== null) {
      error.value = problem;
      return false;
    }

    const name = resolveFileName(blob, fileName);
    let file: File;
    try {
      file = new File([blob], name, { type: blob.type });
    } catch {
      error.value = GENERIC_ERROR;
      return false;
    }
    return run(
      (signal) => api.coverFromFile(file, { format: "jpeg", signal }),
      name,
    );
  }

  function clear(): void {
    // 让进行中的请求失效，避免清除后背景又被写回。
    requestId += 1;
    abortActive();
    busy.value = false;
    error.value = "";
    setBackground({ kind: "none" });
  }

  /** 中止在途上传但保留已有背景；迟到的响应会因 `requestId` 变化被丢弃。 */
  function cancel(): void {
    if (!busy.value) return;
    requestId += 1;
    abortActive();
    busy.value = false;
  }

  return { busy, error, fromFile, fromBlob, cancel, clear };
}
