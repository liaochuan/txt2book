/**
 * 把二进制图片编码为 `data:` URL。
 *
 * 预览 iframe 使用空 `sandbox`（不透明源），父页面创建的 `blob:` URL 会被当作
 * 跨源资源拒绝加载；`data:` URL 自带内容，不受源限制。
 */
export function bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
  // 分块拼接：一次性 `String.fromCharCode(...bytes)` 在大图上会超出调用栈上限。
  const chunkSize = 0x8000;
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return `data:${mimeType};base64,${btoa(chunks.join(""))}`;
}
