// @vitest-environment node
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../server/lib/config";

/** 测试用环境变量：绕过 `NodeJS.ProcessEnv` 的只读索引签名。 */
function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

describe("loadConfig", () => {
  it("refuses to start without SESSION_SECRET", () => {
    expect(() => loadConfig(env({ AUTH_PASSWORD_HASH: "scrypt$1$1$1$AA$BB" }))).toThrow(/SESSION_SECRET/);
  });

  it("refuses to start without AUTH_PASSWORD_HASH", () => {
    expect(() => loadConfig(env({ SESSION_SECRET: "x".repeat(32) }))).toThrow(/AUTH_PASSWORD_HASH/);
  });

  it("allows AUTH_DISABLED without credentials", () => {
    expect(loadConfig(env({ AUTH_DISABLED: "true" })).authDisabled).toBe(true);
  });

  it("only treats explicit true as AUTH_DISABLED", () => {
    expect(() => loadConfig(env({ AUTH_DISABLED: "false" }))).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig(env({ AUTH_DISABLED: "1" }))).toThrow(/SESSION_SECRET/);
    expect(loadConfig(env({ AUTH_DISABLED: "TRUE" })).authDisabled).toBe(true);
  });

  it("requires SESSION_SECRET to be at least 32 characters", () => {
    expect(() =>
      loadConfig(env({ SESSION_SECRET: "x".repeat(31), AUTH_PASSWORD_HASH: "h" })),
    ).toThrow(/SESSION_SECRET/);
    expect(
      loadConfig(env({ SESSION_SECRET: "x".repeat(32), AUTH_PASSWORD_HASH: "h" })).sessionSecret,
    ).toHaveLength(32);
  });

  it("parses numeric overrides", () => {
    const cfg = loadConfig(
      env({ SESSION_SECRET: "x".repeat(32), AUTH_PASSWORD_HASH: "h", RATE_LIMIT_PER_MIN: "5" }),
    );
    expect(cfg.rateLimitPerMin).toBe(5);
  });
});
