# txt2book 服务端与部署 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现单账号登录、签名会话、封面抓取与 PNG 转换、SSRF 防护、静态托管与 Docker Compose 部署。

**Architecture:** Fastify 单进程；`server/lib/` 放可单测的纯逻辑，`server/routes/` 只做校验与响应；所有 `/api` 除白名单外经过会话守卫。

**Tech Stack:** Node 22、Fastify、@fastify/cookie、@fastify/multipart、@fastify/static、sharp、node:crypto。

**Spec:** `docs/superpowers/specs/2026-11-17-txt2book-design.md`

## Global Constraints

- 缺少 `AUTH_PASSWORD_HASH` 或 `SESSION_SECRET` 时拒绝启动。
- 密码从不明文存储；日志不打印密码、Cookie、会话 token。
- 封面代理：仅 http/https、IP 黑名单、重定向逐跳复检、10MB / 8s / 40MP 上限、按 IP 限流。
- 输出封面固定 `image/png`。
- 不写 `git commit`。

## Review Focus

- 私网地址通过十进制/八进制/十六进制 IP、IPv6 映射地址、DNS 重绑定绕过黑名单。
- 登录失败可被用于枚举账号或暴力破解。
- 会话 Cookie 被 JS 读取或被跨站携带。
- `X-Forwarded-For` 伪造导致限流失效。
- 损坏图片或超大图片使 sharp 抛未捕获异常、进程退出。

---

### Task 1: 配置加载与健康检查

**Files:**
- Create: `server/lib/config.ts`
- Create: `server/index.ts`
- Create: `tests/server/config.test.ts`
- Create: `tests/server/health.test.ts`
- Modify: `tsconfig.server.json`（`outDir: server-dist`，`module: NodeNext`）

**Interfaces:**
- Produces:
  ```ts
  export interface AppConfig {
    port: number;
    username: string;
    passwordHash: string;
    sessionSecret: string;
    sessionTtlDays: number;
    cookieSecure: boolean;
    authDisabled: boolean;
    maxCoverBytes: number;
    coverTimeoutMs: number;
    rateLimitPerMin: number;
    trustProxy: boolean;
  }
  export function loadConfig(env: NodeJS.ProcessEnv): AppConfig;
  export function buildServer(config: AppConfig): FastifyInstance;
  ```

- [ ] **Step 1: 写失败测试**

```ts
it("refuses to start without SESSION_SECRET", () => {
  expect(() => loadConfig({ AUTH_PASSWORD_HASH: "scrypt$1$1$1$AA$BB" } as any)).toThrow(/SESSION_SECRET/);
});
it("refuses to start without AUTH_PASSWORD_HASH", () => {
  expect(() => loadConfig({ SESSION_SECRET: "x".repeat(32) } as any)).toThrow(/AUTH_PASSWORD_HASH/);
});
it("allows AUTH_DISABLED without credentials", () => {
  expect(loadConfig({ AUTH_DISABLED: "true" } as any).authDisabled).toBe(true);
});
it("parses numeric overrides", () => {
  const cfg = loadConfig({ SESSION_SECRET: "x".repeat(32), AUTH_PASSWORD_HASH: "h", RATE_LIMIT_PER_MIN: "5" } as any);
  expect(cfg.rateLimitPerMin).toBe(5);
});
it("returns health", async () => {
  const app = buildServer(loadConfig({ AUTH_DISABLED: "true" } as any));
  const res = await app.inject({ method: "GET", url: "/api/health" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });
});
```

- [ ] **Step 2: 跑测试确认失败** → `npm test -- tests/server` FAIL。
- [ ] **Step 3: 实现**：`loadConfig` 做默认值与校验；`buildServer` 注册 `/api/health`，未知 `/api` 路径返回 404 JSON。
- [ ] **Step 4: 验证** → 5 passed。

---

### Task 2: 密码哈希与生成脚本

**Files:**
- Create: `server/lib/password.ts`
- Create: `server/scripts/hash-password.ts`
- Create: `tests/server/password.test.ts`

**Interfaces:**
- Produces: `hashPassword(plain: string): Promise<string>`（`scrypt$N$r$p$saltB64$hashB64`）、`verifyPassword(plain: string, stored: string): Promise<boolean>`。

- [ ] **Step 1: 写失败测试**

