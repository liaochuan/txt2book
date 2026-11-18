const LEADING_BLANK = /^[\t\f\v \u3000\uFEFF]+/;

/**
 * 按行拆分文本：支持 `\r\n`、`\n` 与老式 Mac 的纯 `\r` 断行，
 * 去掉行首半角/全角空白，保留空行。
 * 不做任何章节识别，供解析器逐行处理。
 */
export function preprocessLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/).map((line) => line.replace(LEADING_BLANK, ""));
}

/** 是否至少有一行 trim 后非空。 */
export function hasMeaningfulContent(lines: string[]): boolean {
  return lines.some((line) => line.trim().length > 0);
}
