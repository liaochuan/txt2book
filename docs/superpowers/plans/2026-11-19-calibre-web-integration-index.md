# calibre-web 对接实施计划索引

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement the plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 txt2book 中接入 calibre-web：浏览/筛选书库、导入 TXT 与元数据、导出 EPUB 后推回原书，并加密保存连接配置供后续复用。

**Architecture:** 服务端新增 `server/lib/calibre/*` 与 `/api/calibre/*` 路由，做 OPDS 代理、登录/CSRF/上传与加密配置存储；前端新增 OPDS 解析、`useCalibre` 状态编排与书库面板；书籍关联写入 `BookModel.source`，随撤销/恢复一起回滚。

**Tech Stack:** Vue 3 + TypeScript + Vite + Vitest（happy-dom）；Node 22 + Fastify + TypeScript；`node:crypto`、`node:http(s)`、`node:dns`；不新增运行时依赖。

**Spec:** `docs/superpowers/specs/2026-11-19-calibre-web-integration-design.md`

## 全局约束

- 用户可见文案一律中文；代码、路径、API 字段、环境变量保持英文。
- 不新增运行时依赖：OPDS 用浏览器 `DOMParser`，服务端只用 Node 内置模块。
- 不执行 `git add` / `commit` / `push`；每个任务结束时保留工作区 diff，由用户提交。
- 每个任务结束前必须运行该任务列出的测试命令并看到通过输出。
- 最终必须通过：`npm run typecheck`、`npm test`、`npm run build`。
- 涉及 SSRF、凭据、限流、文件大小的代码必须有对应测试。
- 所有 `/api/calibre/*` 路由都受现有全局登录守卫保护；上游 calibre-web 的 401 不得映射成 401（前端会把 401 当作 txt2book 会话失效并退出登录）。
- 所有上游错误只返回固定中文文案，不包含主机名、IP、上游 HTML 或凭据。
- 单账号应用：连接为服务端全局状态；多个浏览器共享同一连接。

## 子计划与顺序

| 顺序 | 计划 | 交付物 | 独立性 |
|---|---|---|---|
| 1 | `2026-11-19-calibre-web-server.md` | `/api/calibre/*`、加密配置、推送、服务端测试、Docker/env | 完成后可用 curl/测试完整验证 |
| 2 | `2026-11-19-calibre-web-frontend.md` | 类型、解析、composable、面板、导出推送 | 依赖计划 1 的契约；测试内用 mock API，可独立跑通 |
| 3 | `2026-11-19-calibre-web-docs.md` | README、AGENTS、最终验收与全量验证 | 依赖 1、2 |

- 默认顺序执行。若要并行，计划 1 与计划 2 可从同一个 base 各自建 worktree；计划 2 只依赖本索引的契约，不修改 `server/`。
- 单份计划内部任务数 ≤ 10；执行进度写入各计划同目录的 ledger：`<plan-name>.ledger.md`。

## 共享契约（两份计划都以此为准）

### HTTP 契约

所有响应错误体：`{ "error": { "code": string, "message": string } }`。

| 方法 | 路径 | 请求 | 成功响应 |
|---|---|---|---|
| GET | `/api/calibre/session` | — | `CalibreSessionInfo` |
| POST | `/api/calibre/session` | `{ baseUrl, username, password }` | `CalibreSessionInfo` |
| POST | `/api/calibre/session/reconnect` | 空 body | `CalibreSessionInfo` |
| DELETE | `/api/calibre/session` | — | 204 |
| DELETE | `/api/calibre/credentials` | — | 204 |
| GET | `/api/calibre/feed?offset=&q=&format=` | — | `application/atom+xml; charset=utf-8` 原样 XML |
| GET | `/api/calibre/books/:id/file?format=txt` | — | `application/octet-stream` 字节 |
| GET | `/api/calibre/books/:id/cover` | — | `image/png` |
| POST | `/api/calibre/books/:id/epub?overwrite=true|false` | multipart，字段 `file` | `204` |

`CalibreSessionInfo`：

```ts
interface CalibreSessionInfo {
  connected: boolean;
  saved: boolean;
  baseUrl?: string;
  username?: string;
  canPush?: boolean;
  pushReason?: string;
}
```

错误码：

| 状态 | code | 含义 |
|---|---|---|
| 400 | `CALIBRE_INVALID_URL` | 地址非法 |
| 400 | `CALIBRE_INVALID_REQUEST` | 请求参数或上传字段非法 |
| 400 | `CALIBRE_AUTH_FAILED` | calibre-web 账号或密码错误 |
| 403 | `CALIBRE_PUSH_UNAVAILABLE` | 连接为只读（网页登录失败） |
| 403 | `CALIBRE_PUSH_FORBIDDEN` | 账号无上传权限或未开启上传 |
| 404 | `CALIBRE_NOT_FOUND` | 书或格式不存在 |
| 404 | `CALIBRE_FORMAT_UNAVAILABLE` | 格式 feed 不可见 |
| 404 | `CALIBRE_NO_COVER` | 该书没有封面 |
| 409 | `CALIBRE_NOT_CONNECTED` | 未连接且无可用配置 |
| 409 | `CALIBRE_EPUB_EXISTS` | 已有 EPUB 且未确认覆盖 |
| 413 | `CALIBRE_TOO_LARGE` | 超过大小上限 |
| 429 | `CALIBRE_BUSY` | 连接或推送正在进行 |
| 429 | `CALIBRE_RATE_LIMITED` | 触发限流 |
| 502 | `CALIBRE_UNREACHABLE` | 上游不可达或 TLS 失败 |
| 502 | `CALIBRE_UPSTREAM` | 上游返回异常 |
| 502 | `CALIBRE_PUSH_UNVERIFIED` | 已提交但无法确认 |
| 504 | `CALIBRE_TIMEOUT` | 上游超时 |
| 500 | `CALIBRE_CONFIG` | 配置错误（不应出现，兜底） |