```ts
it("round-trips a password", async () => {
  const stored = await hashPassword("correct horse");
  expect(stored.startsWith("scrypt$")).toBe(true);
  await expect(verifyPassword("correct horse", stored)).resolves.toBe(true);
  await expect(verifyPassword("wrong", stored)).resolves.toBe(false);
});
it("returns false for a malformed hash instead of throwing", async () => {
  await expect(verifyPassword("x", "not-a-hash")).resolves.toBe(false);
});
it("uses timingSafeEqual", async () => {
  // 两个不同密码的校验耗时差异不做严格断言，仅断言两次都返回 false 且不抛错
  const stored = await hashPassword("a");
  await expect(Promise.all([verifyPassword("ab", stored), verifyPassword("b", stored)])).resolves.toEqual([false, false]);
});
```

- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**：scrypt 参数 `N=16384, r=8, p=1`，32 字节盐，64 字节输出；比较前长度不等直接返回 false，长度相等用 `timingSafeEqual`。脚本从 `process.argv[2]` 或 stdin 读密码，打印哈希，不打印明文。
- [ ] **Step 4: 验证** → 3 passed；`npx tsx server/scripts/hash-password.ts test123` 输出以 `scrypt$` 开头。

---

### Task 3: 会话签名、认证路由与限流

**Files:**
- Create: `server/lib/session.ts`
- Create: `server/lib/rateLimit.ts`
- Create: `server/routes/auth.ts`
- Modify: `server/index.ts`
- Create: `tests/server/session.test.ts`
- Create: `tests/server/auth.test.ts`
- Create: `tests/server/rateLimit.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SessionPayload { sub: string; iat: number; exp: number; }
  export function signSession(payload: SessionPayload, secret: string): string;
  export function verifySession(token: string, secret: string, now: number = Date.now()): SessionPayload | null;
  export function createRateLimiter(opts: { limit: number; windowMs: number; now?: () => number }): { hit(key: string): boolean };
  export function registerAuthRoutes(app: FastifyInstance, config: AppConfig): Promise<void>;
  export const SESSION_COOKIE = "txt2book_session";
  ```

- [ ] **Step 1: 写失败测试**

```ts
// session
it("rejects a tampered token", () => {
  const t = signSession({ sub: "admin", iat: 1, exp: 2 ** 40 }, "s".repeat(32));
  expect(verifySession(t + "x", "s".repeat(32))).toBeNull();
});
it("rejects an expired token", () => {
  const t = signSession({ sub: "admin", iat: 1, exp: 2 }, "s".repeat(32));
  expect(verifySession(t, "s".repeat(32), () => 3)).toBeNull();
});
// auth
it("sets an http-only strict cookie on success", async () => {
  const stored = await hashPassword("pw");
  const app = buildServer(loadConfig({ SESSION_SECRET: "s".repeat(32), AUTH_PASSWORD_HASH: stored, AUTH_USERNAME: "admin" } as any));
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "pw" } });
  expect(res.statusCode).toBe(204);
  const cookie = res.headers["set-cookie"] as string;
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Strict");
});
it("returns a generic 401 for a wrong password", async () => {
  // ... 同上，password: "bad"
  expect(res.statusCode).toBe(401);
  expect(res.json().error.message).toBe("用户名或密码错误");
});
it("reports me without a session as unauthenticated", async () => {
  const res = await app.inject({ method: "GET", url: "/api/auth/me" });
  expect(res.json()).toEqual({ authenticated: false });
});
it("rate limits the sixth login attempt", async () => {
  // AUTH...，连续 6 次错误登录，第 6 次 429
});
```

- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**

`signSession`：`base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload, secret))`。`verifySession(token, secret, now = Date.now)` 校验签名（`timingSafeEqual`）与 `exp`。

Cookie 选项：`httpOnly: true, sameSite: "strict", path: "/", secure: config.cookieSecure, maxAge: ttlDays * 86400`。

登录：`POST /api/auth/login` 校验 `username === config.username` 且 `verifyPassword`，失败统一 401；成功 204 + Cookie。`POST /api/auth/logout` 清 Cookie（`maxAge: 0`）。`GET /api/auth/me` 读 Cookie 校验后返回 `{ authenticated: true, username }` 或 `{ authenticated: false }`。

`AUTH_DISABLED=true` 时 `me` 返回 `{ authenticated: true, username: "dev" }`，登录路由直接 204。

限流：内存 Map，key 为 `login:${ip}` 与 `login:${username}`，窗口 15 分钟，命中 5 次后返回 429。`trustProxy=false` 时忽略 `X-Forwarded-For`。

Origin 校验：所有 POST 比较 `origin` 与 `host`，缺失或不一致返回 403（同源请求在 `inject` 中需显式传 header，测试要覆盖）。

- [ ] **Step 4: 验证** → session 2 + auth 4 + rateLimit 2 passed。

---

### Task 4: SSRF 校验

