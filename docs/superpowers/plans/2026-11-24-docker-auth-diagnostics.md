# Docker 部署登录失败与图标 404 修复计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 `docker run --env-file` 下带引号的认证配置导致登录永远 401、镜像缺少 `public/` 资源导致图标 404，并补充可定位三类问题的日志。

**Architecture:** 认证配置读取时去掉成对的单/双引号；认证路由与启动阶段输出不含密码、哈希、Cookie、IP 的诊断行（`[auth]` / `[static]`）；Dockerfile 构建阶段复制 `public/`。

**Tech Stack:** Node 22 + Fastify、TypeScript、Vitest、Docker multi-stage build。

**Spec:** 无独立设计文档；依据 README「生成密码哈希」「Docker 镜像」与 AGENTS.md 的测试、安全约定。

## Global Constraints

- 用户可见文案用中文；日志前缀固定 `[auth]` / `[static]`。
- 日志不得包含密码、`AUTH_PASSWORD_HASH`、`SESSION_SECRET`、Cookie 值。
- 认证配置仍 fail-closed：缺 `AUTH_PASSWORD_HASH` / `SESSION_SECRET` 时拒绝启动。
- 新增逻辑必须有 Vitest 用例；测试命令 `npm test`、`npm run typecheck`。

## Review Focus

- `AUTH_PASSWORD_HASH` / `AUTH_USERNAME` 带成对引号（`docker run --env-file` 会原样保留）。
- `.env` 经 Windows 编辑器保存后值前后出现 BOM/空白。
- HTTPS 反代下 `Origin` 与 `request.protocol` 不一致（`TRUST_PROXY` 未开）应留下可定位日志。
- 日志里 `Origin` / `Host` 头可能含换行，必须转义，避免日志注入。
- 镜像构建后 `dist/favicon.svg` 必须存在，否则图标与 manifest 仍 404。

---

### Task 1: 镜像内置 public 静态资源

**Files:**
- Modify: `Dockerfile`（builder 阶段，`COPY src` 之后）
- Test: `tests/assets.test.ts`

**Interfaces:**
- Consumes: 现有 `public/` 目录。
- Produces: 构建阶段存在 `public/`，Vite 会把它复制进 `dist/`。

- [ ] **Step 1: 写失败测试**：在 `tests/assets.test.ts` 增加断言 Dockerfile 含 `COPY public ./public`。
- [ ] **Step 2: 运行测试确认失败**：`npx vitest run tests/assets.test.ts`。
- [ ] **Step 3: 实现**：Dockerfile builder 阶段增加 `COPY public ./public`。
- [ ] **Step 4: 运行测试确认通过**。

### Task 2: 认证配置去引号

**Files:**
- Modify: `server/lib/config.ts`
- Test: `tests/server/config.test.ts`

**Interfaces:**
- Produces: `loadConfig` 对 `AUTH_USERNAME` / `AUTH_PASSWORD_HASH` / `SESSION_SECRET` 去掉首尾空白与成对单/双引号。

- [ ] **Step 1: 写失败测试**：带引号的三项配置被还原；不成对引号保持原样。
- [ ] **Step 2: 运行测试确认失败**。
- [ ] **Step 3: 实现 `readAuthValue` 并替换三项读取**。
- [ ] **Step 4: 运行测试确认通过**。

### Task 3: 认证日志

**Files:**
- Modify: `server/routes/auth.ts`、`server/lib/password.ts`（导出 `isPasswordHashValid`）
- Test: `tests/server/auth.test.ts`

**Interfaces:**
- Produces: `isPasswordHashValid(stored: string): boolean`。
- 日志：`[auth] 登录失败 reason=password_hash_invalid|username_mismatch|password_mismatch|password_too_long`、`[auth] 登录成功`、`[auth] 登录被限流`、`[auth] 跨站请求被拒绝 origin=… host=… protocol=… x-forwarded-proto=…`。

- [ ] **Step 1: 写失败测试**：错误密码返回 401 且 `console.warn` 含 `reason=password_mismatch`，且不含密码明文。
- [ ] **Step 2: 运行测试确认失败**。
- [ ] **Step 3: 实现日志**：不得输出用户名、IP、密码、哈希；头部值经 `JSON.stringify` 转义。
- [ ] **Step 4: 运行测试确认通过**。

### Task 4: 启动自检

**Files:**
- Modify: `server/app.ts`（导出 `DEFAULT_DIST_DIR`）、`server/index.ts`
- Test: 无独立单测，随 Task 3 的认证测试回归；静态检查在 Docker 冒烟验证。

**Interfaces:**
- Produces: 启动时输出 `[auth]` 配置摘要；`password_hash` 无效时给出重新生成命令；`dist/index.html` 存在但缺 `favicon.svg` 时输出 `[static]` 警告。

- [ ] **Step 1: 实现启动日志**。
- [ ] **Step 2: `npm run typecheck` 通过**。

### Task 5: 文档

**Files:**
- Modify: `README.md`

- [ ] **Step 1:** 生成密码哈希一节说明引号与 `$` 展开；Docker 镜像一节说明 `docker logs` 的 `[auth]` / `[static]` 诊断行。
- [ ] **Step 2:** 常见问题增加「Docker 部署登录一直提示用户名或密码错误」的排查表。

### Task 6: 验证

- [ ] `npm test`、`npm run typecheck`。
- [ ] `docker build -t txt2book:diag .`，检查 `dist/favicon.svg` 存在。
- [ ] 用带引号 `.env` 启动容器，登录应返回 204；不带引号同样 204；错误密码 401 并输出 `reason=password_mismatch`。
