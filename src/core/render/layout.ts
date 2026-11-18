import type { ThemeId } from "../../types/book";
import { DEFAULT_THEME_ID } from "./themes";

/**
 * 高级排版模型与静态 CSS 生成。
 *
 * 预览与 EPUB 共用同一份 `layoutCss()` 输出：
 * - 不使用 CSS 变量，兼容旧阅读器；
 * - 不引入 `@font-face`，只用系统字体栈；
 * - 所有数值在归一化时裁剪到文档约定的范围内。
 *
 * 注意：`layoutCss()` 必须拼接在 `theme.css` 之后。章标题选择器与主题的
 * `.txt2book h1.chapter-title` 同特异度，依靠“后出现者生效”覆盖主题默认值。
 */

export type FontChoice = "serif" | "sans" | "song" | "hei" | "kai";

export type ElementKey =
  | "chapterTitle"
  | "body"
  | "volumeTitle"
  | "volumeNote"
  | "intro"
  | "tocTitle"
  | "tocItem";

export type BackgroundPresetId = "paper" | "grid" | "dots" | "linen";

type ElementAlign = "left" | "center" | "right" | "justify";

export interface ElementStyle {
  fontFamily: FontChoice;
  /** em，0.8–1.8 */
  fontSize: number;
  /** 1.2–2.6 */
  lineHeight: number;
  /** em，0–2；正文/简介/卷首文字的段间距 */
  paragraphSpacing: number;
  /** em，0–4 */
  textIndent: number;
  align: ElementAlign;
  /** #rrggbb */
  color: string;
  /** em，0–4 */
  marginTop: number;
  /** em，0–4 */
  marginBottom: number;
}

export interface TypographyConfig {
  version: 1;
  elements: Record<ElementKey, ElementStyle>;
}

/** 自定义背景的原始数据与元信息；字节在归一化阶段已校验。 */
export interface CustomBackground {
  data: Uint8Array;
  mimeType: "image/jpeg" | "image/png";
  width: number;
  height: number;
  fileName: string;
}

/**
 * 背景配置：`kind` 判别是否携带自定义图片。
 * 非 custom 分支把 `custom` 显式声明为 `undefined`，
 * 这样 `kind === "custom"` 收窄后 `custom` 一定存在，调用方不必再判空。
 */
export type BackgroundConfig =
  | { kind: "none"; presetId?: undefined; custom?: undefined }
  | { kind: "preset"; presetId?: BackgroundPresetId; custom?: undefined }
  | { kind: "custom"; presetId?: undefined; custom: CustomBackground };

export interface LayoutSettings {
  typography: TypographyConfig;
  background: BackgroundConfig;
}

/** 字体选项到系统字体栈的映射，全部为 CJK 友好的本地字体。 */
const FONT_STACKS: Record<FontChoice, string> = {
  serif: '"Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", SimSun, serif',
  song: '"Songti SC", SimSun, "Noto Serif SC", serif',
  sans: '-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif',
  hei: '"PingFang SC", "Microsoft YaHei", "Noto Sans SC", "Heiti SC", sans-serif',
  kai: '"Kaiti SC", KaiTi, "Noto Serif SC", Georgia, serif',
};

/**
 * 元素选择器与顺序：顺序固定，保证预览与 EPUB 的 CSS 文本可直接比对。
 * - 章标题与主题选择器保持同特异度，依赖拼接顺序覆盖；
 * - intro 排除 `.book-author`，否则书名页作者行会被误改字号与对齐。
 */
const ELEMENT_SELECTORS: Array<[ElementKey, string]> = [
  ["chapterTitle", ".txt2book h1.chapter-title"],
  ["body", ".txt2book p"],
  ["volumeTitle", ".txt2book .volume-title"],
  ["volumeNote", ".txt2book .volume-note"],
  ["intro", ".txt2book .title-page p:not(.book-author), .txt2book .description-page p"],
  ["tocTitle", ".txt2book .toc-page .toc-title"],
  ["tocItem", ".txt2book .toc-page li"],
];

const ELEMENT_KEYS: ElementKey[] = ELEMENT_SELECTORS.map(([key]) => key);

/** 这些元素的段间距由 `paragraphSpacing` 控制，其余元素用 `marginBottom`。 */
const PARAGRAPH_ELEMENTS = new Set<ElementKey>(["body", "intro"]);

/** 自定义背景的数据上限，避免异常输入导致超大内存分配。 */
const MAX_BACKGROUND_BYTES = 10 * 1024 * 1024;

