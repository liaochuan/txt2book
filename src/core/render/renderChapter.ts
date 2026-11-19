import type { Chapter, Volume } from "../../types/book";
import type { Theme } from "./themes";

export interface RenderChapterOptions {
  /** 是否输出可见的章节标题，默认 `true`。 */
  showTitle?: boolean;
}

const SCENE_BREAK_PATTERN =
  /^(?:[*＊]\s*){3,}$|^(?:[—－-]\s*){3,}$|^(?:[◇◆❖]\s*){3,}$/;

/** 预览文档的基础重置，保证主题 CSS 在不同浏览器里从同一起点出发。 */
const BASE_CSS = `
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { -webkit-text-size-adjust: 100%; }
img { max-width: 100%; height: auto; }
`.trim();

/** XML 1.0 不允许的控制字符（NUL、退格、垂直制表等），脏 TXT 里常见。 */
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/** 转义 XHTML 文本节点的五个特殊字符，并剔除 XML 1.0 非法控制字符。 */
function escapeXml(value: string): string {
  return value
    .replace(INVALID_XML_CHARS, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 判断一行是否为场景分隔符（`***`、`* * *`、`———`、`◇◇◇` 等）。 */
export function detectSceneBreak(line: string): boolean {
  const value = line.trim();
  if (!value) return false;
  return SCENE_BREAK_PATTERN.test(value);
}

/**
 * 渲染章节正文：返回可直接嵌入 XHTML 的 body 片段。
 * 结构对所有主题一致，主题只通过外层 `body.txt2book` 上的 CSS 生效；
 * `theme` 参数保留在签名里，方便预览与导出共用同一调用方式。
 * 空行不输出，段间距交给主题 CSS。
 * 墨水屏主题用纯文本段落代替 `hr`，避免依赖阅读器的 hr 装饰渲染。
 */
export function renderChapterBody(
  chapter: Chapter,
  theme: Theme,
  options: RenderChapterOptions = {},
): string {
  const parts: string[] = [];
  if (options.showTitle !== false) {
    parts.push(`<h1 class="chapter-title">${escapeXml(chapter.title)}</h1>`);
  }
  for (const rawLine of chapter.lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (detectSceneBreak(line)) {
      parts.push(
        theme.id === "eink"
          ? `<p class="scene-break">${escapeXml(theme.sceneBreak)}</p>`
          : '<hr class="scene-break"/>',
      );
      continue;
    }
    parts.push(`<p>${escapeXml(line)}</p>`);
  }
  return parts.join("\n");
}

export interface RenderVolumeOptions {
  /** 输出到卷扉页 section 上的 id；HTML 单文件目录用它做锚点。 */
  id?: string;
}

/**
 * 卷扉页正文：与 EPUB 的 `volumeDocument` 保持同一结构，
 * 供连页预览按 spine 顺序插入卷标题与卷首文字。
 */
export function renderVolumeBody(volume: Volume, options: RenderVolumeOptions = {}): string {
  const id = options.id ? ` id="${escapeXml(options.id)}"` : "";
  const parts: string[] = [
    `<section class="volume-page"${id}>`,
    `<h1 class="volume-title">${escapeXml(volume.title)}</h1>`,
  ];
  for (const rawLine of volume.lines ?? []) {
    const line = rawLine.trim();
    if (!line) continue;
    parts.push(`<p class="volume-note">${escapeXml(line)}</p>`);
  }
  parts.push("</section>");
  return parts.join("\n");
}

/** 渲染 iframe `srcdoc` 使用的完整 HTML 预览文档。 */
export function renderPreviewDocument(
  chapter: Chapter,
  theme: Theme,
  options: { extraCss?: string } = {},
): string {
  return renderDocumentShell(chapter.title, theme, renderChapterBody(chapter, theme), options);
}

export interface RenderVolumePreviewOptions {
  extraCss?: string;
}

/**
 * 卷扉页预览文档：与章节预览共用文档壳、主题 CSS 与高级排版 CSS，
 * 只把正文替换为卷标题与卷首文字。
 */
export function renderVolumePreviewDocument(
  volume: Volume,
  theme: Theme,
  options: RenderVolumePreviewOptions = {},
): string {
  return renderDocumentShell(volume.title, theme, renderVolumeBody(volume), options);
}

/** 章节页与卷扉页共用的 HTML 文档壳。 */
function renderDocumentShell(
  documentTitle: string,
  theme: Theme,
  body: string,
  options: { extraCss?: string },
): string {
  const extra = options.extraCss?.trim() ?? "";
  return [
    "<!DOCTYPE html>",
    "<html>",
    "<head>",
    '<meta charset="utf-8"/>',
    '<meta name="viewport" content="width=device-width, initial-scale=1"/>',
    `<title>${escapeXml(documentTitle)}</title>`,
    `<style>${BASE_CSS}\n${theme.css}${extra ? `\n${extra}` : ""}</style>`,
    "</head>",
    '<body class="txt2book">',
    body,
    "</body>",
    "</html>",
  ].join("\n");
}
