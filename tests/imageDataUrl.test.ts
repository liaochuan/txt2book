import { describe, expect, it } from "vitest";
import { bytesToDataUrl } from "../src/core/imageDataUrl";

function decodeBase64(payload: string): Uint8Array {
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

describe("bytesToDataUrl", () => {
  it("prefixes the payload with the given mime type", () => {
    expect(bytesToDataUrl(new Uint8Array([1, 2, 3]), "image/png")).toBe(
      "data:image/png;base64,AQID",
    );
    expect(bytesToDataUrl(new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg")).toBe(
      "data:image/jpeg;base64,/9j/",
    );
  });

  it("returns an empty base64 payload for empty bytes", () => {
    expect(bytesToDataUrl(new Uint8Array(0), "image/jpeg")).toBe(
      "data:image/jpeg;base64,",
    );
  });

  it("encodes a large array without overflowing the call stack", () => {
    const bytes = new Uint8Array(1024 * 1024);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = index % 256;
    }

    const url = bytesToDataUrl(bytes, "image/png");
    const prefix = "data:image/png;base64,";

    expect(url.startsWith(prefix)).toBe(true);
    const decoded = decodeBase64(url.slice(prefix.length));
    expect(decoded.length).toBe(bytes.length);
    // 抽样比对，避免在 1MB 数组上做整块深比较。
    for (const index of [0, 1, 255, 256, 65535, 524288, bytes.length - 1]) {
      expect(decoded[index]).toBe(bytes[index]);
    }
  });

  it("round-trips arbitrary bytes through base64", () => {
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 200, 254, 255]);
    const url = bytesToDataUrl(bytes, "image/png");
    const prefix = "data:image/png;base64,";

    expect(decodeBase64(url.slice(prefix.length))).toEqual(bytes);
  });
});
