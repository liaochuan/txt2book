import type { Chapter, ChapterKind, Language, Volume } from "../types/book";
import { hasMeaningfulContent } from "./preprocess";
import { compileRule, type ChapterRule, type RuleKind } from "./customRules";

export interface ParsedBook {
  volumes: Volume[];
  chapters: Chapter[];
}

const CN_NUM_BODY = "[0-9０-９零一二三四五六七八九十百千万两〇○壹贰叁肆伍陆柒捌玖拾佰仟]";
const CN_NUM = `${CN_NUM_BODY}+`;
const SEP = "[\\s·、，,：:.．—\\-]+";

/** 卷：`第一卷 风起`、`卷三`、`第一部 少年`、`上部 少年`。 */
const VOLUME = new RegExp(
  `^(第${CN_NUM}?[卷部]|卷${CN_NUM}|[上中下][部卷])(?:${SEP}(.*))?$`,
);
/** 章：`第一章 重逢`、`第一章重逢`、`第一回 甄士隐梦幻识通灵`、`Chapter 5`。 */
const CHAPTER = new RegExp(`^(?:第${CN_NUM}[章回]|Chapter\\s*[0-9]+).*$`, "i");
/** 兼容旧小说常见的 `1.Chapter0---1序` 形式。 */
const INDEXED_CHAPTER = new RegExp(
  `^[0-9]{1,4}[.、]\\s*(?:第${CN_NUM}[章回]|Chapter\\s*[0-9]+).*$`,
  "i",
);
/** 番外：`番外`、`番外篇 小满`、`番外一`、`外传：某某`。 */
const EXTRA = new RegExp(
  `^(?:番外[篇章节]?|外传)${CN_NUM_BODY}*(?:${SEP}(.*))?$`,
);
const PROLOGUE = new RegExp(`^(楔子|序章|序幕|序言|引子|序)(?:${SEP}(.*))?$`);
const EPILOGUE = new RegExp(`^(尾声|后记|终章|尾章)(?:${SEP}(.*))?$`);

const MAX_TITLE_LENGTH = 40;
const TITLE_END = /[。！？…；]\s*$/;

/** 标题行判定结果；`volume` 不是章节类型，单独参与结构装配。 */
type TitleKind = ChapterKind | "volume";

interface TitleHit {
  title: string;
  kind: TitleKind;
}

interface UserPattern {
  regex: RegExp;
  capture: number;
  kind: RuleKind;
}

