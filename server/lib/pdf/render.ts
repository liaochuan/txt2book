import PDFDocument from "pdfkit";
import sharp from "sharp";
import { resolvePdfFonts } from "./fonts.js";
import { wrapCjkTextWithIndent } from "./text.js";
import type {
  PdfAlign,
  PdfBackground,
  PdfBook,
  PdfByteSource,
  PdfChapter,
  PdfElementKey,
  PdfElementStyle,
  PdfFontChoice,
  PdfFontRole,
  PdfFonts,
  PdfLayout,
  PdfMeta,
  PdfOptions,
  PdfPageSize,
  PdfResult,
  PdfVolume,
} from "./types.js";

/**
 * 服务端 PDF 排版（设计文档 §6）。
 *
 * - 两遍排版：第一遍收集卷/章的真实页码，第二遍写入目录与页码；
 * - 中文断行、标点避头尾由 `text.ts` 提供；
 * - 字号以 12pt 为基准乘以布局里的 em；
 * - 自定义背景图以 8% 不透明度铺满每页，预设纹理忽略；
 * - 找不到中文字体时抛 `PdfFontError`（`PDF_FONT_MISSING`）。
 */

const BASE_FONT_SIZE = 12;
const COVER_MARGIN = 36;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_VOLUMES = 500;
const MAX_TOTAL_CHARS = 20_000_000;
const FOOTER_FONT_SIZE = 9;

const PAGE_SIZES: Record<PdfPageSize, { width: number; height: number }> = {
  A4: { width: 595.28, height: 841.89 },
  A5: { width: 419.53, height: 595.28 },
};

const MARGINS = { normal: 56, narrow: 36 } as const;

const ELEMENT_KEYS: PdfElementKey[] = [
  "chapterTitle",
  "body",
  "volumeTitle",
  "volumeNote",
  "intro",
  "tocTitle",
  "tocItem",
];

const FONT_CHOICES: PdfFontChoice[] = ["serif", "sans", "song", "hei", "kai"];
const ALIGNMENTS: PdfAlign[] = ["left", "center", "right", "justify"];

interface ThemeProfile {
  bodyFont: PdfFontChoice;
  titleFont: PdfFontChoice;
  bodyColor: string;
  titleColor: string;
  fontSize: number;
  lineHeight: number;
  paragraphSpacing: number;
  textIndent: number;
  titleAlign: PdfAlign;
  bodyAlign: PdfAlign;
  titleSize: number;
  titleMarginBottom: number;
}

