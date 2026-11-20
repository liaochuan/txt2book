// @vitest-environment node
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createCalibreService } from "../../server/lib/calibre/service";
import { createCalibreStore, type CalibreStore } from "../../server/lib/calibre/store";
import type { SavedCalibrePayload } from "../../server/lib/calibre/types";
import { loadConfig, type AppConfig } from "../../server/lib/config";
import { startCalibreFake, type FakeCalibre, type FakeCalibreOptions } from "./calibreFake";

const SECRET = "s".repeat(32);
const USERNAME = "reader";
const PASSWORD = "s3cret-pass";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const openFakes: FakeCalibre[] = [];

afterEach(async () => {
  const fakes = openFakes.splice(0);
  await Promise.all(fakes.map((fake) => fake.close()));
});

function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

function makeConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig(
    env({
      SESSION_SECRET: SECRET,
      AUTH_PASSWORD_HASH: "h",
      AUTH_USERNAME: "admin",
      CALIBRE_TIMEOUT_MS: "5000",
      ...overrides,
    }),
  );
}

/** 默认注入的禁用存储：不读写任何真实文件，保证 `saved` 为 false。 */
function disabledStore(): CalibreStore {
  return createCalibreStore({
    path: join(tmpdir(), "calibre-service-none.json"),
    key: null,
    enabled: false,
  });
}

/** 进程内存储，用于持久化与恢复用例。 */
function memoryStore(initial: SavedCalibrePayload | null): CalibreStore {
  let saved = initial;
  return {
    async loadSaved() {
      return saved;
    },
    async saveSaved(payload) {
      saved = payload;
      return true;
    },
    async clearSaved() {
      saved = null;
    },
  };
}

async function startFake(overrides: Partial<FakeCalibreOptions> = {}): Promise<FakeCalibre> {
  const fake = await startCalibreFake({
    username: USERNAME,
    password: PASSWORD,
    ...overrides,
  });
  openFakes.push(fake);
  return fake;
}

function basicHeader(username = USERNAME, password = PASSWORD): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

describe("calibreService connect / status", () => {
  it("connects with Basic auth and reports an unsaved, push-capable session", async () => {
    const fake = await startFake();
    const service = createCalibreService(makeConfig(), { store: disabledStore() });

    const info = await service.connect({
      baseUrl: fake.baseUrl,
      username: USERNAME,
      password: PASSWORD,
    });

    expect(info).toEqual({ connected: true, saved: false, canPush: true });

    const opds = fake.requests.find((item) => item.path === "/opds/");
    expect(opds?.auth).toBe(basicHeader());

    const status = await service.status();
    expect(status).toEqual({
      connected: true,
      saved: false,
      baseUrl: fake.baseUrl,
      username: USERNAME,
      canPush: true,
    });
  });

  it("maps a wrong password to CALIBRE_AUTH_FAILED without leaking the host or password", async () => {
    const fake = await startFake();
    const service = createCalibreService(makeConfig(), { store: disabledStore() });

    const error = await service
      .connect({ baseUrl: fake.baseUrl, username: USERNAME, password: "wrong-password" })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ name: "CalibreError", code: "CALIBRE_AUTH_FAILED", statusCode: 400 });
    const message = (error as Error).message;
    expect(message).not.toContain("127.0.0.1");
    expect(message).not.toContain(PASSWORD);
    expect(message).not.toContain("wrong-password");

    expect(await service.status()).toEqual({ connected: false, saved: false });
  });

  it("keeps the connection readable but disables push when the login form fails", async () => {
    const fake = await startFake({ loginWorks: false });
    const service = createCalibreService(makeConfig(), { store: disabledStore() });

    const info = await service.connect({
      baseUrl: fake.baseUrl,
      username: USERNAME,
      password: PASSWORD,
    });

    expect(info).toMatchObject({ connected: true, saved: false, canPush: false });
    expect(typeof info.pushReason).toBe("string");
    expect((info.pushReason ?? "").length).toBeGreaterThan(0);
    expect(info.pushReason).not.toContain("127.0.0.1");

    const status = await service.status();
    expect(status.connected).toBe(true);
    expect(status.canPush).toBe(false);
    expect(status.pushReason).toBe(info.pushReason);
  });

  it("reports {connected:false,saved:false} when nothing is connected", async () => {
    const service = createCalibreService(makeConfig(), { store: disabledStore() });
    expect(await service.status()).toEqual({ connected: false, saved: false });
  });

  it("rejects a concurrent connect with CALIBRE_BUSY (429)", async () => {
    const fake = await startFake({ opdsDelayMs: 150 });
    const service = createCalibreService(makeConfig(), { store: disabledStore() });

    const first = service.connect({
      baseUrl: fake.baseUrl,
      username: USERNAME,
      password: PASSWORD,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const busy = await service
      .connect({ baseUrl: fake.baseUrl, username: USERNAME, password: PASSWORD })
      .catch((caught: unknown) => caught);

    expect(busy).toMatchObject({ code: "CALIBRE_BUSY", statusCode: 429 });

    const info = await first;
    expect(info.connected).toBe(true);
  });
});

