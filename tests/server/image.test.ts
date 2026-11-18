// @vitest-environment node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { CoverError, fetchImage, toImage, toPng } from "../../server/lib/image";

const openServers: Server[] = [];

/** 等待一个异步条件成立；用于断言服务端连接已经被客户端销毁。 */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("等待条件超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

afterEach(async () => {
  const servers = openServers.splice(0);
  await Promise.all(servers.map((server) => closeServer(server)));
});

/** 启动一个只监听回环地址的测试服务器，端口由系统分配。 */
async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ port: number }> {
  const server = createServer(handler);
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("测试服务器未获得端口");
  }
  return { port: address.port };
}

async function samplePng(width = 8, height = 8): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: "#336699" } })
    .png()
    .toBuffer();
}

describe("toPng", () => {
  it("converts webp to png", async () => {
    const webp = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "#123456" },
    })
      .webp()
      .toBuffer();

    const out = await toPng(webp, { maxBytes: 10 * 1024 * 1024 });

    expect(out.png.subarray(1, 4).toString()).toBe("PNG");
    expect(out.width).toBe(8);
    expect(out.height).toBe(8);
  });

  it("applies EXIF rotation", async () => {
    // 40×20 的图片带 orientation=6（顺时针 90°），输出应变成 20×40。
    const jpeg = await sharp({
      create: { width: 40, height: 20, channels: 3, background: "#abcdef" },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect((await sharp(jpeg).metadata()).orientation).toBe(6);

    const out = await toPng(jpeg, { maxBytes: 10 * 1024 * 1024 });

    expect(out.width).toBe(20);
    expect(out.height).toBe(40);
  });

  it("resizes the longest side to 1600px without enlarging small images", async () => {
    const wide = await sharp({
      create: { width: 3200, height: 800, channels: 3, background: "#445566" },
    })
      .png()
      .toBuffer();
    const tall = await sharp({
      create: { width: 500, height: 2400, channels: 3, background: "#445566" },
    })
      .png()
      .toBuffer();
    const small = await samplePng(12, 7);

    const resizedWide = await toPng(wide, { maxBytes: 10 * 1024 * 1024 });
    const resizedTall = await toPng(tall, { maxBytes: 10 * 1024 * 1024 });
    const untouched = await toPng(small, { maxBytes: 10 * 1024 * 1024 });

    expect(resizedWide.width).toBe(1600);
    expect(resizedWide.height).toBe(400);
    expect(resizedTall.width).toBe(333);
    expect(resizedTall.height).toBe(1600);
    expect(untouched.width).toBe(12);
    expect(untouched.height).toBe(7);
  });

  it("rejects non-image bytes with a 415", async () => {
    await expect(toPng(Buffer.from("not an image"), { maxBytes: 1024 })).rejects.toMatchObject({
      code: "UNSUPPORTED_IMAGE",
      statusCode: 415,
    });
  });

  it("rejects empty input with a 415", async () => {
    await expect(toPng(Buffer.alloc(0), { maxBytes: 1024 })).rejects.toMatchObject({
      code: "UNSUPPORTED_IMAGE",
      statusCode: 415,
    });
  });

  it("rejects input larger than maxBytes", async () => {
    const png = await samplePng(16, 16);
    await expect(toPng(png, { maxBytes: 8 })).rejects.toMatchObject({
      code: "TOO_LARGE",
      statusCode: 400,
    });
  });

  it("rejects images above the 40MP pixel limit with a mapped 415", async () => {
    // 7000×6000 = 42MP，超过 sharp 的 limitInputPixels。
    const huge = await sharp({
      create: { width: 7000, height: 6000, channels: 3, background: "#101010" },
    })
      .png()
      .toBuffer();

    const error = await toPng(huge, { maxBytes: 50 * 1024 * 1024 }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(CoverError);
    expect(error).toMatchObject({ code: "UNSUPPORTED_IMAGE", statusCode: 415 });
  });

  it("rejects a truncated png with a mapped 415", async () => {
    const png = await samplePng(64, 64);
    const truncated = png.subarray(0, Math.floor(png.length / 2));

    const error = await toPng(truncated, { maxBytes: 10 * 1024 * 1024 }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(CoverError);
    expect(error).toMatchObject({ code: "UNSUPPORTED_IMAGE", statusCode: 415 });
  });
});

describe("toImage", () => {
  it("converts to jpeg and reports the matching mime type", async () => {
    const png = await samplePng(32, 16);

    const out = await toImage(png, {
      maxBytes: 10 * 1024 * 1024,
      format: "jpeg",
      quality: 82,
    });

    expect(out.format).toBe("jpeg");
    expect(out.mimeType).toBe("image/jpeg");
    expect(out.width).toBe(32);
    expect(out.height).toBe(16);
    expect(out.data[0]).toBe(0xff);
    expect(out.data[1]).toBe(0xd8);
  });

  it("keeps png for transparent images even when jpeg is requested", async () => {
    const transparent = await sharp({
      create: { width: 16, height: 16, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.5 } },
    })
      .png()
      .toBuffer();

    const out = await toImage(transparent, {
      maxBytes: 10 * 1024 * 1024,
      format: "jpeg",
    });

    expect(out.format).toBe("png");
    expect(out.mimeType).toBe("image/png");
    expect(out.data.subarray(1, 4).toString()).toBe("PNG");
  });

  it("still resizes and rotates before encoding", async () => {
    const jpeg = await sharp({
      create: { width: 3200, height: 800, channels: 3, background: "#abcdef" },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const out = await toImage(jpeg, { maxBytes: 10 * 1024 * 1024, format: "jpeg" });

    expect(out.width).toBe(400);
    expect(out.height).toBe(1600);
  });
});

describe("fetchImage", () => {
  it("connects to the pinned address instead of resolving the hostname", async () => {
    const png = await samplePng();
    // 主机名不可解析；只有固定 lookup 生效时才会连上本地测试服务器。
    const { port } = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(png);
    });

    const body = await fetchImage(
      new URL(`http://pinned.invalid:${port}/cover.png`),
      "127.0.0.1",
      4,
      { timeoutMs: 2000, maxBytes: 1024 * 1024 },
    );

    expect(body.equals(png)).toBe(true);
  });

  it("sends an image accept header and a stable user agent", async () => {
    let headers: IncomingMessage["headers"] = {};
    const { port } = await startServer((request, response) => {
      headers = request.headers;
      response.writeHead(200, { "content-type": "image/png" });
      response.end("ok");
    });

    await fetchImage(new URL(`http://pinned.invalid:${port}/`), "127.0.0.1", 4, {
      timeoutMs: 2000,
      maxBytes: 1024,
    });

    expect(headers.accept).toBe("image/*");
    expect(headers["user-agent"]).toBe("txt2book/1.0");
  });

  it("aborts an oversized download", async () => {
    const { port } = await startServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "image/png",
        "content-length": String(1024 * 1024),
      });
      // 分块持续写，确保超限时是流式中止而不是依赖 content-length。
      const chunk = Buffer.alloc(64 * 1024, 1);
      for (let index = 0; index < 16; index += 1) response.write(chunk);
      response.end();
    });

    await expect(
      fetchImage(new URL(`http://pinned.invalid:${port}/big.png`), "127.0.0.1", 4, {
        timeoutMs: 2000,
        maxBytes: 64 * 1024,
      }),
    ).rejects.toMatchObject({ code: "TOO_LARGE", statusCode: 400 });
  });

  it("aborts a chunked body that exceeds maxBytes despite an untrustworthy length", async () => {
    let socketClosed = false;
    const { port } = await startServer((_request, response) => {
      response.on("close", () => {
        socketClosed = true;
      });
      // Node 的 llhttp 会直接拒绝同时带 Content-Length 与 Transfer-Encoding 的响应
      // （HPE_INVALID_TRANSFER_ENCODING），因此这里用“无可靠长度 + chunked”构造
      // 最强可测试场景：长度不可信，1MB 响应体必须以流式上限中止。
      response.writeHead(200, {
        "content-type": "image/png",
        "transfer-encoding": "chunked",
      });
      const chunk = Buffer.alloc(64 * 1024, 1);
      for (let index = 0; index < 16; index += 1) response.write(chunk);
      response.end();
    });

    await expect(
      fetchImage(new URL(`http://pinned.invalid:${port}/lying.png`), "127.0.0.1", 4, {
        timeoutMs: 2000,
        maxBytes: 64 * 1024,
      }),
    ).rejects.toMatchObject({ code: "TOO_LARGE", statusCode: 400 });

    await waitFor(() => socketClosed);
  });

  it("aborts with a timeout when the upstream stalls", async () => {
    const { port } = await startServer(() => {
      // 故意不结束响应。
    });

    await expect(
      fetchImage(new URL(`http://pinned.invalid:${port}/slow.png`), "127.0.0.1", 4, {
        timeoutMs: 50,
        maxBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: "TIMEOUT", statusCode: 504 });
  });

  it("rejects a non-200 upstream status", async () => {
    const { port } = await startServer((_request, response) => {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("missing");
    });

    await expect(
      fetchImage(new URL(`http://pinned.invalid:${port}/missing.png`), "127.0.0.1", 4, {
        timeoutMs: 2000,
        maxBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR", statusCode: 400 });
  });

  it("rejects when the connection fails", async () => {
    // 端口 1 在回环地址上不会有人监听，连接会立即失败。
    await expect(
      fetchImage(new URL("http://pinned.invalid:1/x.png"), "127.0.0.1", 4, {
        timeoutMs: 2000,
        maxBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR", statusCode: 400 });
  });
});