### 前端类型

```ts
// src/types/calibre.ts
export interface CalibreBook {
  id: number;
  title: string;
  authors: string[];
  language?: string;
  summary: string;
  formats: string[];
  hasCover: boolean;
}
export interface CalibreFeed {
  books: CalibreBook[];
  nextOffset: number | null;
}
export type CalibreSessionInfo = { /* 同上 */ };
```

```ts
// src/types/book.ts 追加
export interface BookSource {
  kind: "calibre-web";
  origin: string;
  bookId: number;
  title: string;
  formats: string[];
}
export interface BookModel {
  meta: BookMeta;
  volumes: Volume[];
  chapters: Chapter[];
  cover: CoverAsset | null;
  source?: BookSource | null;
}
```

### 服务端接口（计划 1 产出）

```ts
// server/lib/calibre/service.ts
export interface CalibreService {
  status(): Promise<CalibreSessionInfo>;
  connect(input: { baseUrl: string; username: string; password: string }): Promise<CalibreSessionInfo>;
  resume(): Promise<CalibreSessionInfo>;
  disconnect(): void;
  forget(): Promise<void>;
  feed(input: { offset?: number; q?: string; format?: string }): Promise<string>;
  textFile(bookId: number): Promise<Buffer>;
  coverPng(bookId: number): Promise<Buffer>;
  pushEpub(bookId: number, data: Buffer, filename: string, overwrite: boolean): Promise<void>;
  clearLive(): void;
}
```

### 配置项

| 变量 | 默认 | 类型 |
|---|---|---|
| `CALIBRE_ALLOW_PRIVATE` | `true` | boolean |
| `CALIBRE_PERSIST_CREDENTIALS` | `true` | boolean |
| `CALIBRE_STORE_PATH` | `./data/calibre-connection.json` | string |
| `CALIBRE_TIMEOUT_MS` | `15000` | number |
| `CALIBRE_PUSH_TIMEOUT_MS` | `120000` | number |
| `CALIBRE_MAX_FILE_BYTES` | `52428800` | number |
| `CALIBRE_MAX_PUSH_BYTES` | `52428800` | number |
| `CALIBRE_RATE_LIMIT_PER_MIN` | `120` | number |
| `CALIBRE_PUSH_RATE_LIMIT_PER_MIN` | `6` | number |
| `CALIBRE_CONNECT_RATE_LIMIT_PER_MIN` | `5` | number |

## 文件归属（避免并行冲突）

- 计划 1 独占：`server/**`、`tests/server/**`、`Dockerfile`、`docker-compose.yml`、`.env.example`、`.gitignore`、`.dockerignore`。
- 计划 2 独占：`src/**`、`tests/*.test.ts`（除 `tests/server/**`）。
- 计划 3 独占：`README.md`、`AGENTS.md`。
- 任何计划都不要修改其他计划独占的文件；需要契约变更时先改本索引。

## Review Focus

- **推送前预检必须真实有效**：目标书在列表快照之后新增 EPUB 时，不能在未确认的情况下覆盖；对应测试在计划 1 的 S6。
- **关联来源必须随书籍快照回滚**：本地导入、撤销、登出后不能残留旧书关联；对应测试在计划 2 的 F2 / F6。
- **calibre 导入必须覆盖旧元数据与旧封面**：无封面时清空，不能把上一本书的封面写进 EPUB；对应测试在 F3 / F4 / F6。
- **上游 401 不能变成浏览器 401**：否则会把用户踢出 txt2book；对应测试在 S7。
- **凭据不得以明文出现在文件、响应、日志**：对应测试在 S2 / S7。
- **TXT 过滤在搜索与翻页下仍然正确**：整页被过滤空时自动续取；对应测试在 F6。
- **子路径反代**：`https://host/calibre` 的 base URL 必须正确拼出上游路径；对应测试在 S1 / S4。

## 最终验收

1. `npm run typecheck` 通过。
2. `npm test` 全量通过（包含现有测试）。
3. `npm run build` 通过。
4. 用真实 calibre-web 手动走一遍：连接 → 浏览 → 只看 TXT → 导入 → 元数据/封面 → 导出 EPUB 推送 → 重启 txt2book 后自动恢复连接 → 断开/忘记。
5. 检查 `data/` 未进入 git，`CALIBRE_STORE_PATH` 文件内容不含明文密码。
