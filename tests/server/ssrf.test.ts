// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  isBlockedHostname,
  isBlockedIp,
  normalizeIp,
  resolvePublicUrl,
  type LookupFn,
} from "../../server/lib/ssrf";

/** 构造一个只返回给定地址的假 DNS 解析器。 */
function lookupReturning(...addresses: string[]): LookupFn {
  return async () =>
    addresses.map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));
}

describe("normalizeIp", () => {
  it("lowercases and strips the zone id", () => {
    expect(normalizeIp("FE80::1")).toBe("fe80::1");
    expect(normalizeIp("fe80::1%eth0")).toBe("fe80::1");
    expect(normalizeIp("FE80::1%ETH0")).toBe("fe80::1");
  });

  it("strips IPv6 brackets", () => {
    expect(normalizeIp("[::1]")).toBe("::1");
  });

  it("converts IPv4-mapped IPv6 to IPv4", () => {
    expect(normalizeIp("::ffff:10.0.0.1")).toBe("10.0.0.1");
    expect(normalizeIp("::FFFF:7F00:1")).toBe("127.0.0.1");
    expect(normalizeIp("::ffff:8.8.8.8")).toBe("8.8.8.8");
  });

  it("canonicalizes non-standard IPv4 forms", () => {
    expect(normalizeIp("2130706433")).toBe("127.0.0.1");
    expect(normalizeIp("0x7f.1")).toBe("127.0.0.1");
    expect(normalizeIp("0x7f000001")).toBe("127.0.0.1");
    expect(normalizeIp("0177.0.0.1")).toBe("127.0.0.1");
    expect(normalizeIp("127.1")).toBe("127.0.0.1");
  });

  it("leaves hostnames and public IPv6 untouched apart from case", () => {
    expect(normalizeIp("Example.COM")).toBe("example.com");
    expect(normalizeIp("2606:4700:4700::1111")).toBe("2606:4700:4700::1111");
  });
});

describe("isBlockedIp", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "100.64.0.1",
    "224.0.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ])("blocks %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each([
    // 各网段的边界值
    "0.1.2.3",
    "0.255.255.255",
    "10.255.255.255",
    "100.127.255.255",
    "127.255.255.255",
    "169.254.0.1",
    "172.16.0.0",
    "172.31.255.255",
    "192.0.0.1",
    "192.0.0.255",
    "192.168.0.0",
    "198.18.0.0",
    "198.18.0.1",
    "198.19.255.255",
    "224.0.0.0",
    "239.255.255.255",
    "240.0.0.0",
    "255.255.255.255",
    // IPv6 保留段与映射形式
    "::",
    "::ffff:10.0.0.1",
    "fe80::1%eth0",
    "fc00::1",
    "fdff::1",
    "fe80::1",
    "ff02::1",
    // IPv4 兼容 / NAT64 / 6to4 / IPv4-translated 内嵌的私有地址
    "::7f00:1",
    "::ffff:0:10.0.0.1",
    "::ffff:0:169.254.169.254",
    "::ffff:0:0:0:1",
    "64:ff9b::a00:1",
    "2002:7f00:1::",
    // 非 IP 一律 fail closed
    "",
    "not-an-ip",
  ])("blocks extra %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "2606:4700:4700::1111",
    "93.184.216.34",
    "172.15.255.255",
    "172.32.0.1",
    "100.63.255.255",
    "100.128.0.0",
    "192.167.255.255",
    "198.17.255.255",
    "198.20.0.0",
    "223.255.255.255",
    "11.0.0.1",
    "::ffff:8.8.8.8",
    "::ffff:0:808:808",
    "64:ff9b::808:808",
    "2002:808:808::",
  ])("allows %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });
});

