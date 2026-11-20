# calibre-web 服务端实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 `/api/calibre/*` 服务端能力：连接 calibre-web、代理 OPDS、下载 TXT/封面、推送 EPUB，并加密保存连接配置。

**Architecture:** `server/lib/calibre/` 分层为 URL 策略、HTTP 客户端、纯函数构造器、加密存储与业务 service；路由只做参数校验、限流与错误映射。所有上游访问固定已连接 origin 的 DNS 结果。

**Tech Stack:** Node 22、Fastify 5、`node:http(s)`、`node:dns/promises`、`node:crypto`、Vitest。

**Spec:** `docs/superpowers/specs/2026-11-19-calibre-web-integration-design.md`

## 全局约束

- 不新增运行时依赖。
- 不执行 `git add` / `commit` / `push`。
- 每个任务结束前运行该任务的测试命令并确认通过。
- 上游 401 一律映射为 `400 CALIBRE_AUTH_FAILED`，绝不返回 401。
- 任何错误消息不得包含主机名、IP、上游 HTML、密码或 Cookie。
- 测试中的假 calibre-web 用 `node:http` 启在 `127.0.0.1:0`；用 `lookup` 注入避免真实 DNS。
- 本计划不改 `src/**`、`README.md`、`AGENTS.md`。

## Review Focus

- 私网允许时，云元数据与链路本地地址仍必须拒绝（S1）。
- 配置文件不得含明文地址/账号/密码（S2）。
- 跨 origin 重定向必须拒绝（S3）。
- 推送前必须真实预检 EPUB 是否存在（S6）。
- 上游 401 不得触发前端登出（S7）。

---

### Task S1: 配置项、地址策略与错误类型

**Files:**
- Modify: `server/lib/config.ts`
- Modify: `server/lib/ssrf.ts`
- Create: `server/lib/calibre/types.ts`
- Create: `server/lib/calibre/target.ts`
- Test: `tests/server/calibreTarget.test.ts`
- Test: `tests/server/config.test.ts`（追加）

**Interfaces:**
- Produces:
  - `AppConfig.calibreAllowPrivate: boolean` 等 10 个字段（见索引）。
  - `class CalibreError extends Error { readonly code: CalibreErrorCode; readonly statusCode: number }`
  - `type CalibreErrorCode = "CALIBRE_INVALID_URL" | "CALIBRE_INVALID_REQUEST" | "CALIBRE_AUTH_FAILED" | "CALIBRE_PUSH_UNAVAILABLE" | "CALIBRE_PUSH_FORBIDDEN" | "CALIBRE_NOT_FOUND" | "CALIBRE_FORMAT_UNAVAILABLE" | "CALIBRE_NO_COVER" | "CALIBRE_NOT_CONNECTED" | "CALIBRE_EPUB_EXISTS" | "CALIBRE_TOO_LARGE" | "CALIBRE_BUSY" | "CALIBRE_RATE_LIMITED" | "CALIBRE_UNREACHABLE" | "CALIBRE_UPSTREAM" | "CALIBRE_PUSH_UNVERIFIED" | "CALIBRE_TIMEOUT" | "CALIBRE_CONFIG"`
  - `interface CalibreBase { url: URL; baseUrl: string; origin: string; basePath: string }`
  - `interface CalibreTarget extends CalibreBase { address: string; family: 4 | 6 }`
  - `parseCalibreBaseUrl(raw: string): CalibreBase`
  - `resolveCalibreTarget(raw: string, opts: { allowPrivate: boolean; lookup?: LookupFn }): Promise<CalibreTarget>`
  - `ssrf.isAllowedPort(port: number): boolean`
  - `ssrf.isAlwaysBlockedIp(ip: string): boolean`

- [ ] **Step 1: 写失败测试**

`tests/server/calibreTarget.test.ts`：

