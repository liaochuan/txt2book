/**
 * 沿用旧版 txt-to-epub 的存储键，保证用户已保存的规则升级后仍然生效。
 * 旧规则没有 `kind` 字段，读入时统一补 `"chapter"`。
 */
export const STORAGE_KEY = "txt2epub:customChapterRules";

/**
 * 用户规则可以声明的命中类型。比 `ChapterKind` 多一个 `volume`：
 * 规则命中卷标题时直接生成卷，而不是章节。
 */
export type RuleKind = "volume" | "chapter" | "extra" | "prologue" | "epilogue";

export type KeywordTemplate = "prefix" | "anywhere";

export interface ChapterRule {
  id: string;
  label: string;
  /** 正则源码，不含首尾斜杠。旧 keyword 规则在读取时已转成正则。 */
  pattern: string;
  flags?: string;
  /** 匹配结果中作为标题的分组下标，缺省 0（整个匹配）。 */
  capture?: number;
  enabled: boolean;
  kind: RuleKind;
}

export interface CompiledRule {
  regex: RegExp;
  capture: number;
}

const RULE_KINDS: readonly RuleKind[] = [
  "volume",
  "chapter",
  "extra",
  "prologue",
  "epilogue",
];

export function createRuleId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `rule-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isRuleKind(value: unknown): value is RuleKind {
  return typeof value === "string" && RULE_KINDS.includes(value as RuleKind);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 把旧版的 keyword 规则转成等价正则源码。
 * 关键词按 `|` 与换行拆分，去重、escape 后用 `|` 连接：
 * - `prefix`：`^(alt).*$`，只匹配行首；
 * - `anywhere`：`^.*(alt).*$`，行内任意位置。
 */
export function keywordToRegexSource(
  keywords: string,
  template: KeywordTemplate = "prefix",
): string {
  const tokens = keywords
    .split(/[|\n]/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  if (tokens.length === 0) {
    throw new Error("关键词不能为空");
  }

  const unique = Array.from(new Set(tokens.map(escapeRegex)));
  const alternatives = unique.join("|");
  // 单个关键词不需要分组；多关键词必须分组，否则 `|` 会拆散首尾锚点。
  const body = unique.length > 1 ? `(${alternatives})` : alternatives;
  return template === "anywhere" ? `^.*${body}.*$` : `^${body}.*$`;
}

/**
 * 编译用户规则。`g` / `y` 标志会让逐行匹配携带状态，这里统一去掉，
 * 保证同一条规则在每一行上的行为一致。
 */
export function compileRule(rule: ChapterRule): CompiledRule {
  const flags = (rule.flags ?? "").replace(/[gy]/g, "");
  return {
    regex: new RegExp(rule.pattern, flags),
    capture: rule.capture ?? 0,
  };
}

function normalizeRule(raw: unknown): ChapterRule | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  // 旧版字段名为 name，新版为 label，两者都接受。
  const label =
    typeof value.label === "string"
      ? value.label
      : typeof value.name === "string"
        ? value.name
        : null;
  if (label === null || typeof value.pattern !== "string") return null;

  let pattern = value.pattern;
  let flags = typeof value.flags === "string" ? value.flags : undefined;
  if (value.mode === "keyword") {
    try {
      pattern = keywordToRegexSource(
        value.pattern,
        value.keywordTemplate === "anywhere" ? "anywhere" : "prefix",
      );
    } catch {
      return null;
    }
    // 生成的正则自带锚点，旧 flags 没有意义。
    flags = undefined;
  }

  return {
    id: typeof value.id === "string" && value.id ? value.id : createRuleId(),
    label,
    pattern,
    flags,
    capture: typeof value.capture === "number" ? value.capture : undefined,
    enabled: typeof value.enabled === "boolean" ? value.enabled : true,
    kind: isRuleKind(value.kind) ? value.kind : "chapter",
  };
}

export function loadRules(): ChapterRule[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => normalizeRule(item))
      .filter((rule): rule is ChapterRule => rule !== null);
  } catch {
    return [];
  }
}

export function saveRules(rules: ChapterRule[]): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rules, null, 2));
  } catch {
    // 存储不可用或超出配额时静默失败，不阻断解析与导出。
  }
}
