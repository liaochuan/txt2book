# 增量设计：墨水屏主题、高级排版与卷扉页预览

日期：2026-11-18
状态：待确认
关联设计：`2026-11-17-txt2book-design.md`

## 1. 目标

在现有 txt2book 上增加：

1. 第 5 套排版主题「墨水屏」，面向 Kindle、掌阅、文石等电纸书。
2. 可选的「高级排版」：按元素（卷标题、卷首文字、章标题、正文、简介、目录）分别调整字体、字号、行高、段距、首行缩进、对齐、颜色、上下留白。
3. 背景图：内置纹理与自定义上传/粘贴两种来源；自定义图会嵌入 EPUB。
4. 卷扉页可在预览面板中单独查看（点击卷标题预览，箭头负责折叠/展开）。
5. 导出面板三个内容选项默认全部不勾选，并为每个选项补充说明文字。

## 2. 非目标

- 不引入在线字体文件（EPUB 体积与版权风险），只用系统字体栈。
- 不做分栏、竖排、首字下沉。
- 不保证所有阅读器渲染背景图（很多电纸书会忽略 `body` 背景），文档中说明。
- 高级排版不作用于登录页等应用界面，只作用于预览与 EPUB 内容。

## 3. 墨水屏主题

`ThemeId` 新增 `eink`，显示名「墨水屏」，描述「高对比、无背景图、适合电纸书」。

CSS 约束：

- 纯白底 `#ffffff`、近黑字 `#111111`，不使用灰色文字。
- 系统衬线字体栈（`"Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", SimSun, serif`）。
- `font-size: 1.05em`、`line-height: 1.85`、`p` 段距 `0.5em`、首行缩进 `2em`。
- 标题不做装饰线、不加背景、不加边框与阴影；章标题居中或左对齐跟随用户配置，默认居中。
- 场景分隔符使用纯文本 `* * *`，不使用 `hr` 装饰。
- `page-break-before: always` 于章标题，减少残页。
- 强制忽略背景图（即使高级排版里选了背景，墨水屏下也不输出 `background-image`），UI 给出提示。

## 4. 高级排版模型

### 4.1 数据结构

```ts
type FontChoice = "serif" | "sans" | "song" | "hei" | "kai";

interface ElementStyle {
  fontFamily: FontChoice;
  fontSize: number;       // em，0.8–1.8
  lineHeight: number;     // 1.2–2.6
  paragraphSpacing: number; // em，0–2
  textIndent: number;     // em，0–4
  align: "left" | "center" | "right" | "justify";
  color: string;          // #rrggbb
  marginTop: number;      // em，0–4
  marginBottom: number;   // em，0–4
}

type ElementKey =
  | "chapterTitle"   // 章标题
  | "body"           // 正文段落
  | "volumeTitle"    // 卷扉页标题
  | "volumeNote"     // 卷首文字（卷到章之间的文字）
  | "intro"          // 简介/书名页正文
  | "tocTitle"       // 目录页标题
  | "tocItem";       // 目录页条目

interface TypographyConfig {
  version: 1;
  elements: Record<ElementKey, ElementStyle>;
}

interface BackgroundConfig {
  kind: "none" | "preset" | "custom";
  presetId?: "paper" | "grid" | "dots" | "linen";
  custom?: { data: Uint8Array; mimeType: "image/jpeg" | "image/png"; width: number; height: number; fileName: string };
}

interface LayoutSettings {
  typography: TypographyConfig;
  background: BackgroundConfig;
}
```

- 每个主题一份 `LayoutSettings`，存 `localStorage`，key `txt2book.layout.<themeId>`，非法数据回退该主题默认值。
- 「恢复默认」按钮清除当前主题的覆盖。
- 高级排版面板默认折叠，展开后按元素分组；改动即时反映到预览。

### 4.2 作用范围

| 元素 | 选择器 | 说明 |
|---|---|---|
| 章标题 | `.chapter-title` | 章标题文字 |
| 正文 | `p` | 章正文段落 |
| 卷标题 | `.volume-title` | 卷扉页标题、以及关闭卷扉页后章节顶部的卷标题 |
| 卷首文字 | `.volume-note` | 卷标题与第一章之间的文字；默认居中 |
| 简介 | `.description-page p`、`.title-page p` | 简介/书名页正文 |
| 目录 | `.toc-page` | 目录页标题与条目 |

- 生成静态 CSS（不使用 CSS 变量），兼容旧阅读器。
- 颜色在墨水屏主题下仍可配置，但默认近黑；背景图被忽略。
- 高级排版只覆盖对应属性，不改变布局结构。

### 4.3 背景图

- 内置预设（纯 CSS，无文件）：
  - `paper`：米色纸纹（细斜纹叠加）。
  - `grid`：浅灰网格。
  - `dots`：浅灰点阵。
  - `linen`：亚麻纹理（交叉线）。