/**
 * JSON 数字键对象允许的最大键数。
 * 旧实现用 `Math.max(...indices)` 求长度，键数超过约 125k 时会因参数过多抛
 * `RangeError`；这里改为循环求最大值，并在枚举后先做一次规模检查。
 */
const MAX_BYTE_KEYS = 8_000_000;

const FONT_CHOICES: FontChoice[] = ["serif", "sans", "song", "hei", "kai"];
const ALIGNMENTS: ElementAlign[] = ["left", "center", "right", "justify"];
const PRESET_IDS: BackgroundPresetId[] = ["paper", "grid", "dots", "linen"];

interface ThemeProfile {
  bodyFont: FontChoice;
  titleFont: FontChoice;
  bodyColor: string;
  titleColor: string;
  /** 正文基准字号（em）。 */
  fontSize: number;
  lineHeight: number;
  paragraphSpacing: number;
  textIndent: number;
  titleAlign: ElementAlign;
  bodyAlign: ElementAlign;
  titleSize: number;
  titleMarginBottom: number;
}

/** 五套主题的排版基调：字体族、字号、缩进与标题对齐方式。 */
const THEME_PROFILES: Record<ThemeId, ThemeProfile> = {
  minimal: {
    bodyFont: "sans",
    titleFont: "sans",
    bodyColor: "#1f2328",
    titleColor: "#1f2328",
    fontSize: 1,
    lineHeight: 1.8,
    paragraphSpacing: 0.6,
    textIndent: 0,
    titleAlign: "left",
    bodyAlign: "left",
    titleSize: 1.5,
    titleMarginBottom: 1.6,
  },
  paper: {
    bodyFont: "song",
    titleFont: "song",
    bodyColor: "#3b342b",
    titleColor: "#3b342b",
    fontSize: 1.05,
    lineHeight: 1.85,
    paragraphSpacing: 0.8,
    textIndent: 2,
    titleAlign: "center",
    bodyAlign: "justify",
    titleSize: 1.6,
    titleMarginBottom: 1.8,
  },
  night: {
    bodyFont: "sans",
    titleFont: "sans",
    bodyColor: "#b9bec5",
    titleColor: "#9aa0a6",
    fontSize: 1,
    lineHeight: 1.9,
    paragraphSpacing: 0.75,
    textIndent: 0,
    titleAlign: "left",
    bodyAlign: "left",
    titleSize: 1.35,
    titleMarginBottom: 1.5,
  },
  classic: {
    bodyFont: "kai",
    titleFont: "kai",
    bodyColor: "#4a3521",
    titleColor: "#4a3521",
    fontSize: 1.05,
    lineHeight: 1.9,
    paragraphSpacing: 0.85,
    textIndent: 2,
    titleAlign: "center",
    bodyAlign: "justify",
    titleSize: 1.6,
    titleMarginBottom: 2,
  },
  eink: {
    bodyFont: "serif",
    titleFont: "serif",
    bodyColor: "#111111",
    titleColor: "#111111",
    fontSize: 1.05,
    lineHeight: 1.85,
    paragraphSpacing: 0.5,
    textIndent: 2,
    titleAlign: "center",
    bodyAlign: "justify",
    titleSize: 1.5,
    titleMarginBottom: 1.6,
  },
};

/** 预设背景全部用纯 CSS 渐变实现，不携带任何图片文件。 */
const PRESET_BACKGROUND_CSS: Record<BackgroundPresetId, string> = {
  paper: [
    "  background-image: repeating-linear-gradient(45deg, rgba(0, 0, 0, 0.035) 0, rgba(0, 0, 0, 0.035) 1px, transparent 1px, transparent 7px);",
    "  background-repeat: repeat;",
  ].join("\n"),
  grid: [
    "  background-image: repeating-linear-gradient(0deg, rgba(0, 0, 0, 0.06) 0, rgba(0, 0, 0, 0.06) 1px, transparent 1px, transparent 24px), repeating-linear-gradient(90deg, rgba(0, 0, 0, 0.06) 0, rgba(0, 0, 0, 0.06) 1px, transparent 1px, transparent 24px);",
    "  background-repeat: repeat;",
  ].join("\n"),
  dots: [
    "  background-image: radial-gradient(circle, rgba(0, 0, 0, 0.1) 1px, transparent 1.5px);",
    "  background-size: 16px 16px;",
    "  background-repeat: repeat;",
  ].join("\n"),
  linen: [
    "  background-image: repeating-linear-gradient(0deg, rgba(0, 0, 0, 0.05) 0, rgba(0, 0, 0, 0.05) 1px, transparent 1px, transparent 4px), repeating-linear-gradient(90deg, rgba(255, 255, 255, 0.35) 0, rgba(255, 255, 255, 0.35) 1px, transparent 1px, transparent 4px);",
    "  background-repeat: repeat;",
  ].join("\n"),
};