**Files:**
- Create: `server/lib/ssrf.ts`
- Create: `tests/server/ssrf.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function isBlockedIp(ip: string): boolean;
  export function isBlockedHostname(hostname: string): boolean;
  export function normalizeIp(ip: string): string; // 处理 IPv4-mapped IPv6
  export async function resolvePublicUrl(raw: string, deps?: { lookup?: LookupFn }): Promise<{ url: URL; address: string; family: 4 | 6 }>;
  ```

- [ ] **Step 1: 写失败测试**

```ts
it.each([
  "127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254",
  "0.0.0.0", "100.64.0.1", "224.0.0.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1",
])("blocks %s", (ip) => expect(isBlockedIp(ip)).toBe(true));

it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("allows %s", (ip) => expect(isBlockedIp(ip)).toBe(false));

it("blocks private hostnames", () => {
  for (const h of ["localhost", "foo.local", "svc.internal", "metadata.google.internal"]) {
    expect(isBlockedHostname(h)).toBe(true);
  }
});

it("rejects non-http protocols", async () => {
  await expect(resolvePublicUrl("file:///etc/passwd")).rejects.toThrow();
  await expect(resolvePublicUrl("http://user:pass@example.com/a.png")).rejects.toThrow();
});

it("rejects when any resolved address is private", async () => {
  const lookup = async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }];
  await expect(resolvePublicUrl("http://example.com/a.png", { lookup })).rejects.toThrow(/private/i);
});
```

- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**

IP 判断覆盖：`0.0.0.0/8`、`10/8`、`100.64/10`、`127/8`、`169.254/16`、`172.16/12`、`192.0.0/24`、`192.168/16`、`198.18/15`、`224/4`、`240/4`、IPv6 `::`、`::1`、`fc00::/7`、`fe80::/10`、`ff00::/8`，以及 IPv4-mapped IPv6 先归一化为 IPv4。域名黑名单见测试。端口只允许 80/443/8080/8443/其他 >= 1024 的端口（拒绝 22/25/3306/6379 等常见内网服务端口）。`resolvePublicUrl` 用 `node:dns/promises` 的 `lookup(host, { all: true })`，全部地址都必须通过校验，返回第一个地址供固定连接。

- [ ] **Step 4: 验证** → 全部通过。

---

### Task 5: 封面抓取与 PNG 转换

**Files:**
- Create: `server/lib/image.ts`
- Create: `server/routes/cover.ts`
- Modify: `server/index.ts`
- Create: `tests/server/image.test.ts`
- Create: `tests/server/cover.test.ts`
- Create: `tests/fixtures/cover.webp`（可用 sharp 在测试里现场生成，不提交二进制）

**Interfaces:**
- Produces:
  ```ts
  export async function toPng(input: Buffer, opts: { maxBytes: number }): Promise<{ png: Buffer; width: number; height: number }>;
  export async function fetchImage(url: URL, address: string, family: 4 | 6, opts: { timeoutMs: number; maxBytes: number }): Promise<Buffer>;
  export async function fetchCoverPng(rawUrl: string, config: AppConfig): Promise<{ png: Buffer; width: number; height: number }>;
  export function registerCoverRoutes(app: FastifyInstance, config: AppConfig): Promise<void>;
  ```

- [ ] **Step 1: 写失败测试**

```ts
it("converts webp to png", async () => {
  const webp = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#123456" } }).webp().toBuffer();
  const out = await toPng(webp, { maxBytes: 10 * 1024 * 1024 });
  expect(out.png.subarray(1, 4).toString()).toBe("PNG");
  expect(out.width).toBe(8);
});
it("rejects non-image bytes", async () => {
  await expect(toPng(Buffer.from("not an image"), { maxBytes: 1024 })).rejects.toMatchObject({ statusCode: 415 });
});
it("rejects oversized downloads", async () => {
  await expect(fetchImage(new URL("http://x"), "1.2.3.4", 4, { timeoutMs: 100, maxBytes: 10 })).rejects.toBeTruthy();
});
it("requires authentication for the cover endpoint", async () => {
  const app = buildServer(loadConfig({ SESSION_SECRET: "s".repeat(32), AUTH_PASSWORD_HASH: "h" } as any));
  const res = await app.inject({ method: "POST", url: "/api/cover/from-url", payload: { url: "https://example.com/a.png" } });
  expect(res.statusCode).toBe(401);
});
it("rejects a private url even when authenticated", async () => {
  // 登录拿 cookie 后请求 169.254.169.254，断言 400 且响应体不含 IP
});
```

- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**

`fetchImage` 用 `node:http`/`node:https` 的 `request`，传 `lookup: (_h, _o, cb) => cb(null, address, family)` 固定 IP、`headers: { accept: "image/*", "user-agent": "txt2book/1.0" }`；流式累计字节，超过 `maxBytes` 立即 `destroy()` 并抛错；超时后 `destroy()`。3xx 最多跟随 3 次，每次重新 `resolvePublicUrl`。状态码非 200 抛错。

