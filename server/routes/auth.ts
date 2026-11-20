/**
 * 认证路由（设计文档 §13.2 / §13.3）：
 *
 * - `POST /api/auth/login`：校验单账号凭据，成功后签发 HMAC 会话 Cookie。
 * - `POST /api/auth/logout`：清除会话 Cookie。
 * - `GET  /api/auth/me`：读取 Cookie 报告登录状态。
 *
 * 安全要点：
 * - 登录失败统一 401 “用户名或密码错误”，不区分账号不存在与密码错误；
 *   用户名不匹配时仍然执行一次 scrypt 校验，避免通过响应时间枚举用户名。
 * - 登录限流按 IP 与用户名各 5 次 / 15 分钟。
 * - 所有状态变更请求（有 `Origin` 头时）校验与 Host 同源，防 CSRF；GET/HEAD/OPTIONS 不校验。
 * - 不记录密码或 Cookie。
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { AppConfig } from "../lib/config.js";
import { clientIp } from "../lib/clientIp.js";
import { verifyPassword } from "../lib/password.js";
import { createRateLimiter } from "../lib/rateLimit.js";
import { SESSION_COOKIE, signSession, verifySession } from "../lib/session.js";

/** 登录限流：每 IP / 每用户名 5 次 / 15 分钟（设计文档 §13.2）。 */
const LOGIN_LIMIT = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/** 用户名与密码的输入上限；超长用户名只影响限流 key，不参与凭据比较。 */
const MAX_USERNAME_LENGTH = 256;
const MAX_PASSWORD_LENGTH = 1024;

const SECONDS_PER_DAY = 86_400;
const RETRY_AFTER_SECONDS = Math.ceil(LOGIN_WINDOW_MS / 1000);

/** 统一错误体，与前端 `ApiError` 的 `{error:{code,message}}` 约定一致。 */
function errorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

/** 认证响应不缓存：避免中间代理或浏览器缓存登录状态与错误。 */
function noStore(reply: FastifyReply): FastifyReply {
  return reply.header("cache-control", "no-store");
}

/** 状态变更方法：只有这些方法参与 Origin 校验。 */
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** 把 hostname/port 归一化成 `host:port`，缺省端口按协议补齐。 */
function normalizeHostPort(hostname: string, port: string, protocol: string): string {
  const name = hostname.toLowerCase();
  if (port !== "") return `${name}:${port}`;
  return `${name}:${protocol === "https:" ? "443" : "80"}`;
}

/**
 * 判断 `Origin` 是否与请求同源（协议 + 主机 + 端口）。
 *
 * `protocol` 来自 `request.protocol`，开启 `TRUST_PROXY` 时 Fastify 会采用
 * `X-Forwarded-Proto`，因此反代终止 TLS 后仍能正确比较。`Origin: null`、
 * 非 http(s) 或任何无法解析的值都视为不同源。
 */
function isSameOrigin(origin: string, host: string | undefined, protocol: string): boolean {
  if (host === undefined || host === "") return false;

  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  if (originUrl.protocol !== "http:" && originUrl.protocol !== "https:") return false;

  // request.protocol 形如 "http" / "https"，不带冒号。
  if (originUrl.protocol !== `${protocol.replace(/:$/, "")}:`) return false;

  let hostUrl: URL;
  try {
    hostUrl = new URL(`${originUrl.protocol}//${host}`);
  } catch {
    return false;
  }

  return (
    normalizeHostPort(originUrl.hostname, originUrl.port, originUrl.protocol) ===
    normalizeHostPort(hostUrl.hostname, hostUrl.port, originUrl.protocol)
  );
}

/** 认证路由的可注入依赖：登出时清理其他会话级状态（如 calibre-web 内存连接）。 */
export interface AuthRouteDeps {
  onLogout?: () => void;
}

/**
 * 注册认证路由与全局 Origin 校验。
 *
 * 路由与 hook 同步注册在根实例上（Origin 校验需要覆盖其他任务后续注册的 POST 路由），
 * 返回的 Promise 立即 resolve，便于调用方统一 `await`。
 */
