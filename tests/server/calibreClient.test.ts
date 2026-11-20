// @vitest-environment node
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { calibreRequest } from "../../server/lib/calibre/client";
import type { CalibreTarget } from "../../server/lib/calibre/types";

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
): Promise<{ port: number; target: CalibreTarget }> {
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
  const port = address.port;
  return {
    port,
    target: {
      url: new URL(`http://127.0.0.1:${port}`),
      baseUrl: `http://127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
      basePath: "",
      address: "127.0.0.1",
      family: 4,
    },
  };
}

/** 申请一个当前空闲、随后关闭的端口，用于连接拒绝测试。 */
async function reserveClosedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("测试服务器未获得端口");
  }
  await closeServer(server);
  return address.port;
}

describe("calibreRequest", () => {
  it("sends method, body, authorization and host, and returns the response body", async () => {
    let seen: { method?: string; headers?: IncomingHttpHeaders; body?: string } = {};
    const { target } = await startServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        seen = {
          method: request.method,
          headers: request.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        };
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("pong");
      });
    });

    const result = await calibreRequest(target, "/api/session", {
      method: "POST",
      headers: { authorization: "Basic dXNlcjpwYXNz", "content-type": "application/json" },
      body: Buffer.from('{"hello":true}'),
      timeoutMs: 5000,
      maxBytes: 1024,
    });

    expect(result.status).toBe(200);
    expect(result.body.toString("utf8")).toBe("pong");
    expect(result.url.toString()).toBe(`${target.origin}/api/session`);
    expect(seen.method).toBe("POST");
    expect(seen.body).toBe('{"hello":true}');
    expect(seen.headers?.authorization).toBe("Basic dXNlcjpwYXNz");
    expect(seen.headers?.host).toBe(`127.0.0.1:${target.url.port}`);
    expect(seen.headers?.["user-agent"]).toBe("txt2book-calibre/1.0");
    expect(seen.headers?.connection).toBe("close");
  });

  it("collects Set-Cookie into the injected map, ignoring Max-Age=0 and empty values", async () => {
    let cookieHeader: string | undefined;
    const { target } = await startServer((request, response) => {
      cookieHeader = request.headers.cookie;
      response.setHeader("set-cookie", [
        "session=abc123; Path=/; HttpOnly",
        "theme=gone; Max-Age=0; Path=/",
        "keep=; Path=/",
      ]);
      response.end("ok");
    });

    const jar = new Map<string, string>([
      ["theme", "old"],
      ["keep", "yes"],
      ["other", "stay"],
    ]);

    await calibreRequest(target, "/login", {
      method: "POST",
      cookies: new Map([
        ["a", "1"],
        ["b", "2"],
      ]),
      collectCookies: jar,
      timeoutMs: 5000,
      maxBytes: 1024,
    });

    expect(cookieHeader).toBe("a=1; b=2");
    expect(jar.get("session")).toBe("abc123");
    expect(jar.get("other")).toBe("stay");
    expect(jar.has("theme")).toBe(false);
    expect(jar.has("keep")).toBe(false);
  });

  it("rejects with CALIBRE_TOO_LARGE (413) when the body exceeds maxBytes", async () => {
    const { target } = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.alloc(2048, 0x61));
    });

    const error = await calibreRequest(target, "/file", {
      timeoutMs: 5000,
      maxBytes: 1024,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: "CALIBRE_TOO_LARGE", statusCode: 413 });
    expect((error as Error).message).not.toContain("127.0.0.1");
  });

  it("rejects with CALIBRE_TOO_LARGE (413) when a chunked body exceeds maxBytes", async () => {
    const { target } = await startServer((_request, response) => {
      response.on("error", () => {});
      // 不发送 content-length，Node 改用 chunked 编码，客户端只能边读边计数。
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.write(Buffer.alloc(800, 0x61));
      response.write(Buffer.alloc(800, 0x61));
      response.end();
    });

    const error = await calibreRequest(target, "/stream", {
      timeoutMs: 5000,
      maxBytes: 1024,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "CALIBRE_TOO_LARGE", statusCode: 413 });
    expect((error as Error).message).not.toContain("127.0.0.1");
  });

  it("rejects with CALIBRE_TIMEOUT (504) when the total deadline passes", async () => {
    const { target } = await startServer((_request, _response) => {
      // 故意永不响应，让客户端的总超时生效。
    });

    const error = await calibreRequest(target, "/slow", {
      timeoutMs: 80,
      maxBytes: 1024,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "CALIBRE_TIMEOUT", statusCode: 504 });
    expect((error as Error).message).not.toContain("127.0.0.1");
  });

  it("follows a same-origin 302 for GET, rejects a cross-origin one, and does not follow POST", async () => {
    let hitCrossOrigin = false;
    let crossOriginPort = 0;
    const { target } = await startServer((request, response) => {
      if (request.url === "/redirect") {
        response.writeHead(302, { location: "/final" });
        response.end();
        return;
      }
      if (request.url === "/cross") {
        response.writeHead(302, { location: `http://127.0.0.1:${crossOriginPort}/stolen` });
        response.end();
        return;
      }
      if (request.url === "/post-redirect") {
        response.writeHead(302, { location: "/final" });
        response.end();
        return;
      }
      if (request.url === "/final") {
        response.end("done");
        return;
      }
      response.writeHead(404);
      response.end();
    });

    const other = await startServer((_request, response) => {
      hitCrossOrigin = true;
      response.end("stolen");
    });
    crossOriginPort = other.port;

    const sameOrigin = await calibreRequest(target, "/redirect", {
      redirects: 3,
      timeoutMs: 5000,
      maxBytes: 1024,
    });
    expect(sameOrigin.status).toBe(200);
    expect(sameOrigin.body.toString("utf8")).toBe("done");
    expect(sameOrigin.url.toString()).toBe(`${target.origin}/final`);

    const crossOrigin = await calibreRequest(target, "/cross", {
      redirects: 3,
      timeoutMs: 5000,
      maxBytes: 1024,
    }).catch((caught: unknown) => caught);
    expect(crossOrigin).toMatchObject({ code: "CALIBRE_UPSTREAM", statusCode: 502 });
    expect(hitCrossOrigin).toBe(false);

    const post = await calibreRequest(target, "/post-redirect", {
      method: "POST",
      body: Buffer.from("x"),
      redirects: 3,
      timeoutMs: 5000,
      maxBytes: 1024,
    });
    expect(post.status).toBe(302);
  });

  it("follows same-origin redirects by default and rejects a cross-origin target", async () => {
    let hitCrossOrigin = false;
    let crossOriginPort = 0;
    const { target } = await startServer((request, response) => {
      if (request.url === "/redirect") {
        response.writeHead(302, { location: "/final" });
        response.end();
        return;
      }
      if (request.url === "/cross") {
        response.writeHead(302, { location: `http://127.0.0.1:${crossOriginPort}/stolen` });
        response.end();
        return;
      }
      response.end("done");
    });
    const other = await startServer((_request, response) => {
      hitCrossOrigin = true;
      response.end("stolen");
    });
    crossOriginPort = other.port;

    const sameOrigin = await calibreRequest(target, "/redirect", {
      timeoutMs: 5000,
      maxBytes: 1024,
    });
    expect(sameOrigin.status).toBe(200);
    expect(sameOrigin.body.toString("utf8")).toBe("done");
    expect(sameOrigin.url.toString()).toBe(`${target.origin}/final`);

    const crossOrigin = await calibreRequest(target, "/cross", {
      timeoutMs: 5000,
      maxBytes: 1024,
    }).catch((caught: unknown) => caught);
    expect(crossOrigin).toMatchObject({ code: "CALIBRE_UPSTREAM", statusCode: 502 });
    expect(hitCrossOrigin).toBe(false);
  });

  it("follows up to three same-origin redirects", async () => {
    const hits: string[] = [];
    const { target } = await startServer((request, response) => {
      const path = request.url ?? "/";
      hits.push(path);
      const index = Number(path.replace("/r", ""));
      if (index < 3) {
        response.writeHead(302, { location: `/r${index + 1}` });
        response.end();
        return;
      }
      response.end("done");
    });

    const result = await calibreRequest(target, "/r0", {
      timeoutMs: 5000,
      maxBytes: 1024,
    });

    expect(result.status).toBe(200);
    expect(result.body.toString("utf8")).toBe("done");
    expect(hits).toEqual(["/r0", "/r1", "/r2", "/r3"]);
  });

  it("rejects a fourth same-origin redirect with CALIBRE_UPSTREAM", async () => {
    const hits: string[] = [];
    const { target } = await startServer((request, response) => {
      const path = request.url ?? "/";
      hits.push(path);
      const index = Number(path.replace("/r", ""));
      if (index < 4) {
        response.writeHead(302, { location: `/r${index + 1}` });
        response.end();
        return;
      }
      response.end("done");
    });

    const error = await calibreRequest(target, "/r0", {
      timeoutMs: 5000,
      maxBytes: 1024,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "CALIBRE_UPSTREAM", statusCode: 502 });
    expect(hits).toEqual(["/r0", "/r1", "/r2", "/r3"]);
  });

  it("never follows redirects for headersOnly requests", async () => {
    let followed = false;
    const { target } = await startServer((request, response) => {
      if (request.url === "/redirect") {
        response.writeHead(302, { location: "/final" });
        response.end();
        return;
      }
      followed = true;
      response.end("done");
    });

    const result = await calibreRequest(target, "/redirect", {
      headersOnly: true,
      timeoutMs: 5000,
      maxBytes: 1024,
    });

    expect(result.status).toBe(302);
    expect(result.location).toBe("/final");
    expect(followed).toBe(false);
  });

  it("returns immediately for headersOnly without reading the body or enforcing maxBytes", async () => {
    let closedEarly = false;
    const { target } = await startServer((_request, response) => {
      response.on("error", () => {});
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(4 * 1024 * 1024),
      });
      response.write(Buffer.alloc(64 * 1024, 0x62));
      response.on("close", () => {
        closedEarly = true;
      });
      // 故意不调用 end()：客户端应在响应头到达后立即销毁连接。
    });

    const result = await calibreRequest(target, "/large", {
      headersOnly: true,
      timeoutMs: 5000,
      maxBytes: 16,
    });

    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toBe("application/octet-stream");
    expect(result.body.length).toBe(0);
    await waitFor(() => closedEarly);
  });

  it("rejects with CALIBRE_UNREACHABLE (502) when the connection is refused", async () => {
    const port = await reserveClosedPort();
    const target: CalibreTarget = {
      url: new URL(`http://127.0.0.1:${port}`),
      baseUrl: `http://127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
      basePath: "",
      address: "127.0.0.1",
      family: 4,
    };

    const error = await calibreRequest(target, "/opds/", {
      timeoutMs: 2000,
      maxBytes: 1024,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "CALIBRE_UNREACHABLE", statusCode: 502 });
    expect((error as Error).message).not.toContain("127.0.0.1");
  });
});
