// @vitest-environment node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../server/app";
import { loadConfig, type AppConfig } from "../../server/lib/config";
import { fetchCoverPng, type CoverResolveFn } from "../../server/lib/image";
import { SESSION_COOKIE, signSession } from "../../server/lib/session";

const SECRET = "s".repeat(32);

const openServers: Server[] = [];

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

/** 测试用环境变量：绕过 `NodeJS.ProcessEnv` 的只读索引签名。 */
function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

function makeConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig(
    env({
      SESSION_SECRET: SECRET,
      AUTH_PASSWORD_HASH: "h",
      AUTH_USERNAME: "admin",
      ...overrides,
    }),
  );
}

async function makeApp(overrides: Record<string, string> = {}): Promise<FastifyInstance> {
  const app = buildServer(makeConfig(overrides));
  await app.ready();
  return app;
}

/** 直接签一个合法会话，避免在封面测试里跑 scrypt。 */
function sessionCookie(): string {
  const now = Date.now();
  return `${SESSION_COOKIE}=${signSession(
    { sub: "admin", iat: now, exp: now + 60_000 },
    SECRET,
  )}`;
}

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

async function sampleWebp(): Promise<Buffer> {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: "#123456" } })
    .webp()
    .toBuffer();
}

async function transparentPng(width = 8, height = 8): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.5 } },
  })
    .png()
    .toBuffer();
}

interface MultipartPayload {
  boundary: string;
  body: Buffer;
}

function multipartBody(
  file: Buffer,
  options: { filename?: string; contentType?: string; field?: string } = {},
): MultipartPayload {
  const boundary = "----txt2book-test-boundary";
  const filename = options.filename ?? "cover.webp";
  const contentType = options.contentType ?? "image/webp";
  const field = options.field ?? "file";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return { boundary, body: Buffer.concat([head, file, tail]) };
}

/** 伪造的解析器：把所有主机名固定到回环测试服务器。 */
function pinnedResolver(calls: string[] = []): CoverResolveFn {
  return async (raw) => {
    calls.push(raw);
    return { url: new URL(raw), address: "127.0.0.1", family: 4 };
  };
}

function errorBody(response: { json(): unknown }): { code: string; message: string } {
  const body = response.json() as { error: { code: string; message: string } };
  return body.error;
}

describe("cover route authentication", () => {
  it("requires authentication for both cover endpoints", async () => {
    const app = await makeApp();
    try {
      for (const url of ["/api/cover/from-url", "/api/cover/from-file"]) {
        const res = await app.inject({
          method: "POST",
          url,
          ...(url.endsWith("from-url") ? { payload: { url: "https://example.com/a.png" } } : {}),
        });
        expect(res.statusCode).toBe(401);
        expect(errorBody(res).code).toBe("UNAUTHORIZED");
        expect(res.headers["cache-control"]).toBe("no-store");
      }
    } finally {
      await app.close();
    }
  });

  it("rejects a tampered session cookie", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/cover/from-url",
        headers: { cookie: `${sessionCookie()}x` },
        payload: { url: "https://example.com/a.png" },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("allows requests when AUTH_DISABLED=true", async () => {
    const app = await makeApp({
      AUTH_DISABLED: "true",
      SESSION_SECRET: "",
      AUTH_PASSWORD_HASH: "",
    });
    try {
      // 未登录时也会走到 URL 校验；私网地址被拒绝证明认证已放行。
      const res = await app.inject({
        method: "POST",
        url: "/api/cover/from-url",
        payload: { url: "http://127.0.0.1/a.png" },
      });
      expect(res.statusCode).toBe(400);
      expect(errorBody(res).code).toBe("INVALID_URL");
    } finally {
      await app.close();
    }
  });
});

describe("unified error handler", () => {
  it("maps malformed JSON to a generic 400 without framework details", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/cover/from-url",
        headers: { cookie: sessionCookie(), "content-type": "application/json" },
        payload: '{"url":',
      });

      expect(res.statusCode).toBe(400);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.json()).toEqual({
        error: { code: "INTERNAL", message: "服务器内部错误。" },
      });
      expect(res.body).not.toContain("Unexpected");
      expect(res.body).not.toContain("statusCode");
      expect(res.body).not.toContain("FST_");
    } finally {
      await app.close();
    }
  });

  it("maps an unsupported media type to a generic 415", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/cover/from-url",
        headers: { cookie: sessionCookie(), "content-type": "text/plain" },
        payload: "hello",
      });

      expect(res.statusCode).toBe(415);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.json()).toEqual({
        error: { code: "INTERNAL", message: "服务器内部错误。" },
      });
      expect(res.body).not.toContain("body");
      expect(res.body).not.toContain("FST_");
    } finally {
      await app.close();
    }
  });

  it("maps a body over Fastify's limit to a generic 413", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/cover/from-url",
        headers: { cookie: sessionCookie(), "content-type": "application/json" },
        payload: `{"url":"${"a".repeat(2 * 1024 * 1024)}"}`,
      });

      expect(res.statusCode).toBe(413);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.json()).toEqual({
        error: { code: "INTERNAL", message: "服务器内部错误。" },
      });
    } finally {
      await app.close();
    }
  });
});

