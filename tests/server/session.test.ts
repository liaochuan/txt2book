// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  SESSION_COOKIE,
  signSession,
  verifySession,
  type SessionPayload,
} from "../../server/lib/session";

const SECRET = "s".repeat(32);
/** `exp` 为 Unix 毫秒；选 2100-01-01 保证测试不会随时间失效。 */
const FUTURE_EXP = 4_102_444_800_000;

describe("SESSION_COOKIE", () => {
  it("uses the documented cookie name", () => {
    expect(SESSION_COOKIE).toBe("txt2book_session");
  });
});

describe("signSession / verifySession", () => {
  it("round-trips a valid payload", () => {
    const payload: SessionPayload = { sub: "admin", iat: 1_000, exp: FUTURE_EXP };
    const token = signSession(payload, SECRET);
    expect(token.split(".")).toHaveLength(2);
    expect(verifySession(token, SECRET, 2_000)).toEqual(payload);
  });

  it("rejects a tampered signature", () => {
    const token = signSession({ sub: "admin", iat: 1, exp: FUTURE_EXP }, SECRET);
    expect(verifySession(`${token}x`, SECRET)).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const token = signSession({ sub: "admin", iat: 1, exp: FUTURE_EXP }, SECRET);
    const [payloadPart, signaturePart] = token.split(".") as [string, string];
    const forgedPayload = Buffer.from(
      JSON.stringify({ sub: "root", iat: 1, exp: FUTURE_EXP }),
      "utf8",
    ).toString("base64url");
    expect(forgedPayload).not.toBe(payloadPart);
    expect(verifySession(`${forgedPayload}.${signaturePart}`, SECRET)).toBeNull();
  });

  it("rejects a token signed with another secret", () => {
    const token = signSession({ sub: "admin", iat: 1, exp: FUTURE_EXP }, "x".repeat(32));
    expect(verifySession(token, SECRET)).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = signSession({ sub: "admin", iat: 1, exp: 2 }, SECRET);
    expect(verifySession(token, SECRET, 3)).toBeNull();
  });

  it("expires exactly at exp", () => {
    const token = signSession({ sub: "admin", iat: 1, exp: 2 }, SECRET);
    expect(verifySession(token, SECRET, 2)).toBeNull();
    expect(verifySession(token, SECRET, 1)).toEqual({ sub: "admin", iat: 1, exp: 2 });
  });

  it("returns null for malformed input without throwing", () => {
    const malformed = [
      "",
      ".",
      "a.b",
      "a.b.c",
      "!!!.???",
      "not-a-token",
      `${"a".repeat(5000)}.b`,
      Buffer.from("[]", "utf8").toString("base64url"),
    ];
    for (const token of malformed) {
      expect(() => verifySession(token, SECRET)).not.toThrow();
      expect(verifySession(token, SECRET)).toBeNull();
    }
  });

  it("rejects a correctly signed payload with invalid fields", () => {
    const token = signSession({ sub: "", iat: 1, exp: FUTURE_EXP }, SECRET);
    expect(verifySession(token, SECRET)).toBeNull();
  });

  it("refuses to sign with an empty or too-short secret", () => {
    const payload: SessionPayload = { sub: "admin", iat: 1, exp: FUTURE_EXP };
    expect(() => signSession(payload, "")).toThrow();
    expect(() => signSession(payload, "s".repeat(31))).toThrow();
    expect(() => signSession(payload, "s".repeat(32))).not.toThrow();
  });

  it("rejects tokens when the secret is empty or too short", () => {
    const token = signSession({ sub: "admin", iat: 1, exp: FUTURE_EXP }, SECRET);
    expect(verifySession(token, "")).toBeNull();
    expect(verifySession(token, "s".repeat(31))).toBeNull();
  });

  it("rejects signatures that are not strict unpadded base64url", () => {
    const token = signSession({ sub: "admin", iat: 1, exp: FUTURE_EXP }, SECRET);
    for (const suffix of ["!!!!", "==", "=", "+", "/"]) {
      expect(verifySession(`${token}${suffix}`, SECRET)).toBeNull();
    }
  });
});
