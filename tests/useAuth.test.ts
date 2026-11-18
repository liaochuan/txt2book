import { afterEach, describe, expect, it, vi } from "vitest";
import type { useAuth as UseAuth } from "../src/composables/useAuth";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 每个用例重新加载模块，避免模块级登录态在用例之间串扰。 */
async function freshAuth(): Promise<ReturnType<typeof UseAuth>> {
  vi.resetModules();
  const mod = await import("../src/composables/useAuth");
  return mod.useAuth();
}

function stubFetch(...responses: Array<Response | Error>): void {
  const queue = [...responses];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const next = queue.shift();
      if (!next) throw new Error("unexpected fetch call");
      if (next instanceof Error) throw next;
      return next;
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useAuth", () => {
  it("sets authenticated after a successful login", async () => {
    stubFetch(
      new Response(null, { status: 204 }),
      jsonResponse({ authenticated: true, username: "admin" }),
    );
    const auth = await freshAuth();

    await expect(auth.login("admin", "pw")).resolves.toBe(true);

    expect(auth.authenticated.value).toBe(true);
    expect(auth.username.value).toBe("admin");
    expect(auth.error.value).toBe("");
  });

  it("reports a failed login without touching the authenticated flag", async () => {
    stubFetch(jsonResponse({ error: { code: "UNAUTHORIZED", message: "用户名或密码错误" } }, 401));
    const auth = await freshAuth();

    await expect(auth.login("admin", "bad")).resolves.toBe(false);

    expect(auth.authenticated.value).toBe(false);
    expect(auth.error.value).toBe("用户名或密码错误");
  });

  it("clears authenticated state on logout", async () => {
    stubFetch(
      new Response(null, { status: 204 }),
      jsonResponse({ authenticated: true, username: "admin" }),
      new Response(null, { status: 204 }),
    );
    const auth = await freshAuth();
    await auth.login("admin", "pw");
    expect(auth.authenticated.value).toBe(true);

    await auth.logout();

    expect(auth.authenticated.value).toBe(false);
    expect(auth.username.value).toBe("");
  });

  it("clears authenticated state even when the logout request fails", async () => {
    stubFetch(
      new Response(null, { status: 204 }),
      jsonResponse({ authenticated: true, username: "admin" }),
      new TypeError("Failed to fetch"),
    );
    const auth = await freshAuth();
    await auth.login("admin", "pw");
    expect(auth.authenticated.value).toBe(true);

    await expect(auth.logout()).resolves.toBeUndefined();

    expect(auth.authenticated.value).toBe(false);
    expect(auth.username.value).toBe("");
  });

  it("treats a 401 from check() as unauthenticated without throwing", async () => {
    stubFetch(jsonResponse({ error: { code: "UNAUTHORIZED", message: "请先登录" } }, 401));
    const auth = await freshAuth();

    await expect(auth.check()).resolves.toBe(false);

    expect(auth.authenticated.value).toBe(false);
    expect(auth.username.value).toBe("");
  });

  it("clears authenticated state when check() gets a 401", async () => {
    stubFetch(
      new Response(null, { status: 204 }),
      jsonResponse({ authenticated: true, username: "admin" }),
      jsonResponse({ error: { code: "UNAUTHORIZED", message: "请先登录" } }, 401),
    );
    const auth = await freshAuth();
    await auth.login("admin", "pw");
    expect(auth.authenticated.value).toBe(true);

    await expect(auth.check()).resolves.toBe(false);

    expect(auth.authenticated.value).toBe(false);
  });

  it("keeps authenticated state when check() gets a 500", async () => {
    stubFetch(
      new Response(null, { status: 204 }),
      jsonResponse({ authenticated: true, username: "admin" }),
      jsonResponse({ error: { code: "INTERNAL", message: "服务暂时不可用" } }, 500),
    );
    const auth = await freshAuth();
    await auth.login("admin", "pw");

    await expect(auth.check()).resolves.toBe(false);

    expect(auth.authenticated.value).toBe(true);
    expect(auth.username.value).toBe("admin");
  });

  it("returns false on a network failure from check() without throwing or clearing state", async () => {
    stubFetch(
      new Response(null, { status: 204 }),
      jsonResponse({ authenticated: true, username: "admin" }),
      new TypeError("Failed to fetch"),
    );
    const auth = await freshAuth();
    await auth.login("admin", "pw");

    await expect(auth.check()).resolves.toBe(false);

    expect(auth.authenticated.value).toBe(true);
    expect(auth.error.value).toBe("");
  });

  it("restores the session from check()", async () => {
    stubFetch(jsonResponse({ authenticated: true, username: "admin" }));
    const auth = await freshAuth();

    await expect(auth.check()).resolves.toBe(true);

    expect(auth.authenticated.value).toBe(true);
    expect(auth.username.value).toBe("admin");
  });

  it("tracks checking while the session request is in flight", async () => {
    let release: (response: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      ),
    );
    const auth = await freshAuth();

    expect(auth.checking.value).toBe(false);
    const pending = auth.check();
    expect(auth.checking.value).toBe(true);

    release(jsonResponse({ authenticated: true, username: "admin" }));
    await expect(pending).resolves.toBe(true);
    expect(auth.checking.value).toBe(false);
  });

  it("clears local state through clearSession without calling the server", async () => {
    stubFetch(
      new Response(null, { status: 204 }),
      jsonResponse({ authenticated: true, username: "admin" }),
    );
    const auth = await freshAuth();
    await auth.login("admin", "pw");
    expect(auth.authenticated.value).toBe(true);

    auth.clearSession();

    expect(auth.authenticated.value).toBe(false);
    expect(auth.username.value).toBe("");
  });
});