describe("POST /api/cover/from-url", () => {
  it("rejects private URLs without leaking internal details", async () => {
    const app = await makeApp();
    try {
      const targets = [
        "http://127.0.0.1/cover.png",
        "http://10.0.0.1/cover.png",
        "http://169.254.169.254/latest/meta-data",
        "http://localhost/cover.png",
      ];
      for (const target of targets) {
        const res = await app.inject({
          method: "POST",
          url: "/api/cover/from-url",
          headers: { cookie: sessionCookie() },
          payload: { url: target },
        });
        expect(res.statusCode).toBe(400);
        expect(errorBody(res).code).toBe("INVALID_URL");
        expect(res.headers["cache-control"]).toBe("no-store");

        const body = res.body.toLowerCase();
        for (const secret of [
          "127.0.0.1",
          "10.0.0.1",
          "169.254.169.254",
          "private",
          "localhost",
          "pinned.invalid",
        ]) {
          expect(body).not.toContain(secret);
        }
      }
    } finally {
      await app.close();
    }
  });

  it("rejects a malformed url with a fixed Chinese message", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/cover/from-url",
        headers: { cookie: sessionCookie() },
        payload: { url: "not a url" },
      });
      expect(res.statusCode).toBe(400);
      const error = errorBody(res);
      expect(error.code).toBe("INVALID_URL");
      expect(error.message).toBe("封面地址无效或不可访问。");
    } finally {
      await app.close();
    }
  });

  it("validates the request body with a JSON schema", async () => {
    const app = await makeApp();
    try {
      for (const payload of [{}, { url: 1 }, { url: `https://example.com/${"a".repeat(2100)}` }]) {
        const res = await app.inject({
          method: "POST",
          url: "/api/cover/from-url",
          headers: { cookie: sessionCookie() },
          payload: payload as Record<string, unknown>,
        });
        expect(res.statusCode).toBe(400);
        expect(errorBody(res).code).toBe("INVALID_URL");
      }
    } finally {
      await app.close();
    }
  });
});

