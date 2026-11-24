import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { registerAuthGuard } from "./lib/authGuard.js";
import { createCalibreService, type CalibreService } from "./lib/calibre/service.js";
import type { AppConfig } from "./lib/config.js";
import { isApiPath, normalizeRequestPath } from "./lib/requestPath.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerCalibreRoutes } from "./routes/calibre.js";
import { MAX_COVER_UPLOAD_BYTES, registerCoverRoutes } from "./routes/cover.js";
import { registerExportRoutes, type ExportRouteDeps } from "./routes/export.js";

/** 前端构建产物目录；源码运行时为项目根目录下的 `dist/`。 */
export const DEFAULT_DIST_DIR = fileURLToPath(new URL("../dist/", import.meta.url));

/** 安全头：所有响应（含错误、静态资源）统一附加（设计文档 §13.3 / 任务约定）。 */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
    "frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; " +
    "frame-ancestors 'none'",
};

/** `dist/` 不存在时的开发提示页：服务仍可启动，方便本地分别跑 Vite 与 API。 */
const DEV_HINT_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>txt2book</title>
  </head>
  <body>
    <h1>前端尚未构建</h1>
    <p>未找到 dist/index.html。请先运行 npm run build 构建前端，或在开发时使用 npm run dev。</p>
  </body>
</html>
`;

/** 未匹配路由的 JSON 错误体，与前端 `ApiError` 的 `{error:{code,message}}` 约定一致。 */
function notFoundBody(message: string): { error: { code: string; message: string } } {
  return { error: { code: "NOT_FOUND", message } };
}

/** Fastify bodyLimit 触发的 413：单独给出可识别的错误码，避免与 500 混淆。 */
const PAYLOAD_TOO_LARGE_BODY = {
  error: { code: "PAYLOAD_TOO_LARGE", message: "请求内容过大。" },
} as const;

const FASTIFY_BODY_TOO_LARGE_CODE = "FST_ERR_CTP_BODY_TOO_LARGE";

/**
 * 命中 404 时是否应直接 404，而不是回退到 SPA。
 *
 * `/assets/*` 与「最后一段带扩展名」的路径按静态文件处理：
 * 缺失资源返回 404，避免把 HTML 当 JS/CSS 返回（浏览器会报 MIME 错误，
 * 也会掩盖真实的资源缺失）。只有无扩展名的前端路由才回退到 index.html。
 */
function isStaticAssetPath(requestedPath: string): boolean {
  if (requestedPath === "/assets" || requestedPath.startsWith("/assets/")) return true;
  const lastSegment = requestedPath.slice(requestedPath.lastIndexOf("/") + 1);
  return /\.[A-Za-z0-9]+$/.test(lastSegment);
}

export interface BuildServerOptions {
  /** 覆盖静态资源目录，仅用于测试；默认项目根目录的 `dist/`。 */
  distDir?: string;
  /** 覆盖 PDF 导出依赖（渲染器与时钟），仅用于测试。 */
  exportDeps?: ExportRouteDeps;
  /** 覆盖 calibre-web 依赖（service 与限流时钟），仅用于测试。 */
  calibreDeps?: {
    service?: CalibreService;
    now?: () => number;
  };
}

/**
 * 组装 Fastify 实例：注册插件、守卫与路由，但不监听端口。
 * 测试只导入本文件，入口文件 `index.ts` 负责读取环境变量并 `listen`。
 */