/** 结构性页面在主题基线里固定使用的字号（`themes.ts` 的 STRUCTURAL_CSS）。 */
const VOLUME_TITLE_FONT_SIZE = 1.8;
const TOC_TITLE_FONT_SIZE = 1.6;
const TOC_ITEM_MARGIN = 0.4;

/** 主题不存在时回退默认主题，避免旧数据或测试传入未知值时抛错。 */
function resolveThemeId(themeId: ThemeId): ThemeId {
  return Object.prototype.hasOwnProperty.call(THEME_PROFILES, themeId)
    ? themeId
    : DEFAULT_THEME_ID;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 把输入裁剪到 `[min, max]`；非数字、NaN、Infinity 交给调用方回退默认值。 */
function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function numberField(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return clampNumber(value, min, max);
}

function choiceField<T extends string>(value: unknown, choices: T[], fallback: T): T {
  return typeof value === "string" && (choices as string[]).includes(value) ? (value as T) : fallback;
}

/** 接受 `#rgb` 与 `#rrggbb`，统一输出小写六位；其余返回 `null`。 */
function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const hex = match[1];
  const expanded =
    hex.length === 3
      ? hex
          .split("")
          .map((char) => char + char)
          .join("")
      : hex;
  return `#${expanded.toLowerCase()}`;
}

function normalizeElementStyle(raw: unknown, fallback: ElementStyle): ElementStyle {
  if (!isRecord(raw)) return { ...fallback };
  return {
    fontFamily: choiceField(raw.fontFamily, FONT_CHOICES, fallback.fontFamily),
    fontSize: numberField(raw.fontSize, fallback.fontSize, 0.8, 1.8),
    lineHeight: numberField(raw.lineHeight, fallback.lineHeight, 1.2, 2.6),
    paragraphSpacing: numberField(raw.paragraphSpacing, fallback.paragraphSpacing, 0, 2),
    textIndent: numberField(raw.textIndent, fallback.textIndent, 0, 4),
    align: choiceField(raw.align, ALIGNMENTS, fallback.align),
    color: normalizeHexColor(raw.color) ?? fallback.color,
    marginTop: numberField(raw.marginTop, fallback.marginTop, 0, 4),
    marginBottom: numberField(raw.marginBottom, fallback.marginBottom, 0, 4),
  };
}

/** 解码纯 base64 字符串；格式不合法或为空时返回 `null`。 */
function decodeBase64(value: string): Uint8Array | null {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return null;
  try {
    const binary = atob(normalized);
    if (!binary) return null;
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

function toByte(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255
    ? value
    : null;
}

/**
 * 把自定义背景的数据还原为 `Uint8Array`。
 * 除 `Uint8Array` 外，还兼容 `number[]`、`JSON.stringify` 后的数字键对象
 * （`{"0":1,"1":2}`）以及可选的原生 base64 字符串。
 */
function toByteArray(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) {
    return value.length > 0 && value.length <= MAX_BACKGROUND_BYTES ? value : null;
  }

  if (Array.isArray(value)) {
    if (value.length === 0 || value.length > MAX_BACKGROUND_BYTES) return null;
    const bytes = new Uint8Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      const byte = toByte(value[index]);
      if (byte === null) return null;
      bytes[index] = byte;
    }
    return bytes;
  }

  if (typeof value === "string") {
    return decodeBase64(value);
  }

  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0 || keys.length > MAX_BYTE_KEYS) return null;
    let size = 0;
    for (const key of keys) {
      if (!/^(0|[1-9]\d*)$/.test(key)) return null;
      const index = Number(key);
      if (index >= MAX_BYTE_KEYS) return null;
      // 逐个比较而不是 Math.max(...indices)：展开大数组会触发 RangeError。
      if (index + 1 > size) size = index + 1;
    }
    if (size !== keys.length) return null;
    const bytes = new Uint8Array(size);
    for (let index = 0; index < size; index += 1) {
      const byte = toByte(value[String(index)]);
      if (byte === null) return null;
      bytes[index] = byte;
    }
    return bytes;
  }

  return null;
}

