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

describe("docker build inputs", () => {
  it("copies public assets so icons are available in the image", () => {
    // 图标与 manifest 由 Vite 从 public/ 复制到 dist/；构建上下文缺少 public 时，
    // 镜像里的 dist 只有 assets/ 与 index.html，/favicon.svg 会 404。
    const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/^COPY public \.\/public$/m);
  });
});