- 自定义：
  - 文件选择或剪贴板粘贴（`paste` 事件读取 `image/*`）。
  - 服务端用 sharp 转 JPEG（质量 82、最长边 1600px、应用 EXIF 旋转），透明图输出 PNG；前端持久化 base64，不再使用 `createImageBitmap` / `canvas`。限制输入 10MB。
  - 预览用 `data URL`；导出时写入 `OEBPS/images/background.<ext>` 并在 `theme.css` 生成 `body { background-image: url(...); background-size: cover; background-repeat: no-repeat; }`，同时加入 OPF manifest。
  - 内嵌图不参与封面 PNG 约束。
- 墨水屏主题：UI 禁用背景选择并显示「墨水屏主题不使用背景图」。

## 5. 卷扉页预览

### 5.1 交互

- 目录树中卷标题拆成两个可点击区域：箭头按钮只负责折叠/展开（`aria-expanded`），卷名按钮负责选中并预览该卷。
- 选中卷时：
  - 预览面板显示卷扉页：卷标题 + 卷首文字 + 该卷章节数提示。
  - 该卷在目录树中高亮（`aria-current`）。
  - 预览工具栏显示「卷 · 卷名」，提供「回到章节」按钮（回到该卷第一章）。
- 点击任意章节回到章节预览。
- 连页模式仍按 spine 顺序渲染，卷扉页已包含在内。

### 5.2 状态

- `useBookSession` 增加 `selectedVolumeId` 与 `selectVolume(id)`；`selectedChapterId` 与 `selectedVolumeId` 互斥。
- 删除卷/撤销后若选中的卷不存在，自动回退到第一章。

## 6. 导出内容选项

### 6.1 默认值

`includeTocPage`、`includeTitlePage`、`includeVolumePages` 默认全部 `false`（UI 与转换器默认值同步修改）。

### 6.2 选项说明

| 选项 | 说明文案 |
|---|---|
| 目录页 | 在正文前插入一页可翻阅的目录。关闭后阅读器自带的导航目录仍然可用，只是书里不出现目录页。 |
| 书名页 | 在封面后插入书名、作者与简介页。关闭后直接从正文开始，元数据仍会写入书籍信息。 |
| 卷扉页 | 为每个卷生成独立标题页，并展示卷首文字。关闭后卷首文字会以居中样式并入该卷第一章开头，不会丢失。 |

- 每个复选框下方显示说明，使用 `.option-hint` 样式。
- 三个选项都不勾选时导出：无目录页、无书名页、无卷扉页，卷首文字并入首章。
- 卷扉页关闭时，卷首文字使用 `.volume-note` 样式（应用卷首排版配置），而不是普通正文段落。

## 7. 预览与导出一致性

- `renderChapter` 与 `xhtml` 共用 `layoutCss(theme, settings)` 生成的 CSS。
- 预览的 iframe 文档注入同一份 CSS；背景图在预览中使用 data URL。
- EPUB 的 `theme.css` 为「主题基础 CSS + 高级排版 CSS + 背景规则」，保证效果一致。

## 8. 兼容与迁移

- 已有 `localStorage` 主题偏好不变；新增主题不改变默认值（仍为 `paper`）。
- 已有导出选项默认值从 true 改为 false，属于行为变更，README 更新说明。
- `ThemeId` 扩展为 5 项，所有断言 4 套主题的测试需同步更新。
- 旧书稿与旧 EPUB 不受影响。

## 9. 测试

| 范围 | 用例 |
|---|---|
| 主题 | 5 套主题键序；`eink` 无 `@font-face`、无背景图、关键 CSS 值 |
| 排版 CSS | 每个元素的覆盖生效、默认值、非法配置回退、墨水屏忽略背景 |
| 持久化 | 按主题保存/读取、损坏数据回退、恢复默认 |
| 背景 | 预设生成规则、自定义图缩放与格式、EPUB 内嵌与 manifest、无背景时不输出 |
| 卷预览 | 点卷名进入卷预览、点章节回到章节、删除卷后回退、折叠不受影响 |
| 导出默认值 | 三选项默认 false、说明文案渲染、关闭卷扉页时卷首文字带 `.volume-note` 并入首章 |
| 预览一致性 | 同一配置下预览 CSS 与 EPUB CSS 关键选择器一致 |

## 10. 验收标准

1. 主题选择器出现 5 套主题，墨水屏在电纸书上无背景、无装饰，字号与行距明显更舒适。
2. 高级排版可分别调整卷标题、卷首文字、章标题、正文、简介、目录；预览即时变化，导出的 EPUB 效果一致。
3. 选择内置纹理或上传图片后，预览显示背景，EPUB 内嵌对应图片；墨水屏主题下自动忽略。
4. 点击卷名预览卷扉页，箭头只折叠/展开；删除卷后预览自动回到章节。
5. 导出面板三个复选框默认不勾选，每项有说明；关闭卷扉页时卷首文字以居中样式出现在该卷第一章开头。
