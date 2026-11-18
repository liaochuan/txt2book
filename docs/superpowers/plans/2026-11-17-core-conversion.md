# txt2book 核心转换 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 TXT 读取、章节/卷/番外解析、章节删除合并、主题渲染与 EPUB 生成，全部由单元测试覆盖。

**Architecture:** `src/core/` 内是纯 TypeScript 逻辑，不依赖 Vue 与 DOM（除 `Blob` 与 `JSZip`）。渲染层输出 XHTML body 片段，EPUB 转换器把它包进完整文档，预览与导出共用同一片段。

**Tech Stack:** TypeScript、Vitest、JSZip、jschardet。

**Spec:** `docs/superpowers/specs/2026-11-17-txt2book-design.md`

## Global Constraints

- 用户可见文案中文，代码标识符英文。
- 不写 `git commit`；每个任务以验证命令通过结束。
- 章节标题判定：整行匹配、trim 后 ≤ 40 字、不以 `。！？…；` 结尾。
- EPUB 内部一章一个 XHTML；卷只生成扉页与目录分组。
- 任何封面进入 EPUB 前必须是 PNG。

## Review Focus

- 正文中以「序」「卷」「番外」开头的长句被误判为标题。
- 删除卷内第一章 / 全书第一章 / 唯一章节时正文丢失或错位。
- 预览与导出使用不同渲染路径导致效果不一致。
- 空章节、纯空行章节、超大章节（> 10 万行）导致渲染卡死。
- XHTML 特殊字符（`& < > " '`）未转义导致 EPUB 打不开。

---

### Task 1: 项目脚手架与书籍模型

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.server.json`
- Create: `vite.config.ts`
- Create: `index.html`
- Create: `src/env.d.ts`
- Create: `src/types/book.ts`
- Create: `tests/setup.test.ts`

**Interfaces:**
- Produces: `BookModel`、`Chapter`、`Volume`、`BookMeta`、`CoverAsset`、`ChapterKind`、`VolumeKind`、`ThemeId`、`Language`，字段与索引文档「共享接口」完全一致。

- [ ] **Step 1: 初始化 `package.json` 与配置**

依赖：`vue`、`jschardet`、`jszip`、`fastify`、`@fastify/cookie`、`@fastify/multipart`、`@fastify/static`、`sharp`。
开发依赖：`vite`、`@vitejs/plugin-vue`、`typescript`、`vue-tsc`、`vitest`、`tsx`、`@types/node`。

脚本：

```json
{
  "dev": "vite",
  "dev:server": "tsx watch server/index.ts",
  "build": "npm run build:web && npm run build:server",
  "build:web": "vite build",
  "build:server": "tsc -p tsconfig.server.json",
  "typecheck": "vue-tsc --noEmit && tsc -p tsconfig.server.json --noEmit",
  "test": "vitest run",
  "hash-password": "tsx server/scripts/hash-password.ts"
}
```

`vite.config.ts` 增加 `test: { environment: "node", include: ["tests/**/*.test.ts", "src/**/*.test.ts"] }`，并配置 `server.proxy`：`/api` → `http://127.0.0.1:3000`。

- [ ] **Step 2: 写类型定义**

`src/types/book.ts` 按索引文档「共享接口」逐字段实现，不增删字段。

- [ ] **Step 3: 写一个编译期/运行期冒烟测试**

```ts
// tests/setup.test.ts
import { describe, expect, it } from "vitest";
import type { BookModel } from "../src/types/book";

describe("book model", () => {
  it("supports a book without volumes", () => {
    const book: BookModel = {
      meta: { title: "测试", author: "作者", language: "zh-CN" },
      volumes: [],
      chapters: [{ id: "c1", title: "第一章", kind: "chapter", lines: ["正文"], volumeId: null }],
      cover: null,
    };
    expect(book.chapters[0].volumeId).toBeNull();
  });
});
```

- [ ] **Step 4: 验证**

Run: `npm run typecheck` → 无错误。
Run: `npm test` → 1 passed。

---

### Task 2: 文本读取与预处理

**Files:**
- Create: `src/core/preprocess.ts`
- Create: `src/core/textReader.ts`
- Create: `tests/preprocess.test.ts`
- Create: `tests/textReader.test.ts`

