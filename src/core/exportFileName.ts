/** Windows 上的非法文件名字符（含控制字符）。 */
const INVALID_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

/** 保留设备名，不区分大小写；即使带扩展名（如 `CON.txt`）也不能作为文件名。 */
const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

/** 书名过长时截断，给扩展名和路径留出余量。 */
const MAX_BASE_LENGTH = 80;

const FALLBACK_NAME = "未命名";

/**
 * 生成导出文件名。
 *
 * 顺序很重要：先替换非法字符，再截断，最后清理结尾的点/空格——
 * 否则截断可能重新产生结尾点。清理后为空或命中 Windows 保留名时补兜底，
 * 避免在 Windows 上无法保存。
 */
export function buildExportFileName(title: string, extension: string): string {
  const raw = title.trim() || FALLBACK_NAME;
  const base = raw
    .replace(INVALID_CHARS, "_")
    .slice(0, MAX_BASE_LENGTH)
    .replace(/[. ]+$/, "");
  const safeBase = base || FALLBACK_NAME;
  const name = WINDOWS_RESERVED_NAME.test(safeBase) ? `_${safeBase}` : safeBase;
  return extension ? `${name}.${extension}` : name;
}
