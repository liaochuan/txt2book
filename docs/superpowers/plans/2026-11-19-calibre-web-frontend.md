# calibre-web 前端实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在转换页面接入 calibre-web 书库：解析 OPDS、导入 TXT 与元数据/封面、导出 EPUB 后推送回原书，并加密复用连接配置。

**Architecture:** `core/calibre/feed.ts` 负责 OPDS 解析；`composables/useCalibre.ts` 编排连接、分页、过滤、导入与推送；关联写入 `BookModel.source`，由 `useBookSession` 随快照回滚；`CalibrePanel` 只做展示与事件转发。

**Tech Stack:** Vue 3 Composition API、TypeScript、`DOMParser`、Vitest + happy-dom；不新增依赖。

**Spec:** `docs/superpowers/specs/2026-11-19-calibre-web-integration-design.md`

## 全局约束

- 不新增依赖；不执行 `git add` / `commit` / `push`。
- 所有用户可见文案中文；代码/路径/字段英文。
- 不修改 `server/**`、`tests/server/**`、`README.md`、`AGENTS.md`。
- 每个任务结束前运行该任务测试并确认通过；最终跑 `npm run typecheck`。
- 不使用 `v-html`；calibre 的简介按纯文本处理。
- 组件只做展示与事件转发，业务逻辑放 `src/core/` 或 composable。

## Review Focus

- 关联必须随书籍快照回滚（F2 / F6）。
- calibre 导入必须覆盖旧元数据，无封面时清空旧封面（F3 / F4 / F6）。
- 英文书必须使用英文默认章节标题（F3）。
- 搜索 + TXT 过滤下不能出现空白页（F6）。
- 推送 409 必须经过用户确认才覆盖（F6）。
- 连接断开或 origin 变化后不得显示推送入口（F6 / F9）。

---

### Task F1: 类型与 OPDS 解析

**Files:**
- Create: `src/types/calibre.ts`
- Create: `src/core/calibre/feed.ts`
- Test: `tests/calibreFeed.test.ts`

**Interfaces:**
- Produces:
  - `CalibreBook`、`CalibreFeed`、`CalibreSessionInfo`（见索引）。
  - `parseOpdsFeed(xml: string): CalibreFeed`
  - `mapCalibreLanguage(raw: string | undefined): Language`：`zh`/`zho`/`chi` 前缀 → `zh-CN`；`en`/`eng` → `en`；其余 → `zh-CN`。

- [ ] **Step 1: 写失败测试**

`tests/calibreFeed.test.ts` 内联 XML fixture，包含：
- 一个完整 entry：`title`、两个 `author/name`、`dcterms:language` = `zho`、`content` 内 `TAGS: ...` 与 `<p>真正的简介</p>`、两个 acquisition 链接（txt/epub）、封面链接；
- 一个只有 `<title>` 与 subsection 链接的导航 entry；
- `<link rel="next" href="/opds/books/letter/00?offset=30">`；
- 一个缺 acquisition 链接的坏 entry。

断言：

```ts
expect(feed.books).toHaveLength(1);
expect(feed.books[0]).toEqual({
  id: 42,
  title: "三体",
  authors: ["刘慈欣", "另一位"],
  language: "zho",
  summary: "真正的简介",
  formats: ["TXT", "EPUB"],
  hasCover: true,
});
expect(feed.nextOffset).toBe(30);
```

另加：无 next 时 `nextOffset` 为 `null`；`language` 缺失时为 `undefined`；HTML 实体（`&amp;`）被解码；summary 超过 5000 字被截断。
`mapCalibreLanguage` 的断言：`"zho"`/`"zh"`/`"chi"` → `"zh-CN"`，`"eng"`/`"en"` → `"en"`，`undefined`/`"fra"` → `"zh-CN"`。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/calibreFeed.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现类型与解析**

