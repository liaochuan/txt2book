/**
 * 中文断行与标点避头尾（设计文档 §6.3）。
 *
 * 逐字符测量宽度，累计到 `maxWidth` 时换行。换行点按以下规则回退：
 * - 行首不能是 `、。，．！？：；）】》」』…—`；
 * - 行尾不能是 `（【《「『`。
 *
 * 极端窄行（例如整行只有一个标点）优先保证行首规则，允许标点悬挂。
 */

/** 不允许出现在行首的标点。 */
const NO_LINE_START = new Set("、。，．！？：；）】》」』…—”’".split(""));

/** 不允许出现在行尾的标点。 */
const NO_LINE_END = new Set("（【《「『“".split(""));

/** 避头尾回退的最大步数，避免异常文本造成长时间循环。 */
const MAX_BACKTRACK = 8;

export type MeasureFn = (text: string) => number;

/**
 * 按每行可用宽度换行。`widthForLine` 允许首行因缩进而使用更窄的宽度。
 * 宽度非正或无法测量时按单行返回，避免死循环。
 */
function wrapCjkLines(
  text: string,
  measure: MeasureFn,
  widthForLine: (lineIndex: number) => number,
): string[] {
  const content = text.replace(/[\r\n]+/g, "").trim();
  if (!content) return [];

  const lines: string[] = [];
  let index = 0;
  let lineIndex = 0;

  while (index < content.length) {
    const maxWidth = widthForLine(lineIndex);
    if (!Number.isFinite(maxWidth) || maxWidth <= 0) {
      lines.push(content.slice(index));
      break;
    }

    let end = index;
    let width = 0;
    while (end < content.length) {
      const charWidth = measure(content[end]);
      const safeWidth = Number.isFinite(charWidth) && charWidth > 0 ? charWidth : 0;
      // 至少放一个字符，防止单字宽度超过整行时死循环。
      if (end > index && width + safeWidth > maxWidth) break;
      width += safeWidth;
      end += 1;
    }

    if (end >= content.length) {
      lines.push(content.slice(index));
      break;
    }

    let breakAt = end;
    for (let step = 0; step < MAX_BACKTRACK && breakAt > index + 1; step += 1) {
      if (NO_LINE_START.has(content[breakAt])) {
        breakAt -= 1;
        continue;
      }
      if (NO_LINE_END.has(content[breakAt - 1])) {
        breakAt -= 1;
        continue;
      }
      break;
    }

    if (breakAt === index) breakAt = index + 1;
    // 单字行的下一行仍以标点开头时，把标点悬挂到当前行（宽度略超）。
    if (breakAt === index + 1 && NO_LINE_START.has(content[breakAt])) {
      breakAt = Math.min(breakAt + 1, content.length);
    }

    lines.push(content.slice(index, breakAt));
    index = breakAt;
    lineIndex += 1;
  }

  return lines;
}

/** 以固定宽度换行；正文后续行使用该宽度。 */
export function wrapCjkText(text: string, measure: MeasureFn, maxWidth: number): string[] {
  return wrapCjkLines(text, measure, () => maxWidth);
}

/**
 * 首行缩进时使用：首行宽度为 `firstWidth`，其余行为 `maxWidth`。
 * 与 `wrapCjkText` 共用避头尾规则。
 */
export function wrapCjkTextWithIndent(
  text: string,
  measure: MeasureFn,
  maxWidth: number,
  firstWidth: number,
): string[] {
  return wrapCjkLines(text, measure, (lineIndex) =>
    lineIndex === 0 ? firstWidth : maxWidth,
  );
}
