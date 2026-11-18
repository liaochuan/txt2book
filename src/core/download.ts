/** 对象 URL 释放延迟：部分浏览器在点击后仍需读取 blob，过早 revoke 会取消下载。 */
export const REVOKE_DELAY_MS = 1000;

/**
 * 触发浏览器下载。
 *
 * 链接先挂到 `body` 再点击，兼容 Firefox 等要求节点在文档内才响应
 * `click()` 的浏览器；点击后立即移除节点，对象 URL 延迟释放。
 */
export function downloadBlob(
  blob: Blob,
  filename: string,
  revokeDelayMs: number = REVOKE_DELAY_MS,
): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, revokeDelayMs);
}
