import { ref, type Ref } from "vue";
import { parseChapters } from "../core/chapterParser";
import { loadRules, type ChapterRule } from "../core/customRules";
import { hasMeaningfulContent, preprocessLines } from "../core/preprocess";
import { decodeText } from "../core/textReader";
import type { BookMeta, BookSource, CoverAsset, Language } from "../types/book";
import type { BookSession } from "./useBookSession";

/** 界面上可选的源文件编码。`auto` 交给 jschardet 判断，其余为手动覆盖。 */
export type SourceEncoding = "auto" | "utf-8" | "gb18030" | "big5" | "utf-16le";

export const ENCODING_OPTIONS: ReadonlyArray<{ value: SourceEncoding; label: string }> = [
  { value: "auto", label: "自动识别" },
  { value: "utf-8", label: "UTF-8" },
  { value: "gb18030", label: "GB18030" },
  { value: "big5", label: "Big5" },
  { value: "utf-16le", label: "UTF-16LE" },
];

/** `importBytes` 的可选覆盖项；缺省字段沿用本地导入的默认值。 */
export interface ImportBytesOptions {
  /** 覆盖默认的书名、作者与语言；`language` 同时决定章节兜底标题的语言。 */
  meta?: Partial<BookMeta>;
  /** 外部来源；传入时强制使用 `meta.title` 作为书名。 */
  source?: BookSource | null;
  /** 显式传入时覆盖封面，`null` 清空旧封面；缺省沿用当前封面。 */
  cover?: CoverAsset | null;
}

export interface UseImport {
  /** 最近一次成功导入的文件名（含扩展名），未导入时为空串。 */
  fileName: Ref<string>;
  /** 自动识别出的编码；手动选择编码时为 `null`。 */
  detectedEncoding: Ref<string | null>;
  /** 实际解码使用的编码，未导入时为空串。 */
  usedEncoding: Ref<string>;
  /** 原始字节，重新解析时直接复用，避免再次读取文件。 */
  rawBytes: Ref<Uint8Array | null>;
  /** 当前解析使用的规则，可在导入前替换。 */
  rules: Ref<ChapterRule[]>;
  busy: Ref<boolean>;
  error: Ref<string>;
  importFile(file: File, encoding: SourceEncoding): Promise<boolean>;
  /** 从已读取的字节导入，供 calibre-web 等外部来源复用同一套解析流程。 */
  importBytes(
    bytes: Uint8Array,
    name: string,
    encoding: SourceEncoding,
    options?: ImportBytesOptions,
  ): Promise<boolean>;
  reparse(encoding: SourceEncoding, rules: ChapterRule[]): Promise<void>;
}

const LANGUAGE = "zh-CN" as const;
const UNTITLED = "未命名";
const EMPTY_ERROR = "文件中没有可解析的正文，请检查文件内容或切换编码后重试。";
const READ_ERROR = "读取文件失败，请重新选择文件。";
const NO_FILE_ERROR = "请先导入 TXT 文件。";
const PARSE_ERROR = "解析失败，请检查编码与章节规则后重试。";

/** 只去掉最后一个扩展名，保留书名中的其他点号。 */
function titleFromFileName(name: string): string {
  const base = name.replace(/\.[^.]+$/, "").trim();
  return base || name.trim() || UNTITLED;
}

/** 解析与解码抛出的中文提示可以直接展示，其余异常统一换成安全的兜底文案。 */
function errorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && /[\u4e00-\u9fa5]/.test(cause.message)) return cause.message;
  return fallback;
}

/**
 * TXT 导入与重新解析。
 *
 * 会话由调用方传入，组件与测试共享同一份书籍状态。
 * 原始字节只在成功导入时写入，`reparse` 复用它重新解码；
 * 导入或解析失败时保留当前书籍，避免误操作清空用户已编辑的内容。
 */