**Interfaces:**
- Produces:
  - `preprocessLines(text: string): string[]` — 按行拆分，去掉行首半角/全角空白，去掉行尾 `\r`，不丢弃空行。
  - `hasMeaningfulContent(lines: string[]): boolean` — 存在 trim 后非空行。
  - `decodeText(bytes: Uint8Array, encoding: string | "auto"): { text: string; usedEncoding: string; detectedEncoding: string | null }`
  - `readTextFile(file: File, encoding?: string | "auto"): Promise<{ text: string; bytes: Uint8Array; usedEncoding: string; detectedEncoding: string | null }>`

- [ ] **Step 1: 写失败测试**

```ts
// tests/textReader.test.ts
import { describe, expect, it } from "vitest";
import { decodeText } from "../src/core/textReader";

describe("decodeText", () => {
  it("decodes GB18030 bytes when asked explicitly", () => {
    const bytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]); // 中文
    expect(decodeText(bytes, "gb18030").text).toBe("中文");
  });

  it("decodes Big5 bytes when asked explicitly", () => {
    const bytes = new Uint8Array([0xa4, 0xa4, 0xa4, 0xe5]); // 中文
    expect(decodeText(bytes, "big5").text).toBe("中文");
  });

  it("reports the encoding actually used", () => {
    const bytes = new TextEncoder().encode("第一章 开始");
    const result = decodeText(bytes, "auto");
    expect(result.usedEncoding.toLowerCase()).toContain("utf-8");
  });
});
```

```ts
// tests/preprocess.test.ts
import { describe, expect, it } from "vitest";
import { preprocessLines, hasMeaningfulContent } from "../src/core/preprocess";

describe("preprocessLines", () => {
  it("strips leading ascii and ideographic spaces", () => {
    expect(preprocessLines("  a\n\u3000\u3000b\n\tc")).toEqual(["a", "b", "c"]);
  });
  it("keeps blank lines and strips CR", () => {
    expect(preprocessLines("a\r\n\r\nb")).toEqual(["a", "", "b"]);
  });
  it("detects meaningful content", () => {
    expect(hasMeaningfulContent(["", "  ", "x"])).toBe(true);
    expect(hasMeaningfulContent(["", " "])).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- tests/textReader.test.ts tests/preprocess.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

`textReader` 用 `jschardet.detect` 取编码，映射 `GB2312/GBK/GB18030 → gb18030`、`Big5 → big5`、`UTF-16LE/BE` 对应；无法识别时回退 `utf-8`。用 `TextDecoder` 解码，`fatal: false`。`readTextFile` 通过 `file.arrayBuffer()` 读原始字节并保留，供用户切换编码后重新解码。

- [ ] **Step 4: 验证**

Run: `npm test -- tests/textReader.test.ts tests/preprocess.test.ts` → 6 passed。

---

### Task 3: 章节解析（卷 / 番外 / 楔子 / 尾声）

**Files:**
- Modify: `src/core/customRules.ts`（新建，若不存在）
- Create: `src/core/chapterParser.ts`
- Create: `tests/chapterParser.test.ts`
- Create: `tests/fixtures/structured.txt`
- Modify: `tests/fixtures/`（复制现有 `测试小说_001.txt`、`测试小说_002.txt` 作为回归数据）

**Interfaces:**
- Consumes: `Chapter`、`Volume`、`Language`、`ChapterRule`。
- Produces: `parseChapters(lines, language, userRules?) => ParsedBook`，`compileRule(rule) => { regex, capture }`。

- [ ] **Step 1: 准备 `structured.txt`**

内容必须包含：

```
简介第一段
简介第二段

楔子
楔子正文

第一卷 风起
第一章 重逢
第一卷正文一
第2章 试探
第一卷正文二

番外篇 小满
番外正文

第二卷 云涌
第一章 归来
第二卷正文
尾声
终章正文
```

并额外加 3 行诱饵：`卷顊佹不是标题`、`序辦腊这是正文长句，不应被识别为章节标题。`、`番外篇的正文提到很多事，这一行长度明显超过限制因此不是标题`。

- [ ] **Step 2: 写失败测试**

```ts
// tests/chapterParser.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseChapters } from "../src/core/chapterParser";

const lines = readFileSync(join(__dirname, "fixtures/structured.txt"), "utf8").split(/\r?\n/);

