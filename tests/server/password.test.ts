// @vitest-environment node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../../server/lib/password";

describe("hashPassword", () => {
  it("produces a scrypt hash with the documented parameters", async () => {
    const stored = await hashPassword("correct horse");
    expect(stored.startsWith("scrypt$")).toBe(true);

    const fields = stored.split("$");
    expect(fields).toHaveLength(6);
    expect(fields[0]).toBe("scrypt");
    expect(fields[1]).toBe("16384");
    expect(fields[2]).toBe("8");
    expect(fields[3]).toBe("1");
    expect(Buffer.from(fields[4] ?? "", "base64")).toHaveLength(16);
    expect(Buffer.from(fields[5] ?? "", "base64")).toHaveLength(64);
  });

  it("uses a fresh random salt for every hash", async () => {
    const first = await hashPassword("same password");
    const second = await hashPassword("same password");
    expect(first).not.toBe(second);
  });

  it("does not embed the plaintext", async () => {
    const stored = await hashPassword("hunter2-plaintext");
    expect(stored).not.toContain("hunter2-plaintext");
  });
});

describe("verifyPassword", () => {
  it("round-trips a password", async () => {
    const stored = await hashPassword("correct horse");
    await expect(verifyPassword("correct horse", stored)).resolves.toBe(true);
    await expect(verifyPassword("wrong", stored)).resolves.toBe(false);
  });

  it("returns false for a malformed hash instead of throwing", async () => {
    await expect(verifyPassword("x", "not-a-hash")).resolves.toBe(false);
  });

  it("returns false for malformed variants", async () => {
    const stored = await hashPassword("secret");
    const fields = stored.split("$");
    const validSalt = fields[4] ?? "";
    const validHash = fields[5] ?? "";

    const variants = [
      "",
      "scrypt",
      "scrypt$bad",
      "scrypt$16384$8$1",
      `scrypt$16384$8$1$${validSalt}`,
      `scrypt$16384$8$1$${validSalt}$${validHash}$extra`,
      `scrypt$notanumber$8$1$${validSalt}$${validHash}`,
      `scrypt$16384$8$0$${validSalt}$${validHash}`,
      `scrypt$16384$8$1$!!!not-base64!!!$${validHash}`,
      `scrypt$16384$8$1$${validSalt}$!!!not-base64!!!`,
      `bcrypt$16384$8$1$${validSalt}$${validHash}`,
    ];

    for (const variant of variants) {
      await expect(verifyPassword("secret", variant)).resolves.toBe(false);
    }
  });

  it("returns false when the stored key has a different length", async () => {
    const stored = await hashPassword("secret");
    const fields = stored.split("$");
    const truncated = `scrypt$16384$8$1$${fields[4]}$${Buffer.from(fields[5] ?? "", "base64").subarray(0, 32).toString("base64")}`;
    await expect(verifyPassword("secret", truncated)).resolves.toBe(false);
  });

  it("rejects invalid or oversized scrypt parameters without hanging", async () => {
    const stored = await hashPassword("secret");
    const fields = stored.split("$");
    const salt = fields[4] ?? "";
    const key = fields[5] ?? "";

    const variants = [
      // N 不是 2 的幂
      `scrypt$3$8$1$${salt}$${key}`,
      // N = 2^20、r = 8 时内存需求约 1 GiB，超出上限
      `scrypt$1048576$8$1$${salt}$${key}`,
      // 盐过长（64 字节）
      `scrypt$16384$8$1$${Buffer.alloc(64, 1).toString("base64")}$${key}`,
    ];

    const started = Date.now();
    for (const variant of variants) {
      await expect(verifyPassword("secret", variant)).resolves.toBe(false);
    }
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("returns false for non-string stored values", async () => {
    await expect(verifyPassword("x", undefined as unknown as string)).resolves.toBe(false);
    await expect(verifyPassword("x", null as unknown as string)).resolves.toBe(false);
    await expect(verifyPassword("x", 123 as unknown as string)).resolves.toBe(false);
  });

  it("compares without throwing on differing passwords", async () => {
    // 两个不同密码的校验耗时差异不做严格断言，仅断言两次都返回 false 且不抛错
    const stored = await hashPassword("a");
    await expect(
      Promise.all([verifyPassword("ab", stored), verifyPassword("b", stored)]),
    ).resolves.toEqual([false, false]);
  });
});

describe("hash-password script", () => {
  const scriptPath = path.join(process.cwd(), "server", "scripts", "hash-password.ts");
  const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");

  function runScript(args: string[], input?: string) {
    return spawnSync(process.execPath, [tsxCli, scriptPath, ...args], {
      encoding: "utf8",
      input,
      timeout: 60_000,
    });
  }

  it("prints only the hash for a password passed as an argument", () => {
    const result = runScript(["test123"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trimEnd()).toMatch(
      /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/,
    );
    expect(result.stdout).not.toContain("test123");
    expect(result.stderr).not.toContain("test123");
  });

  it("accepts a password from stdin and strips trailing newlines", () => {
    const result = runScript([], "test123\n\n");

    expect(result.status).toBe(0);
    expect(result.stdout.trimEnd()).toMatch(
      /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/,
    );
    expect(result.stdout).not.toContain("test123");
  });

  it("exits non-zero with a Chinese error for empty input", () => {
    const result = runScript([], "");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/密码不能为空/);
  });
});