export function useImport(session: Pick<BookSession, "loadBook" | "book">): UseImport {
  const fileName = ref("");
  const detectedEncoding = ref<string | null>(null);
  const usedEncoding = ref("");
  const rawBytes = ref<Uint8Array | null>(null);
  const rules = ref<ChapterRule[]>(loadRules());
  const busy = ref(false);
  const error = ref("");

  /** 解码并解析；正文为空时抛错，由调用方转成中文提示且不覆盖现有书籍。 */
  function parseText(text: string, ruleList: ChapterRule[], language: Language) {
    const lines = preprocessLines(text);
    if (!hasMeaningfulContent(lines)) throw new Error(EMPTY_ERROR);
    return parseChapters(lines, language, ruleList);
  }

  /**
   * 写入一次导入结果。调用方负责 busy/error 状态；
   * 解码或解析失败时抛错，现有书籍保持不变。
   */
  function ingest(
    bytes: Uint8Array,
    name: string,
    encoding: SourceEncoding,
    options: ImportBytesOptions = {},
  ): void {
    const decoded = decodeText(bytes, encoding);
    const language = options.meta?.language ?? LANGUAGE;
    const parsed = parseText(decoded.text, rules.value, language);

    const finalName = name || UNTITLED;
    const meta: BookMeta = {
      title: titleFromFileName(finalName),
      author: "",
      language,
      ...options.meta,
    };
    const source = options.source ?? null;

    fileName.value = finalName;
    detectedEncoding.value = decoded.detectedEncoding;
    usedEncoding.value = decoded.usedEncoding;
    rawBytes.value = bytes;
    session.loadBook(meta, parsed, meta.title, {
      source,
      ...(options.cover !== undefined ? { cover: options.cover } : {}),
      ...(source ? { forceTitle: true } : {}),
    });
  }

  /** `ingest` 的错误收口：中文提示直接展示，其余异常统一换成兜底文案。 */
  function ingestSafely(
    bytes: Uint8Array,
    name: string,
    encoding: SourceEncoding,
    options?: ImportBytesOptions,
  ): boolean {
    try {
      ingest(bytes, name, encoding, options);
      return true;
    } catch (cause) {
      error.value = errorMessage(cause, PARSE_ERROR);
      return false;
    }
  }

  async function importFile(file: File, encoding: SourceEncoding): Promise<boolean> {
    if (busy.value) return false;
    busy.value = true;
    error.value = "";
    try {
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await file.arrayBuffer());
      } catch (cause) {
        error.value = errorMessage(cause, READ_ERROR);
        return false;
      }
      return ingestSafely(bytes, file.name || UNTITLED, encoding);
    } finally {
      busy.value = false;
    }
  }

  async function importBytes(
    bytes: Uint8Array,
    name: string,
    encoding: SourceEncoding,
    options: ImportBytesOptions = {},
  ): Promise<boolean> {
    if (busy.value) return false;
    busy.value = true;
    error.value = "";
    try {
      return ingestSafely(bytes, name, encoding, options);
    } finally {
      busy.value = false;
    }
  }

  /**
   * 重新解析只重建章节；作者、简介、语言属于用户编辑过的书籍信息，必须沿用当前值。
   * 有外部来源时书名也沿用当前值（来源书名可能经过用户编辑），否则仍交给
   * `loadBook` 的自动标题规则判断，传入当前文件名。
   */
  async function reparse(encoding: SourceEncoding, nextRules: ChapterRule[]): Promise<void> {
    if (busy.value) return;
    const bytes = rawBytes.value;
    if (!bytes) {
      error.value = NO_FILE_ERROR;
      return;
    }

    busy.value = true;
    error.value = "";
    try {
      const current = session.book.value;
      const source = current.source ?? null;
      const decoded = decodeText(bytes, encoding);
      const parsed = parseText(decoded.text, nextRules, current.meta.language);
      const meta: BookMeta = {
        ...current.meta,
        title: source ? current.meta.title : titleFromFileName(fileName.value),
      };

      rules.value = [...nextRules];
      detectedEncoding.value = decoded.detectedEncoding;
      usedEncoding.value = decoded.usedEncoding;
      session.loadBook(meta, parsed, meta.title, { source });
    } catch (cause) {
      error.value = errorMessage(cause, PARSE_ERROR);
    } finally {
      busy.value = false;
    }
  }

  return {
    fileName,
    detectedEncoding,
    usedEncoding,
    rawBytes,
    rules,
    busy,
    error,
    importFile,
    importBytes,
    reparse,
  };
}
