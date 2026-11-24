// @vitest-environment node
import { createHmac } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../server/app";
import { loadConfig } from "../../server/lib/config";
import { hashPassword } from "../../server/lib/password";
import { SESSION_COOKIE, signSession } from "../../server/lib/session";

const SECRET = "s".repeat(32);
const PASSWORD = "pw";

let storedHash = "";

beforeAll(async () => {
  storedHash = await hashPassword(PASSWORD);
});

/** 测试用环境变量：绕过 `NodeJS.ProcessEnv` 的只读索引签名。 */
function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

async function createApp(overrides: Record<string, string> = {}): Promise<FastifyInstance> {
  const config = loadConfig(
    env({
      SESSION_SECRET: SECRET,
      AUTH_PASSWORD_HASH: storedHash,
      AUTH_USERNAME: "admin",
      ...overrides,
    }),
  );
  const app = buildServer(config);
  await app.ready();
  return app;
}

/** 从 `set-cookie` 响应头中取出会话 Cookie 的值。 */
function sessionCookieValue(setCookie: string | string[] | undefined): string {
  const raw = Array.isArray(setCookie) ? setCookie.join("\n") : (setCookie ?? "");
  const match = new RegExp(`${SESSION_COOKIE}=([^;\\s]+)`).exec(raw);
  if (match === null) throw new Error("响应未设置会话 Cookie");
  return match[1] as string;
}

function cookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${token}`;
}

/** 用真实密钥签出一个结构任意的会话令牌，用于测试字段校验。 */
function forgeSession(payload: unknown): string {
  const payloadPart = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", SECRET).update(payloadPart).digest("base64url");
  return `${payloadPart}.${signature}`;
}

describe("POST /api/auth/login", () => {
  it("logs a rejection reason without leaking credentials", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = await createApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "admin", password: "wrong-password" },
      });
      expect(res.statusCode).toBe(401);
      const logged = warn.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(logged).toContain("[auth] 登录失败");
      expect(logged).toContain("reason=password_mismatch");
      expect(logged).not.toContain("wrong-password");
      expect(logged).not.toContain(storedHash);
    } finally {
      warn.mockRestore();
      await app.close();
    }
  });

  it("sets an http-only strict cookie on success", async () => {
    const app = await createApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "admin", password: PASSWORD },
      });
      expect(res.statusCode).toBe(204);
      expect(res.headers["cache-control"]).toBe("no-store");
      const cookie = res.headers["set-cookie"] as string;
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain("Max-Age=2592000");
      expect(cookie).not.toContain("Secure");
      // 不设置 Domain，避免 Cookie 泄漏到同站的其他子域。
      expect(cookie).not.toContain("Domain=");
    } finally {
      await app.close();
    }
  });

  it("marks the cookie secure when COOKIE_SECURE=true", async () => {
    const app = await createApp({ COOKIE_SECURE: "true" });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "admin", password: PASSWORD },
      });
      expect(res.statusCode).toBe(204);
      expect(res.headers["set-cookie"] as string).toContain("Secure");
    } finally {
      await app.close();
    }
  });

  it("honours SESSION_TTL_DAYS for Max-Age", async () => {
    const app = await createApp({ SESSION_TTL_DAYS: "1" });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "admin", password: PASSWORD },
      });
      expect(res.headers["set-cookie"] as string).toContain("Max-Age=86400");
    } finally {
      await app.close();
    }
  });

  it("returns a generic 401 for a wrong password", async () => {
    const app = await createApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "admin", password: "bad" },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.message).toBe("用户名或密码错误");
      expect(res.headers["set-cookie"]).toBeUndefined();
      expect(res.headers["cache-control"]).toBe("no-store");
    } finally {
      await app.close();
    }
  });

  it("returns the same generic 401 for an unknown username", async () => {
    const app = await createApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "nobody", password: PASSWORD },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("INVALID_CREDENTIALS");
      expect(res.json().error.message).toBe("用户名或密码错误");
      expect(res.headers["set-cookie"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("returns 401 rather than throwing on a malformed body", async () => {
    const app = await createApp();
    try {
      for (const payload of [{}, { username: 1, password: true }, { username: "admin" }]) {
        const res = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: payload as Record<string, unknown>,
        });
        expect(res.statusCode).toBe(401);
        expect(res.json().error.message).toBe("用户名或密码错误");
      }
    } finally {
      await app.close();
    }
  });

  it("succeeds without credentials when AUTH_DISABLED=true", async () => {
    const app = await createApp({ AUTH_DISABLED: "true", SESSION_SECRET: "", AUTH_PASSWORD_HASH: "" });
    try {
      const res = await app.inject({ method: "POST", url: "/api/auth/login" });
      expect(res.statusCode).toBe(204);
    } finally {
      await app.close();
    }
  });
});

describe("GET /api/auth/me", () => {
  it("reports me without a session as unauthenticated", async () => {
    const app = await createApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/auth/me" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ authenticated: false });
      expect(res.headers["cache-control"]).toBe("no-store");
    } finally {
      await app.close();
    }
  });

  it("reports the signed-in user for a valid cookie", async () => {
    const app = await createApp();
    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "admin", password: PASSWORD },
      });
      const token = sessionCookieValue(login.headers["set-cookie"]);
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { cookie: cookieHeader(token) },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ authenticated: true, username: "admin" });
    } finally {
      await app.close();
    }
  });

  it("rejects an expired session cookie", async () => {
    const app = await createApp();
    try {
      const expired = signSession(
        { sub: "admin", iat: 1, exp: Date.now() - 1_000 },
        SECRET,
      );
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { cookie: cookieHeader(expired) },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ authenticated: false });
    } finally {
      await app.close();
    }
  });

  it("rejects a tampered session cookie", async () => {
    const app = await createApp();
    try {
      const token = signSession({ sub: "admin", iat: 1, exp: Date.now() + 60_000 }, SECRET);
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { cookie: cookieHeader(`${token}x`) },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ authenticated: false });
    } finally {
      await app.close();
    }
  });

  it("does not throw on a malformed cookie", async () => {
    const app = await createApp();
    try {
      for (const raw of ["not-a-token", "a.b.c", "%%%", `${SESSION_COOKIE}=`]) {
        const res = await app.inject({
          method: "GET",
          url: "/api/auth/me",
          headers: { cookie: raw.includes("=") ? raw : cookieHeader(raw) },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ authenticated: false });
      }
    } finally {
      await app.close();
    }
  });

  it("rejects a correctly signed token with non-numeric iat/exp", async () => {
    const app = await createApp();
    try {
      const future = Date.now() + 60_000;
      const tokens = [
        forgeSession({ sub: "admin", iat: "now", exp: future }),
        forgeSession({ sub: "admin", iat: 1, exp: String(future) }),
        forgeSession({ sub: "admin", iat: 1 }),
        forgeSession({ sub: "admin", iat: 1, exp: Number.POSITIVE_INFINITY }),
      ];
      for (const token of tokens) {
        const res = await app.inject({
          method: "GET",
          url: "/api/auth/me",
          headers: { cookie: cookieHeader(token) },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ authenticated: false });
      }
    } finally {
      await app.close();
    }
  });

  it("reports the dev user when AUTH_DISABLED=true", async () => {
    const app = await createApp({ AUTH_DISABLED: "true", SESSION_SECRET: "", AUTH_PASSWORD_HASH: "" });
    try {
      const res = await app.inject({ method: "GET", url: "/api/auth/me" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ authenticated: true, username: "dev" });
    } finally {
      await app.close();
    }
  });
});

describe("POST /api/auth/logout", () => {
  it("clears the session cookie", async () => {
    const app = await createApp();
    try {
      const res = await app.inject({ method: "POST", url: "/api/auth/logout" });
      expect(res.statusCode).toBe(204);
      const cookie = res.headers["set-cookie"] as string;
      expect(cookie).toContain(`${SESSION_COOKIE}=`);
      expect(cookie).toContain("Max-Age=0");
      expect(cookie).toContain("HttpOnly");
      // 登出与登录使用同一组属性，避免浏览器按不同作用域保留旧 Cookie。
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).toContain("Path=/");
      expect(cookie).not.toContain("Domain=");
      expect(cookie).not.toContain("Secure");
    } finally {
      await app.close();
    }
  });

  it("keeps the secure flag when clearing a secure cookie", async () => {
    const app = await createApp({ COOKIE_SECURE: "true" });
    try {
      const res = await app.inject({ method: "POST", url: "/api/auth/logout" });
      expect(res.headers["set-cookie"] as string).toContain("Secure");
    } finally {
      await app.close();
    }
  });
});

describe("origin check", () => {
  it("rejects a cross-site login with 403", async () => {
    const app = await createApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: "https://evil.example", host: "localhost:80" },
        payload: { username: "admin", password: PASSWORD },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("FORBIDDEN");
    } finally {
      await app.close();
    }
  });

  it("accepts a same-origin login", async () => {
    const app = await createApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: "http://localhost:80", host: "localhost:80" },
        payload: { username: "admin", password: PASSWORD },
      });
      expect(res.statusCode).toBe(204);
    } finally {
      await app.close();
    }
  });

  it("accepts the dev proxy shape when Host keeps the frontend origin", async () => {
    // Vite 代理不开启 changeOrigin 时，后端看到的是浏览器原始 Host：
    // Host: localhost:5199 + Origin: http://localhost:5199 属于同源。
    const app = await createApp({ AUTH_DISABLED: "true" });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: "http://localhost:5199", host: "localhost:5199" },
      });
      expect(res.statusCode).toBe(204);
    } finally {
      await app.close();
    }
  });

  it("rejects the dev proxy shape when Host was rewritten to the backend", async () => {
    // 回归防护：changeOrigin: true 会把 Host 改成 127.0.0.1:3000，
    // 与浏览器的 Origin 不同源，导致开发时所有 POST 403。
    const app = await createApp({ AUTH_DISABLED: "true" });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: "http://localhost:5199", host: "127.0.0.1:3000" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("FORBIDDEN");
    } finally {
      await app.close();
    }
  });

  it("skips the check when Origin is absent", async () => {
    const app = await createApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "admin", password: PASSWORD },
      });
      expect(res.statusCode).toBe(204);
    } finally {
      await app.close();
    }
  });

  it("does not block safe methods", async () => {
    const app = await createApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { origin: "https://evil.example", host: "localhost:80" },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("rejects the opaque Origin: null", async () => {
    const app = await createApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: "null", host: "localhost:80" },
        payload: { username: "admin", password: PASSWORD },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("FORBIDDEN");
    } finally {
      await app.close();
    }
  });

  it("rejects an unparsable Origin", async () => {
    const app = await createApp();
    try {
      for (const origin of ["not a url", "ftp://localhost", "http://"]) {
        const res = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          headers: { origin, host: "localhost:80" },
          payload: { username: "admin", password: PASSWORD },
        });
        expect(res.statusCode).toBe(403);
      }
    } finally {
      await app.close();
    }
  });

  it("rejects an Origin whose scheme differs from the request", async () => {
    const app = await createApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: "https://localhost:80", host: "localhost:80" },
        payload: { username: "admin", password: PASSWORD },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});

describe("login rate limiting", () => {
  it("rate limits the sixth login attempt", async () => {
    const app = await createApp();
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const res = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { username: "admin", password: "bad" },
        });
        expect(res.statusCode).toBe(401);
      }
      const limited = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "admin", password: "bad" },
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error.code).toBe("RATE_LIMITED");
      expect(limited.json().error.message).toContain("频繁");
      expect(limited.headers["retry-after"]).toBe("900");
      expect(limited.headers["cache-control"]).toBe("no-store");
    } finally {
      await app.close();
    }
  });

  it("rate limits per username across different IPs", async () => {
    const app = await createApp();
    try {
      // 每次用不同的源 IP，隔离 IP 桶，只让用户名桶累积。
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const res = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          remoteAddress: `10.0.0.${attempt + 1}`,
          payload: { username: "nobody", password: "bad" },
        });
        expect(res.statusCode).toBe(401);
      }
      const blocked = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        remoteAddress: "10.0.0.99",
        payload: { username: "nobody", password: "bad" },
      });
      expect(blocked.statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });

  it("rate limits per IP across different usernames", async () => {
    const app = await createApp();
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const res = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          remoteAddress: "10.1.1.1",
          payload: { username: `user${attempt}`, password: "bad" },
        });
        expect(res.statusCode).toBe(401);
      }
      const blocked = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        remoteAddress: "10.1.1.1",
        payload: { username: "admin", password: PASSWORD },
      });
      expect(blocked.statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });

  it("ignores X-Forwarded-For when TRUST_PROXY is off", async () => {
    const app = await createApp();
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const res = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          remoteAddress: "10.2.2.2",
          headers: { "x-forwarded-for": `203.0.113.${attempt + 1}` },
          payload: { username: "admin", password: "bad" },
        });
        expect(res.statusCode).toBe(401);
      }
      const blocked = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        remoteAddress: "10.2.2.2",
        headers: { "x-forwarded-for": "203.0.113.200" },
        payload: { username: "admin", password: "bad" },
      });
      expect(blocked.statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });

  it("falls back to the socket IP when X-Forwarded-For is oversized", async () => {
    const app = await createApp({ TRUST_PROXY: "true" });
    try {
      // 每次用不同用户名，确保用户名桶永远不会触发限流；
      // 6 次请求只能因共享 socket IP 桶而被限流，从而证明超长 XFF 被回退。
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const res = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          remoteAddress: "10.8.8.8",
          headers: { "x-forwarded-for": `${"a".repeat(300)}${attempt}` },
          payload: { username: `u${attempt}`, password: "bad" },
        });
        expect(res.statusCode).toBe(401);
      }
      const blocked = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        remoteAddress: "10.8.8.8",
        headers: { "x-forwarded-for": `${"b".repeat(300)}x` },
        payload: { username: "u5", password: "bad" },
      });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error.code).toBe("RATE_LIMITED");
    } finally {
      await app.close();
    }
  });

  it("does not share a bucket for distinct valid X-Forwarded-For IPs", async () => {
    const app = await createApp({ TRUST_PROXY: "true" });
    try {
      // 对照用例：同样 6 次请求，但 XFF 是合法且互不相同的 IP，用户名也各不相同，
      // 因此每个桶都只记 1 次，不应出现 429（说明 TRUST_PROXY 确实采用了 XFF）。
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const res = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          remoteAddress: "10.8.8.8",
          headers: { "x-forwarded-for": `203.0.113.${attempt + 1}` },
          payload: { username: `v${attempt}`, password: "bad" },
        });
        expect(res.statusCode).toBe(401);
      }
    } finally {
      await app.close();
    }
  });
});

describe("username truncation", () => {
  it("does not authenticate an over-long username with the correct password", async () => {
    const app = await createApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: `admin${"x".repeat(300)}`, password: PASSWORD },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.message).toBe("用户名或密码错误");
      expect(res.headers["set-cookie"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("compares the full username even when the configured name exceeds 256 chars", async () => {
    // 若实现把用户名截断后再比较，`prefix + "extra"` 会错误地认证成功。
    const prefix = "a".repeat(256);
    const app = await createApp({ AUTH_USERNAME: prefix });
    try {
      const overlong = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: `${prefix}extra`, password: PASSWORD },
      });
      expect(overlong.statusCode).toBe(401);
      expect(overlong.headers["set-cookie"]).toBeUndefined();

      const exact = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: prefix, password: PASSWORD },
      });
      expect(exact.statusCode).toBe(204);
    } finally {
      await app.close();
    }
  });

  it("truncates only the rate-limit key for over-long usernames", async () => {
    const prefix = "u".repeat(256);
    const app = await createApp();
    try {
      // 256 字符之后各不相同，但限流 key 相同；每次换源 IP 以排除 IP 桶。
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const res = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          remoteAddress: `10.3.3.${attempt + 1}`,
          payload: { username: `${prefix}${attempt}`, password: "bad" },
        });
        expect(res.statusCode).toBe(401);
      }
      const blocked = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        remoteAddress: "10.3.3.99",
        payload: { username: `${prefix}zzz`, password: "bad" },
      });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error.code).toBe("RATE_LIMITED");
    } finally {
      await app.close();
    }
  });
});