```ts
// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CalibreError } from "../../server/lib/calibre/types";
import { parseCalibreBaseUrl, resolveCalibreTarget } from "../../server/lib/calibre/target";

const lookupTo = (...addresses: string[]) => async () =>
  addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

function codeOf(fn: () => unknown): string {
  try { fn(); } catch (error) { return (error as CalibreError).code; }
  return "NO_ERROR";
}

describe("parseCalibreBaseUrl", () => {
  it("normalizes origin, subpath and trailing slash", () => {
    expect(parseCalibreBaseUrl("https://books.example.com/calibre/")).toMatchObject({
      baseUrl: "https://books.example.com/calibre",
      origin: "https://books.example.com",
      basePath: "/calibre",
    });
    expect(parseCalibreBaseUrl("http://192.168.1.10:8083").basePath).toBe("");
  });

  it.each([
    "ftp://host",
    "https://user:pass@host",
    "https://host/?a=1",
    "https://host/#x",
    `https://host/${"a".repeat(2048)}`,
  ])("rejects %s", (raw) => {
    expect(codeOf(() => parseCalibreBaseUrl(raw))).toBe("CALIBRE_INVALID_URL");
  });
});

describe("resolveCalibreTarget", () => {
  it("allows private addresses when enabled", async () => {
    const target = await resolveCalibreTarget("http://192.168.1.10:8083", {
      allowPrivate: true, lookup: lookupTo("192.168.1.10"),
    });
    expect(target.address).toBe("192.168.1.10");
  });

  it("rejects private addresses when disabled", async () => {
    await expect(resolveCalibreTarget("http://192.168.1.10:8083", {
      allowPrivate: false, lookup: lookupTo("192.168.1.10"),
    })).rejects.toMatchObject({ code: "CALIBRE_INVALID_URL" });
  });

  it.each(["169.254.169.254", "100.100.100.200", "fe80::1"])(
    "always rejects metadata/link-local %s", async (address) => {
      await expect(resolveCalibreTarget("http://calibre.local:8083", {
        allowPrivate: true, lookup: lookupTo(address),
      })).rejects.toMatchObject({ code: "CALIBRE_INVALID_URL" });
    },
  );
});
```

`tests/server/config.test.ts` 追加：

```ts
it("loads calibre defaults and overrides", () => {
  const base = loadConfig(env({ SESSION_SECRET: SECRET, AUTH_PASSWORD_HASH: "h" }));
  expect(base.calibreAllowPrivate).toBe(true);
  expect(base.calibreStorePath).toBe("./data/calibre-connection.json");
  expect(base.calibrePushTimeoutMs).toBe(120_000);
  const custom = loadConfig(env({
    SESSION_SECRET: SECRET, AUTH_PASSWORD_HASH: "h",
    CALIBRE_ALLOW_PRIVATE: "false", CALIBRE_PUSH_TIMEOUT_MS: "90000",
  }));
  expect(custom.calibreAllowPrivate).toBe(false);
  expect(custom.calibrePushTimeoutMs).toBe(90_000);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/server/calibreTarget.test.ts tests/server/config.test.ts`
Expected: FAIL，模块或字段不存在。

- [ ] **Step 3: 实现 config、ssrf 导出与 target**

- `config.ts`：按索引表加入 10 个字段与 `readFlag` / `readPositiveInt` / `readString` 解析；`CALIBRE_STORE_PATH` 用 `readString(env.CALIBRE_STORE_PATH, "./data/calibre-connection.json")`。
- `ssrf.ts`：导出 `isAllowedPort`；新增 `isAlwaysBlockedIp(ip)`，只在 `allowPrivate` 模式下使用，始终拒绝：
  - IPv4：`0.0.0.0/8`、`169.254.0.0/16`、`224.0.0.0/4`、`240.0.0.0/4`、`100.100.100.200`；
  - IPv6：`::/128`、`fe80::/10`、`ff00::/8`、`fec0::/10`。
  复用文件内已有的 `parseIpv4` / `parseIpv6` / `normalizeIp`，不要复制解析逻辑。
- `target.ts`：
  - `parseCalibreBaseUrl`：trim、长度 ≤ 2048、仅 http/https、无 userinfo/query/hash、端口走 `isAllowedPort`；`basePath` 去掉尾部 `/`，根路径为 `""`。
  - 主机名始终拒绝 `metadata`、`instance-data`、`metadata.google.internal`；`allowPrivate=false` 时再拒绝 `localhost`、`*.local`、`*.internal`、`*.lan`、`home.arpa`。
  - IP 字面量：`allowPrivate` 时用 `isAlwaysBlockedIp`，否则用 `isBlockedIp`。
  - DNS：注入 `lookup`，默认 `dnsLookup(hostname, { all: true, verbatim: true })`；任一地址被策略拒绝则整体拒绝；返回第一个合法地址与 family。
  - 所有拒绝抛 `new CalibreError("CALIBRE_INVALID_URL", 400, "calibre-web 地址无效或不可访问。")`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/server/calibreTarget.test.ts tests/server/config.test.ts tests/server/ssrf.test.ts`
Expected: PASS。

---

### Task S2: 加密配置存储

**Files:**
- Modify: `server/lib/calibre/types.ts`
- Create: `server/lib/calibre/crypto.ts`
- Create: `server/lib/calibre/store.ts`
- Test: `tests/server/calibreStore.test.ts`

**Interfaces:**
- Produces:
  - `interface SavedCalibrePayload { baseUrl: string; username: string; password: string }`
  - `interface SavedCalibreFile { version: 1; iv: string; tag: string; data: string }`
  - `deriveConfigKey(sessionSecret: string): Buffer`
  - `encryptSaved(payload: SavedCalibrePayload, key: Buffer): SavedCalibreFile`
  - `decryptSaved(file: SavedCalibreFile, key: Buffer): SavedCalibrePayload | null`
  - `createCalibreStore(opts: { path: string; key: Buffer | null; enabled: boolean }): CalibreStore`
  - `interface CalibreStore { loadSaved(): Promise<SavedCalibrePayload | null>; saveSaved(p: SavedCalibrePayload): Promise<boolean>; clearSaved(): Promise<void> }`

- [ ] **Step 1: 写失败测试**

`tests/server/calibreStore.test.ts`：

```ts
// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveConfigKey, encryptSaved, decryptSaved } from "../../server/lib/calibre/crypto";
import { createCalibreStore } from "../../server/lib/calibre/store";

const KEY = deriveConfigKey("s".repeat(32));
const PAYLOAD = { baseUrl: "https://books.example.com", username: "alice", password: "s3cret" };
const dirs: string[] = [];

async function tempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "calibre-store-"));
  dirs.push(dir);
  return join(dir, "nested", "calibre.json");
}
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe("crypto", () => {
  it("round-trips and never writes plaintext fields", async () => {
    const file = encryptSaved(PAYLOAD, KEY);
    expect(JSON.stringify(file)).not.toContain("s3cret");
    expect(decryptSaved(file, KEY)).toEqual(PAYLOAD);
  });
  it("returns null for a wrong key or tampered file", () => {
    const file = encryptSaved(PAYLOAD, KEY);
    expect(decryptSaved(file, deriveConfigKey("x".repeat(32)))).toBeNull();
    expect(decryptSaved({ ...file, tag: Buffer.alloc(16).toString("base64") }, KEY)).toBeNull();
  });
});

describe("store", () => {
  it("saves atomically and loads", async () => {
    const path = await tempPath();
    const store = createCalibreStore({ path, key: KEY, enabled: true });
    expect(await store.saveSaved(PAYLOAD)).toBe(true);
    expect(await store.loadSaved()).toEqual(PAYLOAD);
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("s3cret");
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
  it("ignores corrupt files and keeps them", async () => {
    const path = await tempPath();
    const store = createCalibreStore({ path, key: KEY, enabled: true });
    await store.saveSaved(PAYLOAD);
    await writeFile(path, "{not json");
    expect(await store.loadSaved()).toBeNull();
    expect((await readFile(path, "utf8"))).toBe("{not json");
  });
  it("returns false when the path cannot be written", async () => {
    const dir = await mkdtemp(join(tmpdir(), "calibre-store-"));
    dirs.push(dir);
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "file");
    const store = createCalibreStore({
      path: join(blocker, "calibre.json"), key: KEY, enabled: true,
    });
    expect(await store.saveSaved(PAYLOAD)).toBe(false);
  });
  it("does nothing when disabled", async () => {
    const path = await tempPath();
    const store = createCalibreStore({ path, key: null, enabled: false });
    expect(await store.saveSaved(PAYLOAD)).toBe(false);
    expect(await store.loadSaved()).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/server/calibreStore.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 crypto 与 store**

- `crypto.ts`：
  - `deriveConfigKey` 用 `hkdfSync("sha256", secret, "txt2book", "calibre-credentials", 32)`。
  - `encryptSaved`：`randomBytes(12)`，`aes-256-gcm`，输出 base64 的 iv/tag/data。
  - `decryptSaved`：校验 `version === 1` 与 base64 长度；任何异常返回 `null`。
- `store.ts`：
  - `loadSaved`：`enabled && key` 才读；`JSON.parse` + `decryptSaved`；任何失败返回 `null`。
  - `saveSaved`：`enabled && key` 才写；`mkdir(dirname, { recursive: true })`；写 `${path}.tmp`，`chmod 0o600`，`rename`；失败清理 tmp 并返回 `false`。
  - `clearSaved`：`unlink`，忽略 `ENOENT`。
  - 内部用一个 `Promise` 链串行化写操作。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/server/calibreStore.test.ts`
Expected: PASS。

---

### Task S3: 固定 DNS 的 HTTP 客户端

**Files:**
- Create: `server/lib/calibre/client.ts`
- Test: `tests/server/calibreClient.test.ts`

**Interfaces:**
- Consumes: `CalibreTarget`、`CalibreError`（S1）。
- Produces:
  - `interface CalibreHttpOptions { method?: string; headers?: Record<string, string>; body?: Buffer; timeoutMs: number; maxBytes: number; cookies?: ReadonlyMap<string, string>; collectCookies?: Map<string, string>; redirects?: number; headersOnly?: boolean }`
  - `interface CalibreHttpResponse { status: number; headers: IncomingHttpHeaders; body: Buffer; location?: string; url: URL }`
  - `calibreRequest(target: CalibreTarget, path: string, opts: CalibreHttpOptions): Promise<CalibreHttpResponse>`

- [ ] **Step 1: 写失败测试**

覆盖：
1. 正确发送 method、body、`Authorization`、`Host`，返回响应体。
2. 收集 `Set-Cookie` 到注入的 Map，忽略 `Max-Age=0`。
3. `maxBytes` 超限抛 `CALIBRE_TOO_LARGE`（413）。
4. 超时抛 `CALIBRE_TIMEOUT`（504）。
5. GET 同 origin 302 跟随；跨 origin 302 抛 `CALIBRE_UPSTREAM`。
6. `headersOnly` 立即结束且不读取大响应体。
7. 连接拒绝抛 `CALIBRE_UNREACHABLE`。

测试用 `createServer` 起本地服务，`target` 手工构造：

```ts
const target = {
  url: new URL(`http://127.0.0.1:${port}`),
  baseUrl: `http://127.0.0.1:${port}`,
  origin: `http://127.0.0.1:${port}`,
  basePath: "",
  address: "127.0.0.1",
  family: 4,
} as const;
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/server/calibreClient.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 `calibreRequest`**

- 用 `http.request` / `https.request`，`lookup` 固定 `target.address`；`servername` 用于 https。
- 路径必须是 `target.basePath + path`，并校验 `path` 以 `/` 开头。
- 默认头：`user-agent: txt2book-calibre/1.0`、`accept: */*`、`connection: close`；Cookie 由 `cookies` 拼 `name=value; ...`。
- 总超时用一个 `setTimeout`，触发后 `request.destroy()` 并 reject `CALIBRE_TIMEOUT`。
- 响应累计字节，超过 `maxBytes` 立即 `destroy()` 并抛 `CALIBRE_TOO_LARGE`；`headersOnly` 在收到响应头后立即 `destroy()` 并返回空 body。
- 3xx：仅当方法为 GET/HEAD 且 `redirects > 0` 时跟随；目标 origin 必须等于 `target.origin`，否则抛 `CALIBRE_UPSTREAM`；跟随次数上限 3。
- 网络错误统一 `CALIBRE_UNREACHABLE`；不要透传 `error.message`。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/server/calibreClient.test.ts`
Expected: PASS。

---

### Task S4: OPDS 路径、CSRF 与 multipart 纯函数

**Files:**
- Create: `server/lib/calibre/opds.ts`
- Create: `server/lib/calibre/login.ts`
- Test: `tests/server/calibrePure.test.ts`

**Interfaces:**
- Produces:
  - `buildFeedPath(input: { q?: string; format?: string; offset?: number }): string`
  - `buildDownloadPath(bookId: number, format: string): string`
  - `buildCoverPath(bookId: number): string`
  - `extractCsrfToken(html: string): string | null`
  - `buildLoginBody(username: string, password: string, csrf: string): string`
  - `sanitizeEpubFilename(title: string): string`
  - `buildMultipartBody(input: { boundary: string; fields: Record<string, string>; file: { field: string; filename: string; contentType: string; data: Buffer } }): Buffer`

- [ ] **Step 1: 写失败测试**

断言：
- `buildFeedPath({})` → `/opds/books/letter/00`；
- `buildFeedPath({ offset: 30 })` → `...?offset=30`；
- `buildFeedPath({ format: "TXT" })` → `/opds/formats/txt`；
- `buildFeedPath({ q: "三体 & 地球", format: "txt" })` → `/opds/search/%E4%B8%89%E4%BD%93%20%26%20%E5%9C%B0%E7%90%83`（q 优先，无 offset）；
- `buildDownloadPath(12, "TXT")` → `/opds/download/12/txt/`；
- 非法 id（0、负数、小数）抛 `CALIBRE_NOT_FOUND`；非法 format 抛 `CALIBRE_INVALID_REQUEST`。
- `extractCsrfToken` 支持：`<input name="csrf_token" value="a">`、属性顺序颠倒、单引号、`<meta name="csrf_token" content="b">`；无 token → `null`。
- `buildLoginBody("a b", "p&=", "t")` → `username=a+b&password=p%26%3D&remember_me=on&csrf_token=t`。
- `sanitizeEpubFilename('a/b:c*?"<>|d')` → `abc d.epub` 这类清洗结果；空标题 → `book.epub`；长度 ≤ 124。
- `buildMultipartBody` 输出包含 `name="csrf_token"`、`name="book_id"`、`name="btn-upload-format"; filename="book.epub"`、`Content-Type: application/epub+zip`、结尾 `--BOUNDARY--\r\n`。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/server/calibrePure.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现纯函数**

- `opds.ts`：bookId 必须是正整数；format 匹配 `/^[a-z0-9]{1,8}$/i`。q 用 `encodeURIComponent`，offset 只有 `> 0` 才追加。
- `login.ts`：
  - `extractCsrfToken` 先找所有 `<input ...>`，属性用独立正则解析 `name`/`value`，兼容属性顺序与单双引号；再找 `<meta ... name="csrf_token" ... content="...">`。
  - `buildLoginBody` 用 `URLSearchParams`。
  - `sanitizeEpubFilename` 去掉 `/\:*?"<>|` 与控制字符，压缩空白，去掉首尾点和空格，截断到 120 字符，空值回退 `book`，追加 `.epub`。
  - `buildMultipartBody` 按 RFC 7578 组装；字段顺序固定 `csrf_token`、`book_id`，最后是文件；文件名与字段名做 CR/LF 转义。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/server/calibrePure.test.ts`
Expected: PASS。

---

### Task S5: service 连接、恢复与读取

**Files:**
- Create: `server/lib/calibre/service.ts`
- Create: `tests/server/calibreFake.ts`
- Test: `tests/server/calibreService.test.ts`

**Interfaces:**
- Consumes: S1–S4 全部。
- Produces:
  - `interface CalibreService { status(): Promise<CalibreSessionInfo>; connect(input): Promise<CalibreSessionInfo>; resume(): Promise<CalibreSessionInfo>; disconnect(): void; forget(): Promise<void>; feed(input): Promise<string>; textFile(id: number): Promise<Buffer>; coverPng(id: number): Promise<Buffer>; pushEpub(...): Promise<void>; clearLive(): void }`
  - `createCalibreService(config: AppConfig, deps?: { lookup?: LookupFn; store?: CalibreStore }): CalibreService`
  - `CalibreSessionInfo` 类型定义在 `types.ts`。

- [ ] **Step 1: 写假 calibre-web 与失败测试**

`tests/server/calibreFake.ts` 提供：

```ts
export interface FakeCalibreOptions {
  username: string;
  password: string;
  books?: Array<{ id: number; title: string; author: string; formats: string[]; language?: string }>;
  loginWorks?: boolean;
}
export async function startCalibreFake(options: FakeCalibreOptions): Promise<{
  baseUrl: string;
  requests: Array<{ method: string; path: string; auth?: string }>;
  close(): Promise<void>;
}>;
```

假服务实现：
- `GET /opds/`：Basic 正确 → 200 Atom feed；否则 401。
- `GET /login`：返回含 `csrf_token` 的表单。
- `POST /login`：校验表单；成功 → 302 `/` + `Set-Cookie: session=fake`；失败 → 200 登录页。
- `GET /opds/books/letter/00`、`/opds/formats/txt`、`/opds/search/:q`：返回含 entry 的 XML。
- `GET /opds/download/:id/txt/`：返回 `第一行\n第二行`。
- `GET /opds/cover/:id`：返回 1×1 PNG（用固定 base64）。

测试断言：
- 除持久化用例外，注入 `store: createCalibreStore({ path: join(tmpdir(), "none.json"), key: null, enabled: false })`，避免写真实文件；`saved` 期望为 `false`。
- `connect` 成功返回 `{connected:true,saved:false,canPush:true}`；请求头带 Basic。
- 密码错误 → `CALIBRE_AUTH_FAILED`。
- OPDS 可读但登录失败 → `connected:true, canPush:false`，`pushReason` 非空。
- `status()` 未连接时 `{connected:false,saved:false}`。
- `feed` 返回上游 XML 原文；`format=txt` 走 `/opds/formats/txt`；`q` 走 `/opds/search/...`。
- `textFile(1)` 返回字节；未知 id → `CALIBRE_NOT_FOUND`。
- `coverPng(1)` 返回 PNG；无封面 → `CALIBRE_NO_COVER`。
- 未连接且无 saved → `CALIBRE_NOT_CONNECTED`。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/server/calibreService.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 service 的连接与读取**

- `connect`：
  1. 若已有连接尝试在途，抛 `CALIBRE_BUSY`（429）；用 `try/finally` 释放。
  2. `resolveCalibreTarget(baseUrl, { allowPrivate: config.calibreAllowPrivate, lookup })`。
  3. `GET /opds/`，Basic，`maxBytes: 2MB`，`timeoutMs: config.calibreTimeoutMs`；401/403 → `CALIBRE_AUTH_FAILED`；非 200 → `CALIBRE_UPSTREAM`；body 不含 `<feed` → `CALIBRE_UPSTREAM`。
  4. 登录测试：`GET /login` 取 token（找不到也继续，发送空 token）→ `POST /login`；成功 = 收到 `session` cookie，且（3xx 且 `location` 不含 `/login`，或 200 且响应体不含密码输入框）。失败不阻断连接，只设 `canPush=false` 与固定中文原因。
  5. 写入 `connection`；`store.saveSaved({ baseUrl, username, password })`，失败忽略。
- `resume`：`store.loadSaved()`；空 → `CALIBRE_NOT_CONNECTED`；否则用保存值调用 `connect`。
- `status`：`store.loadSaved()` 仅用于 `saved` 与地址/账号回显；`connected` 取内存连接。
- `disconnect` / `clearLive`：清空内存连接与 cookie。
- `forget`：清空内存并 `store.clearSaved()`。
- `feed` / `textFile` / `coverPng`：先 `ensureConnection()`（内存为空且有 saved 时尝试一次 `resume`，用一个 `resumePromise` 去重）；按 S4 构造路径；Basic + 已存 cookie；错误码按索引表映射；`coverPng` 用 `toImage(body, { maxBytes: config.maxCoverBytes, format: "png" })` 并映射 `CoverError`。
- **不要**在 service 内做限流或 FD 管理；那是路由职责。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/server/calibreService.test.ts`
Expected: PASS。

---

### Task S6: 推送 EPUB

**Files:**
- Modify: `server/lib/calibre/service.ts`
- Test: `tests/server/calibrePush.test.ts`

**Interfaces:**
- Consumes: S5 的连接、登录、client、构造器。
- Produces: `pushEpub(bookId: number, data: Buffer, filename: string, overwrite: boolean): Promise<void>`

- [ ] **Step 1: 写失败测试**

假服务扩展：
- `GET /opds/download/:id/epub/`：按 `hasEpub` 返回 200 或 404。
- `GET /admin/book/:id`：返回含 `csrf_token` 的 HTML。
- `POST /upload`：解析 multipart，记录 `book_id`、`csrf_token`、文件名、内容；按测试场景返回 200/403/302。

测试：
1. 无 EPUB：预检 404 → 登录 → 上传 → 确认 200 → 成功；`/upload` 收到 `book_id=1`、文件名 `.epub`、`Content-Type: application/epub+zip`。
2. 有 EPUB + `overwrite=false` → `CALIBRE_EPUB_EXISTS`，且 `/upload` 未被调用。
3. 有 EPUB + `overwrite=true` → 上传执行。
4. 登录失败 → `CALIBRE_PUSH_FORBIDDEN` 或 `CALIBRE_PUSH_UNAVAILABLE`（只读连接）。
5. CSRF 过期（首次上传 302 `/login`）→ 自动重登一次并成功。
6. 上传后确认仍 404 → `CALIBRE_PUSH_UNVERIFIED`。
7. 覆盖场景：预检 200 + `content-length: 100`，上传后仍 200 + `content-length: 100` → `CALIBRE_PUSH_UNVERIFIED`；上传后 `content-length: 200` → 成功。
8. 并发第二次调用 → `CALIBRE_BUSY`。
9. 上传超过 `calibreMaxPushBytes` 的 body 由路由拦截（留给 S7 测试）。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/server/calibrePush.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 `pushEpub`**

顺序严格按设计 §6.4 push 步骤 1–10：
- `canPush === false` → `CALIBRE_PUSH_UNAVAILABLE`（403）。
- 预检 `GET /opds/download/<id>/epub/`，`headersOnly: true`；记录 `exists`、`content-length`、`last-modified`；200/206 视为存在。
- 已有且 `!overwrite` → `CALIBRE_EPUB_EXISTS`（409）。
- 确保 Cookie 中有 `session`，否则 `login()`；登录成功判定按 S5。
- `GET /admin/book/<id>`，失败退回 `GET /`，提取 token；仍失败用登录页 token（可以为空）。
- 用 S4 的 `buildMultipartBody`；`POST /upload` 用 `calibrePushTimeoutMs`，`maxBytes: 1MB`。
- 2xx/3xx 视为提交；3xx 到 `/login` 或 400/403 且像 CSRF 错误 → 重登一次再试一次；仍失败按 403/502 映射。
- 确认：再请求 `/opds/download/<id>/epub/`，`headersOnly`；404 等 300ms 重试一次。
  - `exists === false` 且现在 200/206 → 成功；
  - `exists === true` 且现在 200/206，且 `content-length` 或 `last-modified` 与预检不同 → 成功；
  - 其他 → `CALIBRE_PUSH_UNVERIFIED`。
- 用模块级（service 内）`pushing` 布尔保证单并发；结束在 `finally` 释放。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/server/calibrePush.test.ts`
Expected: PASS。

---

### Task S7: 路由、限流、app 装配与登出清理

**Files:**
- Create: `server/routes/calibre.ts`
- Modify: `server/app.ts`
- Modify: `server/routes/auth.ts`
- Test: `tests/server/calibreRoutes.test.ts`

**Interfaces:**
- Consumes: `CalibreService`（S5/S6）、`AppConfig`、`createRateLimiter`、`clientIp`。
- Produces:
  - `registerCalibreRoutes(app: FastifyInstance, config: AppConfig, service: CalibreService): Promise<void>`
  - `BuildServerOptions.calibreDeps?: { service?: CalibreService }`
  - `registerAuthRoutes(app, config, deps?: { onLogout?: () => void })`

- [ ] **Step 1: 写失败测试**

用注入的假 service（记录调用、抛指定错误）覆盖：
- 未登录访问 `/api/calibre/session` → 401。
- `GET /session` 透传 `CalibreSessionInfo`。
- `POST /session` 校验 body：缺字段/超长 → 400；成功 → 200。
- `POST /session/reconnect` 无 body → 200。
- `GET /feed` → `content-type` 含 `atom+xml`、`cache-control: no-store`，body 为假 service 返回的 XML；响应头不含 `set-cookie`。
- `GET /books/1/file?format=txt` → `application/octet-stream`。
- `format=epub` → 400（白名单）。
- `GET /books/1/cover` → `image/png`。
- `POST /books/1/epub`：multipart 文件字段 `file`；缺文件 → 400；文件名非 `.epub` → 400；超过 `CALIBRE_MAX_PUSH_BYTES` → 413；`overwrite=true` 透传。
- 错误映射：假 service 抛 `CalibreError` → 对应状态码与 code；未知错误 → 502 `CALIBRE_UPSTREAM`，响应不含内部消息。
- 上游 401 场景（假 service 抛 `CALIBRE_AUTH_FAILED`）→ HTTP 400 而不是 401。
- 连接限流：同一 IP 第 6 次 `POST /session` → 429 `CALIBRE_RATE_LIMITED`；失败尝试也计数（用假 service 抛错）。
- 推送限流：第 7 次 → 429。
- `POST /api/auth/logout` 调用注入的 `onLogout`。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/server/calibreRoutes.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现路由与装配**

- `calibre.ts`：
  - 三个 `createRateLimiter`：read `config.calibreRateLimitPerMin`、push `config.calibrePushRateLimitPerMin`、connect `config.calibreConnectRateLimitPerMin`；key 用 `calibre:<kind>:${clientIp(request)}`。
  - 错误 helper：`CalibreError` → `reply.status(statusCode).send({ error: { code, message } })`；其他 → 502 固定文案。
  - `POST /session` body schema：`baseUrl` 1–2048、`username` 1–256、`password` 1–1024；`additionalProperties: false`；`attachValidation` 后返回统一 400 `CALIBRE_INVALID_REQUEST`。
  - `GET /feed` querystring：`offset` 非负整数、`q` ≤ 200、`format` ≤ 16；缺失时 undefined。
  - `GET /file`：id 正整数，`format` 只允许 `txt`（大小写不敏感）。
  - `GET /cover`：id 正整数。
  - `POST /epub`：id 正整数，`overwrite` 只接受 `"true"`/`"false"`；`request.isMultipart()` 为假 → 400；`request.file({ limits: { fileSize: config.calibreMaxPushBytes, files: 1, parts: 4 } })`；字段名必须 `file`；文件名 `.epub` 结尾；`toBuffer()` 读取；`CALIBRE_TOO_LARGE`/multipart 超限 → 413。
  - 注意：`app.register(multipart)` 的全局 `fileSize` 是 10MB（封面用）。如果 `request.file({ limits })` 不能覆盖全局限制，调整插件注册：为 calibre 路由使用独立的 encapsulated scope，或在全局 `fileSize` 取 `max(10MB, calibreMaxPushBytes)` 并在封面路由内继续用 10MB。以 S7 的 50MB 上传测试为准。
  - 所有响应 `cache-control: no-store`。
- `app.ts`：创建 `const service = options.calibreDeps?.service ?? createCalibreService(config)`；在 `registerCoverRoutes` 之后、静态资源之前注册；把 `service.clearLive` 作为 `onLogout` 传给 auth 路由。
- `auth.ts`：`registerAuthRoutes(app, config, deps = {})`；在 `/api/auth/logout` 响应前调用 `deps.onLogout?.()`。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/server/calibreRoutes.test.ts tests/server/auth.test.ts tests/server/guard.test.ts`
Expected: PASS。

---

### Task S8: 部署与配置样例

**Files:**
- Modify: `.env.example`
- Modify: `.gitignore`
- Modify: `.dockerignore`
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Test: 构建与配置检查

**Interfaces:**
- 无代码接口；产出可部署的默认值。

- [ ] **Step 1: 更新配置样例与忽略规则**

- `.env.example`：新增 10 个 `CALIBRE_*` 变量（带注释），说明：
  - `CALIBRE_ALLOW_PRIVATE=true` 的含义与收紧方式；
  - `CALIBRE_STORE_PATH` 在 Docker 内为 `/data/calibre-connection.json`；
  - 更换 `SESSION_SECRET` 会使已保存配置失效；
  - `CALIBRE_PERSIST_CREDENTIALS=false` 可关闭落盘。
- `.gitignore`：追加 `data/`。
- `.dockerignore`：追加 `data/`。

- [ ] **Step 2: 更新镜像与 compose**

- `Dockerfile` runner 阶段：
  ```dockerfile
  RUN mkdir -p /data && chown node:node /data
  ENV CALIBRE_STORE_PATH=/data/calibre-connection.json
  ```
  放在 `USER node` 之前。
- `docker-compose.yml`：
  ```yaml
  volumes:
    - txt2book-data:/data
  # 文件末尾
  volumes:
    txt2book-data:
  ```

- [ ] **Step 3: 验证**

Run:
```bash
npm run build
docker compose config
```
Expected: 构建成功；`docker compose config` 显示 `txt2book-data` 卷与 `/data` 挂载（本机没有 Docker 时记录为未验证，不阻塞代码测试）。

- [ ] **Step 4: 运行服务端全量测试**

Run: `npx vitest run tests/server`
Expected: PASS。