describe("calibreService feed / files", () => {
  async function connectedService(fake: FakeCalibre): Promise<ReturnType<typeof createCalibreService>> {
    const service = createCalibreService(makeConfig(), { store: disabledStore() });
    await service.connect({ baseUrl: fake.baseUrl, username: USERNAME, password: PASSWORD });
    return service;
  }

  it("returns the upstream OPDS XML and sends Basic plus the session cookie", async () => {
    const fake = await startFake();
    const service = await connectedService(fake);

    const xml = await service.feed({});
    expect(xml).toContain("<feed");
    expect(xml).toContain("<entry");
    expect(xml).toContain("三体");

    const request = fake.requests.find((item) => item.path === "/opds/new");
    expect(request?.auth).toBe(basicHeader());
    expect(request?.cookie).toContain("session=fake");
  });

  it("falls back to the all-books feed when /opds/new returns 404", async () => {
    const fake = await startFake({ recentUnavailable: true });
    const service = await connectedService(fake);

    const xml = await service.feed({ offset: 1 });
    expect(xml).toContain("<feed");
    expect(xml).toContain("<entry");
    expect(xml).toContain('rel="self" href="/opds/books/letter/00"');

    const paths = fake.requests.map((item) => item.path);
    expect(paths).toContain("/opds/new?offset=1");
    expect(paths).toContain("/opds/books/letter/00?offset=1");
  });

  it("does not fall back on 401", async () => {
    const fake = await startFake({ readAuthFailure: true });
    const service = await connectedService(fake);

    const error = await service.feed({}).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "CALIBRE_AUTH_FAILED", statusCode: 400 });
    expect(fake.requests.some((item) => item.path === "/opds/books/letter/00")).toBe(false);
  });

  it("does not fall back on 403 or 500", async () => {
    const forbidden = await startFake({ recentStatus: 403 });
    const forbiddenError = await connectedService(forbidden)
      .then((service) => service.feed({}))
      .catch((caught: unknown) => caught);
    expect(forbiddenError).toMatchObject({ code: "CALIBRE_AUTH_FAILED", statusCode: 400 });
    expect(forbidden.requests.some((item) => item.path === "/opds/books/letter/00")).toBe(false);

    const broken = await startFake({ recentStatus: 500 });
    const brokenError = await connectedService(broken)
      .then((service) => service.feed({}))
      .catch((caught: unknown) => caught);
    expect(brokenError).toMatchObject({ code: "CALIBRE_UPSTREAM", statusCode: 502 });
    expect(broken.requests.some((item) => item.path === "/opds/books/letter/00")).toBe(false);
  });

  it("maps a 404 on the fallback feed to CALIBRE_UPSTREAM", async () => {
    const fake = await startFake({ recentUnavailable: true, allBooksStatus: 404 });
    const service = await connectedService(fake);

    const error = await service.feed({}).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "CALIBRE_UPSTREAM", statusCode: 502 });
    const paths = fake.requests.map((item) => item.path);
    expect(paths).toContain("/opds/new");
    expect(paths).toContain("/opds/books/letter/00");
  });

  it("routes format feeds and searches to the expected OPDS paths", async () => {
    const fake = await startFake();
    const service = await connectedService(fake);

    const byFormat = await service.feed({ format: "TXT" });
    expect(byFormat).toContain("<entry");
    expect(fake.requests.some((item) => item.path === "/opds/formats/txt")).toBe(true);

    const byQuery = await service.feed({ q: "三体" });
    expect(byQuery).toContain("三体");
    expect(fake.requests.some((item) => item.path === "/opds/search/%E4%B8%89%E4%BD%93")).toBe(true);
  });

  it("maps a missing format feed to CALIBRE_FORMAT_UNAVAILABLE (404)", async () => {
    const fake = await startFake();
    const service = await connectedService(fake);

    const error = await service.feed({ format: "pdf" }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "CALIBRE_FORMAT_UNAVAILABLE", statusCode: 404 });
  });

  it("returns TXT bytes and maps an unknown book id to CALIBRE_NOT_FOUND", async () => {
    const fake = await startFake();
    const service = await connectedService(fake);

    const data = await service.textFile(1);
    expect(Buffer.isBuffer(data)).toBe(true);
    expect(data.toString("utf8")).toBe("第一行\n第二行");

    const missing = await service.textFile(999).catch((caught: unknown) => caught);
    expect(missing).toMatchObject({ code: "CALIBRE_NOT_FOUND", statusCode: 404 });

    const invalid = await service.textFile(0).catch((caught: unknown) => caught);
    expect(invalid).toMatchObject({ code: "CALIBRE_NOT_FOUND", statusCode: 404 });
  });

  it("returns a PNG cover and maps a book without a cover to CALIBRE_NO_COVER", async () => {
    const fake = await startFake();
    const service = await connectedService(fake);

    const png = await service.coverPng(1);
    expect(png.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    expect(png.length).toBeGreaterThan(8);

    const missing = await service.coverPng(2).catch((caught: unknown) => caught);
    expect(missing).toMatchObject({ code: "CALIBRE_NO_COVER", statusCode: 404 });

    const unknown = await service.coverPng(999).catch((caught: unknown) => caught);
    expect(unknown).toMatchObject({ code: "CALIBRE_NO_COVER", statusCode: 404 });
  });

  it("maps 401/403 on reads to CALIBRE_AUTH_FAILED (400)", async () => {
    const fake = await startFake({ readAuthFailure: true });
    const service = createCalibreService(makeConfig(), { store: disabledStore() });
    await service.connect({ baseUrl: fake.baseUrl, username: USERNAME, password: PASSWORD });

    for (const call of [
      () => service.feed({}),
      () => service.textFile(1),
      () => service.coverPng(1),
    ]) {
      const error = await call().catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "CALIBRE_AUTH_FAILED", statusCode: 400 });
      expect((error as Error).message).not.toContain("127.0.0.1");
    }
  });

  it("maps an oversized cover to CALIBRE_TOO_LARGE (413)", async () => {
    const fake = await startFake();
    const service = createCalibreService(makeConfig({ MAX_COVER_BYTES: "8" }), {
      store: disabledStore(),
    });
    await service.connect({ baseUrl: fake.baseUrl, username: USERNAME, password: PASSWORD });

    const error = await service.coverPng(1).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "CALIBRE_TOO_LARGE", statusCode: 413 });
    expect((error as Error).message).not.toContain("127.0.0.1");
  });

  it("throws CALIBRE_NOT_CONNECTED (409) for reads without a live or saved connection", async () => {
    const service = createCalibreService(makeConfig(), { store: disabledStore() });

    for (const call of [
      () => service.feed({}),
      () => service.textFile(1),
      () => service.coverPng(1),
    ]) {
      const error = await call().catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "CALIBRE_NOT_CONNECTED", statusCode: 409 });
    }
  });
});

