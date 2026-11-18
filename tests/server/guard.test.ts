// @vitest-environment node
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../server/app";
import { loadConfig, type AppConfig } from "../../server/lib/config";
import { SESSION_COOKIE, signSession } from "../../server/lib/session";

const SECRET = "s".repeat(32);
const INDEX_MARKER = '<div id="app" data-test="spa-index"></div>';

/** 每个用例的临时 dist 目录，避免依赖真实构建产物。 */
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 测试用环境变量：绕过 `NodeJS.ProcessEnv` 的只读索引签名。 */
function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

function makeConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig(
    env({
      SESSION_SECRET: SECRET,
      AUTH_PASSWORD_HASH: "h",
      AUTH_USERNAME: "admin",
      ...overrides,
    }),
  );
}

/** 造一个最小 dist 目录：只包含 index.html 与一个静态资源。 */
function makeDist(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "txt2book-dist-"));
  tempDirs.push(dir);
  writeFileSync(path.join(dir, "index.html"), `<!doctype html><html><body>${INDEX_MARKER}</body></html>`, "utf8");
  mkdirSync(path.join(dir, "assets"));
  writeFileSync(path.join(dir, "assets", "app.js"), "console.log('ok');", "utf8");
  return dir;
}

async function makeApp(
  overrides: Record<string, string> = {},
  options: { distDir?: string } = {},
): Promise<FastifyInstance> {
  const app = buildServer(makeConfig(overrides), options);
  await app.ready();
  return app;
}

/** 直接签一个合法会话，避免在守卫测试里跑 scrypt。 */
function sessionCookie(): string {
  const now = Date.now();
  return `${SESSION_COOKIE}=${signSession({ sub: "admin", iat: now, exp: now + 60_000 }, SECRET)}`;
}

function errorBody(response: { json(): unknown }): { code: string; message: string } {
  return (response.json() as { error: { code: string; message: string } }).error;
}

