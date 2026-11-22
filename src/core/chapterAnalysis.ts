import { looksLikeChapterTitle } from "./chapterParser";
import type { Chapter } from "../types/book";

export type ContinuityIssueKind = "gap" | "duplicate" | "order";

export interface ContinuityIssue {
  kind: ContinuityIssueKind;
  /** 问题所在章节；点击提醒时跳转到该章。 */
  chapterId: string;
  chapterTitle: string;
  message: string;
}

export interface SuspectedHeading {
  chapterId: string;
  chapterTitle: string;
  /** 疑似标题在章节正文中的下标（0 起）。 */
  lineIndex: number;
  text: string;
}

export interface ChapterReport {
  continuity: ContinuityIssue[];
  suspected: SuspectedHeading[];
  issueCount: number;
}

const CN_DIGITS: Record<string, number> = {
  零: 0,
  "〇": 0,
  "○": 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  壹: 1,
  贰: 2,
  叁: 3,
  肆: 4,
  伍: 5,
  陆: 6,
  柒: 7,
  捌: 8,
  玖: 9,
};

const CN_UNITS: Record<string, number> = {
  十: 10,
  拾: 10,
  百: 100,
  佰: 100,
  千: 1000,
  仟: 1000,
  万: 10000,
};

const CN_NUMBER_BODY =
  "[0-9０-９零〇○一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟]+";
const CHAPTER_NUMBER = new RegExp(`^(?:[0-9０-９]{1,4}[.、]\\s*)?第(${CN_NUMBER_BODY})[章回]`);
const CHAPTER_NUMBER_EN = /^Chapter\s*([0-9]+)/i;

/** 全角数字转半角，其余字符原样保留。 */
function normalizeDigits(text: string): string {
  return text.replace(/[０-９]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xff10 + 0x30),
  );
}

/** 解析中文数字（支持到万位）；无法解析时返回 null。 */
function parseChineseNumber(text: string): number | null {
  let total = 0;
  let section = 0;
  let number = 0;

  for (const char of text) {
    const digit = CN_DIGITS[char];
    if (digit !== undefined) {
      number = digit;
      continue;
    }

    const unit = CN_UNITS[char];
    if (unit === undefined) return null;

    if (unit === 10000) {
      section = (section + number) * unit;
      total += section;
      section = 0;
    } else {
      // `十二` 省略了前导一，按 1 处理。
      section += (number || 1) * unit;
    }
    number = 0;
  }

  return total + section + number;
}

/** 从章节标题提取编号：`第7章`、`第七章`、`Chapter 12`、`3.第7章`。 */
export function chapterNumberOf(title: string): number | null {
  const normalized = normalizeDigits(title.trim());

  const cn = CHAPTER_NUMBER.exec(normalized);
  if (cn) {
    const body = cn[1] ?? "";
    return /^[0-9]+$/.test(body) ? Number(body) : parseChineseNumber(body);
  }

  const en = CHAPTER_NUMBER_EN.exec(normalized);
  return en ? Number(en[1]) : null;
}

/** 同一卷内的章节才互相比较；根级章节统一归入一个分组。 */
function groupKey(chapter: Chapter): string {
  return chapter.volumeId ?? "__root__";
}

interface GroupState {
  previous: { chapter: Chapter; number: number } | null;
  seen: Set<number>;
  /** 大跳候选：等下一章确认是继续向前还是编号重新开始。 */
  pendingGap: { from: number; to: number; previous: Chapter; current: Chapter } | null;
}

function formatMissing(missing: number[]): string {
  if (missing.length === 0) return "";
  const parts: string[] = [];
  let start = missing[0] ?? 0;
  let end = start;

  for (let index = 1; index < missing.length; index += 1) {
    const number = missing[index] ?? 0;
    if (number === end + 1) {
      end = number;
      continue;
    }
    parts.push(start === end ? `${start}` : `${start}–${end}`);
    start = number;
    end = number;
  }
  parts.push(start === end ? `${start}` : `${start}–${end}`);

  return `第${parts.join("、")}章`;
}

