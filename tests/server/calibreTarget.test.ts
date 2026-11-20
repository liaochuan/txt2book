// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CalibreError } from "../../server/lib/calibre/types";
import { parseCalibreBaseUrl, resolveCalibreTarget } from "../../server/lib/calibre/target";

const lookupTo = (...addresses: string[]) => async () =>
  addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

function codeOf(fn: () => unknown): string {
  try { fn(); } catch (error) { return (error as CalibreError).code; }
  return "NO_ERROR";
}

describe("parseCalibreBaseUrl", () => {
  it("normalizes origin, subpath and trailing slash", () => {
    expect(parseCalibreBaseUrl("https://books.example.com/calibre/")).toMatchObject({
      baseUrl: "https://books.example.com/calibre",
      origin: "https://books.example.com",
      basePath: "/calibre",
    });
    expect(parseCalibreBaseUrl("http://192.168.1.10:8083").basePath).toBe("");
  });

  it.each([
    "ftp://host",
    "https://user:pass@host",
    "https://host/?a=1",
    "https://host/#x",
    `https://host/${"a".repeat(2048)}`,
  ])("rejects %s", (raw) => {
    expect(codeOf(() => parseCalibreBaseUrl(raw))).toBe("CALIBRE_INVALID_URL");
  });
});

describe("resolveCalibreTarget", () => {
  it("allows private addresses when enabled", async () => {
    const target = await resolveCalibreTarget("http://192.168.1.10:8083", {
      allowPrivate: true, lookup: lookupTo("192.168.1.10"),
    });
    expect(target.address).toBe("192.168.1.10");
  });

  it("rejects private addresses when disabled", async () => {
    await expect(resolveCalibreTarget("http://192.168.1.10:8083", {
      allowPrivate: false, lookup: lookupTo("192.168.1.10"),
    })).rejects.toMatchObject({ code: "CALIBRE_INVALID_URL" });
  });

  it.each([
    "169.254.169.254",
    "100.100.100.200",
    "fe80::1",
    "64:ff9b::a9fe:a9fe",
    "2002:a9fe:a9fe::",
    "::ffff:a9fe:a9fe",
    "0.0.0.0",
    "224.0.0.1",
    "240.0.0.1",
    "ff02::1",
    "fec0::1",
  ])(
    "always rejects metadata/link-local/reserved %s", async (address) => {
      const literal = address.includes(":") ? `[${address}]` : address;
      await expect(resolveCalibreTarget(`http://${literal}:8083`, {
        allowPrivate: true, lookup: lookupTo(address),
      })).rejects.toMatchObject({ code: "CALIBRE_INVALID_URL" });
    },
  );
});

describe("resolveCalibreTarget IPv6 literals", () => {
  it("reports family 6 for a pure IPv6 literal", async () => {
    const target = await resolveCalibreTarget("http://[::1]:8083", { allowPrivate: true });
    expect(target.address).toBe("::1");
    expect(target.family).toBe(6);
  });

  it("reports family 4 for an IPv4-mapped IPv6 literal", async () => {
    const target = await resolveCalibreTarget("http://[::ffff:127.0.0.1]:8083", {
      allowPrivate: true,
    });
    expect(target.address).toBe("127.0.0.1");
    expect(target.family).toBe(4);
  });

  it("rejects an IPv4-mapped metadata IPv6 literal", async () => {
    await expect(resolveCalibreTarget("http://[::ffff:169.254.169.254]:8083", {
      allowPrivate: true,
    })).rejects.toMatchObject({ code: "CALIBRE_INVALID_URL" });
  });
});
