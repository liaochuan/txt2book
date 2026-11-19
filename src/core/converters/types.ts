import type { BookModel, ThemeId } from "../../types/book";
import type { LayoutSettings } from "../render/layout";
import { DEFAULT_THEME_ID } from "../render/themes";

/** 转换器运行位置：浏览器端生成，或调用服务端接口生成。 */
export type ConverterRuntime = "browser" | "server";

/** 下拉选项的一个候选项。 */
export interface FormatOptionChoice {
  value: string;
  label: string;
}

/**
 * 由转换器元信息声明的格式专属选项。
 * `boolean` 渲染为复选框，`select` 渲染为下拉框（候选项来自 `choices`）。
 */
export interface FormatOption {
  key: string;
  label: string;
  type: "boolean" | "select";
  defaultValue: boolean | string;
  hint?: string;
  choices?: FormatOptionChoice[];
}

/** 导出选项；未提供的字段按默认值处理（目录页 / 书名页 / 卷扉页默认关闭）。 */
export interface ConvertOptions {
  themeId?: ThemeId;
  /** 是否把 `nav.xhtml` 作为可见目录页排进阅读顺序；关闭时仍生成，但 `linear="no"`。 */
  includeTocPage?: boolean;
  includeTitlePage?: boolean;
  /** 是否为每个卷生成卷扉页。 */
  includeVolumePages?: boolean;
  /** 高级排版与背景；未提供时各转换器按主题默认值处理。 */
  layout?: LayoutSettings;
  /** 格式专属选项；键由各转换器的 `options` 声明，值原样透传给转换器。 */
  formatOptions?: Record<string, boolean | string>;
}

export interface ConverterMeta {
  id: string;
  label: string;
  extension: string;
  mimeType: string;
  /** `false` 时 UI 显示“即将支持”。 */
  available: boolean;
  /** 缺省视为 `"browser"`（旧注册项不写也能用）。 */
  runtime?: ConverterRuntime;
  /** 该格式的专属导出选项；缺省表示没有。 */
  options?: FormatOption[];
}

/** 导出阶段：准备内容、生成文件、收尾写盘、等待下载。 */
export type ExportPhase = "preparing" | "generating" | "writing" | "downloading";

/** 一次导出进度；`percent` 为 null 表示无法确定进度。 */
export interface ExportProgress {
  phase: ExportPhase;
  /** 0–100；null 表示不确定进度。 */
  percent: number | null;
  message: string;
}

/** 转换器在关键阶段调用的进度回调；未提供时转换器不调用。 */
export interface ConvertHooks {
  onProgress?: (progress: ExportProgress) => void;
}

export interface BookConverter extends ConverterMeta {
  convert(book: BookModel, options?: ConvertOptions, hooks?: ConvertHooks): Promise<Blob>;
}

/** `resolveConvertOptions` 补齐的字段；`layout` 留给转换器按主题决定默认值。 */
export type ResolvedConvertOptions = Required<
  Pick<ConvertOptions, "themeId" | "includeTocPage" | "includeTitlePage" | "includeVolumePages">
> & {
  /** 仅在调用方提供时透传，未提供则保持缺省，避免影响既有 payload。 */
  formatOptions?: Record<string, boolean | string>;
};

/** 把可选字段补齐为确定的布尔值与主题 id；`formatOptions` 原样透传。 */
export function resolveConvertOptions(options: ConvertOptions = {}): ResolvedConvertOptions {
  const resolved: ResolvedConvertOptions = {
    themeId: options.themeId ?? DEFAULT_THEME_ID,
    includeTocPage: options.includeTocPage ?? false,
    includeTitlePage: options.includeTitlePage ?? false,
    includeVolumePages: options.includeVolumePages ?? false,
  };
  if (options.formatOptions) resolved.formatOptions = options.formatOptions;
  return resolved;
}
