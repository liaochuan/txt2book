import { describe, expect, it } from "vitest";
import { decodeText, readTextFile } from "../src/core/textReader";

/**
 * 真实 GBK（代码页 936）字节样本，由 Windows 编码器生成后固化为 base64，
 * 不用 TextEncoder（它只能产出 UTF-8）。共 239 字节。
 */
const GBK_SAMPLE_TEXT =
  "第一章 开始\n" +
  "夜色落在这座小城里，街灯一盏接一盏地亮起来。\n" +
  "他站在窗前，看着远处的山影，心里忽然涌上一阵说不清的情绪。\n" +
  "「该走了。」他低声说。\n" +
  "风从半开的窗缝里钻进来，带着雨后泥土的味道。\n" +
  "他把桌上的旧书收进背包，又回头看了一眼那盏还亮着的灯。\n";

const GBK_SAMPLE_BASE64 =
  "tdrSu9XCIL+qyrwK0rnJq8Lk1NrV4tf50KGzx8Dvo6y91rXG0rvVtb3T0rvVtbXYwcHG8MC0oaMKy/vVvtTatLDHsKOsv7TXxdS2tKa1xMm907CjrNDEwO+69si707/Jz9K71fPLtbK7x+W1xMfp0PehowqhuLjD19/By6GjobnL+7XNyfnLtaGjCrfntNOw67+qtcS0sLfswO/X6r34wLSjrLT418XT6rrzxODNwbXEzra1wKGjCsv7sNHXwMnPtcS+ycrpytW9+LGzsPyjrNPWu9jNt7+0wcvSu9HbxMfVtbu5wcHXxbXEtcahowo=";

function base64ToBytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, "base64"));
}

describe("decodeText", () => {
  it("decodes GB18030 bytes when asked explicitly", () => {
    const bytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]); // 中文
    expect(decodeText(bytes, "gb18030").text).toBe("中文");
  });

  it("decodes Big5 bytes when asked explicitly", () => {
    const bytes = new Uint8Array([0xa4, 0xa4, 0xa4, 0xe5]); // 中文
    expect(decodeText(bytes, "big5").text).toBe("中文");
  });

  it("reports the encoding actually used", () => {
    const bytes = new TextEncoder().encode("第一章 开始");
    const result = decodeText(bytes, "auto");
    expect(result.usedEncoding.toLowerCase()).toContain("utf-8");
  });

  it("auto-detects a BOM-less GBK file and decodes it as gb18030", () => {
    const bytes = base64ToBytes(GBK_SAMPLE_BASE64);
    expect(bytes.length).toBeGreaterThan(200);

    const result = decodeText(bytes, "auto");

    expect(result.detectedEncoding).toBeTruthy();
    expect(result.usedEncoding.toLowerCase()).toMatch(/gb18030|gbk|gb2312/);
    expect(result.text).toBe(GBK_SAMPLE_TEXT);
  });

  it("auto-detects UTF-16LE from its BOM", () => {
    const body = new Uint8Array(Buffer.from("第一章 开始", "utf16le"));
    const bytes = new Uint8Array(2 + body.length);
    bytes.set([0xff, 0xfe]);
    bytes.set(body, 2);

    const result = decodeText(bytes, "auto");

    expect(result.usedEncoding.toLowerCase()).toContain("utf-16le");
    expect(result.text).toBe("第一章 开始");
  });
});

describe("readTextFile", () => {
  it("keeps the raw bytes so the text can be decoded again", async () => {
    const bytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]); // 中文
    const file = new File([bytes], "a.txt", { type: "text/plain" });

    const auto = await readTextFile(file);
    const manual = await readTextFile(file, "gb18030");

    expect(manual.text).toBe("中文");
    expect(manual.bytes).toEqual(auto.bytes);
    expect(manual.bytes).toEqual(bytes);
  });

  it("defaults to auto detection", async () => {
    const bytes = new TextEncoder().encode("中文");
    const file = new File([bytes], "a.txt", { type: "text/plain" });

    const result = await readTextFile(file);

    expect(result.text).toBe("中文");
    expect(result.usedEncoding.toLowerCase()).toContain("utf-8");
  });
});
