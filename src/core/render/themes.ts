import type { ThemeId } from "../../types/book";

export interface Theme {
  id: ThemeId;
  /** 主题面板显示的名称。 */
  label: string;
  /** 主题面板显示的一句话说明。 */
  description: string;
  /** 仅作用于 `.txt2book` 作用域内的 CSS。 */
  css: string;
  /** 场景分隔符的可见文案，同时作为 `.scene-break` 的装饰内容。 */
  sceneBreak: string;
}

/**
 * 结构性页面样式：封面页、书名页、卷扉页、目录页、隐藏标题锚点。
 * 所有主题共用同一套布局，只靠 `currentColor` 与继承的字体/配色跟随主题，
 * 避免为每套主题重复一遍、也避免依赖阅读器可能不支持的 CSS 变量。
 */
const STRUCTURAL_CSS = `
/* 结构性页面：封面 / 书名页 / 卷扉页 / 目录页 */
.txt2book.cover-page {
  min-height: 100vh;
  margin: 0;
  padding: 0;
}
.txt2book .cover {
  margin: 0 auto;
  padding: 0;
  text-align: center;
}
.txt2book .cover-image {
  display: block;
  max-width: 100%;
  max-height: 100vh;
  margin: 0 auto;
}
.txt2book .volume-page {
  padding-top: 20%;
  text-align: center;
}
.txt2book .description-page {
  padding-top: 12%;
  text-align: left;
}
.txt2book .description-title {
  margin: 0 0 1.4em;
  font-size: 1.5em;
  font-weight: 600;
  text-align: center;
  letter-spacing: 0.1em;
}
.txt2book .description-page p {
  margin: 0;
  text-indent: 0;
}
.txt2book .description-page p.paragraph-start {
  margin-top: 1em;
}
.txt2book .volume-title {
  margin: 0 0 1.2em;
  padding-bottom: 0.6em;
  border-bottom: 1px solid currentColor;
  font-size: 1.8em;
  font-weight: 600;
  letter-spacing: 0.15em;
}
.txt2book .volume-note {
  margin: 0 0 0.8em;
  text-align: left;
  text-indent: 2em;
}
/* 关闭卷扉页时，卷标题与卷首文字并入该卷第一章的顶部。 */
.txt2book .volume-note-block {
  margin: 0 0 2em;
  text-align: center;
}
.txt2book .toc-title {
  margin: 0 0 1.6em;
  font-size: 1.6em;
  font-weight: 600;
  text-align: center;
  letter-spacing: 0.1em;
}
.txt2book .toc-page ol {
  margin: 0;
  padding: 0;
  list-style: none;
}
.txt2book .toc-page li {
  margin: 0.4em 0;
}
.txt2book .toc-page a {
  color: inherit;
  text-decoration: none;
}
.txt2book .toc-page ol ol {
  margin: 0.4em 0 0 1.2em;
  font-size: 0.95em;
}
/* 连页预览：章节之间的分隔线，五套主题共用，只跟随 currentColor。 */
.txt2book hr.chapter-sep {
  width: 60%;
  height: 0;
  margin: 3em auto;
  border: 0;
  border-top: 1px solid currentColor;
  opacity: 0.4;
}
.txt2book .title-anchor {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}`.trim();

/** 场景分隔装饰：所有主题共用同一套盒模型，只替换字符与配色。 */
function sceneBreakCss(marker: string): string {
  return [
    ".txt2book hr.scene-break {",
    "  margin: 2em auto;",
    "  border: 0;",
    "  height: 1.5em;",
    "  text-align: center;",
    "  letter-spacing: 0.4em;",
    "  opacity: 0.6;",
    "}",
    `.txt2book hr.scene-break::after { content: "${marker}"; }`,
  ].join("\n");
}

function defineTheme(
  id: ThemeId,
  label: string,
  description: string,
  sceneBreak: string,
  css: string,
  /** 追加在共享结构性 CSS 之后，用于个别主题关闭装饰。 */
  structuralOverrides = "",
): Theme {
  return {
    id,
    label,
    description,
    sceneBreak,
    css: [css.trim(), sceneBreakCss(sceneBreak), STRUCTURAL_CSS, structuralOverrides.trim()]
      .filter(Boolean)
      .join("\n"),
  };
}

