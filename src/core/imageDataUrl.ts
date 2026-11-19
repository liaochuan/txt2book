import { bytesToBase64 } from "./base64";

/**
 * 把二进制图片编码为 `data:` URL。
 *
 * 预览 iframe 使用空 `sandbox`（不透明源），父页面创建的 `blob:` URL 会被当作
 * 跨源资源拒绝加载；`data:` URL 自带内容，不受源限制。
 */
export function bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${bytesToBase64(bytes)}`;
}
