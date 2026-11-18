// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server/app";
import { loadConfig } from "../../server/lib/config";

/** 测试用环境变量：绕过 `NodeJS.ProcessEnv` 的只读索引签名。 */
function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

describe("GET /api/health", () => {
  it("returns health", async () => {
    const app = buildServer(loadConfig(env({ AUTH_DISABLED: "true" })));
    try {
      const res = await app.inject({ method: "GET", url: "/api/health" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });

  it("returns json 404 for unknown api routes", async () => {
    const app = buildServer(loadConfig(env({ AUTH_DISABLED: "true" })));
    try {
      const res = await app.inject({ method: "GET", url: "/api/nope" });
      expect(res.statusCode).toBe(404);
      expect(res.headers["content-type"]).toContain("application/json");
      expect(res.json()).toEqual({ error: { code: "NOT_FOUND", message: "接口不存在。" } });

      // 带 query 的 /api 根路径同样走 API 404，而不是静态资源 404。
      const root = await app.inject({ method: "GET", url: "/api?x=1" });
      expect(root.statusCode).toBe(404);
      expect(root.json()).toEqual({ error: { code: "NOT_FOUND", message: "接口不存在。" } });
    } finally {
      await app.close();
    }
  });
});
