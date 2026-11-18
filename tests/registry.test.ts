import { describe, expect, it } from "vitest";
import { converterRegistry, listConverters } from "../src/core/converters";
import { resolveConvertOptions } from "../src/core/converters/types";

describe("converter registry", () => {
  it("registers epub as available", () => {
    expect(listConverters().map((c) => c.id)).toEqual(["epub"]);
    expect(converterRegistry.epub.available).toBe(true);
    expect(converterRegistry.epub.extension).toBe("epub");
    expect(converterRegistry.epub.mimeType).toBe("application/epub+zip");
  });

  it("defaults every content option to false", () => {
    expect(resolveConvertOptions({})).toEqual({
      themeId: "paper",
      includeTocPage: false,
      includeTitlePage: false,
      includeVolumePages: false,
    });
  });
});
