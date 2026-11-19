# 多格式导出实施计划索引

**Goal:** 增加单文件 HTML、服务端 PDF、整理版 TXT 三种导出格式。

**Architecture:** 扩展 `ConverterMeta`（runtime + 动态选项），HTML/TXT 在浏览器生成，PDF 由服务端 pdfkit 生成并通过 `/api/export/pdf` 返回。

**Spec:** `docs/superpowers/specs/2026-11-18-multi-format-export-design.md`

## 执行顺序

| 顺序 | 子计划 | 交付 |
|---|---|---|
| 1 | `2026-11-18-format-abstraction.md` | 抽象扩展 + HTML + TXT + 选项 UI |
| 2 | `2026-11-18-pdf-export.md` | PDF 引擎 + 接口 + 前端接入 + Docker 字体 |

## 全局约束

- 不执行 `git commit`；所有改动在 worktree `E:\Code\txt-epub\txt2book\.worktree\task-20261118-formats` 内。
- 用户可见文案中文，代码标识符英文。
- 新增依赖：服务端 `pdfkit`（MIT）；不引入 headless 浏览器。
- 预览与导出共用主题/排版 CSS 生成函数。
- 现有 851 个测试必须通过。

## 共享接口

```ts
// src/core/converters/types.ts
export type ConverterRuntime = "browser" | "server";
export interface FormatOptionChoice { value: string; label: string }
export interface FormatOption {
  key: string;
  label: string;
  type: "boolean" | "select";
  defaultValue: boolean | string;
  hint?: string;
  choices?: FormatOptionChoice[];
}
export interface ConverterMeta {
  id: string; label: string; extension: string; mimeType: string;
  available: boolean; runtime: ConverterRuntime; options?: FormatOption[];
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

| 格式 | runtime | 选项 key |
|---|---|---|
| epub | browser | 无（沿用三个内容选项） |
| html | browser | 无 |
| txt | browser | `includeIntro`、`includeVolumeTitles` |
| pdf | server | `pageSize`（A4/A5）、`margin`（normal/narrow）、`pageNumbers`、`includeCover`、`includeToc`、`bookmarks` |

## Review Focus

- 导出格式切换后，旧格式的选项不能串到新格式。
- HTML 必须单文件、无外链、资源内联。
- TXT 必须 UTF-8 无 BOM、空行稳定。
- PDF 中文字体缺失时给出清晰错误，而不是输出空白或方框。
- PDF 接口的鉴权、体积/数量上限、并发与限流必须真实生效。