const minimal = defineTheme(
  "minimal",
  "素白",
  "无背景色、无衬线，适合快速浏览",
  "* * *",
  `
.txt2book {
  background: #ffffff;
  color: #1f2328;
  font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 16px;
  line-height: 1.8;
  padding: 2.5rem 1.5rem;
}
.txt2book p {
  margin: 0 0 0.6em;
  text-indent: 0;
}
.txt2book h1.chapter-title {
  margin: 0 0 1.6em;
  padding-bottom: 0.5em;
  border-bottom: 1px solid #e5e7eb;
  font-size: 1.5em;
  font-weight: 600;
  text-align: left;
  letter-spacing: 0;
}
`,
);

const paper = defineTheme(
  "paper",
  "纸墨",
  "米黄纸色、宋体、首行缩进，接近纸质书",
  "* * *",
  `
.txt2book {
  background: #f7f1e3;
  color: #3b342b;
  font-family: "Songti SC", SimSun, "Noto Serif SC", serif;
  font-size: 17px;
  line-height: 1.85;
  padding: 2.5rem 2rem;
}
.txt2book p {
  margin: 0 0 0.8em;
  text-indent: 2em;
}
.txt2book h1.chapter-title {
  margin: 0 0 1.8em;
  padding-top: 1.2em;
  border-top: 1px solid #c9b99a;
  font-size: 1.6em;
  font-weight: 600;
  text-align: center;
  letter-spacing: 0.1em;
}
`,
);

const night = defineTheme(
  "night",
  "夜读",
  "深灰底浅灰字、低对比，适合夜间阅读",
  "* * *",
  `
.txt2book {
  background: #23262b;
  color: #b9bec5;
  font-family: -apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif;
  font-size: 16px;
  line-height: 1.9;
  padding: 2.5rem 1.75rem;
}
.txt2book p {
  margin: 0 0 0.75em;
  text-indent: 0;
}
.txt2book h1.chapter-title {
  margin: 0 0 1.5em;
  padding-bottom: 0.5em;
  border-bottom: 1px solid #3a3f47;
  color: #9aa0a6;
  font-size: 1.35em;
  font-weight: 400;
  text-align: left;
}
`,
);

const classic = defineTheme(
  "classic",
  "古卷",
  "暖褐纸色、衬线、双线标题，古典排版",
  "❖",
  `
.txt2book {
  background: #f3e6d0;
  color: #4a3521;
  font-family: "Kaiti SC", KaiTi, "Noto Serif SC", Georgia, serif;
  font-size: 17px;
  line-height: 1.9;
  padding: 2.75rem 2rem;
}
.txt2book p {
  margin: 0 0 0.85em;
  text-indent: 2em;
}
.txt2book h1.chapter-title {
  margin: 0 0 2em;
  padding: 0.8em 0;
  border-top: 3px double #8a6a44;
  border-bottom: 3px double #8a6a44;
  font-size: 1.6em;
  font-weight: 600;
  text-align: center;
  letter-spacing: 0.15em;
}
`,
);

const eink = defineTheme(
  "eink",
  "墨水屏",
  "高对比、无背景图、适合电纸书",
  "* * *",
  `
.txt2book {
  background: #ffffff;
  color: #111111;
  font-family: "Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", SimSun, serif;
  font-size: 1.05em;
  line-height: 1.85;
  padding: 2.5rem 2rem;
}
.txt2book p {
  margin: 0 0 0.5em;
  text-indent: 2em;
}
.txt2book p.scene-break {
  margin: 1.5em 0;
  text-indent: 0;
  text-align: center;
  letter-spacing: 0.4em;
}
.txt2book h1.chapter-title {
  margin: 0 0 1.6em;
  font-size: 1.5em;
  font-weight: 600;
  text-align: center;
  letter-spacing: 0.1em;
  page-break-before: always;
  break-before: page;
}
`,
  `
/* 墨水屏无装饰：卷扉页底线、连页章节分隔线和作者名半透明都会产生
   灰阶抖动与残影，这里统一关闭，只用字号、字重与留白区分层级。 */
.txt2book .volume-title {
  border-bottom: 0;
}
.txt2book hr.chapter-sep {
  border-top: 0;
  opacity: 1;
}
`,
);

export const themes: Record<ThemeId, Theme> = {
  minimal,
  paper,
  night,
  classic,
  eink,
};

/** 默认主题：纸墨。预览与导出都以它兜底。 */
export const DEFAULT_THEME_ID: ThemeId = "paper";
