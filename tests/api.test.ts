import { afterEach, describe, expect, it, vi } from "vitest";
import { api, setUnauthorizedHandler } from "../src/core/api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function pngResponse(): Response {
  return new Response(new Uint8Array([137, 80, 78, 71]), {
    status: 200,
    headers: { "content-type": "image/png" },
  });
}

afterEach(() => {
  setUnauthorizedHandler(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("api", () => {
  it("maps 401 to a friendly ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: "UNAUTHORIZED", message: "请先登录" } }),
            { status: 401, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    await expect(api.coverFromUrl("http://x/y.png")).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
      message: "请先登录",
    });
  });

  it("returns a blob for a successful cover fetch", async () => {
    const fetchMock = vi.fn(
      async (_input: string, _init?: RequestInit) =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const blob = await api.coverFromUrl("http://x/y.png");

    expect(blob.type).toBe("image/png");
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.headers).toMatchObject({ accept: "image/png" });
  });

  it("posts the login payload as JSON with same-origin credentials", async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await api.login("admin", "pw");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0];
    expect(input).toBe("/api/auth/login");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("same-origin");
    expect(init?.headers).toMatchObject({ "content-type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({ username: "admin", password: "pw" });
  });

  it("reads the current session from /api/auth/me", async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) =>
      jsonResponse({ authenticated: true, username: "admin" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.me()).resolves.toEqual({ authenticated: true, username: "admin" });
    const [input, init] = fetchMock.mock.calls[0];
    expect(input).toBe("/api/auth/me");
    expect(init?.cache).toBe("no-store");
  });

  it("calls logout with a POST request", async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await api.logout();

    const [input, init] = fetchMock.mock.calls[0];
    expect(input).toBe("/api/auth/logout");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("same-origin");
  });

  it("uploads a file as multipart form data", async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => pngResponse());
    vi.stubGlobal("fetch", fetchMock);
    const file = new File([new Uint8Array([1, 2, 3])], "cover.png", { type: "image/png" });

    const blob = await api.coverFromFile(file);

    expect(blob.type).toBe("image/png");
    const [input, init] = fetchMock.mock.calls[0];
    expect(input).toBe("/api/cover/from-file");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("same-origin");
    const form = init?.body as FormData;
    const uploaded = form.get("file") as File;
    expect(uploaded).toBeInstanceOf(File);
    expect(uploaded.name).toBe("cover.png");
    expect(uploaded.type).toBe("image/png");
    expect(uploaded.size).toBe(file.size);
  });

  it("requests a jpeg cover with the matching accept header", async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) =>
      new Response(new Uint8Array([255, 216, 255]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const file = new File([new Uint8Array([1, 2, 3])], "cover.png", { type: "image/png" });

    const blob = await api.coverFromFile(file, { format: "jpeg" });

    expect(blob.type).toBe("image/jpeg");
    const [input, init] = fetchMock.mock.calls[0];
    expect(input).toBe("/api/cover/from-file?format=jpeg");
    expect(init?.headers).toMatchObject({ accept: "image/jpeg, image/png" });
  });

  it("maps network failures to ApiError(0, NETWORK)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    await expect(api.me()).rejects.toMatchObject({ status: 0, code: "NETWORK" });
  });

  it("falls back to an HTTP status code when the error body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>boom</html>", {
            status: 500,
            headers: { "content-type": "text/html" },
          }),
      ),
    );

    await expect(api.logout()).rejects.toMatchObject({ status: 500, code: "HTTP_500" });
  });

  it("notifies the unauthorized handler for a 401 outside the login endpoint", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "请先登录" } }), {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    await expect(api.me()).rejects.toMatchObject({ status: 401 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not treat a failed login as a global session expiry", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: "UNAUTHORIZED", message: "用户名或密码错误" } }),
            { status: 401, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    await expect(api.login("admin", "bad")).rejects.toMatchObject({ status: 401 });
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not treat a failed logout as a global session expiry", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "请先登录" } }), {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    await expect(api.logout()).rejects.toMatchObject({ status: 401 });
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not call the unauthorized handler for other error statuses", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: "INTERNAL", message: "服务不可用" } }), {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    await expect(api.me()).rejects.toMatchObject({ status: 500 });
    expect(handler).not.toHaveBeenCalled();
  });
});
