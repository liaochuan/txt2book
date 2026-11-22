// @vitest-environment node
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createCalibreService } from "../../server/lib/calibre/service";
import { createCalibreStore } from "../../server/lib/calibre/store";
import { loadConfig, type AppConfig } from "../../server/lib/config";
import {
  startCalibreFake,
  type FakeCalibre,
  type FakeCalibreBook,
  type FakeCalibreOptions,
} from "./calibreFake";

const SECRET = "s".repeat(32);
const USERNAME = "reader";
const PASSWORD = "s3cret-pass";
const EPUB_PATH = "/opds/download/1/epub/";
const EPUB_DATA = Buffer.from("fake-epub-binary", "utf8");

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

/** 默认注入的禁用存储：不读写真实文件。 */
function disabledStore() {
  return createCalibreStore({
    path: join(tmpdir(), "calibre-push-none.json"),
    key: null,
    enabled: false,
  });
}

function bookOne(overrides: Partial<FakeCalibreBook> = {}): FakeCalibreBook[] {
  return [{ id: 1, title: "三体", author: "刘慈欣", formats: ["txt"], hasEpub: false, ...overrides }];
}

async function startFake(overrides: Partial<FakeCalibreOptions> = {}): Promise<FakeCalibre> {
  const fake = await startCalibreFake({
    username: USERNAME,
    password: PASSWORD,
    books: bookOne(),
    ...overrides,
  });
  openFakes.push(fake);
  return fake;
}

async function connectedService(
  fake: FakeCalibre,
  overrides: Record<string, string> = {},
): Promise<ReturnType<typeof createCalibreService>> {
  const service = createCalibreService(makeConfig(overrides), { store: disabledStore() });
  await service.connect({ baseUrl: fake.baseUrl, username: USERNAME, password: PASSWORD });
  return service;
}

function loginPosts(fake: FakeCalibre): number {
  return fake.requests.filter((item) => item.method === "POST" && item.path === "/login").length;
}