describe("auth guard", () => {
  it("returns 401 json for protected routes without a session", async () => {
    const app = await makeApp();
    try {
      for (const url of ["/api/cover/from-url", "/api/cover/from-file"]) {
        const res = await app.inject({
          method: "POST",
          url,
          ...(url.endsWith("from-url") ? { payload: { url: "https://example.com/a.png" } } : {}),
        });
        expect(res.statusCode).toBe(401);
        expect(res.headers["content-type"]).toContain("application/json");
        expect(res.headers["cache-control"]).toBe("no-store");
        expect(res.json()).toEqual({
          error: { code: "UNAUTHORIZED", message: "请先登录。" },
        });
      }
    } finally {
      await app.close();
    }
  });

  it("rejects a tampered or expired session cookie", async () => {
    const app = await makeApp();
    try {
      const now = Date.now();
      const expired = signSession({ sub: "admin", iat: 1, exp: now - 1_000 }, SECRET);
      const tokens = [`${sessionCookie()}x`, `${SESSION_COOKIE}=${expired}`];
      for (const cookie of tokens) {
        const res = await app.inject({
          method: "POST",
          url: "/api/cover/from-url",
          headers: { cookie },
          payload: { url: "https://example.com/a.png" },
        });
        expect(res.statusCode).toBe(401);
        expect(errorBody(res).code).toBe("UNAUTHORIZED");
      }
    } finally {
      await app.close();
    }
  });

  it("returns 401 before parsing the request body", async () => {
    const app = await makeApp();
    try {
      // 畸形 JSON 若先被解析会得到 400；守卫必须在 onRequest 阶段拒绝。
      const res = await app.inject({
        method: "POST",
        url: "/api/cover/from-url",
        headers: { "content-type": "application/json" },
        payload: '{"url":',
      });
      expect(res.statusCode).toBe(401);
      expect(errorBody(res).code).toBe("UNAUTHORIZED");
    } finally {
      await app.close();
    }
  });

  it("lets a valid session reach the cover route", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/cover/from-url",
        headers: { cookie: sessionCookie() },
        payload: { url: "http://127.0.0.1/a.png" },
      });
      // 拒绝私网地址证明请求已通过守卫进入路由逻辑。
      expect(res.statusCode).toBe(400);
      expect(errorBody(res).code).toBe("INVALID_URL");
    } finally {
      await app.close();
    }
  });

  it("rejects a session signed for another user", async () => {
    const app = await makeApp();
    try {
      const now = Date.now();
      const token = signSession({ sub: "someone-else", iat: now, exp: now + 60_000 }, SECRET);
      const res = await app.inject({
        method: "POST",
        url: "/api/cover/from-url",
        headers: { cookie: `${SESSION_COOKIE}=${token}` },
        payload: { url: "http://127.0.0.1/a.png" },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("allows whitelisted routes without a session", async () => {
    const app = await makeApp();
    try {
      const health = await app.inject({ method: "GET", url: "/api/health" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ ok: true });

      const head = await app.inject({ method: "HEAD", url: "/api/health" });
      expect(head.statusCode).toBe(200);

      const me = await app.inject({ method: "GET", url: "/api/auth/me" });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toEqual({ authenticated: false });

      const logout = await app.inject({ method: "POST", url: "/api/auth/logout" });
      expect(logout.statusCode).toBe(204);

      // 登录接口本身必须可访问：凭据错误时返回路由自己的错误码，而不是守卫的 UNAUTHORIZED。
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "admin", password: "bad" },
      });
      expect(login.statusCode).toBe(401);
      expect(errorBody(login).code).toBe("INVALID_CREDENTIALS");
    } finally {
      await app.close();
    }
  });

  it("does not let encoded or absolute-form targets bypass the guard", async () => {
    const app = await makeApp();
    try {
      const targets = [
        "/%61pi/cover/from-url",
        "/ap%69/cover/from-file",
        "http://example.com/api/cover/from-url",
      ];
      for (const url of targets) {
        const res = await app.inject({ method: "POST", url });
        expect(res.statusCode, url).toBe(401);
        expect(errorBody(res).code).toBe("UNAUTHORIZED");
      }
    } finally {
      await app.close();
    }
  });

  it("normalizes an encoded whitelisted path for a valid session", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/%61pi/auth/me",
        headers: { cookie: sessionCookie() },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ authenticated: true, username: "admin" });
    } finally {
      await app.close();
    }
  });

  it("keeps the origin check for protected routes", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/cover/from-url",
        headers: {
          cookie: sessionCookie(),
          origin: "https://evil.example",
          host: "localhost:80",
        },
        payload: { url: "https://example.com/a.png" },
      });
      expect(res.statusCode).toBe(403);
      expect(errorBody(res).code).toBe("FORBIDDEN");
    } finally {
      await app.close();
    }
  });

  it("skips the guard when AUTH_DISABLED=true", async () => {
    const app = await makeApp({
      AUTH_DISABLED: "true",
      SESSION_SECRET: "",
      AUTH_PASSWORD_HASH: "",
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/cover/from-url",
        payload: { url: "http://127.0.0.1/a.png" },
      });
      expect(res.statusCode).toBe(400);
      expect(errorBody(res).code).toBe("INVALID_URL");
    } finally {
      await app.close();
    }
  });
});