describe("POST /api/cover/from-file", () => {
  it("converts an uploaded webp to png", async () => {
    const app = await makeApp();
    try {
      const webp = await sampleWebp();
      const { boundary, body } = multipartBody(webp);

      const res = await app.inject({
        method: "POST",
        url: "/api/cover/from-file",
        headers: {
          cookie: sessionCookie(),
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload: body,
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("image/png");
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.rawPayload.subarray(1, 4).toString()).toBe("PNG");
    } finally {
      await app.close();
    }
  });

  it("converts an uploaded image to jpeg when requested", async () => {
    const app = await makeApp();
    try {
      const webp = await sampleWebp();
      const { boundary, body } = multipartBody(webp);

      const res = await app.inject({
        method: "POST",
        url: "/api/cover/from-file?format=jpeg",
        headers: {
          cookie: sessionCookie(),
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload: body,
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("image/jpeg");
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.rawPayload[0]).toBe(0xff);
      expect(res.rawPayload[1]).toBe(0xd8);
    } finally {
      await app.close();
    }
  });

  it("returns png for transparent uploads even when jpeg is requested", async () => {
    const app = await makeApp();
    try {
      const png = await transparentPng();
      const { boundary, body } = multipartBody(png, {
        filename: "transparent.png",
        contentType: "image/png",
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/cover/from-file?format=jpeg",
        headers: {
          cookie: sessionCookie(),
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload: body,
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("image/png");
      expect(res.rawPayload.subarray(1, 4).toString()).toBe("PNG");
    } finally {
      await app.close();
    }
  });

  it("rejects an unknown output format with 400", async () => {
    const app = await makeApp();
    try {
      const webp = await sampleWebp();
      const { boundary, body } = multipartBody(webp);

      const res = await app.inject({
        method: "POST",
        url: "/api/cover/from-file?format=webp",
        headers: {
          cookie: sessionCookie(),
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload: body,
      });

      expect(res.statusCode).toBe(400);
      expect(errorBody(res).code).toBe("INVALID_FORMAT");
    } finally {
      await app.close();
    }
  });

  it("rejects non-image uploads with 415", async () => {
    const app = await makeApp();
    try {
      const { boundary, body } = multipartBody(Buffer.from("definitely not an image"), {
        filename: "cover.txt",
        contentType: "text/plain",
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/cover/from-file",
        headers: {
          cookie: sessionCookie(),
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload: body,
      });

      expect(res.statusCode).toBe(415);
      expect(errorBody(res).code).toBe("UNSUPPORTED_IMAGE");
      expect(errorBody(res).message).toBe("不支持的图片格式。");
    } finally {
      await app.close();
    }
  });

  it("rejects an upload over the 10MB multipart limit", async () => {
    const app = await makeApp();
    try {
      const oversized = Buffer.alloc(10 * 1024 * 1024 + 1024, 1);
      const { boundary, body } = multipartBody(oversized, { filename: "huge.png" });

      const res = await app.inject({
        method: "POST",
        url: "/api/cover/from-file",
        headers: {
          cookie: sessionCookie(),
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload: body,
      });

      expect(res.statusCode).toBe(400);
      expect(errorBody(res).code).toBe("TOO_LARGE");
      // 不把 multipart/框架错误细节回传给客户端。
      expect(res.body).not.toContain("FST_");
      expect(res.body).not.toContain("busboy");
    } finally {
      await app.close();
    }
  });

  it("rejects a multipart request without the file field", async () => {
    const app = await makeApp();
    try {
      const { boundary, body } = multipartBody(Buffer.from("data"), {
        field: "avatar",
        filename: "a.png",
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/cover/from-file",
        headers: {
          cookie: sessionCookie(),
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload: body,
      });

      expect(res.statusCode).toBe(400);
      expect(errorBody(res).code).toBe("INVALID_REQUEST");
    } finally {
      await app.close();
    }
  });

  it("rejects a non-multipart request", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/cover/from-file",
        headers: { cookie: sessionCookie() },
        payload: { file: "nope" },
      });
      expect(res.statusCode).toBe(400);
      expect(errorBody(res).code).toBe("INVALID_REQUEST");
    } finally {
      await app.close();
    }
  });
});

describe("fetchCoverPng redirects", () => {
  it("follows a redirect and revalidates every hop", async () => {
    const png = await samplePng(8, 8);
    const { port } = await startServer((request, response) => {
      if (request.url === "/start") {
        response.writeHead(302, { location: "/final" });
        response.end();
        return;
      }
      if (request.url === "/final") {
        response.writeHead(200, { "content-type": "image/png" });
        response.end(png);
        return;
      }
      response.writeHead(404).end();
    });
    const calls: string[] = [];

    const out = await fetchCoverPng(
      `http://public.example:${port}/start`,
      makeConfig({ COVER_TIMEOUT_MS: "2000" }),
      { resolve: pinnedResolver(calls) },
    );

    expect(out.png.subarray(1, 4).toString()).toBe("PNG");
    expect(out.width).toBe(8);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("/start");
    expect(calls[1]).toContain("/final");
  });

  it("rejects the fourth redirect", async () => {
    const png = await samplePng();
    const hits: string[] = [];
    const { port } = await startServer((request, response) => {
      const path = request.url ?? "/";
      hits.push(path);
      const index = Number(path.replace("/r", ""));
      if (index < 4) {
        response.writeHead(302, { location: `/r${index + 1}` });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "image/png" });
      response.end(png);
    });
    const calls: string[] = [];

    await expect(
      fetchCoverPng(`http://public.example:${port}/r0`, makeConfig(), {
        resolve: pinnedResolver(calls),
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR", statusCode: 400 });

    expect(calls).toHaveLength(4);
    expect(hits).toEqual(["/r0", "/r1", "/r2", "/r3"]);
  });

  it("rejects a redirect that resolves to a private address without leaking it", async () => {
    const png = await samplePng();
    const { port } = await startServer((_request, response) => {
      response.writeHead(302, { location: "/private.png" });
      response.end();
    });
    let calls = 0;
    const resolve: CoverResolveFn = async (raw) => {
      calls += 1;
      if (calls > 1) throw new Error("private address 127.0.0.1 rejected");
      return { url: new URL(raw), address: "127.0.0.1", family: 4 };
    };

    const error = await fetchCoverPng(`http://public.example:${port}/start`, makeConfig(), {
      resolve,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "INVALID_URL", statusCode: 400 });
    const message = (error as Error).message.toLowerCase();
    expect(message).not.toContain("127.0.0.1");
    expect(message).not.toContain("private");
    expect(png.length).toBeGreaterThan(0);
  });

  it("rejects a redirect without a Location header", async () => {
    const { port } = await startServer((_request, response) => {
      response.writeHead(302);
      response.end();
    });

    await expect(
      fetchCoverPng(`http://public.example:${port}/start`, makeConfig(), {
        resolve: pinnedResolver(),
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR", statusCode: 400 });
  });

  it("rejects a non-2xx final response", async () => {
    const { port } = await startServer((_request, response) => {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("boom");
    });

    await expect(
      fetchCoverPng(`http://public.example:${port}/x.png`, makeConfig(), {
        resolve: pinnedResolver(),
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR", statusCode: 400 });
  });
});

describe("fetchCoverPng limits and content", () => {
  it("rejects a response whose content-type is not an image", async () => {
    const png = await samplePng();
    const { port } = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(png);
    });

    await expect(
      fetchCoverPng(`http://public.example:${port}/page`, makeConfig(), {
        resolve: pinnedResolver(),
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_IMAGE", statusCode: 415 });
  });

  it("rejects bytes that only claim to be an image", async () => {
    const { port } = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(Buffer.from("still not an image"));
    });

    await expect(
      fetchCoverPng(`http://public.example:${port}/fake.png`, makeConfig(), {
        resolve: pinnedResolver(),
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_IMAGE", statusCode: 415 });
  });

  it("rejects downloads larger than MAX_COVER_BYTES", async () => {
    const { port } = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(Buffer.alloc(4096, 1));
    });

    await expect(
      fetchCoverPng(`http://public.example:${port}/big.png`, makeConfig({ MAX_COVER_BYTES: "1024" }), {
        resolve: pinnedResolver(),
      }),
    ).rejects.toMatchObject({ code: "TOO_LARGE", statusCode: 400 });
  });

  it("times out with a 504", async () => {
    const { port } = await startServer(() => {
      // 故意不结束响应。
    });

    await expect(
      fetchCoverPng(`http://public.example:${port}/slow.png`, makeConfig({ COVER_TIMEOUT_MS: "50" }), {
        resolve: pinnedResolver(),
      }),
    ).rejects.toMatchObject({ code: "TIMEOUT", statusCode: 504 });
  });

  it("uses TLS for https targets and never sends a plaintext HTTP request", async () => {
    let httpRequests = 0;
    const { port } = await startServer((_request, response) => {
      httpRequests += 1;
      response.writeHead(200, { "content-type": "image/png" });
      response.end();
    });
    const calls: string[] = [];

    // 目标域名是 https，但固定到本地“明文 HTTP”服务器：若实现误用 http.request，
    // 服务器会收到合法 HTTP 请求；正确实现会先做 TLS 握手并因对端不是 TLS 而失败。
    const error = await fetchCoverPng(
      `https://public.example:${port}/cover.png`,
      makeConfig({ COVER_TIMEOUT_MS: "1500" }),
      { resolve: pinnedResolver(calls) },
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "UPSTREAM_ERROR", statusCode: 400 });
    expect(calls).toHaveLength(1);
    expect(httpRequests).toBe(0);
  });
});