`toPng`：`sharp(input, { limitInputPixels: 40_000_000, failOn: "error" })`，`rotate()` 应用 EXIF，`resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })`，`png()`。捕获 sharp 异常转为 `{ statusCode: 415, message: "不支持的图片格式" }`。

`from-file`：`@fastify/multipart`，限制 10MB，只接收一个文件字段 `file`。`from-url`：JSON schema 校验 `url` 为字符串，长度 ≤ 2048。

- [ ] **Step 4: 验证** → 5 passed。

---

### Task 6: 全局守卫、静态托管与安全头

**Files:**
- Create: `server/lib/authGuard.ts`
- Modify: `server/index.ts`
- Create: `tests/server/guard.test.ts`

**Interfaces:**
- Produces: `registerAuthGuard(app, config)` — 对 `/api/*` 白名单外请求校验会话。

- [ ] **Step 1: 写失败测试**

```ts
it("returns 401 json for protected routes without a session", async () => {
  const app = buildServer(loadConfig({ SESSION_SECRET: "s".repeat(32), AUTH_PASSWORD_HASH: "h" } as any));
  const res = await app.inject({ method: "POST", url: "/api/cover/from-file" });
  expect(res.statusCode).toBe(401);
  expect(res.json().error.code).toBe("UNAUTHORIZED");
});
it("allows whitelisted routes without a session", async () => {
  const res = await app.inject({ method: "GET", url: "/api/auth/me" });
  expect(res.statusCode).toBe(200);
});
it("serves index.html for unknown non-api routes", async () => {
  const res = await app.inject({ method: "GET", url: "/some/route" });
  expect(res.headers["content-type"]).toContain("text/html");
});
it("sets security headers", async () => {
  const res = await app.inject({ method: "GET", url: "/" });
  expect(res.headers["x-content-type-options"]).toBe("nosniff");
  expect(res.headers["referrer-policy"]).toBe("no-referrer");
});
```

- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**

- `@fastify/static` 指向 `dist/`，`wildcard: false`；未命中的非 `/api` 路由回退 `index.html`。
- 安全头：`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-src 'self' blob:; object-src 'none'; base-uri 'none'`。
- 全局错误处理器：已知错误带 `statusCode` 与 `code`，未知错误 500 且只返回“服务器内部错误”，日志记录堆栈但不记录请求体。
- `trustProxy` 只在显式开启时传给 Fastify。

- [ ] **Step 4: 验证** → 4 passed，`npm test` 全绿。

---

### Task 7: Docker 与文档

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `.dockerignore`
- Create: `.env.example`
- Create: `README.md`

**Interfaces:**
- 无代码接口；产物是 `docker compose up -d --build` 可启动的服务。

- [ ] **Step 1: Dockerfile**

多阶段：`node:22-alpine` builder 安装全部依赖、`npm run build`；runner 只复制 `package.json`、`package-lock.json`、`dist/`、`server-dist/`，执行 `npm ci --omit=dev`，`USER node`，`EXPOSE 3000`，`CMD ["node", "server-dist/index.js"]`。sharp 在 alpine 使用预编译包，若构建失败则加 `apk add --no-cache vips-dev` 并记录在 README。

- [ ] **Step 2: compose 与 env 示例**

`docker-compose.yml` 与设计文档 §17 一致；`.env.example` 填入：

```
AUTH_USERNAME=admin
AUTH_PASSWORD_HASH=
SESSION_SECRET=
COOKIE_SECURE=false
```

- [ ] **Step 3: README**

章节：功能、本地开发、生成密码哈希、Docker 部署、HTTPS 反向代理（`COOKIE_SECURE=true`、`TRUST_PROXY=true`）、安全说明（登录、限流、SSRF 防护）、支持的章节格式、主题列表。

- [ ] **Step 4: 验证**

Run: `docker compose config` → 无错误。
Run: `docker compose build` → 成功。
Run: `docker compose up -d` → `curl http://127.0.0.1:8080/api/health` 返回 `{"ok":true}`。
Run: `curl -i -X POST http://127.0.0.1:8080/api/cover/from-url -H "content-type: application/json" -d '{"url":"https://example.com/a.png"}'` → `401`。

---

## 完成标准

- `npm test`、`npm run typecheck`、`npm run build` 全部通过。
- `docker compose up -d --build` 后完成一次：登录 → 上传 → 取封面 → 导出。
- 未登录访问封面接口返回 401；内网地址返回 400 且不回显地址。
