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

function atomResponse(xml = "<feed/>"): Response {
  return new Response(xml, {
    status: 200,
    headers: { "content-type": "application/atom+xml; charset=utf-8" },
  });
}

function calibreSessionBody() {
  return { connected: true, saved: true, baseUrl: "http://calibre.local", username: "reader" };
}

describe("api.calibre", () => {
  it("requests the feed with encoded query parameters in a stable order", async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => atomResponse());
    vi.stubGlobal("fetch", fetchMock);

    const xml = await api.calibreFeed({ offset: 30, q: "三体", format: "txt" });

    expect(xml).toBe("<feed/>");
    const [input, init] = fetchMock.mock.calls[0];
    expect(input).toBe("/api/calibre/feed?offset=30&q=%E4%B8%89%E4%BD%93&format=txt");
    expect(init?.credentials).toBe("same-origin");
    expect(init?.headers).toMatchObject({ accept: "application/atom+xml" });
  });

  it("omits empty feed query parameters", async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => atomResponse());
    vi.stubGlobal("fetch", fetchMock);

    await api.calibreFeed({});
    await api.calibreFeed({ q: "", format: "" });

    expect(fetchMock.mock.calls[0][0]).toBe("/api/calibre/feed");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/calibre/feed");
  });

  it("reads the calibre session from /api/calibre/session", async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) =>
      jsonResponse(calibreSessionBody()),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.calibreStatus()).resolves.toEqual(calibreSessionBody());
    const [input, init] = fetchMock.mock.calls[0];
    expect(input).toBe("/api/calibre/session");
    expect(init?.method).toBeUndefined();
    expect(init?.headers).toMatchObject({ accept: "application/json" });
  });

  it("posts the connect payload as JSON", async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) =>
      jsonResponse(calibreSessionBody()),
    );
    vi.stubGlobal("fetch", fetchMock);

    const info = await api.calibreConnect({
      baseUrl: "http://calibre.local",
      username: "reader",
      password: "secret",
    });

    expect(info.connected).toBe(true);
    const [input, init] = fetchMock.mock.calls[0];
    expect(input).toBe("/api/calibre/session");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("same-origin");
    expect(init?.headers).toMatchObject({ "content-type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({
      baseUrl: "http://calibre.local",
      username: "reader",
      password: "secret",
    });
  });

  it("reconnects with a POST and no body", async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) =>
      jsonResponse(calibreSessionBody()),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.calibreReconnect();

    const [input, init] = fetchMock.mock.calls[0];
    expect(input).toBe("/api/calibre/session/reconnect");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeUndefined();
  });

  it("disconnects with a DELETE and no body", async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.calibreDisconnect()).resolves.toBeUndefined();

    const [input, init] = fetchMock.mock.calls[0];
    expect(input).toBe("/api/calibre/session");
    expect(init?.method).toBe("DELETE");
    expect(init?.body).toBeUndefined();
  });

  it("forgets stored credentials via DELETE /api/calibre/credentials", async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.calibreForget()).resolves.toBeUndefined();

    const [input, init] = fetchMock.mock.calls[0];
    expect(input).toBe("/api/calibre/credentials");
    expect(init?.method).toBe("DELETE");
    expect(init?.body).toBeUndefined();
  });

  it("downloads a book text file as a blob without a query string", async () => {
    const fetchMock = vi.fn(
      async (_input: string, _init?: RequestInit) =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const blob = await api.calibreTextFile(7);

    expect(blob.size).toBe(3);
    const [input, init] = fetchMock.mock.calls[0];
    expect(input).toBe("/api/calibre/books/7/file");
    expect(init?.headers).toMatchObject({ accept: "application/octet-stream" });
  });

  it("downloads a cover as a png blob", async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => pngResponse());
    vi.stubGlobal("fetch", fetchMock);

    const blob = await api.calibreCover(7);

    expect(blob.type).toBe("image/png");
    const [input, init] = fetchMock.mock.calls[0];
    expect(input).toBe("/api/calibre/books/7/cover");
    expect(init?.headers).toMatchObject({ accept: "image/png" });
  });

  it("rejects a cover response that is not a png", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>boom</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      ),
    );

    await expect(api.calibreCover(7)).rejects.toMatchObject({
      status: 200,
      code: "BAD_RESPONSE",
    });
  });

  it("pushes an epub as multipart form data with the overwrite query flag", async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "application/epub+zip" });

    await expect(api.calibrePush(7, blob, "三体.epub", true)).resolves.toBeUndefined();

    const [input, init] = fetchMock.mock.calls[0];
    expect(input).toBe("/api/calibre/books/7/epub?overwrite=true");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("same-origin");
    const form = init?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const uploaded = form.get("file") as File;
    expect(uploaded).toBeInstanceOf(File);
    expect(uploaded.name).toBe("三体.epub");
    expect(uploaded.size).toBe(3);
  });

  it("omits the overwrite flag when pushing without overwrite", async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const blob = new Blob([new Uint8Array([1])], { type: "application/epub+zip" });

    await api.calibrePush(9, blob, "book.epub", false);

    expect(fetchMock.mock.calls[0][0]).toBe("/api/calibre/books/9/epub");
  });

  it("maps calibre 404 and 502 error bodies to ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: "CALIBRE_NOT_FOUND", message: "书不存在" } }), {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    await expect(api.calibreTextFile(7)).rejects.toMatchObject({
      status: 404,
      code: "CALIBRE_NOT_FOUND",
      message: "书不存在",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: "CALIBRE_UPSTREAM", message: "上游不可用" } }), {
            status: 502,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    await expect(api.calibreFeed({})).rejects.toMatchObject({
      status: 502,
      code: "CALIBRE_UPSTREAM",
      message: "上游不可用",
    });
  });
});
