# 增量设计：HTML / PDF / TXT 导出

日期：2026-11-18
状态：已确认（PDF 采用服务端 pdfkit 手动排版）

## 1. 目标

在现有 EPUB 转换器之外增加：

1. **单文件 HTML**：一个 `.html` 包含主题、排版、封面、背景、书名页、简介、卷扉页与可点击目录，可离线用浏览器打开。
2. **PDF**：服务端 `pdfkit` 手动排版，支持 A4/A5、页边距、页码、封面、目录页与书签，中文字体从服务端固定路径解析。
3. **TXT（整理版）**：UTF-8 无 BOM，卷/章标题独占一行，保留正文段落，可选简介与番外分组标题。

三个格式都通过现有 `BookConverter` 注册表接入，UI 不写死格式。

## 2. 非目标

- PDF 不追求与网页预览 100% 像素级一致；CSS 渐变背景、圆角、阴影等网页效果不进入 PDF。
- 不做 MOBI/AZW3/DOCX。
- 不引入浏览器端 PDF 生成或 headless Chromium。

## 3. 转换器抽象

`src/core/converters/types.ts` 扩展：

```ts
export type ConverterRuntime = "browser" | "server";

export interface FormatOptionChoice {
  value: string;
  label: string;
}

export interface FormatOption {
  key: string;
  label: string;
  type: "boolean" | "select";
  defaultValue: boolean | string;
  hint?: string;
  choices?: FormatOptionChoice[];
}

export interface ConverterMeta {
  id: string;
  label: string;
  extension: string;
  mimeType: string;
  available: boolean;
  runtime: ConverterRuntime;
  options?: FormatOption[];
}

export interface ConvertOptions {
  themeId?: ThemeId;
  layout?: LayoutSettings;
  includeTocPage?: boolean;
  includeTitlePage?: boolean;
  includeVolumePages?: boolean;
  formatOptions?: Record<string, boolean | string>;
}
```

- `runtime: "server"` 的转换器在前端的 `convert()` 内部调用服务端接口。
- `ExportPanel` 根据所选转换器的 `options` 动态渲染选项，默认值来自 `defaultValue`，最终放入 `formatOptions`。

## 4. 单文件 HTML

`src/core/converters/html/index.ts`：

- 使用 `themes[themeId].css + layoutCss(themeId, layout, { backgroundSrc })` 作为内联样式。
- 结构：`<header class="cover-page">`（有封面时）、书名页（可选）、简介页、目录页（可选，锚点链接）、卷扉页（可选）、章节。
- 章节正文复用 `renderChapterBody`，卷页复用 `renderVolumeBody`，确保与预览一致。
- 封面与自定义背景转 `data:` URL 内联；预设背景由 CSS 渐变生成。
- 目录条目是 `<a href="#chapter-N">`，不使用脚本。
- 输出 `text/html`，文件名 `<title>.html`。

## 5. TXT（整理版）

`src/core/converters/txt/index.ts`：

- 纯文本，UTF-8 无 BOM，行尾 `\n`。
- 章节标题独占一行，前后各一个空行；正文行原样保留（trim 行尾），连续空行折叠为最多一个。
- 卷标题独占一行；`番外` 分组输出“番外”标题。
- 选项：
  - `includeIntro`（默认 true）：是否输出“简介”。
  - `includeVolumeTitles`（默认 true）：是否输出卷标题。
  - `includeTitlePage` 复用于是否在开头输出书名/作者。

## 6. PDF（服务端）

### 6.1 模块

```text
server/lib/pdf/
  fonts.ts      字体候选路径解析与注册
  text.ts       中文断行、标点避头尾、段落测量
  render.ts     文档结构、分页、页眉页脚、书签
  types.ts      PdfOptions / PdfResult
server/routes/export.ts   POST /api/export/pdf
```

### 6.2 字体

- 顺序：`PDF_FONT_PATH`（+ `PDF_FONT_FAMILY`）→ 平台候选：
  - Windows：`C:\Windows\Fonts\simsun.ttc`（SimSun）、`simhei.ttf`、`simkai.ttf`。
  - Linux：`/usr/share/fonts/noto/NotoSerifCJK-Regular.ttc`、`NotoSansCJK-Regular.ttc`。
  - macOS：`/System/Library/Fonts/Songti.ttc`、`/System/Library/Fonts/PingFang.ttc`。