function createId(prefix: string, index: number): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${prefix}-${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`;
}

function compileUserRules(userRules: ChapterRule[]): UserPattern[] {
  const patterns: UserPattern[] = [];
  for (const rule of userRules) {
    if (!rule.enabled) continue;
    try {
      const compiled = compileRule(rule);
      patterns.push({
        regex: compiled.regex,
        capture: compiled.capture,
        kind: rule.kind ?? "chapter",
      });
    } catch {
      // 单条规则的正则非法时跳过，不能让整本书解析失败。
    }
  }
  return patterns;
}

function matches(regex: RegExp, line: string): boolean {
  try {
    return regex.test(line);
  } catch {
    return false;
  }
}

/**
 * 用用户规则匹配一行。标题取 `capture` 指定的分组；
 * 分组不存在或为空时回退整行，避免产出空标题。
 */
function matchUserRule(pattern: UserPattern, line: string): TitleHit | null {
  try {
    const matched = pattern.regex.exec(line);
    if (!matched) return null;
    const captured = matched[pattern.capture];
    const title = typeof captured === "string" && captured.trim() ? captured.trim() : line;
    return { title, kind: pattern.kind };
  } catch {
    return null;
  }
}

/**
 * 章节标记后面必须是行尾或分隔符，用于区分标题和正文句子：
 * `第一章的内容…`、`第一回合…` 在章/回后直接跟汉字，不算标题。
 */
const CHAPTER_HEAD = new RegExp(
  `^(?:[0-9]{1,4}[.、]\\s*)?(?:第${CN_NUM}[章回]|Chapter\\s*[0-9]+)(?=$|${SEP})`,
  "i",
);

/** 判断一行是否具备章节标题结构（忽略标点与长度限制）。 */
export function looksLikeChapterTitle(line: string): boolean {
  return matches(CHAPTER_HEAD, line.trim());
}

/**
 * 判断一行是否为标题。先 trim，再排除过长或句末带标点的正文行；
 * 用户规则优先，内置规则按 卷 → 章 → 番外 → 楔子 → 尾声 兜底。
 * 内置规则的标题取整行 trim，保留原编号文字。
 *
 * 以句末标点结尾的标题（如 `第7章 啊？神器？`）只有在满足以下条件时才接受：
 * - 具备章节结构（卷、番外、楔子、尾声不享受豁免）；
 * - 与前文空行隔离，或紧跟在已识别的标题之后。
 * 正文里夹带的 `第一章的内容，…` / `第一回合，…` 结构不完整，仍按正文处理。
 */
function classifyTitle(
  line: string,
  isolated: boolean,
  userPatterns: UserPattern[],
): TitleHit | null {
  const title = line.trim();
  if (!title) return null;
  if (title.length > MAX_TITLE_LENGTH) return null;
  if (TITLE_END.test(title) && !(isolated && looksLikeChapterTitle(title))) {
    return null;
  }

  for (const pattern of userPatterns) {
    const hit = matchUserRule(pattern, title);
    if (hit) return hit;
  }
  if (matches(VOLUME, title)) return { title, kind: "volume" };
  if (matches(CHAPTER, title) || matches(INDEXED_CHAPTER, title)) {
    return { title, kind: "chapter" };
  }
  if (matches(EXTRA, title)) return { title, kind: "extra" };
  if (matches(PROLOGUE, title)) return { title, kind: "prologue" };
  if (matches(EPILOGUE, title)) return { title, kind: "epilogue" };
  return null;
}

/** 去掉正文首尾的空行，保留内部空行。 */
function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start += 1;
  while (end > start && lines[end - 1].trim() === "") end -= 1;
  return lines.slice(start, end);
}

function text(language: Language, zh: string, en: string): string {
  return language === "zh-CN" ? zh : en;
}

function makeChapter(
  id: string,
  title: string,
  kind: ChapterKind,
  lines: string[],
  volumeId: string | null,
): Chapter {
  return { id, title, originalTitle: title, kind, lines, volumeId };
}

/**
 * 把预处理后的行装配成卷与章节。
 *
 * - 全部为空白时返回空结果，不产生空章节。
 * - 第一个标题之前的非空内容成为“简介”章（`kind: "intro"`）。
 * - 卷开启新分组，卷标题与下一个标题之间的行写入 `Volume.lines`；
 *   后续章节归属该卷，第一个卷之前的章节 `volumeId = null`。
 * - 番外章节从原位置抽出，统一追加到 `chapters` 末尾，并归入末尾的“番外”分组。
 * - 有内容但完全识别不到标题时，整篇作为单章“正文”。
 */
export function parseChapters(
  lines: string[],
  language: Language,
  userRules: ChapterRule[] = [],
): ParsedBook {
  if (!hasMeaningfulContent(lines)) {
    return { volumes: [], chapters: [] };
  }

  const userPatterns = compileUserRules(userRules);
  const hits: Array<{ index: number } & TitleHit> = [];
  let previousWasTitle = false;
  lines.forEach((line, index) => {
    const isolated =
      index === 0 || previousWasTitle || (lines[index - 1] ?? "").trim() === "";
    const hit = classifyTitle(line, isolated, userPatterns);
    if (hit) {
      hits.push({ index, ...hit });
      previousWasTitle = true;
      return;
    }
    previousWasTitle = false;
  });

  if (hits.length === 0) {
    const title = text(language, "正文", "Content");
    return {
      volumes: [],
      chapters: [
        makeChapter(createId("chapter", 0), title, "chapter", trimBlankLines(lines), null),
      ],
    };
  }

  const volumes: Volume[] = [];
  const chapters: Chapter[] = [];
  const pendingExtraIds = new Set<string>();
  const extraGroups: Volume[] = [];
  let currentVolumeId: string | null = null;

  const introLines = trimBlankLines(lines.slice(0, hits[0].index));
  if (hasMeaningfulContent(introLines)) {
    const title = text(language, "简介", "Introduction");
    chapters.push(makeChapter(createId("intro", 0), title, "intro", introLines, null));
  }

  hits.forEach((hit, position) => {
    const bodyStart = hit.index + 1;
    const bodyEnd = position + 1 < hits.length ? hits[position + 1].index : lines.length;
    const body = trimBlankLines(lines.slice(bodyStart, bodyEnd));

    if (hit.kind === "volume") {
      const volume: Volume = {
        id: createId("volume", volumes.length + 1),
        title: hit.title,
        originalTitle: hit.title,
        kind: "volume",
      };
      if (body.length > 0) volume.lines = body;
      volumes.push(volume);
      currentVolumeId = volume.id;
      return;
    }

    if (hit.kind === "extra") {
      let group: Volume | undefined = extraGroups[0];
      if (!group) {
        const title = text(language, "番外", "Extras");
        group = {
          id: createId("extra", 0),
          title,
          originalTitle: title,
          kind: "extra-group",
        };
        extraGroups.push(group);
        volumes.push(group);
      }
      const chapter = makeChapter(
        createId("chapter", chapters.length + 1),
        hit.title,
        "extra",
        body,
        group.id,
      );
      chapters.push(chapter);
      pendingExtraIds.add(chapter.id);
      return;
    }

    chapters.push(
      makeChapter(
        createId("chapter", chapters.length + 1),
        hit.title,
        hit.kind,
        body,
        currentVolumeId,
      ),
    );
  });

  if (extraGroups.length === 0) {
    return { volumes, chapters };
  }

  const group = extraGroups[0];
  const extras = chapters.filter((chapter) => pendingExtraIds.has(chapter.id));
  const regular = chapters.filter((chapter) => !pendingExtraIds.has(chapter.id));
  const orderedVolumes = [
    ...volumes.filter((volume) => volume.id !== group.id),
    group,
  ];

  return { volumes: orderedVolumes, chapters: [...regular, ...extras] };
}