function commitPendingGap(state: GroupState, issues: ContinuityIssue[]): void {
  const pending = state.pendingGap;
  if (!pending) return;
  state.pendingGap = null;

  const missing: number[] = [];
  for (let number = pending.from + 1; number < pending.to; number += 1) {
    // 已经被前面的章节占用过的编号不算缺号（编号重排场景）。
    if (!state.seen.has(number)) missing.push(number);
  }
  if (missing.length === 0) return;

  issues.push({
    kind: "gap",
    chapterId: pending.current.id,
    chapterTitle: pending.current.title,
    message: `「${pending.previous.title}」与「${pending.current.title}」之间缺少${formatMissing(missing)}`,
  });
}

/**
 * 校验章节编号连续性：缺号、重号与倒序。
 * 只统计 `kind === "chapter"` 且标题能提取编号的章节；
 * 按卷分组，分卷重新编号的小说不会跨卷误报。
 *
 * 缺号先挂起，下一章编号更大时才确认；如果下一章编号反而变小，
 * 说明编号重新开始，丢弃候选，避免级联误报。
 */
export function analyzeContinuity(chapters: Chapter[]): ContinuityIssue[] {
  const issues: ContinuityIssue[] = [];
  const states = new Map<string, GroupState>();

  for (const chapter of chapters) {
    if (chapter.kind !== "chapter") continue;
    const number = chapterNumberOf(chapter.title);
    if (number === null) continue;

    const key = groupKey(chapter);
    let state = states.get(key);
    if (!state) {
      state = { previous: null, seen: new Set<number>(), pendingGap: null };
      states.set(key, state);
    }

    if (state.pendingGap) {
      if (number >= state.pendingGap.to) commitPendingGap(state, issues);
      else state.pendingGap = null;
    }

    const previous = state.previous;
    if (state.seen.has(number)) {
      issues.push({
        kind: "duplicate",
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        message: `「第${number}章」编号重复：${chapter.title}`,
      });
    } else if (previous && number < previous.number) {
      issues.push({
        kind: "order",
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        message: `「${chapter.title}」出现在「${previous.chapter.title}」之后，顺序可能有问题`,
      });
    } else if (previous && number > previous.number + 1) {
      state.pendingGap = {
        from: previous.number,
        to: number,
        previous: previous.chapter,
        current: chapter,
      };
    }

    state.seen.add(number);
    state.previous = { chapter, number };
  }

  for (const state of states.values()) commitPendingGap(state, issues);

  return issues;
}

/**
 * 判断章节正文中的某一行是否是“疑似漏检标题”。
 * 规则与解析器保持一致：空行隔离、非本章标题、长度不超过 60 字。
 * 供提醒卡片与分章弹窗的默认勾选共用，避免两套规则漂移。
 */
export function isSuspectedHeadingLine(
  lines: string[],
  lineIndex: number,
  chapterTitle?: string,
): boolean {
  if (!Number.isInteger(lineIndex) || lineIndex <= 0 || lineIndex >= lines.length) {
    return false;
  }
  const text = (lines[lineIndex] ?? "").trim();
  if (!text) return false;
  if (chapterTitle !== undefined && text === chapterTitle) return false;
  if (text.length > 60) return false;
  if ((lines[lineIndex - 1] ?? "").trim() !== "") return false;
  return looksLikeChapterTitle(text);
}

/**
 * 扫描章节正文里仍像章节标题的行，通常是解析时漏掉的手动分章点。
 * 与章节自身标题相同的行不算；只提示与上文空行隔离的候选行，
 * 避免把正文里提到的「第一章，……」当成漏检标题。
 */
export function findSuspectedHeadings(chapters: Chapter[]): SuspectedHeading[] {
  const suspected: SuspectedHeading[] = [];

  for (const chapter of chapters) {
    chapter.lines.forEach((line, lineIndex) => {
      if (!isSuspectedHeadingLine(chapter.lines, lineIndex, chapter.title)) return;
      suspected.push({
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        lineIndex,
        text: line.trim(),
      });
    });
  }

  return suspected;
}

/** 汇总连续性校验与疑似漏检标题，供页面提醒使用。 */
export function analyzeChapters(chapters: Chapter[]): ChapterReport {
  const continuity = analyzeContinuity(chapters);
  const suspected = findSuspectedHeadings(chapters);
  return { continuity, suspected, issueCount: continuity.length + suspected.length };
}