describe("parseChapters", () => {
  const book = parseChapters(lines, "zh-CN");

  it("creates an intro chapter before the first title", () => {
    expect(book.chapters[0].kind).toBe("intro");
    expect(book.chapters[0].title).toBe("简介");
  });

  it("recognizes volumes and assigns chapters to them", () => {
    expect(book.volumes.map((v) => v.title)).toEqual(["第一卷 风起", "第二卷 云涌", "番外"]);
    const ch = book.chapters.find((c) => c.title === "第一章 重逢")!;
    expect(ch.volumeId).toBe(book.volumes[0].id);
  });

  it("moves extras into a trailing extra group", () => {
    const extras = book.chapters.filter((c) => c.kind === "extra");
    expect(extras.map((c) => c.title)).toEqual(["番外篇 小满"]);
    expect(extras[0].volumeId).toBe(book.volumes.at(-1)!.id);
    expect(book.volumes.at(-1)!.kind).toBe("extra-group");
  });

  it("does not treat prose lines as titles", () => {
    const titles = book.chapters.map((c) => c.title);
    expect(titles.some((t) => t.startsWith("卷顊佹"))).toBe(false);
    expect(titles.some((t) => t.startsWith("序辦腊"))).toBe(false);
    expect(titles.some((t) => t.startsWith("番外篇的正文"))).toBe(false);
  });

  it("marks prologue and epilogue kinds", () => {
    expect(book.chapters.find((c) => c.title === "楔子")!.kind).toBe("prologue");
    expect(book.chapters.find((c) => c.title === "尾声")!.kind).toBe("epilogue");
  });

  it("falls back to a single chapter when nothing matches", () => {
    const single = parseChapters(["只有正文", "没有标题"], "zh-CN");
    expect(single.chapters).toHaveLength(1);
    expect(single.chapters[0].title).toBe("正文");
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npm test -- tests/chapterParser.test.ts` → FAIL。

- [ ] **Step 4: 实现内置规则（按顺序匹配，先卷后章）**

```ts
const CN_NUM = "[0-9０-９零一二三四五六七八九十百千万两〇○]+";
const VOLUME = new RegExp(`^(第${CN_NUM}?[卷部]|卷${CN_NUM})(?:[\\s·、，,：:.-]+(.*))?$`);
const CHAPTER = new RegExp(`^(第${CN_NUM}章|Chapter\\s*[0-9]+)(?:[\\s·、，,：:.-]+(.*))?$`, "i");
const EXTRA = /^(番外[篇章节]?)(?:[\s·、，,：:.-]+(.*))?$/;
const PROLOGUE = /^(楔子|序章|序幕|序言|引子|序)(?:[\s·、，,：:.-]+(.*))?$/;
const EPILOGUE = /^(尾声|后记|终章|尾章)(?:[\s·、，,：:.-]+(.*))?$/;
```

判定函数 `classifyTitle(line): { title, kind } | null`：先 trim；长度 > 40 或结尾是 `。！？…；` 返回 null；按 卷 → 章 → 番外 → 楔子 → 尾声 顺序匹配内置；未命中再走用户规则（`kind` 取自规则）。标题取“整行 trim”，保留原编号文字。

装配：

- 维护 `currentVolumeId`；遇到卷时 `push Volume` 并设为当前。
- 遇到 extra：若不存在 `extra-group` 则创建（标题“番外”），该章 `volumeId = extraGroup.id`，并记录到 `pendingExtras`；装配结束后把这些章节从原位置移除、按顺序追加到 `chapters` 末尾。
- 第一个卷之前的章：`volumeId = null`。
- 开头非空内容 → `kind: "intro"`、`title: "简介"`。
- 每章正文为下一个标题前的行，去掉首尾空行。

- [ ] **Step 5: 验证**

Run: `npm test -- tests/chapterParser.test.ts` → 6 passed。
Run: `node -e "import('./src/core/chapterParser.ts')"` 不需要；改为在 `tests/chapterParser.test.ts` 追加：

```ts
it("still parses the two legacy fixtures", () => {
  for (const name of ["测试小说_001.txt", "测试小说_002.txt"]) {
    const text = readFileSync(join(__dirname, "fixtures", name), "utf8");
    const parsed = parseChapters(text.split(/\r?\n/), "zh-CN");
    expect(parsed.chapters.length).toBeGreaterThan(1);
  }
});
```

Expected: 全部通过。

---

### Task 4: 章节操作与撤销

**Files:**
- Create: `src/core/chapterOps.ts`
- Create: `tests/chapterOps.test.ts`

**Interfaces:**
- Consumes: `BookModel`、`Chapter`、`Volume`。
- Produces: `renameChapter`、`deleteChapter`、`deleteVolume`、`createHistory`。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { createHistory, deleteChapter, deleteVolume, renameChapter } from "../src/core/chapterOps";
import type { BookModel } from "../src/types/book";

function book(): BookModel {
  return {
    meta: { title: "书", author: "", language: "zh-CN" },
    volumes: [
      { id: "v1", title: "第一卷", kind: "volume" },
      { id: "v2", title: "第二卷", kind: "volume" },
    ],
    chapters: [
      { id: "c1", title: "一", kind: "chapter", lines: ["a"], volumeId: "v1" },
      { id: "c2", title: "二", kind: "chapter", lines: ["b"], volumeId: "v1" },
      { id: "c3", title: "三", kind: "chapter", lines: ["c"], volumeId: "v2" },
      { id: "c4", title: "四", kind: "chapter", lines: ["d"], volumeId: "v2" },
    ],
    cover: null,
  };
}

describe("deleteChapter", () => {
  it("appends the removed body to the previous chapter", () => {
    const next = deleteChapter(book(), "c3");
    expect(next.chapters.map((c) => c.id)).toEqual(["c1", "c2", "c4"]);
    expect(next.chapters[1].lines).toEqual(["b", "", "c"]);
  });

  it("merges the first chapter into the next one", () => {
    const next = deleteChapter(book(), "c1");
    expect(next.chapters[0].lines).toEqual(["a", "", "b"]);
    expect(next.chapters[0].title).toBe("二");
  });

  it("refuses to delete the only chapter", () => {
    const one = book();
    one.chapters = [one.chapters[0]];
    expect(deleteChapter(one, "c1").chapters).toHaveLength(1);
  });

  it("does not mutate the input", () => {
    const original = book();
    deleteChapter(original, "c2");
    expect(original.chapters[1].lines).toEqual(["b"]);
  });
});

describe("deleteVolume", () => {
  it("promotes children and drops the volume", () => {
    const next = deleteVolume(book(), "v1");
    expect(next.volumes.map((v) => v.id)).toEqual(["v2"]);
    expect(next.chapters.slice(0, 2).every((c) => c.volumeId === null)).toBe(true);
  });
});

describe("renameChapter", () => {
  it("keeps originalTitle", () => {
    const next = renameChapter(book(), "c1", "新名字");
    expect(next.chapters[0].title).toBe("新名字");
    expect(next.chapters[0].originalTitle).toBe("一");
  });
});

describe("history", () => {
  it("undoes the last snapshot", () => {
    const h = createHistory(20);
    const before = book();
    h.push(before);
    const after = deleteChapter(before, "c2");
    expect(h.canUndo()).toBe(true);
    expect(h.undo()).toBe(before);
    expect(h.canUndo()).toBe(false);
  });

  it("caps the number of snapshots", () => {
    const h = createHistory(2);
    h.push(book()); h.push(book()); h.push(book());
    h.undo(); h.undo();
    expect(h.canUndo()).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败** → `npm test -- tests/chapterOps.test.ts` FAIL。

- [ ] **Step 3: 实现**

合并时用 `[...prev.lines, "", ...removed.lines]`，去掉被删章节对象；删除卷只把该卷下章节 `volumeId` 置 `null`，其余不动。所有函数返回新对象，不修改入参。

- [ ] **Step 4: 验证** → 8 passed。

---

### Task 5: 主题与正文渲染

**Files:**
- Create: `src/core/render/themes.ts`
- Create: `src/core/render/renderChapter.ts`
- Create: `tests/render.test.ts`

**Interfaces:**
- Consumes: `Chapter`、`ThemeId`。
- Produces: `themes: Record<ThemeId, Theme>`、`renderChapterBody(chapter, theme, options?)`、`renderPreviewDocument(chapter, theme)`、`detectSceneBreak(line: string): boolean`。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { themes } from "../src/core/render/themes";
import { renderChapterBody, renderPreviewDocument } from "../src/core/render/renderChapter";

const chapter = {
  id: "c1", title: "第一章 <重逢> & \"开始\"", kind: "chapter" as const,
  lines: ["第一段", "", "***", "第二段 & <b>"], volumeId: null,
};

describe("renderChapterBody", () => {
  it("escapes xml special characters", () => {
    const html = renderChapterBody(chapter, themes.paper);
    expect(html).toContain("&lt;重逢&gt; &amp; &quot;开始&quot;");
    expect(html).toContain("第二段 &amp; &lt;b&gt;");
    expect(html).not.toContain("<b>");
  });
  it("renders scene breaks as hr", () => {
    const html = renderChapterBody(chapter, themes.paper);
    expect(html).toContain('<hr class="scene-break"/>');
  });
  it("omits the visible title when asked", () => {
    const html = renderChapterBody(chapter, themes.paper, { showTitle: false });
    expect(html).not.toContain("<h1");
  });
  it("exposes all four themes with scoped css", () => {
    expect(Object.keys(themes)).toEqual(["minimal", "paper", "night", "classic"]);
    for (const theme of Object.values(themes)) {
      expect(theme.css).toContain(".txt2book");
    }
  });
  it("wraps preview in a full html document", () => {
    const doc = renderPreviewDocument(chapter, themes.night);
    expect(doc.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(doc).toContain(themes.night.css);
  });
});
```

- [ ] **Step 2: 跑测试确认失败** → FAIL。

- [ ] **Step 3: 实现四套主题**

`themes` 每个对象包含 `id/label/description/css/sceneBreak`。CSS 统一以 `.txt2book` 前缀，至少定义：`background`、`color`、`font-family`、`font-size`、`line-height`、`p` 的 `margin` 与 `text-indent`、`h1` 样式、`.scene-break` 样式。`night` 用深色底，`classic` 的 sceneBreak 为 `❖`，其余为 `* * *`。

渲染规则：

- 章节标题：`<h1 class="chapter-title">`（`showTitle !== false` 时）。
- 每个非空行：`<p>`；空行不再输出（段间距由 CSS 控制）。
- `detectSceneBreak` 匹配 `/^([*＊]\s*){3,}$|^[—－-]{3,}$|^[◇◆❖]{3,}$/`，命中输出 `<hr class="scene-break"/>`。
- 全部文本经 `escapeXml` 转义。
- `renderPreviewDocument` 用模板拼 `<style>base + theme.css</style>` 与 `<body class="txt2book">`。

- [ ] **Step 4: 验证** → 5 passed。

---

### Task 6: EPUB 生成（结构、封面、主题）

**Files:**
- Create: `src/core/converters/types.ts`
- Create: `src/core/converters/epub/xhtml.ts`
- Create: `src/core/converters/epub/opf.ts`
- Create: `src/core/converters/epub/index.ts`
- Create: `tests/epub.test.ts`

**Interfaces:**
- Consumes: `BookModel`、`ConvertOptions`、`themes`、`renderChapterBody`。
- Produces: `buildEpub(book, options): Promise<Blob>`，`epubConverter: BookConverter`（`id: "epub"`、`available: true`）。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { buildEpub } from "../src/core/converters/epub";
import type { BookModel } from "../src/types/book";

const book: BookModel = {
  meta: { title: "测试书", author: "作者", language: "zh-CN", description: "简介" },
  volumes: [{ id: "v1", title: "第一卷", kind: "volume" }],
  chapters: [
    { id: "c1", title: "第一章", kind: "chapter", lines: ["正文一"], volumeId: "v1" },
    { id: "c2", title: "第二章", kind: "chapter", lines: ["正文二"], volumeId: "v1" },
  ],
  cover: { png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), width: 2, height: 2 },
};

const options = { themeId: "paper" as const, includeTocPage: true, includeTitlePage: true, includeVolumePages: true };

describe("buildEpub", () => {
  it("writes an uncompressed mimetype first and a valid container", async () => {
    const zip = await JSZip.loadAsync(await (await buildEpub(book, options)).arrayBuffer());
    expect(await zip.file("mimetype")!.async("string")).toBe("application/epub+zip");
    expect(await zip.file("META-INF/container.xml")!.async("string")).toContain("OEBPS/content.opf");
  });

  it("includes one xhtml per chapter and a nested nav", async () => {
    const zip = await JSZip.loadAsync(await (await buildEpub(book, options)).arrayBuffer());
    const nav = await zip.file("OEBPS/nav.xhtml")!.async("string");
    expect(nav).toContain("第一卷");
    expect(nav).toContain("第一章");
    expect(Object.keys(zip.files).filter((f) => /chapter-\d+\.xhtml$/.test(f))).toHaveLength(2);
  });

  it("stores the cover as png and declares it", async () => {
    const zip = await JSZip.loadAsync(await (await buildEpub(book, options)).arrayBuffer());
    const opf = await zip.file("OEBPS/content.opf")!.async("string");
    expect(opf).toContain('media-type="image/png"');
    expect(opf).toContain('properties="cover-image"');
    expect(zip.file("OEBPS/images/cover.png")).toBeTruthy();
  });

  it("links the selected theme stylesheet", async () => {
    const zip = await JSZip.loadAsync(await (await buildEpub(book, options)).arrayBuffer());
    const styles = await zip.file("OEBPS/styles/theme.css")!.async("string");
    expect(styles).toContain(".txt2book");
  });

  it("omits optional pages when disabled", async () => {
    const zip = await JSZip.loadAsync(await (await buildEpub(book, { ...options, includeTitlePage: false, includeTocPage: false, includeVolumePages: false })).arrayBuffer());
    expect(zip.file("OEBPS/titlepage.xhtml")).toBeNull();
    expect(zip.file("OEBPS/volume-1.xhtml")).toBeNull();
    const opf = await zip.file("OEBPS/content.opf")!.async("string");
    expect(opf).toMatch(/idref="nav"[^>]*linear="no"/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败** → FAIL。

- [ ] **Step 3: 实现**

- `xhtml.ts`：`xhtmlDocument(title, lang, body)`；`chapterDocument(chapter, theme, index, lang)`；`coverDocument`；`titlePageDocument`；`volumeDocument`；`navDocument`；`tocNcxDocument`。
- `opf.ts`：`buildOpf(meta, items, assets)`，包含 `dc:identifier`（`urn:uuid`）、`dc:title`、`dc:creator`、`dc:description`、`dc:language`、`dcterms:modified`、`cover-image` 属性、`spine` 顺序；nav 关闭时写 `linear="no"`。
- `index.ts`：`buildEpub` 用 `JSZip`，`mimetype` 用 `{ compression: "STORE" }`；图片写 `OEBPS/images/cover.png`，`media-type` 固定 `image/png`；样式写 `OEBPS/styles/theme.css`；章节名 `chapter-N.xhtml`（N 从 1 开始，全书连续）。
- 目录：`nav.xhtml` 用嵌套 `<ol>`，卷为一级、其下章节为二级；无卷章节直接在根 `<ol>`；番外分组同样嵌套。同时生成 `toc.ncx`。

- [ ] **Step 4: 验证** → 5 passed。

---

### Task 7: 转换器注册表

**Files:**
- Modify: `src/core/converters/types.ts`
- Create: `src/core/converters/index.ts`
- Create: `tests/registry.test.ts`

**Interfaces:**
- Produces: `converterRegistry: Record<string, BookConverter>`、`listConverters(): ConverterMeta[]`。`listConverters()` 返回 `[epub]`，UI 只依赖它。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { converterRegistry, listConverters } from "../src/core/converters";

describe("converter registry", () => {
  it("registers epub as available", () => {
    expect(listConverters().map((c) => c.id)).toEqual(["epub"]);
    expect(converterRegistry.epub.available).toBe(true);
    expect(converterRegistry.epub.extension).toBe("epub");
    expect(converterRegistry.epub.mimeType).toBe("application/epub+zip");
  });
});
```

- [ ] **Step 2: 跑测试确认失败** → FAIL。
- [ ] **Step 3: 实现注册表并把 `epubConverter` 注册进去**。
- [ ] **Step 4: 验证** → `npm test` 全绿（核心计划累计 25 个用例以上）。

---

## 完成标准

- `npm test` 全绿。
- `npm run typecheck` 无错误。
- 用 `tests/fixtures/测试小说_001.txt` 走一遍解析 → 渲染 → EPUB，生成的 EPUB 用阅读器打开目录层级正确。