export function buildServer(config: AppConfig, options: BuildServerOptions = {}): FastifyInstance {
  // TRUST_PROXY=true 时 Fastify 会采用 X-Forwarded-For / X-Forwarded-Proto 作为客户端 IP 与协议；
  // 这要求反向代理覆盖（而不是追加）这些头，否则客户端可伪造 IP 绕过登录限流。
  const app = Fastify({
    logger: false,
    trustProxy: config.trustProxy,
    // Fastify 默认 `removeAdditional: true` 会静默丢弃 schema 之外的字段。
    // 本项目的路由用 `additionalProperties: false` 表达「拒绝多余字段」，
    // 因此关闭自动剔除，让多余字段真正变成校验错误（如 calibre 连接 body）。
    ajv: { customOptions: { removeAdditional: false } },
  });

  // 安全头必须最先注册，确保后续所有路由（含静态与 404）都带上。
  app.addHook("onSend", async (_request, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      reply.header(name, value);
    }
    return payload;
  });

  // 统一错误出口：任何未被路由捕获的错误都只返回固定中文结构。
  // 不输出框架错误消息、`error` 字段或请求数据；保留 4xx 状态码（如 400/413/415），
  // 其余错误一律视为 500，避免把内部失败包装成可区分的客户端错误。
  // bodyLimit 触发的 413 单独映射为 PAYLOAD_TOO_LARGE，其余 4xx/5xx 行为保持不变。
  app.setErrorHandler(async (error, _request, reply) => {
    const rawStatus =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : 0;
    const rawCode =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : "";

    if (rawCode === FASTIFY_BODY_TOO_LARGE_CODE || rawStatus === 413) {
      return reply
        .header("cache-control", "no-store")
        .status(413)
        .send(PAYLOAD_TOO_LARGE_BODY);
    }

    const statusCode = rawStatus >= 400 && rawStatus < 500 ? rawStatus : 500;
    return reply
      .header("cache-control", "no-store")
      .status(statusCode)
      .send({ error: { code: "INTERNAL", message: "服务器内部错误。" } });
  });

  // API 只接受 JSON：移除 Fastify 内置的 text/plain 解析器，
  // 让纯文本请求走 415，而不是被当作合法字符串交给路由。
  app.removeContentTypeParser("text/plain");

  // 会话 Cookie 的读取与序列化；认证路由依赖 `request.cookies` / `reply.setCookie`。
  app.register(cookie);

  // 封面本地上传：单文件上限取封面与 calibre 推送的较大值，保证推送大文件不被全局插件拦截；
  // 每个路由仍通过 `request.file({ limits })` 声明自己的实际上限（封面 10MB、推送可配置）。
  app.register(multipart, {
    limits: {
      fileSize: Math.max(MAX_COVER_UPLOAD_BYTES, config.calibreMaxPushBytes),
      files: 1,
      parts: 8,
    },
  });

  // calibre-web 集成：进程内单个连接，登出时清理。
  const calibreService = options.calibreDeps?.service ?? createCalibreService(config);

  // 全局 `/api` 守卫必须在业务路由之前注册，才能在 `onRequest` 阶段覆盖它们。
  registerAuthGuard(app, config);

  // 健康检查保持公开，供容器与反代探活。
  app.get("/api/health", async () => ({ ok: true }));

  // 认证路由同步注册在根实例上；其 Origin 校验 hook 同时覆盖后续注册的 POST 路由。
  void registerAuthRoutes(app, config, { onLogout: () => calibreService.clearLive() });

  // 封面抓取/转换路由；认证与限流在守卫和路由内完成。
  void registerCoverRoutes(app, config);

  // PDF 导出：认证由全局守卫覆盖，限流、并发、超时与内容上限在路由内处理。
  void registerExportRoutes(app, config, options.exportDeps);

  // calibre-web 书库：认证由全局守卫覆盖，限流、参数校验与错误映射在路由内完成。
  void registerCalibreRoutes(app, config, calibreService, {
    ...(options.calibreDeps?.now === undefined ? {} : { now: options.calibreDeps.now }),
  });

  // 前端构建产物：`wildcard: false` 只为启动时已存在的文件注册路由，
  // 不提供目录列表；未知非 API 路径由 404 处理器回退到 index.html。
  const distDir = options.distDir ?? DEFAULT_DIST_DIR;
  const indexPath = path.join(distDir, "index.html");
  const indexHtml = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : null;

  if (indexHtml !== null) {
    app.register(fastifyStatic, {
      root: distDir,
      wildcard: false,
      index: false,
      list: false,
      redirect: false,
    });
  }

  // 未知路由：与守卫共用同一套路径归一化，`/%61pi/nope` 也必须得到 JSON 404；
  // 非 API 的无扩展名 GET/HEAD 交给 SPA，静态资源与带扩展名的路径保持 404。
  app.setNotFoundHandler(async (request, reply) => {
    const { path: requestedPath } = normalizeRequestPath(request.url);
    if (isApiPath(requestedPath)) {
      return reply.status(404).send(notFoundBody("接口不存在。"));
    }

    if (request.method === "GET" || request.method === "HEAD") {
      if (isStaticAssetPath(requestedPath)) {
        return reply.status(404).send(notFoundBody("资源不存在。"));
      }
      return reply
        .type("text/html; charset=utf-8")
        .status(200)
        .send(indexHtml ?? DEV_HINT_HTML);
    }

    return reply.status(404).send(notFoundBody("资源不存在。"));
  });

  return app;
}