function normalizeCustomBackground(raw: unknown): CustomBackground | null {
  if (!isRecord(raw)) return null;
  const { mimeType, width, height, fileName } = raw;
  const data = toByteArray(raw.data);
  if (!data) return null;
  if (mimeType !== "image/jpeg" && mimeType !== "image/png") return null;
  // JPEG 输出不携带客户端解析的尺寸，允许 0×0；负数或非数字仍视为无效。
  if (typeof width !== "number" || !Number.isFinite(width) || width < 0) return null;
  if (typeof height !== "number" || !Number.isFinite(height) || height < 0) return null;
  if (typeof fileName !== "string" || !fileName) return null;
  return { data, mimeType, width, height, fileName };
}

function normalizeBackground(raw: unknown): BackgroundConfig {
  if (!isRecord(raw)) return { kind: "none" };
  if (raw.kind === "none") return { kind: "none" };
  if (raw.kind === "preset") {
    const presetId = choiceField(raw.presetId, PRESET_IDS, "paper");
    return { kind: "preset", presetId };
  }
  if (raw.kind === "custom") {
    const custom = normalizeCustomBackground(raw.custom);
    return custom ? { kind: "custom", custom } : { kind: "none" };
  }
  return { kind: "none" };
}

/** 主题默认排版。每次返回全新对象，避免调用方改到共享默认值。 */
export function defaultLayoutFor(themeId: ThemeId): LayoutSettings {
  const profile = THEME_PROFILES[resolveThemeId(themeId)];
  const elements: Record<ElementKey, ElementStyle> = {
    chapterTitle: {
      fontFamily: profile.titleFont,
      fontSize: profile.titleSize,
      lineHeight: profile.lineHeight,
      paragraphSpacing: 0,
      textIndent: 0,
      align: profile.titleAlign,
      color: profile.titleColor,
      marginTop: 0,
      marginBottom: profile.titleMarginBottom,
    },
    body: {
      fontFamily: profile.bodyFont,
      fontSize: profile.fontSize,
      lineHeight: profile.lineHeight,
      paragraphSpacing: profile.paragraphSpacing,
      textIndent: profile.textIndent,
      align: profile.bodyAlign,
      color: profile.bodyColor,
      marginTop: 0,
      marginBottom: 0,
    },
    volumeTitle: {
      fontFamily: profile.titleFont,
      fontSize: VOLUME_TITLE_FONT_SIZE,
      lineHeight: profile.lineHeight,
      paragraphSpacing: 0,
      textIndent: 0,
      align: profile.titleAlign,
      color: profile.titleColor,
      marginTop: 0,
      marginBottom: 1.2,
    },
    volumeNote: {
      fontFamily: profile.bodyFont,
      fontSize: profile.fontSize,
      lineHeight: profile.lineHeight,
      paragraphSpacing: 0,
      textIndent: 0,
      align: "center",
      color: profile.bodyColor,
      marginTop: 0,
      marginBottom: 0.8,
    },
    intro: {
      fontFamily: profile.bodyFont,
      fontSize: profile.fontSize,
      lineHeight: profile.lineHeight,
      paragraphSpacing: 0,
      textIndent: 0,
      align: "left",
      color: profile.bodyColor,
      marginTop: 0,
      marginBottom: 0,
    },
    tocTitle: {
      fontFamily: profile.titleFont,
      fontSize: TOC_TITLE_FONT_SIZE,
      lineHeight: profile.lineHeight,
      paragraphSpacing: 0,
      textIndent: 0,
      align: "center",
      color: profile.titleColor,
      marginTop: 0,
      marginBottom: 1.6,
    },
    tocItem: {
      fontFamily: profile.bodyFont,
      fontSize: 1,
      lineHeight: profile.lineHeight,
      paragraphSpacing: 0,
      textIndent: 0,
      align: "left",
      color: profile.bodyColor,
      marginTop: TOC_ITEM_MARGIN,
      marginBottom: TOC_ITEM_MARGIN,
    },
  };
  return { typography: { version: 1, elements }, background: { kind: "none" } };
}

/**
 * 归一化任意来源的排版配置（localStorage、旧版本数据、手工构造的对象）。
 * 数值超出范围时裁剪到边界，类型错误或缺失时回退主题默认值；
 * 未知元素键直接忽略。
 */