describe("cover rate limiting", () => {
  it("returns 429 with Retry-After after the per-IP limit", async () => {
    const app = await makeApp({ RATE_LIMIT_PER_MIN: "1" });
    try {
      const first = await app.inject({
        method: "POST",
        url: "/api/cover/from-url",
        headers: { cookie: sessionCookie() },
        payload: { url: "http://127.0.0.1/a.png" },
      });
      expect(first.statusCode).toBe(400);
      expect(errorBody(first).code).toBe("INVALID_URL");

      const limited = await app.inject({
        method: "POST",
        url: "/api/cover/from-url",
        headers: { cookie: sessionCookie() },
        payload: { url: "http://127.0.0.1/a.png" },
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBe("60");
      expect(limited.headers["cache-control"]).toBe("no-store");
      expect(limited.json()).toEqual({
        error: { code: "RATE_LIMITED", message: "请求过于频繁，请稍后再试。" },
      });
    } finally {
      await app.close();
    }
  });

  it("shares the bucket across both cover endpoints", async () => {
    const app = await makeApp({ RATE_LIMIT_PER_MIN: "1" });
    try {
      const first = await app.inject({
        method: "POST",
        url: "/api/cover/from-url",
        headers: { cookie: sessionCookie() },
        payload: { url: "http://127.0.0.1/a.png" },
      });
      expect(first.statusCode).toBe(400);

      const limited = await app.inject({
        method: "POST",
        url: "/api/cover/from-file",
        headers: { cookie: sessionCookie() },
      });
      expect(limited.statusCode).toBe(429);
      expect(errorBody(limited).code).toBe("RATE_LIMITED");
    } finally {
      await app.close();
    }
  });

  it("keys the limiter by validated client IP", async () => {
    const app = await makeApp({ RATE_LIMIT_PER_MIN: "1" });
    try {
      for (const remoteAddress of ["10.9.9.1", "10.9.9.2"]) {
        const res = await app.inject({
          method: "POST",
          url: "/api/cover/from-url",
          headers: { cookie: sessionCookie() },
          remoteAddress,
          payload: { url: "http://127.0.0.1/a.png" },
        });
        expect(res.statusCode).toBe(400);
      }
      // 同一 IP 的第三次请求才被限流。
      const blocked = await app.inject({
        method: "POST",
        url: "/api/cover/from-url",
        headers: { cookie: sessionCookie() },
        remoteAddress: "10.9.9.2",
        payload: { url: "http://127.0.0.1/a.png" },
      });
      expect(blocked.statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });

  it("does not count unauthenticated requests against the limit", async () => {
    const app = await makeApp({ RATE_LIMIT_PER_MIN: "1" });
    try {
      const denied = await app.inject({
        method: "POST",
        url: "/api/cover/from-url",
        payload: { url: "http://127.0.0.1/a.png" },
      });
      expect(denied.statusCode).toBe(401);

      const first = await app.inject({
        method: "POST",
        url: "/api/cover/from-url",
        headers: { cookie: sessionCookie() },
        payload: { url: "http://127.0.0.1/a.png" },
      });
      expect(first.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe("static hosting", () => {
  it("serves index.html for unknown non-api GET routes", async () => {
    const app = await makeApp({}, { distDir: makeDist() });
    try {
      const res = await app.inject({ method: "GET", url: "/some/route?x=1" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.body).toContain(INDEX_MARKER);
    } finally {
      await app.close();
    }
  });

  it("serves the SPA shell at the root and existing assets", async () => {
    const app = await makeApp({}, { distDir: makeDist() });
    try {
      const root = await app.inject({ method: "GET", url: "/" });
      expect(root.statusCode).toBe(200);
      expect(root.headers["content-type"]).toContain("text/html");
      expect(root.body).toContain(INDEX_MARKER);

      const asset = await app.inject({ method: "GET", url: "/assets/app.js" });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers["content-type"]).toContain("javascript");
      expect(asset.body).toBe("console.log('ok');");
    } finally {
      await app.close();
    }
  });

  it("does not allow directory listing", async () => {
    const app = await makeApp({}, { distDir: makeDist() });
    try {
      const res = await app.inject({ method: "GET", url: "/assets/" });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain("app.js");
    } finally {
      await app.close();
    }
  });

  it("still starts and returns a hint page when dist is missing", async () => {
    const missing = path.join(tmpdir(), `txt2book-missing-dist-${Date.now()}`);
    const app = await makeApp({}, { distDir: missing });
    try {
      expect(existsSync(missing)).toBe(false);

      const root = await app.inject({ method: "GET", url: "/" });
      expect(root.statusCode).toBe(200);
      expect(root.headers["content-type"]).toContain("text/html");
      expect(root.body).toContain("npm run build");

      const spa = await app.inject({ method: "GET", url: "/some/route" });
      expect(spa.statusCode).toBe(200);
      expect(spa.body).toContain("npm run build");
    } finally {
      await app.close();
    }
  });

  it("normalizes encoded api paths in the not-found handler", async () => {
    const app = await makeApp({}, { distDir: makeDist() });
    try {
      // 守卫先按归一化路径要求认证，因此 404 分支需要有效会话才会到达。
      const res = await app.inject({
        method: "GET",
        url: "/%61pi/nope",
        headers: { cookie: sessionCookie() },
      });
      expect(res.statusCode).toBe(404);
      expect(res.headers["content-type"]).toContain("application/json");
      expect(res.json()).toEqual({ error: { code: "NOT_FOUND", message: "接口不存在。" } });

      // 未登录时守卫 fail closed，仍是 401 而不是 SPA HTML。
      const guarded = await app.inject({ method: "GET", url: "/%61pi/nope" });
      expect(guarded.statusCode).toBe(401);

      const absolute = await app.inject({
        method: "GET",
        url: "http://example.com/api/nope",
        headers: { cookie: sessionCookie() },
      });
      expect(absolute.statusCode).toBe(404);
      expect(absolute.headers["content-type"]).toContain("application/json");
    } finally {
      await app.close();
    }
  });

  it("returns 404 for missing assets and file-like paths instead of the SPA shell", async () => {
    const app = await makeApp({}, { distDir: makeDist() });
    try {
      for (const url of ["/assets/missing.js", "/favicon.ico", "/robots.txt"]) {
        const res = await app.inject({ method: "GET", url });
        expect(res.statusCode, url).toBe(404);
        expect(res.headers["content-type"], url).toContain("application/json");
        expect(res.body, url).not.toContain(INDEX_MARKER);
      }
    } finally {
      await app.close();
    }
  });

  it("keeps json 404 for unknown api routes and non-GET non-api routes", async () => {
    const app = await makeApp({}, { distDir: makeDist() });
    try {
      const api = await app.inject({
        method: "GET",
        url: "/api/nope",
        headers: { cookie: sessionCookie() },
      });
      expect(api.statusCode).toBe(404);
      expect(api.headers["content-type"]).toContain("application/json");
      expect(api.json()).toEqual({ error: { code: "NOT_FOUND", message: "接口不存在。" } });

      // 未登录的未知 /api 请求仍先被守卫拦截。
      const guarded = await app.inject({ method: "GET", url: "/api/nope" });
      expect(guarded.statusCode).toBe(401);

      const post = await app.inject({ method: "POST", url: "/some/route" });
      expect(post.statusCode).toBe(404);
      expect(post.headers["content-type"]).toContain("application/json");
    } finally {
      await app.close();
    }
  });
});

describe("security headers", () => {
  const CSP =
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
    "frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; " +
    "frame-ancestors 'none'";

  it("sets the required headers on every response", async () => {
    const app = await makeApp({}, { distDir: makeDist() });
    try {
      const responses = await Promise.all([
        app.inject({ method: "GET", url: "/" }),
        app.inject({ method: "GET", url: "/api/health" }),
        app.inject({ method: "POST", url: "/api/cover/from-url" }),
        app.inject({ method: "GET", url: "/api/nope" }),
      ]);

      for (const res of responses) {
        expect(res.headers["x-content-type-options"]).toBe("nosniff");
        expect(res.headers["referrer-policy"]).toBe("no-referrer");
        expect(res.headers["x-frame-options"]).toBe("DENY");
        expect(res.headers["content-security-policy"]).toBe(CSP);
      }
    } finally {
      await app.close();
    }
  });

  it("sets headers when dist is missing", async () => {
    const missing = path.join(tmpdir(), `txt2book-missing-dist-${Date.now()}-2`);
    const app = await makeApp({}, { distDir: missing });
    try {
      const res = await app.inject({ method: "GET", url: "/" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["content-security-policy"]).toBe(CSP);
    } finally {
      await app.close();
    }
  });
});
