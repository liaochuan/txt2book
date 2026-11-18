// @vitest-environment node
import { describe, expect, it } from "vitest";
import { formatStartupError } from "../../server/index.js";

describe("formatStartupError", () => {
  it("adds a .env hint when config is missing and .env exists", () => {
    const message = formatStartupError(
      new Error("缺少必需的环境变量：SESSION_SECRET。"),
      true,
    );
    expect(message).toContain("缺少必需的环境变量");
    expect(message).toContain("检测到 .env");
    expect(message).toContain("npm start");
  });

  it("does not add the hint when .env is absent", () => {
    const message = formatStartupError(
      new Error("缺少必需的环境变量：SESSION_SECRET。"),
      false,
    );
    expect(message).toBe("缺少必需的环境变量：SESSION_SECRET。");
  });

  it("does not add the hint for unrelated errors", () => {
    const message = formatStartupError(new Error("EADDRINUSE"), true);
    expect(message).toBe("EADDRINUSE");
  });

  it("handles non-Error throwables", () => {
    expect(formatStartupError("boom", true)).toBe("boom");
  });
});
