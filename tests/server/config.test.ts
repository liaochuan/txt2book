// @vitest-environment node
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../server/lib/config";

/** 满足最小长度要求的会话密钥。 */
const SECRET = "x".repeat(32);

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

  it("strips matching quotes from auth values", () => {
    // docker run --env-file 会把引号原样传进容器；不去掉时哈希解析失败，登录永远 401。
    const cfg = loadConfig(
      env({
        SESSION_SECRET: `"${SECRET}"`,
        AUTH_PASSWORD_HASH: "'scrypt$1$1$1$AA$BB'",
        AUTH_USERNAME: '"admin"',
      }),
    );
    expect(cfg.sessionSecret).toBe(SECRET);
    expect(cfg.passwordHash).toBe("scrypt$1$1$1$AA$BB");
    expect(cfg.username).toBe("admin");
  });

  it("keeps unmatched quotes untouched", () => {
    const cfg = loadConfig(
      env({
        SESSION_SECRET: SECRET,
        AUTH_PASSWORD_HASH: "'scrypt$1$1$1$AA$BB",
        AUTH_USERNAME: "admin'",
      }),
    );
    expect(cfg.passwordHash).toBe("'scrypt$1$1$1$AA$BB");
    expect(cfg.username).toBe("admin'");
  });

  it("accepts Compose $$ escaping in AUTH_PASSWORD_HASH", () => {
    // Compose 要求 $ 写成 $$；raw env_file 与 docker run --env-file 不会还原。
    const cfg = loadConfig(
      env({
        SESSION_SECRET: SECRET,
        AUTH_PASSWORD_HASH: "scrypt$$1$$1$$1$$AA$$BB",
      }),
    );
    expect(cfg.passwordHash).toBe("scrypt$1$1$1$AA$BB");
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

  it("loads calibre defaults and overrides", () => {
    const base = loadConfig(env({ SESSION_SECRET: SECRET, AUTH_PASSWORD_HASH: "h" }));
    expect(base.calibreAllowPrivate).toBe(true);
    expect(base.calibreStorePath).toBe("./data/calibre-connection.json");
    expect(base.calibrePushTimeoutMs).toBe(120_000);
    const custom = loadConfig(env({
      SESSION_SECRET: SECRET, AUTH_PASSWORD_HASH: "h",
      CALIBRE_ALLOW_PRIVATE: "false", CALIBRE_PUSH_TIMEOUT_MS: "90000",
    }));
    expect(custom.calibreAllowPrivate).toBe(false);
    expect(custom.calibrePushTimeoutMs).toBe(90_000);
  });
});
