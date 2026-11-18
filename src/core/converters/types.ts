import type { BookModel, ThemeId } from "../../types/book";
import type { LayoutSettings } from "../render/layout";
import { DEFAULT_THEME_ID } from "../render/themes";

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
}

export interface ConverterMeta {
  id: string;
  label: string;
  extension: string;
  mimeType: string;
  /** `false` 时 UI 显示“即将支持”。 */
  available: boolean;
}

export interface BookConverter extends ConverterMeta {
  convert(book: BookModel, options?: ConvertOptions): Promise<Blob>;
}

/** `resolveConvertOptions` 补齐的字段；`layout` 留给转换器按主题决定默认值。 */
export type ResolvedConvertOptions = Required<
  Pick<ConvertOptions, "themeId" | "includeTocPage" | "includeTitlePage" | "includeVolumePages">
>;

/** 把可选字段补齐为确定的布尔值与主题 id。 */
export function resolveConvertOptions(options: ConvertOptions = {}): ResolvedConvertOptions {
  return {
    themeId: options.themeId ?? DEFAULT_THEME_ID,
    includeTocPage: options.includeTocPage ?? false,
    includeTitlePage: options.includeTitlePage ?? false,
    includeVolumePages: options.includeVolumePages ?? false,
  };
}