- `src/types/calibre.ts` 按索引定义三个类型。
- `parseOpdsFeed`：
  - `new DOMParser().parseFromString(xml, "text/xml")`；parsererror → 返回 `{ books: [], nextOffset: null }`。
  - 遍历 `feed > entry`；只保留至少一个 `link[rel*="acquisition"]` 的条目。
  - id：从任意 `/opds/(download|cover)/(\d+)` 链接提取；无则跳过。
  - formats：从 acquisition href 的 `/<fmt>/` 段取大写；去重。
  - language：`getElementsByTagName` 找 `tagName` 以 `language` 结尾（忽略大小写）的第一个 textContent 并 trim。
  - authors：所有 `author > name`；`join("、")` 后的字符串同时保留数组（索引类型为 `authors: string[]`）。
  - summary：`content` 内所有 `p` 的 textContent 拼接；无 `p` 时取 `content.textContent`；`replace(/\s+/g, " ").trim()`；截断 5000。
  - hasCover：存在 `rel` 含 `image` 的 link。
  - nextOffset：`link[rel="next"]` 的 href，用 `new URL(href, "http://localhost")` 取 `offset`，非数字 → null。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/calibreFeed.test.ts`
Expected: PASS。

---

### Task F2: 书籍来源与 `loadBook` 覆盖选项

**Files:**
- Modify: `src/types/book.ts`
- Modify: `src/composables/useBookSession.ts`
- Test: `tests/useBookSession.test.ts`（追加）

**Interfaces:**
- Produces:
  - `BookSource` 与 `BookModel.source?: BookSource | null`
  - `BookSession.loadBook(meta, parsed, title, options?: { source?: BookSource | null; cover?: CoverAsset | null; forceTitle?: boolean }): void`
  - `BookSession.addSourceFormat(format: string): void`

- [ ] **Step 1: 写失败测试**

在 `tests/useBookSession.test.ts` 追加：

```ts
it("stores and restores the book source with undo", () => {
  const session = useBookSession();
  session.loadBook(metaA, parsedA, "A");
  session.loadBook(metaB, parsedB, "B", { source: SOURCE });
  expect(session.book.value.source).toEqual(SOURCE);
  session.undo();
  expect(session.book.value.source).toBeNull();
});

it("clears the cover when cover: null is passed", () => {
  const session = useBookSession();
  session.loadBook(metaA, parsedA, "A", { cover: COVER });
  session.loadBook(metaB, parsedB, "B", { cover: null });
  expect(session.book.value.cover).toBeNull();
});

it("forceTitle overrides a user-edited title", () => {
  const session = useBookSession();
  session.loadBook(metaA, parsedA, "A");
  session.updateMeta({ title: "手改" });
  session.loadBook(metaB, parsedB, "calibre 标题", { forceTitle: true });
  expect(session.book.value.meta.title).toBe("calibre 标题");
});

