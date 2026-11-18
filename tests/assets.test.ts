// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");

describe("site icons", () => {
  it("ships the favicon and manifest referenced by index.html", () => {
    const html = readFileSync(join(root, "index.html"), "utf8");
    for (const href of [
      "/favicon.svg",
      "/favicon-32.png",
      "/apple-touch-icon.png",
      "/site.webmanifest",
    ]) {
      expect(html).toContain(`href="${href}"`);
      expect(existsSync(join(root, "public", href.slice(1)))).toBe(true);
    }
  });

  it("lists icons that really exist in the manifest", () => {
    const manifest = JSON.parse(
      readFileSync(join(root, "public", "site.webmanifest"), "utf8"),
    ) as { icons: Array<{ src: string; sizes: string }> };
    expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
    for (const icon of manifest.icons) {
      expect(existsSync(join(root, "public", icon.src.slice(1)))).toBe(true);
    }
  });
});
