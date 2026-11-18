import { describe, expect, it } from "vitest";
import { hasMeaningfulContent, preprocessLines } from "../src/core/preprocess";

describe("preprocessLines", () => {
  it("strips leading ascii and ideographic spaces", () => {
    expect(preprocessLines("  a\n\u3000\u3000b\n\tc")).toEqual(["a", "b", "c"]);
  });
  it("keeps blank lines and strips CR", () => {
    expect(preprocessLines("a\r\n\r\nb")).toEqual(["a", "", "b"]);
  });
  it("splits lines on lone CR (old Mac line endings)", () => {
    expect(preprocessLines("a\rb\r\r\u3000c")).toEqual(["a", "b", "", "c"]);
  });
  it("detects meaningful content", () => {
    expect(hasMeaningfulContent(["", "  ", "x"])).toBe(true);
    expect(hasMeaningfulContent(["", " "])).toBe(false);
  });
});
