# txt2book 实施计划索引

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement each sub-plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 TXT 小说转换成带卷/番外结构、封面、主题排版与在线预览的 EPUB，并通过 Docker Compose 以带登录认证的方式部署。

**Architecture:** 前端 Vue 3 负责解析、章节编辑、预览与在浏览器内生成 EPUB；后端 Node/Fastify 只负责登录认证、封面抓取与 PNG 转换、静态托管。前后端通过固定 `/api` 契约通信，转换器通过注册表抽象，后续格式只加实现。

**Tech Stack:** Vue 3 + Vite + TypeScript、JSZip、vitest、Node 22 + Fastify + sharp、Docker multi-stage。

**Spec:** `docs/superpowers/specs/2026-11-17-txt2book-design.md`

## 执行顺序

| 顺序 | 子计划 | 可独立交付的成果 |
|---|---|---|
| 1 | `2026-11-17-core-conversion.md` | 解析、章节操作、主题渲染、EPUB 生成，全部有单测 |
| 2 | `2026-11-17-web-ui.md` | 可操作的界面：上传、目录树、预览、主题、导出、登录 |
| 3 | `2026-11-17-server-auth-cover.md` | 认证、封面代理、静态托管、Docker 部署 |

子计划 2 依赖子计划 1 的类型与函数；子计划 3 与 1、2 无代码依赖，可以并行，但最终联调需要在 2 完成后。

## 全局约束

- 提交由用户执行。计划中的每个任务以「验证通过」结束，不包含 `git commit`。
- 所有用户可见文案为简体中文；代码标识符、路径、API 字段为英文。
- 不引入设计文档之外的重型依赖；新增依赖必须在该任务里说明用途。
- 安全相关代码（SSRF、认证、限流、会话）必须有对应测试，且测试要覆盖拒绝路径。
- 目录约定见 `AGENTS.md`；样式只用 `src/styles/tokens.css` 的变量。
- Node 运行时版本：本地 ≥ 22，Docker 镜像 `node:22-alpine`。

## 共享接口（三个子计划共同遵守）

### 书籍模型 `src/types/book.ts`

```ts
export type Language = "zh-CN" | "en";
export type ChapterKind = "intro" | "chapter" | "extra" | "prologue" | "epilogue";
export type VolumeKind = "volume" | "extra-group";
export type ThemeId = "minimal" | "paper" | "night" | "classic";

export interface Chapter {
  id: string;
  title: string;
  originalTitle?: string;
  kind: ChapterKind;
  lines: string[];
  volumeId: string | null;
}

export interface Volume {
  id: string;
  title: string;
  originalTitle?: string;
  kind: VolumeKind;
  lines?: string[];
}

export interface BookMeta {
  title: string;
  author: string;
  language: Language;
  description?: string;
}

export interface CoverAsset {
  png: Uint8Array;
  width: number;
  height: number;
  sourceName?: string;
}

export interface BookModel {
  meta: BookMeta;
  volumes: Volume[];
  chapters: Chapter[];
  cover: CoverAsset | null;
}
```

### 解析器 `src/core/chapterParser.ts`

```ts
export interface ParsedBook {
  volumes: Volume[];
  chapters: Chapter[];
}
export function parseChapters(
  lines: string[],
  language: Language,
  userRules?: ChapterRule[],
): ParsedBook;
```

### 章节规则 `src/core/customRules.ts`

```ts
export interface ChapterRule {
  id: string;
  label: string;
  pattern: string;   // 正则源码，不含首尾斜杠
  flags?: string;
  capture?: number;  // 默认 0
  enabled: boolean;
  kind: RuleKind;    // 旧数据迁移时补 "chapter"
}
export type RuleKind = "volume" | "chapter" | "extra" | "prologue" | "epilogue";
export function loadRules(): ChapterRule[];
export function saveRules(rules: ChapterRule[]): void;
export function compileRule(rule: ChapterRule): { regex: RegExp; capture: number };
```

### 章节操作 `src/core/chapterOps.ts`

```ts
export function renameChapter(book: BookModel, chapterId: string, title: string): BookModel;
export function deleteChapter(book: BookModel, chapterId: string): BookModel;
export function deleteVolume(book: BookModel, volumeId: string): BookModel;
export interface History {
  push(snapshot: BookModel): void;
  undo(): BookModel | null;
  canUndo(): boolean;
}
export function createHistory(limit?: number): History; // 默认 20
```

### 渲染 `src/core/render/renderChapter.ts`

```ts
export interface Theme {
  id: ThemeId;
  label: string;
  description: string;
  css: string;       // 主题样式，作用域前缀 .txt2book
  sceneBreak: string; // 场景分隔符字符
}
export function renderChapterBody(
  chapter: Chapter,
  theme: Theme,
  options?: { showTitle?: boolean },
): string; // XHTML body 内片段
export function renderPreviewDocument(chapter: Chapter, theme: Theme): string; // 完整 HTML，供 iframe srcdoc
```

### 转换器 `src/core/converters/types.ts`

```ts
export interface ConverterMeta {
  id: string;
  label: string;
  extension: string;
  mimeType: string;
  available: boolean;
}
export interface ConvertOptions {
  themeId: ThemeId;
  includeTocPage: boolean;
  includeTitlePage: boolean;
  includeVolumePages: boolean;
}
export interface BookConverter extends ConverterMeta {
  convert(book: BookModel, options: ConvertOptions): Promise<Blob>;
}
export const converterRegistry: Record<string, BookConverter>; // 至少包含 "epub"
```

### HTTP 契约

| 方法 | 路径 | 请求 | 成功响应 |
|---|---|---|---|
| GET | `/api/health` | 无 | `200 {"ok":true}` |
| GET | `/api/auth/me` | Cookie | `200 {"authenticated":boolean,"username"?:string}` |
| POST | `/api/auth/login` | `{"username","password"}` | `204` + Set-Cookie |
| POST | `/api/auth/logout` | Cookie | `204` |
| POST | `/api/cover/from-url` | `{"url"}` | `200 image/png` |
| POST | `/api/cover/from-file` | multipart `file` | `200 image/png` |

错误响应统一为 `{"error":{"code":string,"message":string}}`；认证失败 `401`，参数错误 `400`，不支持的图片 `415`，限流 `429`。

### 环境变量

见设计文档 §16。前端只依赖 `/api/auth/me` 判断登录态。

## Review Focus

- 标题误判：正文里以「序」「卷」开头的长句不能被当成章节标题。Plan 1 Task 3 覆盖。
- 删除边界：删除卷内第一章、全书第一章、唯一章节都不得丢正文。Plan 1 Task 4 覆盖。
- 预览/导出不一致：同一 `renderChapterBody` 输出必须同时用于 iframe 与 EPUB。Plan 1 Task 5、Task 6 覆盖。
- 封面不是 PNG：任何输入（webp/gif/损坏文件）最终写入 EPUB 的都必须是 PNG。Plan 3 Task 5 覆盖。
- 未登录绕过：除白名单外所有 `/api` 必须 401，且限流基于可信 IP。Plan 3 Task 6 覆盖。
- 大文件：10MB TXT 与 40MP 图片下不崩、不卡死。Plan 2 Task 2、Plan 3 Task 5 覆盖。
