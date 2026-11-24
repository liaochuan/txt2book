import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildServer, DEFAULT_DIST_DIR } from "./app.js";
import { loadConfig } from "./lib/config.js";
import { isPasswordHashValid } from "./lib/password.js";

/**
 * 组装启动失败信息。
 * 常见误用是配置了 `.env` 却直接运行 `node server-dist/index.js`——Node 不会自动读取它。
 * 这里只在检测到 `.env` 且错误是缺配置时追加提示，不改变原始错误。
 */
export function formatStartupError(error: unknown, hasEnvFile: boolean): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (!hasEnvFile || !detail.includes("缺少必需的环境变量")) return detail;
  return [
    detail,
    "检测到 .env，但当前进程没有加载它。请使用 npm run dev:server（开发）或 npm start（构建后）启动，",
    "或显式执行 node --env-file=.env server-dist/index.js。",
  ].join("\n");
}

/** 启动服务：读取环境变量、构建实例并监听端口。 */
export async function start(): Promise<void> {
  const config = loadConfig(process.env);

  if (config.authDisabled) {
    console.warn("⚠ 警告：AUTH_DISABLED=true，登录认证已关闭，仅限本地开发环境使用。");
  } else {
    const hashValid = isPasswordHashValid(config.passwordHash);
    const usernameConfigured = (process.env.AUTH_USERNAME ?? "").trim() !== "";
    console.info(
      `[auth] 登录已启用 COOKIE_SECURE=${config.cookieSecure} TRUST_PROXY=${config.trustProxy} username=${usernameConfigured ? "来自 AUTH_USERNAME" : "默认"} password_hash=${hashValid ? "有效" : "无效"}`,
    );
    if (!hashValid) {
      console.warn(
        "[auth] AUTH_PASSWORD_HASH 格式无效，任何密码都会登录失败。请重新生成：npm run hash-password -- '你的密码'，并把输出直接写入 .env（避免 $ 被 shell 展开，也不要保留外层引号）。",
      );
    }
  }

  // 构建产物存在但缺少图标，说明 public/ 没有进入构建；图标与 manifest 会 404。
  if (
    existsSync(join(DEFAULT_DIST_DIR, "index.html")) &&
    !existsSync(join(DEFAULT_DIST_DIR, "favicon.svg"))
  ) {
    console.warn(
      "[static] dist/favicon.svg 不存在：构建未包含 public/ 资源，图标与 manifest 会返回 404，请重新构建镜像。",
    );
  }

  const app = buildServer(config);
  // 监听失败时由入口捕获并用 console.error 输出（`logger: false` 下 app.log 是空操作）。
  await app.listen({ port: config.port, host: "0.0.0.0" });
}

/** 仅在被直接执行时启动；被测试导入时不监听端口。 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isEntryPoint()) {
  start().catch((error: unknown) => {
    console.error(`服务启动失败：${formatStartupError(error, existsSync(".env"))}`);
    process.exit(1);
  });
}
