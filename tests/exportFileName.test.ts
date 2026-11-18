import { describe, expect, it } from "vitest";
import { buildExportFileName } from "../src/core/exportFileName";

describe("buildExportFileName", () => {
  it("replaces invalid characters and trims trailing dots and spaces", () => {
    expect(buildExportFileName('X:/<>|?"*\\. .', "epub")).toBe("X_________.epub");
  });

  it("truncates before trimming trailing dots", () => {
    const title = `${"a".repeat(79)}.尾巴`;

    expect(buildExportFileName(title, "epub")).toBe(`${"a".repeat(79)}.epub`);
  });

  it.each(["", "   ", ". . .", "... "])(
    "falls back to 未命名 when the title cleans up to nothing: %j",
    (title) => {
      expect(buildExportFileName(title, "epub")).toBe("未命名.epub");
    },
  );

  it.each(["CON", "con", "Prn.txt", "AUX", "NUL", "COM1", "com9.log", "LPT1", "lpt9"])(
    "prefixes the Windows reserved name %s with an underscore",
    (title) => {
      expect(buildExportFileName(title, "epub")).toBe(`_${title}.epub`);
    },
  );

  it.each(["CONSOLE", "NULL", "COM0", "LPT10", "CON_x", "第二章"])(
    "leaves names that only resemble reserved names untouched: %s",
    (title) => {
      expect(buildExportFileName(title, "epub")).toBe(`${title}.epub`);
    },
  );

  it("omits the separator when there is no extension", () => {
    expect(buildExportFileName("书名", "")).toBe("书名");
  });
});
