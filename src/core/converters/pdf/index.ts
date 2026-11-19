import type { BookModel, CoverAsset } from "../../../types/book";
import {
  api,
  type PdfExportBook,
  type PdfExportCover,
  type PdfExportLayout,
  type PdfExportPayload,
} from "../../api";
import { bytesToBase64 } from "../../base64";
import type { LayoutSettings } from "../../render/layout";
import {
  resolveConvertOptions,
  type BookConverter,
  type ConvertHooks,
  type ConvertOptions,
  type ExportProgress,
} from "../types";

export type { PdfExportPayload } from "../../api";

type PdfPageSize = "A4" | "A5";
type PdfMargin = "normal" | "narrow";

const PAGE_SIZES: readonly PdfPageSize[] = ["A4", "A5"];
const MARGINS: readonly PdfMargin[] = ["normal", "narrow"];

/** 兼容 `formatOptions` 里可能以字符串形式传入的布尔值。 */
function readBoolean(
  formatOptions: Record<string, boolean | string> | undefined,
  key: string,
  fallback: boolean,
): boolean {
  const value = formatOptions?.[key];
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  const normalized = value.trim().toLowerCase();
  return !["false", "0", "no", "off", ""].includes(normalized);
}

/** 只接受声明过的候选项，未知值回退默认值，避免把脏数据发给服务端。 */
function readChoice<T extends string>(
  formatOptions: Record<string, boolean | string> | undefined,
  key: string,
  choices: readonly T[],
  fallback: T,
): T {
  const value = formatOptions?.[key];
  return typeof value === "string" && (choices as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** 封面字节转 base64；返回新对象，不改动原 `book`。 */
function serializeCover(cover: CoverAsset): PdfExportCover {
  return { ...cover, png: bytesToBase64(cover.png) };
}

function serializeBook(book: BookModel): PdfExportBook {
  return {
    ...book,
    cover: book.cover ? serializeCover(book.cover) : null,
  };
}

/** 自定义背景字节转 base64；返回新对象，不改动原 `layout`。 */
function serializeLayout(layout: LayoutSettings): PdfExportLayout {
  const { background } = layout;
  if (background.kind !== "custom") return { ...layout, background };
  return {
    ...layout,
    background: {
      kind: "custom",
      custom: {
        ...background.custom,
        data: bytesToBase64(background.custom.data),
      },
    },
  };
}

/**
 * 生成 PDF：服务端 `pdfkit` 排版，前端只负责组装请求与下载。
 *
 * 选项同时以扁平字段和 `formatOptions` 发送：服务端按扁平字段读取
 * `pageSize` / `margin` / `pageNumbers` / `includeCover` / `bookmarks`，
 * `formatOptions` 保留原始选择便于以后扩展。`layout` 只放在顶层，避免两份配置。
 */
export async function buildPdf(
  book: BookModel,
  options: ConvertOptions = {},
  hooks?: ConvertHooks,
): Promise<Blob> {
  const report = (progress: ExportProgress): void => {
    hooks?.onProgress?.(progress);
  };
  // 先上报再序列化：即使请求体组装失败，UI 也知道导出已进入生成阶段。
  report({
    phase: "generating",
    percent: null,
    message: "正在生成 PDF，可能需要几十秒…",
  });

  const opts = resolveConvertOptions(options);
  const raw = opts.formatOptions ?? {};

  const pageSize = readChoice(raw, "pageSize", PAGE_SIZES, "A4");
  const margin = readChoice(raw, "margin", MARGINS, "normal");
  const pageNumbers = readBoolean(raw, "pageNumbers", true);
  const includeCover = readBoolean(raw, "includeCover", true);
  const includeToc = readBoolean(raw, "includeToc", true);
  const bookmarks = readBoolean(raw, "bookmarks", true);

  const formatOptions: Record<string, boolean | string> = {
    ...raw,
    pageSize,
    margin,
    pageNumbers,
    includeCover,
    includeToc,
    bookmarks,
  };

  const payload: PdfExportPayload = {
    book: serializeBook(book),
    ...(options.layout ? { layout: serializeLayout(options.layout) } : {}),
    options: {
      ...formatOptions,
      pageSize,
      margin,
      pageNumbers,
      includeCover,
      includeToc,
      bookmarks,
      themeId: opts.themeId,
      // PDF 只有“目录页”一个开关，直接决定是否排入目录页。
      includeTocPage: includeToc,
      includeTitlePage: opts.includeTitlePage,
      includeVolumePages: opts.includeVolumePages,
      formatOptions,
    },
  };

  const blob = await api.exportPdf(payload);
  report({ phase: "downloading", percent: 100, message: "PDF 已生成，正在准备下载…" });
  return blob;
}

export const pdfConverter: BookConverter = {
  id: "pdf",
  label: "PDF",
  extension: "pdf",
  mimeType: "application/pdf",
  available: true,
  runtime: "server",
  options: [
    {
      key: "pageSize",
      label: "纸张",
      type: "select",
      defaultValue: "A4",
      hint: "A4 适合打印，A5 接近常见电子书开本。",
      choices: [
        { value: "A4", label: "A4" },
        { value: "A5", label: "A5" },
      ],
    },
    {
      key: "margin",
      label: "页边距",
      type: "select",
      defaultValue: "normal",
      hint: "标准边距留白更多；窄边距可容纳更多正文。",
      choices: [
        { value: "normal", label: "标准" },
        { value: "narrow", label: "窄" },
      ],
    },
    {
      key: "pageNumbers",
      label: "页码",
      type: "boolean",
      defaultValue: true,
      hint: "在每页底部显示页码。",
    },
    {
      key: "includeCover",
      label: "封面",
      type: "boolean",
      defaultValue: true,
      hint: "有封面时作为 PDF 首页；无封面时自动跳过。",
    },
    {
      key: "includeToc",
      label: "目录页",
      type: "boolean",
      defaultValue: true,
      hint: "在正文前插入带页码的可翻阅目录。",
    },
    {
      key: "bookmarks",
      label: "书签",
      type: "boolean",
      defaultValue: true,
      hint: "按卷与章生成 PDF 导航书签；部分阅读器可能不显示。",
    },
  ],
  convert: buildPdf,
};