describe("calibreService resume / persistence", () => {
  it("resumes from a saved payload and deduplicates concurrent resume attempts", async () => {
    const fake = await startFake();
    const store = memoryStore({ baseUrl: fake.baseUrl, username: USERNAME, password: PASSWORD });
    const service = createCalibreService(makeConfig(), { store });

    const before = fake.requests.filter((item) => item.path === "/opds/").length;

    const [first, second] = await Promise.all([service.feed({}), service.feed({})]);
    expect(first).toContain("<feed");
    expect(second).toContain("<feed");

    const after = fake.requests.filter((item) => item.path === "/opds/").length;
    expect(after - before).toBe(1);

    const status = await service.status();
    expect(status).toMatchObject({ connected: true, saved: true, baseUrl: fake.baseUrl });
  });

  it("maps resume without a saved payload to CALIBRE_NOT_CONNECTED (409)", async () => {
    const service = createCalibreService(makeConfig(), { store: memoryStore(null) });
    const error = await service.resume().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "CALIBRE_NOT_CONNECTED", statusCode: 409 });
  });

  it("persists credentials on connect and keeps them after disconnect", async () => {
    const fake = await startFake();
    const store = memoryStore(null);
    const service = createCalibreService(makeConfig(), { store });

    const info = await service.connect({
      baseUrl: fake.baseUrl,
      username: USERNAME,
      password: PASSWORD,
    });
    expect(info).toEqual({ connected: true, saved: true, canPush: true });
    expect(await store.loadSaved()).toEqual({
      baseUrl: fake.baseUrl,
      username: USERNAME,
      password: PASSWORD,
    });

    service.disconnect();
    expect(await service.status()).toEqual({
      connected: false,
      saved: true,
      baseUrl: fake.baseUrl,
      username: USERNAME,
    });

    const resumed = await service.resume();
    expect(resumed).toMatchObject({ connected: true, saved: true, canPush: true });
  });

  it("forgets the live connection and the saved payload", async () => {
    const fake = await startFake();
    const store = memoryStore(null);
    const service = createCalibreService(makeConfig(), { store });
    await service.connect({ baseUrl: fake.baseUrl, username: USERNAME, password: PASSWORD });

    await service.forget();

    expect(await store.loadSaved()).toBeNull();
    expect(await service.status()).toEqual({ connected: false, saved: false });
  });

  it("maps a store deletion failure to CALIBRE_CONFIG (500) without leaking the path", async () => {
    const store: CalibreStore = {
      async loadSaved() {
        return null;
      },
      async saveSaved() {
        return false;
      },
      async clearSaved() {
        throw new Error("E:/very/secret/location/calibre-connection.json");
      },
    };
    const service = createCalibreService(makeConfig(), { store });

    const error = await service.forget().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: "CalibreError", code: "CALIBRE_CONFIG", statusCode: 500 });
    expect((error as Error).message).not.toContain("secret");
    expect((error as Error).message).not.toContain("calibre-connection.json");
  });

  it("does not throw from status when the store cannot be read", async () => {
    const store: CalibreStore = {
      async loadSaved() {
        throw new Error("corrupt store");
      },
      async saveSaved() {
        return false;
      },
      async clearSaved() {
        // no-op
      },
    };
    const service = createCalibreService(makeConfig(), { store });

    expect(await service.status()).toEqual({ connected: false, saved: false });
  });
});