it("addSourceFormat updates formats without a new undo entry", () => {
  const session = useBookSession();
  session.loadBook(metaA, parsedA, "A", { source: { ...SOURCE, formats: ["TXT"] } });
  const undoBefore = session.canUndo.value;
  session.addSourceFormat("EPUB");
  expect(session.book.value.source?.formats).toEqual(["TXT", "EPUB"]);
  expect(session.canUndo.value).toBe(undoBefore);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/useBookSession.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

- `types/book.ts` 加 `BookSource`，`BookModel.source?: BookSource | null`。
- `toBookModel(meta, parsed, cover, source)` 复制 source（浅拷贝 + `formats: [...formats]`）。
- `loadBook`：
  - `forceTitle === true` 时 `nextTitle = requestedTitle || currentTitle`，并 `lastAutoTitle = nextTitle`；否则保持现有判定。
  - `cover`：`"cover" in options` 时用 `options.cover ?? null`，否则沿用 `current.cover`。
  - `source`：`options.source ?? null`。
- `addSourceFormat`：source 存在且未包含该格式时，替换 `book.value` 的 source（新对象、去重、大写），**不**压历史、不增加 `version`。
- `reset()` 后 source 自然为空。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/useBookSession.test.ts`
Expected: PASS。

---

### Task F3: `useImport.importBytes`、语言与来源

**Files:**
- Modify: `src/composables/useImport.ts`
- Test: `tests/useImport.test.ts`（追加）

**Interfaces:**
- Consumes: F2 的 `loadBook` 选项。
- Produces:
  - `UseImport.importBytes(bytes: Uint8Array, name: string, encoding: SourceEncoding, options?: { meta?: Partial<BookMeta>; source?: BookSource | null; cover?: CoverAsset | null }): Promise<boolean>`
  - `importFile` 行为不变。

- [ ] **Step 1: 写失败测试**

断言：
1. `importBytes(utf8Bytes("第一章 开始\n正文"), "book.txt", "auto", { meta: { title: "三体", author: "刘慈欣", language: "zh-CN", description: "简介" }, source: SOURCE, cover: COVER })` 成功后 `book.meta` 四项、`book.source`、`book.cover` 都正确。
2. `cover: null` 时清空旧封面。
3. 英文：`{ meta: { language: "en" } }` + 纯文本，`parseChapters` 的兜底标题为 `Content`（断言 `chapters[0].title`）。
4. `reparse` 后 source、书名、作者、简介、语言保持；`rawBytes` 已写入。
5. 不传 options 的 `importFile` 后 `book.source` 为 `null`。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/useImport.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

- `parseText(text, rules, language)` 把 language 传给 `parseChapters`。
- `importBytes`：
  - `decodeText(bytes, encoding)`；
  - `const language = options?.meta?.language ?? LANGUAGE`（`LANGUAGE = "zh-CN"`）；
  - `meta = { title: titleFromFileName(name), author: "", language, ...options?.meta }`；
  - `session.loadBook(meta, parsed, meta.title, { source: options?.source ?? null, ...(options?.cover !== undefined ? { cover: options.cover } : {}), ...(options?.source ? { forceTitle: true } : {}) })`；
  - 写入 `fileName`、`rawBytes`、编码状态。
- `importFile` 读取字节后调用 `importBytes`。
- `reparse`：使用 `session.book.value.meta.language`；标题在 `source` 存在时用当前 meta.title，否则用 `titleFromFileName(fileName)`；传 `source: session.book.value.source`；不传 cover（沿用）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/useImport.test.ts`
Expected: PASS。

---

### Task F4: `useCover.prepare` 与 `fromBlob`

**Files:**
- Modify: `src/composables/useCover.ts`
- Test: `tests/useCover.test.ts`（追加）

**Interfaces:**
- Produces:
  - `UseCover.prepare(blob: Blob, sourceName?: string): Promise<CoverAsset>`
  - `UseCover.fromBlob(blob: Blob, sourceName?: string): Promise<boolean>`

- [ ] **Step 1: 写失败测试**

- `prepare(pngBlob)` 返回 asset，`session.book.value.cover` 仍为旧值；
- `prepare` 对非 PNG 抛错；
- `prepare` 的 asset 尺寸来自 `measureImageSize`；
- `fromBlob(pngBlob)` 写入 session 并生成 object URL；
- `fromBlob` 失败时不改动现有封面，`error` 有值。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/useCover.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

- 抽 `loadAsset(load: (signal) => Promise<Blob>, sourceName?): Promise<CoverAsset>`：复用现有超时、PNG 校验、尺寸测量；失败抛现有错误。
- `prepare(blob)`：`loadAsset(async () => blob)`。
- `fromBlob(blob)`：`prepare` 后调用现有写入逻辑（preview + `session.setCover`）；失败走 `coverErrorMessage`。
- `run` 改为 `loadAsset` + 写入，保持现有行为。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/useCover.test.ts`
Expected: PASS。

---

### Task F5: API 客户端

**Files:**
- Modify: `src/core/api.ts`
- Test: `tests/api.test.ts`（追加）

**Interfaces:**
- Consumes: 索引中的 HTTP 契约。
- Produces：`api` 上新增：

```ts
calibreStatus(): Promise<CalibreSessionInfo>;
calibreConnect(input: { baseUrl: string; username: string; password: string }): Promise<CalibreSessionInfo>;
calibreReconnect(): Promise<CalibreSessionInfo>;
calibreDisconnect(): Promise<void>;
calibreForget(): Promise<void>;
calibreFeed(input: { offset?: number; q?: string; format?: string }): Promise<string>;
calibreTextFile(id: number): Promise<Blob>;
calibreCover(id: number): Promise<Blob>;
calibrePush(id: number, blob: Blob, filename: string, overwrite: boolean): Promise<void>;
```

- [ ] **Step 1: 写失败测试**

用现有 fetch mock 风格断言：
- `calibreFeed({ offset: 30, q: "三体", format: "txt" })` 请求 URL 为 `/api/calibre/feed?offset=30&q=%E4%B8%89%E4%BD%93&format=txt`；
- `calibreConnect` POST JSON，body 精确；
- `calibreTextFile(7)` 无 query；
- `calibrePush(7, blob, "三体.epub", true)` 的请求 URL 含 `?overwrite=true`，FormData 的 `file` 文件名正确；
- 404/502 抛 `ApiError`，code/message 来自错误体；
- `calibreDisconnect` 使用 DELETE，`calibreForget` 请求 `/api/calibre/credentials`。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/api.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

- 用 `URLSearchParams` 构造 feed query，空值不写。
- `calibreFeed` 用 `request(...)` 后 `response.text()`；`accept: application/atom+xml`。
- `calibreTextFile` 返回 `Blob`，`accept: application/octet-stream`。
- `calibreCover` 返回 `Blob`，`accept: image/png`，并校验 content-type 含 `image/png`。
- `calibrePush` 构造 `FormData`，`form.append("file", blob, filename)`；`overwrite` 放在 query。
- DELETE 请求不带 body。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/api.test.ts`
Expected: PASS。

---

### Task F6: `useCalibre`

**Files:**
- Create: `src/composables/useCalibre.ts`
- Test: `tests/useCalibre.test.ts`

**Interfaces:**
- Consumes: F1–F5。
- Produces：

```ts
export interface CalibreClient {
  status(): Promise<CalibreSessionInfo>;
  connect(input: { baseUrl: string; username: string; password: string }): Promise<CalibreSessionInfo>;
  reconnect(): Promise<CalibreSessionInfo>;
  disconnect(): Promise<void>;
  forget(): Promise<void>;
  feed(input: { offset?: number; q?: string; format?: string }): Promise<string>;
  textFile(id: number): Promise<Blob>;
  cover(id: number): Promise<Blob>;
  push(id: number, blob: Blob, filename: string, overwrite: boolean): Promise<void>;
}

export interface UseCalibre {
  info: Ref<CalibreSessionInfo | null>;
  books: Ref<CalibreBook[]>;
  query: Ref<string>;
  txtOnly: Ref<boolean>;
  loading: Ref<boolean>;
  error: Ref<string>;
  notice: Ref<string>;
  nextOffset: Ref<number | null>;
  connecting: Ref<boolean>;
  pushing: Ref<boolean>;
  linkedBook: ComputedRef<BookSource | null>;
  canPush: ComputedRef<boolean>;
  loadStatus(): Promise<void>;
  connect(input: { baseUrl: string; username: string; password: string }): Promise<boolean>;
  resume(): Promise<boolean>;
  disconnect(): Promise<void>;
  forget(): Promise<void>;
  refresh(): Promise<void>;
  loadMore(): Promise<void>;
  importBook(book: CalibreBook): Promise<boolean>;
  push(blob: Blob, filename: string): Promise<boolean>;
  clearLocal(): void;
}

export function useCalibre(deps: {
  session: BookSession;
  importer: Pick<UseImport, "importBytes">;
  cover: Pick<UseCover, "prepare">;
  client?: CalibreClient;
  confirm?: (message: string) => boolean;
}): UseCalibre;
```

- [ ] **Step 1: 写失败测试**

用假 client / 假 importer / 假 cover / 真实 `useBookSession`：
1. `connect` 成功保存 info、清空并加载第一页。
2. `loadStatus` 后 `saved && !connected` → `resume` 被调用一次；失败后 `info.saved` 仍为 true、`error` 有中文提示。
3. `refresh` 在 `txtOnly` 下丢弃无 TXT；若第一页全被过滤且 `nextOffset=30`，自动取第二页；连续 3 页仍空则停止并显示 notice。
4. `importBook`：先 `textFile`，有封面时 `cover`，再 `importer.importBytes`；`source` 的 origin/bookId/formats 正确；无封面时 `cover` 参数为 `null`。
5. `push` 成功 → `session.addSourceFormat("EPUB")`；客户端收到 `overwrite=false`。
6. `push` 抛 `ApiError(409,"CALIBRE_EPUB_EXISTS")` + `confirm=true` → 第二次调用 `overwrite=true`；`confirm=false` → 不重试、返回 false、notice 提示已取消。
7. `canPush` 在 info.canPush=false 或 origin 不匹配时为 false。
8. `disconnect` 后 `autoResumeSuppressed` 生效：再调用 `loadStatus` 不自动 resume；`forget` 清空 info 与 books。
9. 错误映射：`CALIBRE_AUTH_FAILED`、`CALIBRE_TIMEOUT`、`CALIBRE_TOO_LARGE` 有对应中文文案。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/useCalibre.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

- 默认 `client` 是一个薄适配器（不是直接传 `api`）：

  ```ts
  const client = deps.client ?? {
    status: () => api.calibreStatus(),
    connect: (input) => api.calibreConnect(input),
    reconnect: () => api.calibreReconnect(),
    disconnect: () => api.calibreDisconnect(),
    forget: () => api.calibreForget(),
    feed: (input) => api.calibreFeed(input),
    textFile: (id) => api.calibreTextFile(id),
    cover: (id) => api.calibreCover(id),
    push: (id, blob, filename, overwrite) => api.calibrePush(id, blob, filename, overwrite),
  };
  ```

- `confirm` 默认 `window.confirm`。
- `parseOpdsFeed` 解析 feed；`fetchPage(offset)` 返回 `{ books, nextOffset }`。
- `refresh` / `loadMore` 共用 `appendPage(offset)`：
  - 循环最多 3 页；`txtOnly` 时过滤 `formats.includes("TXT")`；过滤后为空且 `nextOffset !== null` 继续取，否则停止。
  - `nextOffset` 始终以最后一次上游响应为准。
- `importBook`：
  - `const blob = await client.textFile(id)`；`const bytes = new Uint8Array(await blob.arrayBuffer())`；
  - 文件名 `${safeTitle}.txt`（去掉 `/\` 与控制字符，空则 `book`）；
  - 封面：`book.hasCover ? await cover.prepare(await client.cover(id)) : null`；任何异常记录 notice 并按 `null`；
  - meta：`title`、`author = authors.join("、")`、`language = mapCalibreLanguage(book.language)`、`description = summary || undefined`；
  - `source = { kind: "calibre-web", origin: new URL(info.baseUrl!).origin, bookId: id, title, formats: [...book.formats] }`；
  - `await importer.importBytes(bytes, filename, "auto", { meta, source, cover })`。
- `push`：调用 `client.push(id, blob, filename, false)`；捕获 `ApiError` 且 `code === "CALIBRE_EPUB_EXISTS"` → `confirm("该书已有 EPUB，推送会覆盖原文件，是否继续？")`；确认则 `addSourceFormat` 前先 `client.push(..., true)`。
- `clearLocal`：`info=null, books=[], nextOffset=null, error="", notice=""`，不改 session 书籍。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/useCalibre.test.ts`
Expected: PASS。

---

### Task F7: 书库面板与行组件

**Files:**
- Create: `src/components/CalibreBookRow.vue`
- Create: `src/components/CalibrePanel.vue`
- Test: `tests/CalibrePanel.test.ts`

**Interfaces:**
- Consumes: `UseCalibre`（F6）。
- Produces:
  - `CalibreBookRow` props `{ book: CalibreBook; linked: boolean }`，emit `import`。
  - `CalibrePanel` props `{ calibre: UseCalibre }`。

- [ ] **Step 1: 写失败测试**

- 未连接：显示地址/账号/密码输入与「连接」按钮；提交调用 `calibre.connect`。
- 存在 saved 且未连接：显示「已保存连接」与预填地址/账号，不显示密码值。
- 已连接：显示地址、账号、「刷新」「修改连接」「断开连接」「忘记凭据」。
- 搜索输入 300ms 防抖后设置 `calibre.query` 并触发 `refresh`。
- 「只看有 TXT 的」绑定 `txtOnly`。
- 列表：无 TXT 的行「导入」禁用并显示「无 TXT」；有 TXT 的行点击调用 `importBook`。
- `nextOffset !== null` 时显示「加载更多」，点击调用 `loadMore`。
- `loading` 时显示加载态；`error` 用 `role="alert"`；`notice` 用 `role="status"`；空列表显示空态。
- 断开/忘记触发 `window.confirm`，取消时不调用。
- 关联书籍显示「已关联」，来自另一实例时显示对应提示。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/CalibrePanel.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现组件**

- 组件从 `calibre` 读取状态，不自己持有业务状态；本地只保留地址/账号/密码表单字段与「修改连接」展开状态。
- 密码输入 `type="password"`、`autocomplete="off"`；连接成功后立即清空本地密码变量。
- 搜索使用 `setTimeout` 300ms；卸载时清理。
- 样式沿用 `card`、`field`、`btn`、`option-hint` 等现有 class；不新增内联样式。
- 错误与提示分别用 `role="alert"` / `role="status"`。
- 行组件展示格式徽标（TXT/EPUB）与导入按钮；按钮 `:disabled="!book.formats.includes('TXT')"`。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/CalibrePanel.test.ts`
Expected: PASS。

---

### Task F8: 共享 `useImport` / `useCover` 注入

**Files:**
- Modify: `src/components/UploadPanel.vue`
- Modify: `src/components/CoverPanel.vue`
- Test: `tests/UploadPanel.test.ts`（追加）
- Test: `tests/CoverPanel.test.ts`（追加）

**Interfaces:**
- Produces:
  - `UploadPanel` props 追加 `importer?: UseImport`
  - `CoverPanel` props 追加 `controller?: UseCover`

- [ ] **Step 1: 写失败测试**

- 传入假 `importer` 时，选择文件调用假 `importFile`，不创建内部实例（用一个 `vi.fn` 断言）。
- 不传时保持现有行为（现有测试继续通过）。
- `CoverPanel` 传入假 controller 时，「抓取」按钮调用它的 `fromUrl`；不传时用内部实例。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/UploadPanel.test.ts tests/CoverPanel.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

```ts
const props = defineProps<{ session: BookSession; rules?: ChapterRule[]; importer?: UseImport }>();
const importer = props.importer ?? useImport(props.session);
```

`CoverPanel` 同理：`const controller = props.controller ?? useCover(props.session)`，模板中改用 `controller.*`。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/UploadPanel.test.ts tests/CoverPanel.test.ts`
Expected: PASS。

---

### Task F9: App 装配、导出推送与登出清理

**Files:**
- Modify: `src/App.vue`
- Modify: `src/components/ExportPanel.vue`
- Test: `tests/ExportPanel.test.ts`（追加）
- Test: `tests/App.test.ts`（追加）

**Interfaces:**
- Consumes: F5–F8。
- Produces:
  - `ExportPanel`：
  - 新增 props：`canPush?: boolean`、`pushToCalibre?: boolean`、`calibreTitle?: string`、`hasEpub?: boolean`、`pushing?: boolean`；emit `update:pushToCalibre`。
  - `showPush = canPush && selected.id === "epub"`；只在 `showPush` 为真时渲染复选框与警告。
  - 父级监听 `linkedBook`：变化时设 `pushToCalibre = canPush && !hasEpub`；`hasEpub` 变为 true 时自动取消勾选。
  - `pushing=true` 时按钮文案为「正在推送」且禁用；进度区显示「正在推送到 Calibre-Web…」。
  - App 内共享 `importer`、`coverController`、`calibre`。

- [ ] **Step 1: 写失败测试**

`tests/ExportPanel.test.ts`：
- `canPush=false` 时不显示推送复选框；
- `canPush=true` 时显示，勾选切换 emit `update:pushToCalibre`；
- `hasEpub=true` 时显示覆盖警告，且复选框未勾选；
- `pushing=true` 时按钮文案为「正在推送」且禁用。

`tests/App.test.ts`：
- 选择 EPUB 且勾选推送时，`converterRegistry.epub.convert` 后调用 `calibre.push`，成功 Toast 含「已推送」；
- 推送失败时 Toast 同时说明「已下载」；
- 登出/401 后调用 `calibre.clearLocal()`。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/ExportPanel.test.ts tests/App.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

- App setup：
  ```ts
  const importer = useImport(session);
  const coverController = useCover(session);
  const calibre = useCalibre({ session, importer, cover: coverController });
  ```
  传给 `UploadPanel :importer`、`CoverPanel :controller`、`CalibrePanel :calibre`、`ExportPanel` 的推送 props。
- 登录成功后（`authenticated` 变 true）调用 `calibre.loadStatus()`；它内部在 `saved && !connected` 时自动 resume 一次。
- `onLogout` / `handleUnauthorized` 调用 `calibre.clearLocal()`。
- `onExport`：
  - 保持现有转换、进度、下载逻辑；
  - 下载完成后，若 `request.format === "epub" && pushToCalibre && calibre.canPush.value`：
    - `pushing.value = true`；
    - `await calibre.push(blob, filename)`；
    - 成功 Toast `已推送到 Calibre-Web「${linkedBook.title}」`；
    - 失败 Toast `已下载，但推送失败：${calibre.error}`；
    - 最终 `pushing.value = false`。
- `ExportPanel`：新增复选框与警告；`busy || pushing` 时禁用导出；按钮文案按 `pushing` 切换。
- `canPush` 由 App 计算：`calibre.canPush.value && format === "epub"`（格式变化通过 `ExportPanel` 内部状态，父级用 `v-model` 或由 ExportPanel 自己按 `canPush` 与 `selected.id` 判断；选后者，父级只传 `canPush`）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/ExportPanel.test.ts tests/App.test.ts`
Expected: PASS。

- [ ] **Step 5: 全量前端验证**

Run: `npm run typecheck && npx vitest run`
Expected: 全部通过。
