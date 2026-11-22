import { describe, expect, it } from "vitest";
import { hasMeaningfulContent, indentParagraphs, preprocessLines } from "../src/core/preprocess";

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

describe("indentParagraphs", () => {
  it("indents every non-empty paragraph with two ideographic spaces", () => {
    expect(indentParagraphs("第一段\n第二段")).toBe("　　第一段\n　　第二段");
  });

  it("normalizes existing leading whitespace instead of adding more", () => {
    expect(indentParagraphs("  第一段\n\u3000\u3000第二段\n\t第三段")).toBe(
      "　　第一段\n　　第二段\n　　第三段",
    );
  });

  it("keeps blank lines and normalizes CRLF", () => {
    expect(indentParagraphs("第一段\r\n\r\n第二段\r\n")).toBe("　　第一段\n\n　　第二段");
  });

  it("returns empty output for empty or whitespace-only input", () => {
    expect(indentParagraphs("")).toBe("");
    expect(indentParagraphs("   ")).toBe("");
    expect(indentParagraphs("\n\n")).toBe("");
  });

  it("is idempotent", () => {
    const once = indentParagraphs("第一段\n\n第二段");
    expect(indentParagraphs(once)).toBe(once);
  });
});
