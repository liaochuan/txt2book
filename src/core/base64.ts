/**
 * 二进制转 base64（不带 `data:` 前缀）。
 *
 * 分块拼接：一次性 `String.fromCharCode(...bytes)` 在大图上会超出调用栈上限。
 * 用于 JSON 请求体：`Uint8Array` 直接序列化会变成数字键对象，体积膨胀约 13 倍。
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return btoa(chunks.join(""));
}