- 字体选择映射：宋体/衬线 → Serif；黑体/无衬线 → Sans；楷体 → Kai。缺失时回退第一个可用字体，并在响应头 `X-PDF-Font` 中记录实际字族（不泄漏路径）。
- 找不到任何中文字体时返回 500 `PDF_FONT_MISSING`，文案提示安装 Noto CJK 或设置 `PDF_FONT_PATH`。

### 6.3 排版

- 页面：A4（595×842pt）/ A5（420×595pt），标准边距 56pt / 窄边距 36pt。
- 元素顺序与 EPUB spine 一致：封面 → 书名页（可选）→ 简介页 → 目录页（可选）→ 卷扉页（可选）→ 章节。
- 高级排版映射：字号（em × 基准 12pt）、行高、段距、首行缩进、对齐、颜色；标题上下留白。
- 中文断行：按字符宽度累加，禁止行首出现 `、。，．！？：；）】》」』…—`，禁止行尾出现 `（【《「『`。
- 页脚页码；目录页带真实页码（两遍排版：先测量，再写入）。
- 书签：卷 → 章 两级。
- 自定义背景图：以 8% 不透明度铺满页面后绘制文字；预设 CSS 纹理不进入 PDF。
- 封面使用原图按比例缩放居中。

### 6.4 接口与限制

`POST /api/export/pdf`：

- 请求 JSON：`{ book, layout, options }`，`book` 与前端 `BookModel` 同构。
- 认证：由现有全局守卫保护。
- `bodyLimit: 20MB`。
- 校验：章节数 ≤ 2000，单章字符 ≤ 200 万，总字符 ≤ 2000 万，失败返回 400。
- 并发：同时只允许 1 个 PDF 任务，超出返回 429。
- 超时：60 秒；超时返回 504（任务继续占位直到结束）。
- 限流：按 IP 6 次/分钟。
- 错误统一 `{error:{code,message}}`，中文文案，不泄露字体路径。

## 7. 前端接入

- `src/core/api.ts` 增加 `exportPdf(payload, signal?)`。
- `src/core/converters/pdf/index.ts` 实现 `BookConverter`（`runtime: "server"`），调用 `api.exportPdf`。
- `ExportPanel` 选中 PDF 时显示：纸张（A4/A5）、页边距（标准/窄）、页码、封面、目录页、书签。
- 选中 HTML/TXT 时显示各自选项；保持现有三个内容选项。
- 导出按钮的 loading 文案区分“正在生成 PDF”。

## 8. 安全

- PDF 接口新增 CPU/内存消耗面：已用鉴权、20MB body、数量上限、并发 1、限流、60s 超时缓解。
- 字体路径只来自固定候选与环境变量，不接受请求参数。
- 文本由 pdfkit 绘制，不执行 HTML/脚本。
- Docker 建议 `mem_limit: 1g`。

## 9. 测试

| 范围 | 用例 |
|---|---|
| 抽象 | registry 三个新格式；ExportPanel 动态选项与默认值 |
| HTML | 单文件包含主题 CSS、封面 data URL、目录锚点、卷扉页；无外链；标题转义 |
| TXT | 卷/章/简介/番外顺序；空行折叠；UTF-8 无 BOM；关闭卷标题 |
| PDF | 生成字节以 `%PDF-` 开头；页数随章节增加；书签包含卷与章；A4/A5 尺寸；字体缺失错误 |
| 服务端 | 未登录 401；超限 400；并发 429；限流 429；PDF 响应类型 |
| Docker | 运行镜像安装 Noto CJK；`PDF_FONT_PATH` 可覆盖 |

## 10. 验收

1. 导出格式下拉出现 EPUB / HTML / PDF / TXT，后三者可选并导出成功。
2. HTML 单文件离线打开后，主题、封面、卷扉页、目录与预览一致。
3. TXT 用记事本打开不乱码，卷章结构清晰。
4. PDF 在 A4/A5 下中文正常、分页合理、目录页码与书签可用。
5. 未登录调用 PDF 接口返回 401；超限与并发有明确错误。
6. `docker compose up -d --build` 后 PDF 导出正常。
