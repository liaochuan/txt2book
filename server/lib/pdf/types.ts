/**
 * PDF 导出使用的最小数据结构。
 *
 * 服务端不能 import 前端 `src/`，因此这里定义与 `BookModel` / `LayoutSettings`
 * 结构兼容的类型；请求体经 JSON 序列化后，字节数组可能是 `number[]`、
 * 数字键对象或 base64 字符串，统一用 `PdfByteSource` 覆盖。
 */

/** 字节来源：前端 `Uint8Array`、JSON 后的数组/对象或 base64 字符串。 */
export type PdfByteSource =
  | Uint8Array
  | ArrayBuffer
  | number[]
  | string
  | Record<string, number>;

export interface PdfChapter {
  id: string;
  title: string;
  originalTitle?: string;
  kind?: string;
  lines: string[];
  volumeId?: string | null;
}

export interface PdfVolume {
  id: string;
  title: string;
  originalTitle?: string;
  kind?: string;
  lines?: string[];
}

export interface PdfMeta {
  title: string;
  author?: string;
  language?: string;
  description?: string;
}

export interface PdfCover {
  /** 封面 PNG 字节（浏览器端已统一转为 PNG）。 */
  png: PdfByteSource;
  width?: number;
  height?: number;
  sourceName?: string;
}

export interface PdfBook {
  meta: PdfMeta;
  volumes?: PdfVolume[];
  chapters: PdfChapter[];
  cover?: PdfCover | null;
}

export type PdfPageSize = "A4" | "A5";
export type PdfMargin = "normal" | "narrow";
export type PdfAlign = "left" | "center" | "right" | "justify";
export type PdfFontChoice = "serif" | "sans" | "song" | "hei" | "kai";

export interface PdfElementStyle {
  fontFamily: PdfFontChoice;
  /** em，服务端按基准 12pt 换算 */
  fontSize: number;
  lineHeight: number;
  /** em，正文段间距 */
  paragraphSpacing: number;
  /** em，正文首行缩进 */
  textIndent: number;
  align: PdfAlign;
  /** #rrggbb */
  color: string;
  /** em，标题上留白 */
  marginTop: number;
  /** em，标题下留白 / 结构性页面的段后距 */
  marginBottom: number;
}

export type PdfElementKey =
  | "chapterTitle"
  | "body"
  | "volumeTitle"
  | "volumeNote"
  | "intro"
  | "tocTitle"
  | "tocItem";

export interface PdfTypography {
  version: 1;
  elements: Record<PdfElementKey, PdfElementStyle>;
}

export interface PdfCustomBackground {
  data: PdfByteSource;
  mimeType: "image/jpeg" | "image/png";
  width?: number;
  height?: number;
  fileName?: string;
}

export interface PdfLayout {
  typography: PdfTypography;
  /** 预设纹理在 PDF 中忽略，只有 `custom` 会以 8% 不透明度铺底。 */
  background?: PdfBackground;
}

export type PdfBackground =
  | { kind: "none"; presetId?: undefined; custom?: undefined }
  | { kind: "preset"; presetId?: string; custom?: undefined }
  | { kind: "custom"; presetId?: undefined; custom: PdfCustomBackground };

export interface PdfOptions {
  pageSize?: PdfPageSize;
  margin?: PdfMargin;
  pageNumbers?: boolean;
  includeCover?: boolean;
  includeTocPage?: boolean;
  includeTitlePage?: boolean;
  includeVolumePages?: boolean;
  bookmarks?: boolean;
  themeId?: string;
  layout?: PdfLayout;
}

export interface PdfResult {
  buffer: Buffer;
  pageCount: number;
  /** 安全的字族标签（`serif` / `sans` / `kai`），不包含字体路径。 */
  fontFamily: string;
}

export interface PdfFontFile {
  path: string;
  /** TTC/DFont 集合中的字族名，pdfkit 注册时需要。 */
  family?: string;
}

export interface PdfFonts {
  serif: PdfFontFile;
  sans: PdfFontFile;
  kai: PdfFontFile;
}

/** 与 brief 中的 `FontFile` 命名兼容。 */
export type FontFile = PdfFontFile;

export type PdfFontRole = keyof PdfFonts;
