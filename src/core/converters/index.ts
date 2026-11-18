import { epubConverter } from "./epub";
import type { BookConverter, ConverterMeta } from "./types";

/**
 * 已注册的转换器，顺序即 UI 中的展示顺序。
 * 新增格式：在 `src/core/converters/<format>/` 实现 `BookConverter` 后追加到这里。
 */
const registrations: BookConverter[] = [epubConverter];

/** 按格式 id 取转换器，生成文件与下载时用。 */
export const converterRegistry: Record<string, BookConverter> = Object.fromEntries(
  registrations.map((converter) => [converter.id, converter]),
);

/** 供 UI 渲染格式列表的元信息；不暴露 `convert` 实现。 */
export function listConverters(): ConverterMeta[] {
  return registrations.map(({ id, label, extension, mimeType, available }) => ({
    id,
    label,
    extension,
    mimeType,
    available,
  }));
}
