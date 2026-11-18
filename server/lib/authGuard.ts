/**
 * 全局认证守卫（设计文档 §13.3）。
 *
 * 除白名单外，所有 `/api/*` 请求都必须在 `onRequest` 阶段携带有效会话，
 * 否则返回 401。放在 `onRequest` 而不是路由处理器里，保证：
 * - 未登录请求不会被读取 body（大文件上传、畸形 JSON 都不会触达解析器）；
 * - 新增 API 路由默认受保护，避免忘记加认证。
 *
 * `/api` 之外的路径（静态资源与 SPA 回退）不做鉴权：它们不含敏感数据，
 * 未登录时前端只渲染登录页。
 *
 * 白名单只放认证自身与探活接口：登录、登出、当前用户、健康检查。
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";
import { isApiPath, normalizeRequestPath } from "./requestPath.js";
import { SESSION_COOKIE, verifySession } from "./session.js";

/** 无需会话即可访问的 `METHOD path` 组合，路径已归一化。 */
const PUBLIC_ROUTES = new Set([
  "GET /api/health",
  "HEAD /api/health",
  "POST /api/auth/login",
  "GET /api/auth/me",
  "POST /api/auth/logout",
]);

const UNAUTHORIZED_BODY = { error: { code: "UNAUTHORIZED", message: "请先登录。" } } as const;

/**
 * 从原始 `Cookie` 请求头读取指定 Cookie。
 *
 * 守卫注册得比 `@fastify/cookie` 的解析 hook 更早（同层 hook 按注册顺序执行），
 * 因此这里直接解析请求头，避免依赖插件初始化顺序。会话令牌是 base64url + `.`，
 * 浏览器不会做额外编码，无需再解码。
 */
function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined || header === "") return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return value === "" ? null : value;
  }
  return null;
}

/** 校验会话；任何畸形、篡改、过期或用户不匹配的令牌都视为未登录。 */
function hasValidSession(request: FastifyRequest, config: AppConfig): boolean {
  const token = readCookie(request.headers.cookie, SESSION_COOKIE);
  if (token === null) return false;

  const payload = verifySession(token, config.sessionSecret);
  return payload !== null && payload.sub === config.username;
}

/**
 * 注册全局 `/api` 守卫。必须在业务路由之前调用，`onRequest` hook 才会覆盖它们。
 * `AUTH_DISABLED=true`（仅本地开发）时直接放行。
 */
export function registerAuthGuard(app: FastifyInstance, config: AppConfig): void {
  app.addHook("onRequest", async (request, reply) => {
    if (config.authDisabled) return;

    // 不能用原始 `request.url` 做前缀判断：路由器会先解析 absolute-form 并解码一次。
    const { path, suspicious } = normalizeRequestPath(request.url);

    // 异常目标一律 fail closed；非 API 的普通路径交给静态资源与 SPA。
    if (!suspicious && !isApiPath(path)) return;

    // 白名单只认精确的「方法 + 归一化路径」；异常目标不允许借白名单免认证。
    if (!suspicious && PUBLIC_ROUTES.has(`${request.method} ${path}`)) return;
    if (hasValidSession(request, config)) return;

    return reply
      .header("cache-control", "no-store")
      .status(401)
      .send(UNAUTHORIZED_BODY);
  });
}