/** 与前端 `src/core/render/layout.ts` 的主题基调保持一致；服务端不能直接 import。 */
const THEME_PROFILES: Record<string, ThemeProfile> = {
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

/** 找不到中文字体时抛出；`code` 供路由层映射 500 响应。 */
export class PdfFontError extends Error {
  readonly code = "PDF_FONT_MISSING";

  constructor() {
    super("未找到可用的中文字体，请安装 Noto CJK 或设置 PDF_FONT_PATH。");
    this.name = "PdfFontError";
  }
}

/** 引擎侧资源上限：路由层映射为 400 `EXPORT_TOO_LARGE`。 */
export class PdfLimitError extends Error {
  readonly code = "EXPORT_TOO_LARGE";

  constructor(message = "导出内容过大，请减少章节或字数后重试。") {
    super(message);
    this.name = "PdfLimitError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function numberField(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return clampNumber(value, min, max);
}

function choiceField<T extends string>(value: unknown, choices: T[], fallback: T): T {
  return typeof value === "string" && (choices as string[]).includes(value)
    ? (value as T)
    : fallback;
}

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

/** 主题不存在时回退 paper，避免旧数据或未知 id 抛错。 */
function resolveThemeId(themeId: string | undefined): string {
  if (typeof themeId === "string" && Object.prototype.hasOwnProperty.call(THEME_PROFILES, themeId)) {
    return themeId;
  }
  return "paper";
}

/** 主题默认排版；每次返回新对象。 */
export function defaultPdfLayoutFor(themeId?: string): PdfLayout {
  const profile = THEME_PROFILES[resolveThemeId(themeId)];
  const elements = {
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
      fontSize: 1.8,
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
      fontSize: 1.6,
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
      marginTop: 0.4,
      marginBottom: 0.4,
    },
  } satisfies Record<PdfElementKey, PdfElementStyle>;
  return { typography: { version: 1, elements }, background: { kind: "none" } };
}

function normalizeElementStyle(raw: unknown, fallback: PdfElementStyle): PdfElementStyle {
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

function isByteSource(value: unknown): value is PdfByteSource {
  return (
    typeof value === "string" ||
    Array.isArray(value) ||
    value instanceof Uint8Array ||
    value instanceof ArrayBuffer ||
    isRecord(value)
  );
}

function normalizeBackground(raw: unknown): PdfBackground {
  if (!isRecord(raw)) return { kind: "none" };
  if (raw.kind === "preset") {
    const presetId = typeof raw.presetId === "string" ? raw.presetId : undefined;
    return { kind: "preset", ...(presetId ? { presetId } : {}) };
  }
  if (raw.kind === "custom" && isRecord(raw.custom)) {
    const { mimeType } = raw.custom;
    if (
      (mimeType === "image/png" || mimeType === "image/jpeg") &&
      isByteSource(raw.custom.data)
    ) {
      return {
        kind: "custom",
        custom: {
          data: raw.custom.data,
          mimeType,
          ...(typeof raw.custom.width === "number" ? { width: raw.custom.width } : {}),
          ...(typeof raw.custom.height === "number" ? { height: raw.custom.height } : {}),
          ...(typeof raw.custom.fileName === "string" ? { fileName: raw.custom.fileName } : {}),
        },
      };
    }
  }
  return { kind: "none" };
}

/** 归一化任意来源的布局（JSON 请求体、旧数据、手工对象）。 */
export function normalizePdfLayout(raw: unknown, themeId?: string): PdfLayout {
  const fallback = defaultPdfLayoutFor(themeId);
  if (!isRecord(raw)) return fallback;
  const typography = isRecord(raw.typography) ? raw.typography : {};
  const rawElements = isRecord(typography.elements) ? typography.elements : {};

  const elements = {} as Record<PdfElementKey, PdfElementStyle>;
  for (const key of ELEMENT_KEYS) {
    elements[key] = normalizeElementStyle(rawElements[key], fallback.typography.elements[key]);
  }

  return {
    typography: { version: 1, elements },
    background: normalizeBackground(raw.background),
  };
}

/** 把请求体里的字节来源统一成 Buffer；非法输入返回 `null`。 */
function toBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) {
    return value.length > 0 && value.length <= MAX_IMAGE_BYTES ? value : null;
  }
  if (value instanceof Uint8Array) {
    if (value.length === 0 || value.length > MAX_IMAGE_BYTES) return null;
    return Buffer.from(value);
  }
  if (value instanceof ArrayBuffer) {
    if (value.byteLength === 0 || value.byteLength > MAX_IMAGE_BYTES) return null;
    return Buffer.from(new Uint8Array(value));
  }
  if (Array.isArray(value)) {
    if (value.length === 0 || value.length > MAX_IMAGE_BYTES) return null;
    const bytes = Buffer.alloc(value.length);
    for (let index = 0; index < value.length; index += 1) {
      const byte = value[index];
      if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) {
        return null;
      }
      bytes[index] = byte;
    }
    return bytes;
  }
  if (typeof value === "string") {
    const normalized = value.trim();
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return null;
    const buffer = Buffer.from(normalized, "base64");
    return buffer.length > 0 && buffer.length <= MAX_IMAGE_BYTES ? buffer : null;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0 || keys.length > MAX_IMAGE_BYTES) return null;
    const bytes = Buffer.alloc(keys.length);
    for (const key of keys) {
      if (!/^(0|[1-9]\d*)$/.test(key)) return null;
      const index = Number(key);
      if (index >= keys.length) return null;
      const byte = value[key];
      if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) {
        return null;
      }
      bytes[index] = byte;
    }
    return bytes;
  }
  return null;
}

/** PNG 魔数（8 字节）。 */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPngImage(buffer: Buffer): boolean {
  if (buffer.length < PNG_SIGNATURE.length) return false;
  return PNG_SIGNATURE.every((byte, index) => buffer[index] === byte);
}

