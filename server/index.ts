import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { buildServer } from "./app.js";
import { loadConfig } from "./lib/config.js";

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
