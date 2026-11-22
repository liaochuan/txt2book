import { describe, expect, it } from "vitest";
import { converterRegistry, listConverters } from "../src/core/converters";
import { resolveConvertOptions } from "../src/core/converters/types";

describe("converter registry", () => {
  it("registers epub, html, txt and pdf as available", () => {
    expect(listConverters().map((c) => c.id)).toEqual(["epub", "html", "txt", "pdf"]);
    expect(converterRegistry.epub.available).toBe(true);
    expect(converterRegistry.epub.extension).toBe("epub");
    expect(converterRegistry.epub.mimeType).toBe("application/epub+zip");
    expect(converterRegistry.html.available).toBe(true);
    expect(converterRegistry.html.extension).toBe("html");
    expect(converterRegistry.html.mimeType).toBe("text/html");
    expect(converterRegistry.html.runtime).toBe("browser");
    expect(converterRegistry.txt.available).toBe(true);
    expect(converterRegistry.txt.extension).toBe("txt");
    expect(converterRegistry.txt.mimeType).toBe("text/plain;charset=utf-8");
    expect(converterRegistry.txt.runtime).toBe("browser");
    expect(converterRegistry.pdf.available).toBe(true);
    expect(converterRegistry.pdf.extension).toBe("pdf");
    expect(converterRegistry.pdf.mimeType).toBe("application/pdf");
    expect(converterRegistry.pdf.runtime).toBe("server");
    expect(converterRegistry.txt.options?.map((option) => option.key)).toEqual([
      "includeIntro",
      "includeVolumeTitles",
    ]);
    expect(listConverters().at(-1)?.options?.map((option) => option.key)).toEqual([
      "pageSize",
      "margin",
      "pageNumbers",
      "includeCover",
      "includeToc",
      "bookmarks",
    ]);
  });

  it("defaults every content option to false and preserves format options", () => {
    expect(resolveConvertOptions({})).toEqual({
      themeId: "paper",
      includeTocPage: false,
      includeDescription: false,
      includeVolumePages: false,
    });

    const formatOptions = { mode: "y", flag: false };
    expect(resolveConvertOptions({ formatOptions }).formatOptions).toEqual(formatOptions);
    expect(resolveConvertOptions({ formatOptions: {} }).formatOptions).toEqual({});
  });

  it("exposes runtime and format options metadata to the UI", () => {
    const [epub] = listConverters();

    expect(epub.runtime).toBe("browser");
    expect(epub.options).toBeUndefined();
  });
});