describe("isBlockedHostname", () => {
  it.each([
    "localhost",
    "LOCALHOST",
    "localhost.",
    "localhost..",
    "foo.localhost",
    "foo.LOCALHOST",
    "foo.local",
    "foo.local.",
    "home.arpa",
    "foo.home.arpa",
    "foo.lan",
    "localhost.localdomain",
    "instance-data",
    "instance-data.",
    "svc.internal",
    "metadata.google.internal",
    "metadata.google.internal.",
    "metadata",
    "",
    "   ",
  ])("blocks private hostname %s", (host) => {
    expect(isBlockedHostname(host)).toBe(true);
  });

  it.each([
    "example.com",
    "images.example.com",
    "localhost.example.com",
    "notlocalhost",
    "metadata.example.com",
    "foo.internal.example.com",
    "lan.example.com",
    "home.arpa.example.com",
    "instance-data.example.com",
  ])("allows public hostname %s", (host) => {
    expect(isBlockedHostname(host)).toBe(false);
  });
});

describe("resolvePublicUrl", () => {
  it("returns the URL with the first resolved public address", async () => {
    const result = await resolvePublicUrl("http://example.com/a.png", {
      lookup: lookupReturning("93.184.216.34"),
    });
    expect(result.url.toString()).toBe("http://example.com/a.png");
    expect(result.address).toBe("93.184.216.34");
    expect(result.family).toBe(4);
  });

  it("trims surrounding whitespace", async () => {
    const result = await resolvePublicUrl("  http://example.com/a.png  ", {
      lookup: lookupReturning("93.184.216.34"),
    });
    expect(result.url.toString()).toBe("http://example.com/a.png");
  });

  it("accepts https on the default port", async () => {
    const result = await resolvePublicUrl("https://example.com/a.png", {
      lookup: lookupReturning("93.184.216.34"),
    });
    expect(result.url.protocol).toBe("https:");
    expect(result.url.port).toBe("");
  });

  it("accepts non-default web ports", async () => {
    for (const port of [1024, 8080, 8443, 12345, 65535]) {
      const result = await resolvePublicUrl(`http://example.com:${port}/a.png`, {
        lookup: lookupReturning("93.184.216.34"),
      });
      expect(result.url.port).toBe(String(port));
    }
  });

  it("does not resolve public IPv6 literals through DNS", async () => {
    const lookup = vi.fn(async (): Promise<never> => {
      throw new Error("lookup should not be called");
    });
    const result = await resolvePublicUrl("http://[2606:4700:4700::1111]/a.png", { lookup });
    expect(result.address).toBe("2606:4700:4700::1111");
    expect(result.family).toBe(6);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("accepts public IPv6 results and reports family 6", async () => {
    const result = await resolvePublicUrl("http://example.com/a.png", {
      lookup: lookupReturning("2606:4700:4700::1111"),
    });
    expect(result.address).toBe("2606:4700:4700::1111");
    expect(result.family).toBe(6);
  });

  it("normalizes IPv4-mapped results returned by DNS", async () => {
    const result = await resolvePublicUrl("http://example.com/a.png", {
      lookup: lookupReturning("::ffff:8.8.8.8"),
    });
    expect(result.address).toBe("8.8.8.8");
    expect(result.family).toBe(4);
  });

  it("does not resolve public IP literals through DNS", async () => {
    const lookup = vi.fn(async (): Promise<never> => {
      throw new Error("lookup should not be called");
    });
    const result = await resolvePublicUrl("http://8.8.8.8/a.png", { lookup });
    expect(result.address).toBe("8.8.8.8");
    expect(result.family).toBe(4);
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    "file:///etc/passwd",
    "ftp://example.com/a.png",
    "gopher://example.com/",
    "javascript:alert(1)",
    "data:text/plain,hi",
  ])("rejects unsupported URL %s", async (raw) => {
    await expect(resolvePublicUrl(raw)).rejects.toThrow();
  });

  it("rejects empty input", async () => {
    await expect(resolvePublicUrl("")).rejects.toThrow();
    await expect(resolvePublicUrl("   ")).rejects.toThrow();
  });

  it("rejects URLs with credentials", async () => {
    await expect(resolvePublicUrl("http://user:pass@example.com/a.png")).rejects.toThrow();
    await expect(resolvePublicUrl("http://user@example.com/a.png")).rejects.toThrow();
  });

  it.each([0, 22, 25, 53, 110, 143, 1023, 3306, 5432, 6379, 9200, 11211])(
    "rejects port %i",
    async (port) => {
      await expect(
        resolvePublicUrl(`http://example.com:${port}/a.png`, {
          lookup: lookupReturning("93.184.216.34"),
        }),
      ).rejects.toThrow(/端口/);
    },
  );

  it("rejects a privileged port over https", async () => {
    await expect(
      resolvePublicUrl("https://example.com:1023/a.png", {
        lookup: lookupReturning("93.184.216.34"),
      }),
    ).rejects.toThrow(/端口/);
  });

  it("rejects unprivileged ports below 1024", async () => {
    await expect(
      resolvePublicUrl("http://example.com:888/a.png", {
        lookup: lookupReturning("93.184.216.34"),
      }),
    ).rejects.toThrow(/端口/);
  });

  it.each([
    "http://localhost/a.png",
    "http://LOCALHOST/a.png",
    "http://localhost./a.png",
    "http://localhost../a.png",
    "http://foo.local/a.png",
    "http://foo.lan/a.png",
    "http://foo.home.arpa/a.png",
    "http://localhost.localdomain/a.png",
    "http://instance-data/a.png",
    "http://svc.internal/a.png",
    "http://metadata.google.internal/a.png",
    "http://metadata/a.png",
  ])("rejects private hostname %s before DNS", async (raw) => {
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    await expect(resolvePublicUrl(raw, { lookup })).rejects.toThrow(/private/i);
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    "http://127.0.0.1/a.png",
    "http://2130706433/a.png",
    "http://0x7f.1/a.png",
    "http://0x7f000001/a.png",
    "http://0177.0.0.1/a.png",
    "http://[::1]/a.png",
    "http://[::ffff:127.0.0.1]/a.png",
    "http://[fc00::1]/a.png",
    "http://169.254.169.254/latest/meta-data/",
  ])("rejects private IP literal %s", async (raw) => {
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    await expect(resolvePublicUrl(raw, { lookup })).rejects.toThrow(/private/i);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("rejects when any resolved address is private", async () => {
    const lookup = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ];
    await expect(resolvePublicUrl("http://example.com/a.png", { lookup })).rejects.toThrow(
      /private/i,
    );
  });

  it("rejects IPv4-mapped private addresses returned by DNS", async () => {
    await expect(
      resolvePublicUrl("http://example.com/a.png", {
        lookup: lookupReturning("::ffff:127.0.0.1"),
      }),
    ).rejects.toThrow(/private/i);
  });

  it("throws when DNS returns no addresses", async () => {
    await expect(
      resolvePublicUrl("http://example.com/a.png", { lookup: async () => [] }),
    ).rejects.toThrow();
  });

  it("throws when DNS returns a non-array result", async () => {
    const lookup = async () =>
      "93.184.216.34" as unknown as { address: string; family: number }[];
    await expect(resolvePublicUrl("http://example.com/a.png", { lookup })).rejects.toThrow(
      /解析结果|未获得|解析/,
    );
  });

  it("throws when a DNS entry lacks an address", async () => {
    const lookup = async () => [{ family: 4 } as unknown as { address: string; family: number }];
    await expect(resolvePublicUrl("http://example.com/a.png", { lookup })).rejects.toThrow(
      /解析结果|未获得|解析/,
    );
  });

  it("throws when DNS fails", async () => {
    const lookup = async (): Promise<never> => {
      throw new Error("ENOTFOUND");
    };
    await expect(resolvePublicUrl("http://example.com/a.png", { lookup })).rejects.toThrow(/解析/);
  });

  it("does not fetch or follow redirects (redirect handling belongs to the caller)", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: "http://127.0.0.1/" } }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const result = await resolvePublicUrl("http://example.com/redirect-me.png", {
        lookup: lookupReturning("93.184.216.34"),
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(Object.keys(result).sort()).toEqual(["address", "family", "url"]);
      expect(result.url.href).toBe("http://example.com/redirect-me.png");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