export function normalizeLayout(raw: unknown, themeId: ThemeId): LayoutSettings {
  const resolvedThemeId = resolveThemeId(themeId);
  const defaults = defaultLayoutFor(resolvedThemeId);
  const source = isRecord(raw) ? raw : {};
  const typography = isRecord(source.typography) ? source.typography : {};
  const rawElements = isRecord(typography.elements) ? typography.elements : {};

  const elements = {} as Record<ElementKey, ElementStyle>;
  for (const key of ELEMENT_KEYS) {
    elements[key] = normalizeElementStyle(rawElements[key], defaults.typography.elements[key]);
  }

  return {
    typography: { version: 1, elements },
    background: normalizeBackground(source.background),
  };
}

/** 数字输出去掉多余小数位，避免 CSS 里出现 `1.0500000000000003`。 */
function formatNumber(value: number): string {
  return String(Number(value.toFixed(2)));
}

function elementRule(key: ElementKey, selector: string, style: ElementStyle): string {
  const spacing = PARAGRAPH_ELEMENTS.has(key) ? style.paragraphSpacing : style.marginBottom;
  return [
    `${selector} {`,
    `  font-family: ${FONT_STACKS[style.fontFamily]};`,
    `  font-size: ${formatNumber(style.fontSize)}em;`,
    `  line-height: ${formatNumber(style.lineHeight)};`,
    `  color: ${style.color};`,
    `  text-align: ${style.align};`,
    `  text-indent: ${formatNumber(style.textIndent)}em;`,
    `  margin: ${formatNumber(style.marginTop)}em 0 ${formatNumber(spacing)}em;`,
    "}",
  ].join("\n");
}

/** 数据 URL 只接受这三类图片，避免 `data:text/html` 之类的注入。 */
const SAFE_DATA_IMAGE_PREFIXES = [
  "data:image/png;base64,",
  "data:image/jpeg;base64,",
  "data:image/webp;base64,",
];

/**
 * 校验自定义背景来源：
 * - 允许 `data:image/{png,jpeg,webp};base64,...`、`blob:` 与相对路径；
 * - 相对路径不得含 `:`（因此 `javascript:` 等协议一律拒绝），
 *   也不得含空白、换行、`<`、`>`、`"`、`\`。
 * 返回 `null` 表示不输出背景规则。
 */
function safeBackgroundSrc(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;

  for (const prefix of SAFE_DATA_IMAGE_PREFIXES) {
    if (value.startsWith(prefix)) {
      const payload = value.slice(prefix.length);
      return /^[A-Za-z0-9+/]+={0,2}$/.test(payload) ? value : null;
    }
  }

  if (value.startsWith("blob:")) {
    const rest = value.slice("blob:".length);
    return rest && /^[^\s<>"\\]+$/.test(rest) ? value : null;
  }

  return /^[^\s<>"\\:]+$/.test(value) ? value : null;
}

/** 自定义背景的 URL 再做一层转义，作为校验之外的兜底。 */
function escapeCssUrl(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "%22").replace(/[\r\n]/g, "");
}

function backgroundRule(
  themeId: ThemeId,
  background: BackgroundConfig,
  options: { backgroundSrc?: string },
): string {
  // 墨水屏强制忽略所有背景图，即使配置里选了纹理或自定义图片。
  if (themeId === "eink") return "";
  if (background.kind === "none") return "";

  if (background.kind === "custom") {
    const src = safeBackgroundSrc(options.backgroundSrc);
    if (!src) return "";
    return [
      ".txt2book {",
      `  background-image: url("${escapeCssUrl(src)}");`,
      "  background-size: cover;",
      "  background-repeat: no-repeat;",
      "}",
    ].join("\n");
  }

  const presetId = background.presetId ?? "paper";
  return [".txt2book {", PRESET_BACKGROUND_CSS[presetId], "}"].join("\n");
}

/**
 * 生成高级排版 CSS（静态字符串，选择器统一加 `.txt2book` 前缀）。
 * 预览 iframe 与 EPUB 的 `theme.css` 共用此函数，保证两端一致。
 */
export function layoutCss(
  themeId: ThemeId,
  layout: LayoutSettings,
  options: { backgroundSrc?: string } = {},
): string {
  const resolvedThemeId = resolveThemeId(themeId);
  const normalized = normalizeLayout(layout, resolvedThemeId);
  const blocks = [
    "/* 高级排版：需拼接在 theme.css 之后，只覆盖字体、间距与配色，不改变布局结构。 */",
    ...ELEMENT_SELECTORS.map(([key, selector]) =>
      elementRule(key, selector, normalized.typography.elements[key]),
    ),
    backgroundRule(resolvedThemeId, normalized.background, options),
  ].filter(Boolean);
  return blocks.join("\n\n");
}