function isJpegImage(buffer: Buffer): boolean {
  return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

/** 只有 PNG/JPEG 才能交给 pdfkit；损坏或伪装的字节直接跳过该图层。 */
function isSupportedImage(buffer: Buffer): boolean {
  return isPngImage(buffer) || isJpegImage(buffer);
}

/**
 * 校验并解码图片：魔数、像素上限与截断都检查。
 * 失败返回 `null`，调用方跳过该图层而不是中断导出。
 */
async function prepareImage(value: unknown): Promise<Buffer | null> {
  const buffer = toBuffer(value);
  if (!buffer || !isSupportedImage(buffer)) return null;
  try {
    const { info } = await sharp(buffer, {
      limitInputPixels: MAX_IMAGE_PIXELS,
      failOn: "error",
    }).toBuffer({ resolveWithObject: true });
    if (!info.width || !info.height) return null;
    if (info.width * info.height > MAX_IMAGE_PIXELS) return null;
    return buffer;
  } catch {
    return null;
  }
}

/** 引擎侧防御：字符总量与卷数量上限（路由层之外再兜底一次）。 */
function assertPdfLimits(book: PdfBook): void {
  const volumes = volumeList(book);
  if (volumes.length > MAX_VOLUMES) throw new PdfLimitError();

  const meta = book.meta;
  let total = (meta.title ?? "").length + (meta.author ?? "").length;
  total += (meta.description ?? "").length;

  for (const volume of volumes) {
    total += volume.title.length;
    for (const line of volume.lines ?? []) total += line.length;
  }
  for (const chapter of chapterList(book)) {
    total += chapter.title.length;
    for (const line of chapter.lines) total += line.length;
  }

  if (total > MAX_TOTAL_CHARS) throw new PdfLimitError();
}

function roleForChoice(choice: PdfFontChoice): PdfFontRole {
  switch (choice) {
    case "sans":
    case "hei":
      return "sans";
    case "kai":
      return "kai";
    default:
      return "serif";
  }
}

function labelFor(language: string | undefined, zh: string, en: string): string {
  return language === "en" ? en : zh;
}

/** 目录链接的命名目标：ASCII 且全书唯一。 */
function destinationName(kind: "chapter" | "volume", index: number): string {
  return `${kind}-${index}`;
}

/** 目录条目键（`v:<卷序号>` / `c:<章序号>`）→ 对应的命名目标。 */
function destinationForTocKey(key: string): string {
  return key.startsWith("v:")
    ? destinationName("volume", Number(key.slice(2)))
    : destinationName("chapter", Number(key.slice(2)));
}

function bookTitle(meta: PdfMeta): string {
  return meta.title.trim() || "未命名";
}

export interface PlannedChapter {
  chapter: PdfChapter;
  number: number;
}

export type PdfBlock =
  | { kind: "volume"; volume: PdfVolume; ordinal: number; hasPage: boolean }
  | { kind: "chapter"; entry: PlannedChapter };

interface TocEntry {
  title: string;
  depth: number;
  /** 指向的页码键：`v:<序号>` 或 `c:<章序号>`。 */
  key: string;
}

interface PageBox {
  width: number;
  height: number;
}

interface FontSelection {
  /** 角色 → 已注册且实测可用的字体别名。 */
  aliases: Record<PdfFontRole, string>;
  /** 角色 → 实际使用的角色（注册或实测失败时回退）。 */
  actualRoles: Record<PdfFontRole, PdfFontRole>;
}

interface RenderState {
  doc: PDFKit.PDFDocument;
  fontSelection: FontSelection;
  layout: PdfLayout;
  page: PageBox;
  margin: number;
  pageNumbers: boolean;
  bookmarks: boolean;
  /** 是否生成目录链接；关闭目录页时不注册目标、不加注解。 */
  tocLinks: boolean;
  background: Buffer | null;
  pages: Map<string, number>;
  pageCount: number;
  coverPage: number | null;
  volumeNode: PDFKit.PDFOutline | null;
  bookmarkVolumeId: string | null;
}

function contentWidth(state: RenderState): number {
  return state.page.width - state.margin * 2;
}

function contentHeight(state: RenderState): number {
  return state.page.height - state.margin * 2;
}

function contentBottom(state: RenderState): number {
  return state.page.height - state.margin;
}

const FONT_ROLES: PdfFontRole[] = ["serif", "sans", "kai"];

/**
 * 注册字体并实测可用性（设计文档 §6.2）。
 *
 * - 同一路径（含 family）只注册一次，多个角色复用同一别名；
 * - 注册后用 `widthOfString("中")` 实测字形宽度，失败的角色回退；
 * - 所有角色都不可用时抛 `PdfFontError`。
 */
function registerFonts(doc: PDFKit.PDFDocument, fonts: PdfFonts): FontSelection {
  const aliasByKey = new Map<string, string>();
  const roleAlias = new Map<PdfFontRole, string>();

  for (const role of FONT_ROLES) {
    const file = fonts[role];
    const key = `${file.path}\u0000${file.family ?? ""}`;
    let alias = aliasByKey.get(key);
    if (alias === undefined) {
      alias = `pdf-font-${aliasByKey.size}`;
      try {
        doc.registerFont(alias, file.path, file.family);
      } catch {
        // 文件不存在、TTC 字族名不对等：该角色视为不可用。
        continue;
      }
      aliasByKey.set(key, alias);
    }
    roleAlias.set(role, alias);
  }

  const validated = new Set<string>();
  for (const alias of new Set(roleAlias.values())) {
    try {
      doc.font(alias).fontSize(BASE_FONT_SIZE);
      if (doc.widthOfString("中") > 0) validated.add(alias);
    } catch {
      // 无法实测字形（字体损坏、非 CJK 字体等）同样视为不可用。
    }
  }

  const fallbackRole = FONT_ROLES.find((role) => {
    const alias = roleAlias.get(role);
    return alias !== undefined && validated.has(alias);
  });
  if (fallbackRole === undefined) throw new PdfFontError();
  const fallbackAlias = roleAlias.get(fallbackRole);
  if (fallbackAlias === undefined) throw new PdfFontError();

  const aliases = {} as Record<PdfFontRole, string>;
  const actualRoles = {} as Record<PdfFontRole, PdfFontRole>;
  for (const role of FONT_ROLES) {
    const alias = roleAlias.get(role);
    if (alias !== undefined && validated.has(alias)) {
      aliases[role] = alias;
      actualRoles[role] = role;
    } else {
      aliases[role] = fallbackAlias;
      actualRoles[role] = fallbackRole;
    }
  }

  return { aliases, actualRoles };
}

function drawFooter(state: RenderState): void {
  const { doc } = state;
  const font = state.fontSelection.aliases.serif;
  doc.font(font).fontSize(FOOTER_FONT_SIZE).fillColor("#666666");
  const savedBottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  doc.text(String(state.pageCount), state.margin, state.page.height - state.margin + 8, {
    width: contentWidth(state),
    align: "center",
    lineBreak: false,
  });
  doc.page.margins.bottom = savedBottom;
}

function startPage(state: RenderState, options: { cover?: boolean } = {}): void {
  const { doc, page, margin } = state;
  doc.addPage({
    size: [page.width, page.height],
    margins: { top: margin, bottom: margin, left: margin, right: margin },
  });
  state.pageCount += 1;
  if (options.cover) state.coverPage = state.pageCount;

  if (state.background) {
    state.doc.save();
    try {
      state.doc.opacity(0.08);
      state.doc.image(state.background, 0, 0, { width: page.width, height: page.height });
    } catch {
      // 解码失败时跳过背景图层，不影响正文。
    } finally {
      state.doc.restore();
    }
  }
  doc.fillColor("#000000");

  if (state.pageNumbers && state.coverPage !== state.pageCount) drawFooter(state);
}

function addBookmark(
  state: RenderState,
  title: string,
  parent: PDFKit.PDFOutline | null,
): PDFKit.PDFOutline | null {
  if (!state.bookmarks) return null;
  const safeTitle = title.trim();
  if (!safeTitle) return null;
  return parent ? parent.addItem(safeTitle) : state.doc.outline.addItem(safeTitle);
}

/** 在当前页顶部注册命名目标；关闭目录页时跳过，避免产生多余的 Names 条目。 */
function addPageDestination(
  state: RenderState,
  kind: "chapter" | "volume",
  index: number,
): void {
  if (!state.tocLinks) return;
  state.doc.addNamedDestination(
    destinationName(kind, index),
    "XYZ",
    state.margin,
    state.margin,
    null,
  );
}

/**
 * 绘制一段自动换行的文本，返回下一行的 y 坐标。
 * 内容超出页面底部时自动开新页。
 */
function drawParagraph(
  state: RenderState,
  text: string,
  style: PdfElementStyle,
  x: number,
  width: number,
  top: number,
  options: { indent?: boolean } = {},
): number {
  const { doc } = state;
  const role = roleForChoice(style.fontFamily);
  const font = state.fontSelection.aliases[role];
  const fontSize = BASE_FONT_SIZE * style.fontSize;
  const lineHeight = fontSize * style.lineHeight;
  const wantsIndent =
    options.indent === true && (style.align === "left" || style.align === "justify");
  const indent = wantsIndent ? style.textIndent * fontSize : 0;
  const firstWidth = Math.max(width - indent, fontSize);

  doc.font(font).fontSize(fontSize).fillColor(style.color);
  const measure = (value: string): number => doc.widthOfString(value);
  const lines = wrapCjkTextWithIndent(text, measure, width, firstWidth);

  let y = top;
  for (let index = 0; index < lines.length; index += 1) {
    if (y + lineHeight > contentBottom(state)) {
      startPage(state);
      y = state.margin;
      doc.font(font).fontSize(fontSize).fillColor(style.color);
    }
    const line = lines[index];
    const lineWidth = measure(line);
    let drawX = x;
    let targetWidth = width;
    if (style.align === "center") drawX = x + (width - lineWidth) / 2;
    else if (style.align === "right") drawX = x + width - lineWidth;
    else if (index === 0 && indent > 0) {
      drawX = x + indent;
      targetWidth = width - indent;
    }

    // 两端对齐：只拉伸段内行，最后一行保持自然宽度。
    const isLastLine = index === lines.length - 1;
    const characterSpacing =
      style.align === "justify" && !isLastLine && line.length > 1
        ? Math.max(0, (targetWidth - lineWidth) / (line.length - 1))
        : 0;

    doc.text(line, drawX, y, {
      lineBreak: false,
      ...(characterSpacing > 0 ? { characterSpacing } : {}),
    });
    y += lineHeight;
  }
  return y;
}

function chapterList(book: PdfBook): PdfChapter[] {
  return Array.isArray(book.chapters) ? book.chapters : [];
}

function volumeList(book: PdfBook): PdfVolume[] {
  return Array.isArray(book.volumes) ? book.volumes : [];
}

/** 按阅读顺序规划卷分组；卷首次出现时生成卷块。 */
export function planPdfBlocks(book: PdfBook, includeVolumePages: boolean): PdfBlock[] {
  const volumes = volumeList(book);
  const chapters = chapterList(book);
  // 全书无章节时，卷扉页是卷首文字的唯一载体，必须强制输出。
  const forceVolumePages = chapters.length === 0;
  const volumeById = new Map(volumes.map((volume) => [volume.id, volume]));
  const volumeOrdinal = new Map(volumes.map((volume, index) => [volume.id, index + 1]));
  const blocks: PdfBlock[] = [];
  const emitted = new Set<string>();
  let currentVolumeId: string | null = null;
  let number = 0;

  for (const chapter of chapters) {
    number += 1;
    const volumeId = chapter.volumeId ?? null;
    const volume = volumeId ? volumeById.get(volumeId) : undefined;
    if (!volume) {
      currentVolumeId = null;
    } else if (volume.id !== currentVolumeId) {
      currentVolumeId = volume.id;
      const firstAppearance = !emitted.has(volume.id);
      emitted.add(volume.id);
      blocks.push({
        kind: "volume",
        volume,
        ordinal: volumeOrdinal.get(volume.id) ?? number,
        hasPage:
          firstAppearance && volume.kind === "volume" && (includeVolumePages || forceVolumePages),
      });
    }
    blocks.push({ kind: "chapter", entry: { chapter, number } });
  }

  // 零章卷：插到其后方第一个有章节的卷之前；没有后续有章节的卷则放末尾。
  // `extra-group` 不参与卷页与卷首文字承载，直接跳过。
  const pending = volumes
    .map((volume, index) => ({ volume, index }))
    .filter(({ volume }) => volume.kind === "volume" && !emitted.has(volume.id));

  for (const { volume, index } of pending) {
    const block: PdfBlock = {
      kind: "volume",
      volume,
      ordinal: volumeOrdinal.get(volume.id) ?? index + 1,
      hasPage: includeVolumePages || forceVolumePages,
    };
    const targetVolume = volumes.find(
      (candidate, candidateIndex) => candidateIndex > index && emitted.has(candidate.id),
    );
    if (!targetVolume) {
      blocks.push(block);
      continue;
    }
    const insertAt = blocks.findIndex(
      (item) => item.kind === "volume" && item.volume.id === targetVolume.id,
    );
    if (insertAt === -1) blocks.push(block);
    else blocks.splice(insertAt, 0, block);
  }

  return blocks;
}

/**
 * 关闭卷扉页时，按 EPUB/HTML 规则寻找卷首文字的承载章节：
 * 该卷首个章节 → 全书后续第一个章节 → 全书最后一章。
 * 同一章可承载多个卷的 note；`extra-group` 不参与。
 */
export function buildPdfVolumeNotes(book: PdfBook): Map<string, PdfVolume[]> {
  const notes = new Map<string, PdfVolume[]>();
  const volumes = volumeList(book);
  const chapters = chapterList(book);
  if (chapters.length === 0) return notes;

  const volumeOrder = new Map(volumes.map((volume, index) => [volume.id, index]));
  const chapterVolumeOrder = chapters.map((chapter) => {
    const volumeId = chapter.volumeId ?? null;
    if (volumeId === null) return null;
    return volumeOrder.get(volumeId) ?? null;
  });
  const lastChapter = chapters[chapters.length - 1];

  volumes.forEach((volume, index) => {
    if (volume.kind !== "volume") return;
    if (!volume.lines || volume.lines.length === 0) return;

    let carrier = chapters.find((chapter) => (chapter.volumeId ?? null) === volume.id);
    if (!carrier) {
      carrier = chapters.find((_chapter, chapterIndex) => {
        const order = chapterVolumeOrder[chapterIndex];
        return order !== null && order >= index;
      });
    }
    if (!carrier) carrier = lastChapter;
    if (!carrier) return;

    const list = notes.get(carrier.id) ?? [];
    list.push(volume);
    notes.set(carrier.id, list);
  });

  return notes;
}

function buildTocEntries(book: PdfBook, blocks: PdfBlock[]): TocEntry[] {
  const volumeIds = new Set(volumeList(book).map((volume) => volume.id));
  const lastChapter = [...blocks].reverse().find((block) => block.kind === "chapter");
  const entries: TocEntry[] = [];

  blocks.forEach((block, index) => {
    if (block.kind === "volume") {
      if (block.hasPage) {
        entries.push({ title: block.volume.title, depth: 0, key: `v:${block.ordinal}` });
        return;
      }
      const next = blocks.slice(index + 1).find((item) => item.kind === "chapter");
      const fallback =
        lastChapter && lastChapter.kind === "chapter" ? lastChapter.entry.number : null;
      const chapterNumber =
        next && next.kind === "chapter" ? next.entry.number : fallback;
      if (chapterNumber !== null) {
        entries.push({ title: block.volume.title, depth: 0, key: `c:${chapterNumber}` });
      }
      return;
    }
    const entry = block.entry;
    const inVolume =
      entry.chapter.volumeId !== null &&
      entry.chapter.volumeId !== undefined &&
      volumeIds.has(entry.chapter.volumeId);
    entries.push({
      title: entry.chapter.title,
      depth: inVolume ? 1 : 0,
      key: `c:${entry.number}`,
    });
  });

  return entries;
}

function drawCover(state: RenderState, buffer: Buffer): void {
  startPage(state, { cover: true });
  const boxWidth = state.page.width - COVER_MARGIN * 2;
  const boxHeight = state.page.height - COVER_MARGIN * 2;
  try {
    state.doc.image(buffer, COVER_MARGIN, COVER_MARGIN, {
      fit: [boxWidth, boxHeight],
      align: "center",
      valign: "center",
    });
  } catch {
    // 预览图已通过 sharp 校验；这里兜底 pdfkit 解码失败，不中断导出。
  }
}

function drawDescriptionPage(state: RenderState, meta: PdfMeta): void {
  const description = meta.description?.trim();
  if (!description) return;
  startPage(state);
  const elements = state.layout.typography.elements;
  const headingStyle = elements.tocTitle;
  const headingSize = BASE_FONT_SIZE * headingStyle.fontSize;
  let y = state.margin + headingStyle.marginTop * headingSize;
  y = drawParagraph(
    state,
    labelFor(meta.language, "简介", "Description"),
    headingStyle,
    state.margin,
    contentWidth(state),
    y,
  );
  y += headingStyle.marginBottom * headingSize;

  const introStyle = elements.intro;
  const introSize = BASE_FONT_SIZE * introStyle.fontSize;
  for (const rawLine of description.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    y = drawParagraph(state, line, introStyle, state.margin, contentWidth(state), y);
    y += introStyle.paragraphSpacing * introSize;
  }
}

/** 单行截断：先按 `widthOfString` 测量，放不下时手绘省略号。 */
function fitOneLine(doc: PDFKit.PDFDocument, text: string, maxWidth: number): string {
  if (doc.widthOfString(text) <= maxWidth) return text;
  const ellipsis = "…";
  let kept = "";
  for (const char of Array.from(text)) {
    if (doc.widthOfString(kept + char + ellipsis) > maxWidth) break;
    kept += char;
  }
  return kept.length > 0 ? `${kept}${ellipsis}` : ellipsis;
}

function drawTocPage(
  state: RenderState,
  entries: TocEntry[],
  language: string | undefined,
  pages: Map<string, number>,
): void {
  startPage(state);
  const elements = state.layout.typography.elements;
  const titleStyle = elements.tocTitle;
  const titleSize = BASE_FONT_SIZE * titleStyle.fontSize;
  let y = state.margin + titleStyle.marginTop * titleSize;
  y = drawParagraph(
    state,
    labelFor(language, "目录", "Contents"),
    titleStyle,
    state.margin,
    contentWidth(state),
    y,
  );
  y += titleStyle.marginBottom * titleSize;

  const itemStyle = elements.tocItem;
  const role = roleForChoice(itemStyle.fontFamily);
  const font = state.fontSelection.aliases[role];
  const fontSize = BASE_FONT_SIZE * itemStyle.fontSize;
  const lineHeight = fontSize * Math.max(itemStyle.lineHeight, 1.5);
  const width = contentWidth(state);

  for (const entry of entries) {
    if (y + lineHeight > contentBottom(state)) {
      startPage(state);
      y = state.margin;
    }
    const indent = entry.depth * fontSize * 2;
    const numberLabel = pages.get(entry.key);
    const numberText = numberLabel === undefined ? "" : String(numberLabel);

    // 页码列固定用 Helvetica 绘制：不受 CJK 字体缺字影响，且便于导出后校验。
    state.doc.font("Helvetica").fontSize(fontSize);
    const reserved = state.doc.widthOfString("0000") + 8;
    const numberWidth = numberText ? state.doc.widthOfString(numberText) : 0;
    const textWidth = Math.max(width - indent - reserved, fontSize);

    state.doc.font(font).fontSize(fontSize).fillColor(itemStyle.color);
    // 先截断再手绘，绝不把 width + lineBreak:false 交给 pdfkit 自动换行。
    const title = fitOneLine(state.doc, entry.title, textWidth);
    // 直接把 goTo 交给 text()：注解矩形由 pdfkit 按实际排版宽度计算。
    state.doc.text(title, state.margin + indent, y, {
      lineBreak: false,
      ...(state.tocLinks ? { goTo: destinationForTocKey(entry.key) } : {}),
    });

    if (numberText) {
      state.doc.font("Helvetica").fontSize(fontSize).fillColor(itemStyle.color);
      state.doc.text(numberText, state.margin + width - numberWidth, y, {
        lineBreak: false,
      });
    }
    state.doc.y = y + lineHeight;
    y += lineHeight;
  }
}

function drawVolumePage(
  state: RenderState,
  volume: PdfVolume,
  ordinal: number,
  pages: Map<string, number>,
): void {
  startPage(state);
  pages.set(`v:${ordinal}`, state.pageCount);
  addPageDestination(state, "volume", ordinal);
  state.volumeNode = addBookmark(state, volume.title, null);
  state.bookmarkVolumeId = volume.id;

  const elements = state.layout.typography.elements;
  const titleStyle = elements.volumeTitle;
  const titleSize = BASE_FONT_SIZE * titleStyle.fontSize;
  let y = state.margin + contentHeight(state) * 0.22;
  y += titleStyle.marginTop * titleSize;
  y = drawParagraph(state, volume.title, titleStyle, state.margin, contentWidth(state), y);
  y += titleStyle.marginBottom * titleSize;

  const noteStyle = elements.volumeNote;
  for (const rawLine of volume.lines ?? []) {
    const line = rawLine.trim();
    if (!line) continue;
    y = drawParagraph(state, line, noteStyle, state.margin, contentWidth(state), y);
    y += noteStyle.paragraphSpacing * BASE_FONT_SIZE * noteStyle.fontSize;
  }
}

function drawVolumeNotes(
  state: RenderState,
  volumes: PdfVolume[],
  startY: number,
): number {
  const elements = state.layout.typography.elements;
  const titleStyle = elements.volumeTitle;
  const noteStyle = elements.volumeNote;
  let y = startY;
  for (const volume of volumes) {
    y = drawParagraph(state, volume.title, titleStyle, state.margin, contentWidth(state), y);
    y += titleStyle.marginBottom * BASE_FONT_SIZE * titleStyle.fontSize;
    for (const rawLine of volume.lines ?? []) {
      const line = rawLine.trim();
      if (!line) continue;
      y = drawParagraph(state, line, noteStyle, state.margin, contentWidth(state), y);
      y += noteStyle.paragraphSpacing * BASE_FONT_SIZE * noteStyle.fontSize;
    }
  }
  return y;
}

function drawChapterPage(
  state: RenderState,
  entry: PlannedChapter,
  volumeNotes: Map<string, PdfVolume[]>,
  volumeById: Map<string, PdfVolume>,
  includeVolumePages: boolean,
  pages: Map<string, number>,
): void {
  startPage(state);
  pages.set(`c:${entry.number}`, state.pageCount);
  addPageDestination(state, "chapter", entry.number);

  const volumeId = entry.chapter.volumeId ?? null;
  const volume = volumeId ? volumeById.get(volumeId) : undefined;

  if (includeVolumePages) {
    // 卷扉页已经创建了父节点；换卷（含番外分组）时回到根。
    if (volumeId !== state.bookmarkVolumeId) {
      state.volumeNode = null;
      state.bookmarkVolumeId = null;
    }
  } else if (volume && volume.kind === "volume") {
    // 默认书签两级：在该卷第一章页面创建卷级父节点。
    if (state.bookmarkVolumeId !== volume.id) {
      state.volumeNode = addBookmark(state, volume.title, null);
      state.bookmarkVolumeId = volume.id;
    }
  } else {
    state.volumeNode = null;
    state.bookmarkVolumeId = null;
  }
  addBookmark(state, entry.chapter.title, state.volumeNode);

  const elements = state.layout.typography.elements;
  const titleStyle = elements.chapterTitle;
  const titleSize = BASE_FONT_SIZE * titleStyle.fontSize;
  let y = state.margin + titleStyle.marginTop * titleSize;

  if (!includeVolumePages) {
    const notes = volumeNotes.get(entry.chapter.id);
    if (notes && notes.length > 0) {
      y = drawVolumeNotes(state, notes, y);
      y += titleSize * 0.6;
    }
  }

  y = drawParagraph(state, entry.chapter.title, titleStyle, state.margin, contentWidth(state), y);
  y += titleStyle.marginBottom * titleSize;

  const bodyStyle = elements.body;
  const bodySize = BASE_FONT_SIZE * bodyStyle.fontSize;
  for (const rawLine of entry.chapter.lines) {
    const line = rawLine.trim();
    if (!line) continue;
    y = drawParagraph(state, line, bodyStyle, state.margin, contentWidth(state), y, {
      indent: true,
    });
    y += bodyStyle.paragraphSpacing * bodySize;
  }
}

interface BuildOutput {
  buffer: Buffer;
  pageCount: number;
  pages: Map<string, number>;
  actualRoles: Record<PdfFontRole, PdfFontRole>;
}

interface PreparedImages {
  cover: Buffer | null;
  background: Buffer | null;
}

/** 生成一遍 PDF；`tocPages` 为空时用于测量，非空时用于写入目录页码。 */
function buildPdf(
  book: PdfBook,
  options: PdfOptions,
  fonts: PdfFonts,
  layout: PdfLayout,
  tocPages: Map<string, number>,
  images: PreparedImages,
): Promise<BuildOutput> {
  const pageSize = PAGE_SIZES[options.pageSize ?? "A4"] ?? PAGE_SIZES.A4;
  const margin = MARGINS[options.margin ?? "normal"] ?? MARGINS.normal;
  const doc = new PDFDocument({
    autoFirstPage: false,
    size: [pageSize.width, pageSize.height],
    margins: { top: margin, bottom: margin, left: margin, right: margin },
    info: {
      Title: bookTitle(book.meta),
      Author: book.meta.author ?? "",
      Creator: "txt2book",
    },
  });

  const fontSelection = registerFonts(doc, fonts);
  const state: RenderState = {
    doc,
    fontSelection,
    layout,
    page: pageSize,
    margin,
    pageNumbers: options.pageNumbers ?? true,
    bookmarks: options.bookmarks ?? true,
    tocLinks: options.includeTocPage ?? false,
    background: images.background,
    pages: new Map(),
    pageCount: 0,
    coverPage: null,
    volumeNode: null,
    bookmarkVolumeId: null,
  };

  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  if ((options.includeCover ?? true) && images.cover) {
    drawCover(state, images.cover);
  }

  if (options.includeDescription ?? false) {
    drawDescriptionPage(state, book.meta);
  }

  const includeVolumePages = options.includeVolumePages ?? false;
  const blocks = planPdfBlocks(book, includeVolumePages);
  if (options.includeTocPage ?? false) {
    drawTocPage(state, buildTocEntries(book, blocks), book.meta.language, tocPages);
  }

  const volumeNotes = includeVolumePages ? new Map<string, PdfVolume[]>() : buildPdfVolumeNotes(book);
  const volumeById = new Map(volumeList(book).map((volume) => [volume.id, volume]));

  for (const block of blocks) {
    if (block.kind === "volume") {
      if (block.hasPage) drawVolumePage(state, block.volume, block.ordinal, state.pages);
      continue;
    }
    drawChapterPage(
      state,
      block.entry,
      volumeNotes,
      volumeById,
      includeVolumePages,
      state.pages,
    );
  }

  // 空书也要生成一页，避免输出 0 页 PDF；不再输出书名/作者页。
  if (state.pageCount === 0) {
    startPage(state);
  }

  doc.end();

  return finished.then((buffer) => ({
    buffer,
    pageCount: state.pageCount,
    pages: state.pages,
    actualRoles: fontSelection.actualRoles,
  }));
}

export interface PdfRenderDeps {
  /** 测试或调用方可注入字体；`null` 表示明确没有可用字体。 */
  fonts?: PdfFonts | null;
}

/**
 * 生成 PDF：封面 → 简介（可选）→ 目录（可选）→ 卷扉页（可选）→ 章节。
 * 两遍排版保证目录页码与正文一致。
 */
export async function renderPdf(
  book: PdfBook,
  options: PdfOptions = {},
  deps: PdfRenderDeps = {},
): Promise<PdfResult> {
  assertPdfLimits(book);

  const fonts = deps.fonts === undefined ? resolvePdfFonts() : deps.fonts;
  if (!fonts) throw new PdfFontError();

  const layout = normalizePdfLayout(options.layout, options.themeId);
  const bodyRole = roleForChoice(layout.typography.elements.body.fontFamily);

  // eink 与 EPUB/HTML 一致：不绘制自定义背景；图片先做完整解码校验。
  const isEink = options.themeId === "eink";
  const customBackground =
    !isEink && layout.background?.kind === "custom"
      ? layout.background.custom.data
      : undefined;

  const [cover, background] = await Promise.all([
    book.cover ? prepareImage(book.cover.png) : Promise.resolve(null),
    customBackground === undefined ? Promise.resolve(null) : prepareImage(customBackground),
  ]);
  const images: PreparedImages = { cover, background };

  // 没有目录页时不需要测量遍，避免重复渲染。
  let final: BuildOutput;
  if (options.includeTocPage ?? false) {
    const measured = await buildPdf(book, options, fonts, layout, new Map(), images);
    final = await buildPdf(book, options, fonts, layout, measured.pages, images);
  } else {
    final = await buildPdf(book, options, fonts, layout, new Map(), images);
  }

  return {
    buffer: final.buffer,
    pageCount: final.pageCount,
    // 字体加载失败并回退时，报告实际使用的角色。
    fontFamily: final.actualRoles[bodyRole],
  };
}
