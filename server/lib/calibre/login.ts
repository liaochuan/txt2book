/**
 * calibre-web 登录与上传所需的表单/CSRF 纯函数（设计文档 §4、§6.1）。
 *
 * 这里不发起请求，只负责：
 * - 从登录页 HTML 提取 Flask-WTF 的 CSRF token；
 * - 生成 `application/x-www-form-urlencoded` 登录体；
 * - 清洗 EPUB 上传文件名；
 * - 按 RFC 7578 组装 multipart 上传体。
 */

/** RFC 7578 / RFC 2046 的换行固定为 CRLF。 */
const CRLF = "\r\n";

/**
 * 文件名清洗后允许的最大字符数（不含 `.epub` 后缀）。
 * `.epub` 占 5 个字符，因此保留 119 个字符才能保证总长 ≤ 124。
 */
const MAX_FILENAME_LENGTH = 119;

/** 清洗后为空时使用的回退名（不含后缀）。 */
const FALLBACK_FILENAME = "book";

/** Windows 与各平台文件系统都不接受的字符。 */
const FORBIDDEN_FILENAME_CHARS = /[/\\:*?"<>|]/g;

/** 折叠空白（含制表、换行等）。 */
const WHITESPACE_RUN = /\s+/g;

/** 折叠空白后仍残留的控制字符（C0 + DEL + C1）。 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/** 首尾的点与空格（避免隐藏文件或 Windows 非法结尾）。 */
const EDGE_DOTS_AND_SPACES = /^[.\s]+|[.\s]+$/g;

/** `<input>` / `<meta>` 标签；允许引号内出现 `>`。 */
const INPUT_TAG_PATTERN = /<input\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const META_TAG_PATTERN = /<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const TEXTAREA_PATTERN = /<textarea\b(?:[^>"']|"[^"]*"|'[^']*')*>([\s\S]*?)<\/textarea>/gi;
const HTML_ENTITY_PATTERN = /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi;
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

/** 解码 calibre-web 表单里的常见 HTML 实体；未知实体保持原样。 */
function decodeHtmlEntities(value: string): string {
  return value.replace(HTML_ENTITY_PATTERN, (match, entity: string) => {
    const key = entity.toLowerCase();
    if (key.startsWith("#x")) {
      const code = Number.parseInt(key.slice(2), 16);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    if (key.startsWith("#")) {
      const code = Number.parseInt(key.slice(1), 10);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return NAMED_ENTITIES[key] ?? match;
  });
}

/** 独立解析标签属性：`name="v"`、`name='v'`、`name=v`（大小写不敏感）。 */
const ATTRIBUTE_PATTERN = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

/** 读取标签上某个属性；不存在返回 null，空值返回 `""`。 */
function readAttribute(tag: string, attribute: string): string | null {
  const wanted = attribute.toLowerCase();
  for (const match of tag.matchAll(ATTRIBUTE_PATTERN)) {
    if (match[1].toLowerCase() === wanted) {
      return match[2] ?? match[3] ?? match[4] ?? "";
    }
  }
  return null;
}

/**
 * 提取登录页的 CSRF token。
 *
 * 先扫描所有 `<input>`，再回退到 `<meta name="csrf_token">`；属性顺序与
 * 单双引号均不影响结果。返回值去掉首尾空白，找不到（或为空）返回 null。
 */
export function extractCsrfToken(html: string): string | null {
  for (const match of html.matchAll(INPUT_TAG_PATTERN)) {
    const tag = match[0];
    if (readAttribute(tag, "name")?.trim().toLowerCase() !== "csrf_token") continue;
    const token = readAttribute(tag, "value")?.trim() ?? "";
    if (token !== "") return token;
  }

  for (const match of html.matchAll(META_TAG_PATTERN)) {
    const tag = match[0];
    if (readAttribute(tag, "name")?.trim().toLowerCase() !== "csrf_token") continue;
    const token = readAttribute(tag, "content")?.trim() ?? "";
    if (token !== "") return token;
  }

  return null;
}

/**
 * 提取编辑页里需要在上传后原样回传的元数据字段。
 *
 * calibre-web 的 `/upload` 会走 `do_edit_book`：缺少 `comments` 时简介会变成
 * 字面量 “None”，缺少 identifier 字段时所有书号会被删除；缺少 authors 会直接
 * 抛 KeyError，缺少 rating 会清空评分。这里读取编辑表单的现有值，上传成功后
 * 再 POST 回 `/admin/book/<id>` 恢复。
 */
export function extractUploadMetadata(html: string): {
  found: boolean;
  fields: Record<string, string>;
} {
  const fields: Record<string, string> = {};
  // 编辑页的内联脚本也会拼接 identifier 输入框，必须先剔除，避免伪造空书号。
  const cleaned = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  for (const match of cleaned.matchAll(TEXTAREA_PATTERN)) {
    const tag = match[0].slice(0, match[0].indexOf(">") + 1);
    if (readAttribute(tag, "name")?.trim().toLowerCase() !== "comments") continue;
    fields.comments = decodeHtmlEntities(match[1] ?? "");
    break;
  }

  const identifiers = new Map<string, { type?: string; value?: string }>();
  for (const match of cleaned.matchAll(INPUT_TAG_PATTERN)) {
    const tag = match[0];
    const name = readAttribute(tag, "name")?.trim() ?? "";
    if (name === "" || readAttribute(tag, "value") === null) continue;
    const value = decodeHtmlEntities(readAttribute(tag, "value") ?? "");

    if (name === "authors") {
      fields.authors = value;
      continue;
    }
    if (name === "title") {
      // do_edit_book 在无 upload_formats 分支会读取 title_change，缺 title 会报错。
      fields.title = value;
      continue;
    }
    if (
      ["tags", "series", "series_index", "publisher", "languages", "rating"].includes(name) &&
      value.trim() !== ""
    ) {
      fields[name] = value;
      continue;
    }

    const identifier = /^identifier-(type|val)-([A-Za-z0-9_.-]+)$/i.exec(name);
    if (!identifier) continue;
    const [, kind, suffix] = identifier;
    if (!suffix) continue;
    const entry = identifiers.get(suffix) ?? {};
    if (kind?.toLowerCase() === "type") entry.type = value;
    else entry.value = value;
    identifiers.set(suffix, entry);
  }

  for (const [suffix, entry] of identifiers) {
    const type = entry.type?.trim() ?? "";
    const value = entry.value?.trim() ?? "";
    if (type === "" || value === "") continue;
    fields[`identifier-type-${suffix}`] = type;
    fields[`identifier-val-${suffix}`] = entry.value ?? "";
  }

  return {
    found: fields.comments !== undefined || fields.authors !== undefined,
    fields,
  };
}

/**
 * 生成登录表单体；字段顺序固定为 username、password、remember_me、csrf_token。
 * `URLSearchParams` 负责百分号编码（空格为 `+`）。
 */
export function buildLoginBody(username: string, password: string, csrf: string): string {
  return new URLSearchParams({
    username,
    password,
    remember_me: "on",
    csrf_token: csrf,
  }).toString();
}

/**
 * 清洗书名并追加 `.epub`。
 *
 * 去掉文件系统禁止字符与控制字符，压缩空白，去掉首尾点和空格；结果为空时
 * 回退为 `book`。先截断到 119 字符再追加 5 字符的 `.epub`，总长度 ≤ 124。
 */
export function sanitizeEpubFilename(title: string): string {
  let name = title
    .replace(FORBIDDEN_FILENAME_CHARS, "")
    .replace(WHITESPACE_RUN, " ")
    .replace(CONTROL_CHARS, "")
    .trim()
    .replace(EDGE_DOTS_AND_SPACES, "");

  if (name === "") name = FALLBACK_FILENAME;

  return `${name.slice(0, MAX_FILENAME_LENGTH)}.epub`;
}

/**
 * 转义 multipart 头部参数值，阻止 CR/LF 头注入，并避免引号提前闭合。
 */
function escapeDispositionValue(value: string): string {
  return value
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A")
    .replace(/"/g, "%22")
    .replace(/\\/g, "%5C");
}

export interface MultipartFilePart {
  /** 表单字段名，例如 `btn-upload-format`。 */
  field: string;
  /** 客户端文件名，例如 `书名.epub`。 */
  filename: string;
  /** 文件的 Content-Type。 */
  contentType: string;
  /** 文件字节。 */
  data: Buffer;
}

export interface MultipartBodyInput {
  boundary: string;
  /** 普通字段；按对象插入顺序输出。 */
  fields: Record<string, string>;
  /** 文件字段，始终排在普通字段之后。 */
  file: MultipartFilePart;
}

/**
 * 按 RFC 7578 组装 `multipart/form-data` 请求体。
 *
 * 普通字段按 `fields` 的插入顺序输出，文件字段固定最后；正文以
 * `--<boundary>--\r\n` 收尾。字段名与文件名中的 CR/LF 会被转义。
 */
export function buildMultipartBody(input: MultipartBodyInput): Buffer {
  const chunks: Buffer[] = [];
  const { boundary, fields, file } = input;

  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}${CRLF}` +
          `Content-Disposition: form-data; name="${escapeDispositionValue(name)}"${CRLF}` +
          `${CRLF}` +
          `${value}${CRLF}`,
        "utf8",
      ),
    );
  }

  chunks.push(
    Buffer.from(
      `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="${escapeDispositionValue(file.field)}"; ` +
        `filename="${escapeDispositionValue(file.filename)}"${CRLF}` +
        `Content-Type: ${file.contentType}${CRLF}` +
        `${CRLF}`,
      "utf8",
    ),
  );
  chunks.push(file.data);
  chunks.push(Buffer.from(`${CRLF}--${boundary}--${CRLF}`, "utf8"));

  return Buffer.concat(chunks);
}