export function registerAuthRoutes(
  app: FastifyInstance,
  config: AppConfig,
  deps: AuthRouteDeps = {},
): Promise<void> {
  const ipLimiter = createRateLimiter({ limit: LOGIN_LIMIT, windowMs: LOGIN_WINDOW_MS });
  const usernameLimiter = createRateLimiter({ limit: LOGIN_LIMIT, windowMs: LOGIN_WINDOW_MS });

  const cookieOptions = (maxAge: number) => ({
    httpOnly: true,
    sameSite: "strict" as const,
    path: "/",
    secure: config.cookieSecure,
    maxAge,
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!STATE_CHANGING_METHODS.has(request.method)) return;
    const origin = request.headers.origin;
    // 浏览器同源 POST 一定带 Origin；非浏览器客户端（curl、测试、健康检查）可能不带，
    // 此时不做否决，仍由会话 Cookie 的 SameSite=Strict 兜底。
    if (origin === undefined) return;
    if (!isSameOrigin(origin, request.headers.host, request.protocol)) {
      return reply.status(403).send(errorBody("FORBIDDEN", "跨站请求被拒绝。"));
    }
  });

  app.post("/api/auth/login", async (request, reply) => {
    noStore(reply);

    // 开发模式：不校验凭据，直接视为登录成功。
    if (config.authDisabled) {
      return reply.status(204).send();
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const rawUsername = typeof body.username === "string" ? body.username : "";
    const rawPassword = typeof body.password === "string" ? body.password : "";
    // 截断值只用于限流 key（限制内存占用），凭据比较始终使用完整用户名。
    const usernameKey = rawUsername.slice(0, MAX_USERNAME_LENGTH);
    const passwordTooLong = rawPassword.length > MAX_PASSWORD_LENGTH;
    const ipKey = `login:ip:${clientIp(request)}`;
    const userKey = `login:user:${usernameKey}`;

    // 任一维度已超限时直接拒绝，且不为另一个维度插入新桶：
    // 攻击者轮换用户名/来源时不会让限流 Map 因“已封禁维度”继续增长。
    if (ipLimiter.blocked(ipKey) || usernameLimiter.blocked(userKey)) {
      return noStore(reply)
        .header("retry-after", String(RETRY_AFTER_SECONDS))
        .status(429)
        .send(errorBody("RATE_LIMITED", "登录尝试过于频繁，请 15 分钟后再试。"));
    }

    // 两个维度都先记一次命中，避免短路导致用户名桶漏记。
    const ipAllowed = ipLimiter.hit(ipKey);
    const userAllowed = usernameLimiter.hit(userKey);
    if (!ipAllowed || !userAllowed) {
      return noStore(reply)
        .header("retry-after", String(RETRY_AFTER_SECONDS))
        .status(429)
        .send(errorBody("RATE_LIMITED", "登录尝试过于频繁，请 15 分钟后再试。"));
    }

    // 超长密码不截断比较（截断会让前缀相同的密码意外通过），但依旧执行一次 scrypt。
    const passwordOk = await verifyPassword(
      passwordTooLong ? "" : rawPassword,
      config.passwordHash,
    );
    if (passwordTooLong || rawUsername !== config.username || !passwordOk) {
      return reply.status(401).send(errorBody("INVALID_CREDENTIALS", "用户名或密码错误"));
    }

    const now = Date.now();
    const ttlSeconds = config.sessionTtlDays * SECONDS_PER_DAY;
    const token = signSession(
      { sub: config.username, iat: now, exp: now + ttlSeconds * 1000 },
      config.sessionSecret,
    );

    return reply
      .setCookie(SESSION_COOKIE, token, cookieOptions(ttlSeconds))
      .status(204)
      .send();
  });

  app.post("/api/auth/logout", async (_request, reply) => {
    noStore(reply);
    // 先清理其他会话级状态再响应；即使清理抛错也必须完成登出（删除 Cookie）。
    try {
      deps.onLogout?.();
    } catch {
      // 忽略清理失败：登出本身不能被阻断。
    }
    // 显式 maxAge=0，确保浏览器立即删除 Cookie。
    return reply
      .setCookie(SESSION_COOKIE, "", cookieOptions(0))
      .status(204)
      .send();
  });

  app.get("/api/auth/me", async (request, reply) => {
    noStore(reply);

    if (config.authDisabled) {
      return { authenticated: true, username: "dev" };
    }

    const token = request.cookies[SESSION_COOKIE];
    if (typeof token !== "string" || token === "") {
      return { authenticated: false };
    }

    const payload = verifySession(token, config.sessionSecret);
    if (payload === null) {
      return { authenticated: false };
    }
    return { authenticated: true, username: payload.sub };
  });

  return Promise.resolve();
}
