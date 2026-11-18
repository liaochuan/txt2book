import { detect } from "jschardet";

export interface DecodedText {
  text: string;
  usedEncoding: string;
  detectedEncoding: string | null;
}

export interface ReadTextFileResult extends DecodedText {
  /** 原始字节，保留下来供用户切换编码后重新解码。 */
  bytes: Uint8Array;
}

/** 自动检测最多读取的字节数，避免大文件整本转成字符串。 */
const DETECT_SAMPLE_LIMIT = 1024 * 1024;
const CHUNK_SIZE = 0x8000;

/**
 * jschardet 识别结果 → TextDecoder 可用的编码名。
 * GB2312/GBK 都是 GB18030 的子集，统一按 gb18030 解码可覆盖生僻字。
 */
const ENCODING_ALIASES: Record<string, string> = {
  ascii: "utf-8",
  "us-ascii": "utf-8",
  utf8: "utf-8",
  gb2312: "gb18030",
  gbk: "gb18030",
  "x-gbk": "gb18030",
  gb18030: "gb18030",
  big5: "big5",
  "big5-hkscs": "big5",
  cp950: "big5",
  "utf-16": "utf-16le",
};

function normalizeEncoding(encoding: string): string {
  const key = encoding.trim().toLowerCase();
  return ENCODING_ALIASES[key] ?? key;
}

function createDecoder(encoding: string): TextDecoder {
  const label = normalizeEncoding(encoding);
  try {
    return new TextDecoder(label, { fatal: false });
  } catch {
    // 无法识别的编码名回退到 UTF-8，保证界面仍能给出结果。
    return new TextDecoder("utf-8", { fatal: false });
  }
}

function bytesToBinaryString(bytes: Uint8Array, limit: number): string {
  const end = Math.min(bytes.length, limit);
  let result = "";
  for (let offset = 0; offset < end; offset += CHUNK_SIZE) {
    const chunk = bytes.subarray(offset, Math.min(offset + CHUNK_SIZE, end));
    result += String.fromCharCode(...chunk);
  }
  return result;
}

function detectByBom(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return "UTF-8";
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return "UTF-16LE";
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return "UTF-16BE";
  }
  return null;
}

/** 返回 jschardet 的原始编码名，无法判断时返回 null。 */
function detectEncoding(bytes: Uint8Array): string | null {
  if (bytes.length === 0) {
    return null;
  }
  const bomEncoding = detectByBom(bytes);
  if (bomEncoding) {
    return bomEncoding;
  }
  try {
    const result = detect(bytesToBinaryString(bytes, DETECT_SAMPLE_LIMIT));
    return result?.encoding ?? null;
  } catch {
    return null;
  }
}

/**
 * 解码文本。`encoding` 为 `"auto"` 时自动识别，识别失败回退 UTF-8。
 * `detectedEncoding` 只在自动识别时有值，供界面提示用户当前判断。
 */
export function decodeText(bytes: Uint8Array, encoding: string | "auto"): DecodedText {
  const detectedEncoding = encoding === "auto" ? detectEncoding(bytes) : null;
  const decoder = createDecoder(encoding === "auto" ? (detectedEncoding ?? "utf-8") : encoding);
  return {
    text: decoder.decode(bytes),
    usedEncoding: decoder.encoding,
    detectedEncoding,
  };
}

/**
 * 读取 TXT 文件字节并解码，原始字节随结果返回，
 * 用户切换编码时可直接 `decodeText(result.bytes, nextEncoding)` 重新解码。
 */
export async function readTextFile(
  file: File,
  encoding: string | "auto" = "auto",
): Promise<ReadTextFileResult> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { ...decodeText(bytes, encoding), bytes };
}
