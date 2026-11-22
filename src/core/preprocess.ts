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

const PARAGRAPH_INDENT = "\u3000\u3000";
const LEADING_ANY = /^[\s\u3000\uFEFF]+/;

/**
 * 给简介等按段落展示的文本统一加首行缩进：
 * 每个非空段落去掉原有前导空白后补两个全角空格，空行原样保留。
 *
 * 注意：缩进保存在文本里，右栏输入框与 TXT 导出可见；
 * EPUB/HTML 简介页仍由主题排版决定，转换器会逐行 trim。
 */
export function indentParagraphs(text: string): string {
  const lines = text.split(/\r\n|\r|\n/).map((line) => {
    const content = line.replace(LEADING_ANY, "").replace(/\s+$/, "");
    return content === "" ? "" : `${PARAGRAPH_INDENT}${content}`;
  });

  while (lines.length > 0 && (lines[0] ?? "") === "") lines.shift();
  while (lines.length > 0 && (lines[lines.length - 1] ?? "") === "") lines.pop();

  return lines.join("\n");
}