describe("calibreService pushEpub", () => {
  it("preflights, uploads a sanitized EPUB, and verifies it via the OPDS download path", async () => {
    const fake = await startFake();
    const service = await connectedService(fake);

    await service.pushEpub(1, EPUB_DATA, "三体/黑暗森林", false);

    expect(fake.uploads).toHaveLength(1);
    const upload = fake.uploads[0];
    expect(upload.fields.book_id).toBe("1");
    expect(upload.fields.csrf_token).toBe("fake-admin-csrf-token");
    // /upload 不读取这些字段，元数据必须在上传后单独回写。
    expect(upload.fields.comments).toBeUndefined();
    expect(upload.fields["identifier-type-isbn"]).toBeUndefined();
    expect(upload.fileField).toBe("btn-upload-format");
    expect(upload.fileName).toBe("三体黑暗森林.epub");
    expect(upload.fileContentType).toBe("application/epub+zip");
    expect(upload.data?.equals(EPUB_DATA)).toBe(true);
    expect(upload.csrfHeader).toBe("fake-admin-csrf-token");

    expect(fake.metadataRestores).toHaveLength(1);
    expect(fake.metadataRestores[0]?.bookId).toBe(1);
    expect(fake.metadataRestores[0]?.fields).toMatchObject({
      csrf_token: "fake-admin-csrf-token",
      title: "三体",
      authors: "刘慈欣 & 另一位",
      rating: "4",
      tags: "科幻, 小说",
      series: "地球往事",
      series_index: "1",
      publisher: "重庆出版社",
      languages: "中文",
      comments: "第一段 & 第二段",
      "identifier-type-isbn": "isbn",
      "identifier-val-isbn": "978-7-111",
      "identifier-type-起点": "起点",
      "identifier-val-起点": "https://www.qidian.com/book/1037975901/",
    });
    const uploadIndex = fake.requests.findIndex((item) => item.path === "/upload");
    const restoreIndex = fake.requests.findIndex(
      (item) => item.method === "POST" && item.path === "/admin/book/1",
    );
    expect(uploadIndex).toBeGreaterThanOrEqual(0);
    expect(restoreIndex).toBeGreaterThan(uploadIndex);

    // 预检一次 + 上传后确认一次。
    expect(fake.requests.filter((item) => item.path === EPUB_PATH)).toHaveLength(2);
    expect(fake.requests.some((item) => item.path === "/admin/book/1")).toBe(true);
    expect(fake.requests.some((item) => item.path === "/upload")).toBe(true);
  });

  it("fails closed before upload when the edit page is unavailable", async () => {
    const fake = await startFake({ adminBookStatus: 403 });
    const service = await connectedService(fake);

    const error = await service
      .pushEpub(1, EPUB_DATA, "三体", false)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "CALIBRE_PUSH_METADATA_UNAVAILABLE",
      statusCode: 403,
    });
    expect(fake.uploads).toHaveLength(0);
    expect(fake.requests.some((item) => item.path === "/upload")).toBe(false);
  });

  it("reports metadata restore failure after the EPUB was added", async () => {
    const fake = await startFake({ metadataRestoreStatus: 500 });
    const service = await connectedService(fake);

    const error = await service
      .pushEpub(1, EPUB_DATA, "三体", false)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "CALIBRE_PUSH_METADATA_FAILED",
      statusCode: 502,
    });
    expect(fake.uploads).toHaveLength(1);
    expect(fake.metadataRestores).toHaveLength(1);
  });

  it("rejects an existing EPUB with CALIBRE_EPUB_EXISTS (409) before any upload", async () => {
    const fake = await startFake({ books: bookOne({ hasEpub: true }) });
    const service = await connectedService(fake);

    const error = await service
      .pushEpub(1, EPUB_DATA, "三体", false)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "CALIBRE_EPUB_EXISTS", statusCode: 409 });
    expect((error as Error).message).not.toContain("127.0.0.1");
    expect(fake.uploads).toHaveLength(0);
    expect(fake.requests.some((item) => item.path === "/upload")).toBe(false);
  });

  it.each([
    ["超时", { epubHeadDelayMs: 2000 }, { CALIBRE_TIMEOUT_MS: "50" }],
    ["不可达", { epubHeadDestroy: true }, {}],
    ["重定向", { epubHeadStatus: 302 }, {}],
    ["500", { epubHeadStatus: 500 }, {}],
  ] as const)(
    "fails closed with CALIBRE_PUSH_UNVERIFIED when the preflight %s cannot determine existence",
    async (_label, fakeOptions, configOverrides) => {
      const fake = await startFake(fakeOptions);
      const service = await connectedService(fake, configOverrides);

      const error = await service
        .pushEpub(1, EPUB_DATA, "三体", false)
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({ code: "CALIBRE_PUSH_UNVERIFIED", statusCode: 502 });
      expect((error as Error).message).toBe(
        "无法确认该书是否已有 EPUB，已取消上传，请检查网络后重试。",
      );
      expect(fake.uploads).toHaveLength(0);
      expect(fake.requests.some((item) => item.path === "/upload")).toBe(false);
    },
  );

  it("uploads when the preflight reports 404 (no existing EPUB)", async () => {
    const fake = await startFake();
    const service = await connectedService(fake);

    await service.pushEpub(1, EPUB_DATA, "三体", false);

    expect(fake.uploads).toHaveLength(1);
    expect(fake.requests.some((item) => item.path === "/upload")).toBe(true);
  });

  it("uploads when overwrite=true for an existing EPUB", async () => {
    const fake = await startFake({
      books: bookOne({ hasEpub: true }),
      epubContentLength: 100,
      epubContentLengthAfterUpload: 200,
    });
    const service = await connectedService(fake);

    await service.pushEpub(1, EPUB_DATA, "三体", true);

    expect(fake.uploads).toHaveLength(1);
    expect(fake.requests.filter((item) => item.path === EPUB_PATH)).toHaveLength(2);
  });

  it("reports CALIBRE_PUSH_UNAVAILABLE for a read-only connection", async () => {
    const fake = await startFake({ loginWorks: false });
    const service = createCalibreService(makeConfig(), { store: disabledStore() });
    const info = await service.connect({
      baseUrl: fake.baseUrl,
      username: USERNAME,
      password: PASSWORD,
    });
    expect(info.canPush).toBe(false);

    const error = await service
      .pushEpub(1, EPUB_DATA, "三体", false)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "CALIBRE_PUSH_UNAVAILABLE", statusCode: 403 });
    expect(fake.uploads).toHaveLength(0);
  });

  it("maps upload denials and failures to FORBIDDEN, TOO_LARGE, and UPSTREAM", async () => {
    const cases: Array<{ status: number; code: string; statusCode: number }> = [
      { status: 403, code: "CALIBRE_PUSH_FORBIDDEN", statusCode: 403 },
      { status: 413, code: "CALIBRE_TOO_LARGE", statusCode: 413 },
      { status: 500, code: "CALIBRE_UPSTREAM", statusCode: 502 },
    ];

    for (const item of cases) {
      const fake = await startFake({ uploadStatus: item.status });
      const service = await connectedService(fake);

      const error = await service
        .pushEpub(1, EPUB_DATA, "三体", false)
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({ code: item.code, statusCode: item.statusCode });
      expect((error as Error).message).not.toContain("127.0.0.1");
    }
  });

  it("releases the push lock after a failed upload", async () => {
    const fake = await startFake({ uploadStatus: 500 });
    const service = await connectedService(fake);

    const first = await service
      .pushEpub(1, EPUB_DATA, "三体", false)
      .catch((caught: unknown) => caught);
    expect(first).toMatchObject({ code: "CALIBRE_UPSTREAM" });

    const second = await service
      .pushEpub(1, EPUB_DATA, "三体", false)
      .catch((caught: unknown) => caught);
    expect(second).toMatchObject({ code: "CALIBRE_UPSTREAM" });
  });

  it("logs in again once and retries when the upload redirects to /login", async () => {
    const fake = await startFake({ uploadLoginRedirects: 1 });
    const service = await connectedService(fake);

    const before = loginPosts(fake);
    await service.pushEpub(1, EPUB_DATA, "三体", false);

    expect(fake.uploads).toHaveLength(2);
    expect(loginPosts(fake) - before).toBe(1);
    expect(fake.uploads[1]?.fields.csrf_token).toBe("fake-admin-csrf-token");
  });

  it("maps an upload that never becomes visible to CALIBRE_PUSH_UNVERIFIED", async () => {
    const fake = await startFake({ skipEpubAfterUpload: true });
    const service = await connectedService(fake);

    const error = await service
      .pushEpub(1, EPUB_DATA, "三体", false)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "CALIBRE_PUSH_UNVERIFIED", statusCode: 502 });
    expect((error as Error).message).not.toContain("127.0.0.1");
    // 预检 + 首次确认 + 300ms 后重试。
    expect(fake.requests.filter((item) => item.path === EPUB_PATH).length).toBeGreaterThanOrEqual(3);
  });

  it("treats an unchanged content-length after overwrite as unverified", async () => {
    const fake = await startFake({
      books: bookOne({ hasEpub: true }),
      epubContentLength: 100,
      epubContentLengthAfterUpload: 100,
    });
    const service = await connectedService(fake);

    const error = await service
      .pushEpub(1, EPUB_DATA, "三体", true)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "CALIBRE_PUSH_UNVERIFIED", statusCode: 502 });
  });

  it("accepts a changed content-length after overwrite", async () => {
    const fake = await startFake({
      books: bookOne({ hasEpub: true }),
      epubContentLength: 100,
      epubContentLengthAfterUpload: 200,
    });
    const service = await connectedService(fake);

    await expect(service.pushEpub(1, EPUB_DATA, "三体", true)).resolves.toBeUndefined();
  });

  it("rejects a concurrent push with CALIBRE_BUSY (429)", async () => {
    const fake = await startFake({ uploadDelayMs: 200 });
    const service = await connectedService(fake);

    const first = service.pushEpub(1, EPUB_DATA, "三体", false);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const busy = await service
      .pushEpub(1, EPUB_DATA, "三体", false)
      .catch((caught: unknown) => caught);

    expect(busy).toMatchObject({ code: "CALIBRE_BUSY", statusCode: 429 });
    await expect(first).resolves.toBeUndefined();
    expect(fake.uploads).toHaveLength(1);
  });
});
