import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/core/api";
import { useBookSession, type BookSession } from "../src/composables/useBookSession";
import { useCalibre, type CalibreClient } from "../src/composables/useCalibre";
import type { BookSource, CoverAsset } from "../src/types/book";
import type { CalibreBook, CalibreSessionInfo } from "../src/types/calibre";
import type { ImportBytesOptions, SourceEncoding } from "../src/composables/useImport";

const ATOM_NS = "http://www.w3.org/2005/Atom";
const DC_NS = "http://purl.org/dc/terms/";
const BASE_URL = "https://books.example.com/calibre";
const ORIGIN = "https://books.example.com";

const CONNECTED: CalibreSessionInfo = {
  connected: true,
  saved: true,
  baseUrl: BASE_URL,
  username: "reader",
  canPush: true,
};

const COVER: CoverAsset = {
  png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  width: 2,
  height: 3,
};

const SOURCE_TXT: BookSource = {
  kind: "calibre-web",
  origin: ORIGIN,
  bookId: 42,
  title: "三体",
  formats: ["TXT"],
};

type FeedInput = { offset?: number; q?: string; format?: string };

function feedXml(entries: string, nextOffset?: number, self = ""): string {
  const next =
    nextOffset === undefined
      ? ""
      : `<link rel="next" href="/opds/books/letter/00?offset=${nextOffset}" type="application/atom+xml"/>`;
  const selfLink =
    self === "" ? "" : `<link rel="self" href="${self}" type="application/atom+xml"/>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<feed xmlns="${ATOM_NS}" xmlns:dc="${DC_NS}">`,
    "<title>书库</title>",
    selfLink,
    next,
    entries,
    "</feed>",
  ].join("");
}

function emptyFeed(): string {
  return feedXml("");
}

function entryXml(
  id: number,
  formats: string[],
  title = `书 ${id}`,
  options: { cover?: boolean; updated?: string } = {},
): string {
  const links = formats
    .map(
      (format) =>
        `<link rel="http://opds-spec.org/acquisition" href="/opds/download/${id}/${format.toLowerCase()}/" type="application/octet-stream"/>`,
    )
    .join("");
  const cover = options.cover
    ? `<link rel="http://opds-spec.org/image" href="/opds/cover/${id}" type="image/png"/>`
    : "";
  const updated =
    options.updated === undefined ? "" : `<updated>${options.updated}</updated>`;
  return [
    "<entry>",
    `<id>urn:uuid:${id}</id>`,
    `<title>${title}</title>`,
    `<author><name>作者${id}</name></author>`,
    updated,
    `<dc:language>zho</dc:language>`,
    links,
    cover,
    "</entry>",
  ].join("");
}

function page(ids: number[], nextOffset?: number): string {
  return feedXml(ids.map((id) => entryXml(id, ["TXT"])).join(""), nextOffset);
}

function book(overrides: Partial<CalibreBook> = {}): CalibreBook {
  return {
    id: 42,
    title: "三体",
    authors: ["刘慈欣"],
    language: "zho",
    summary: "简介",
    formats: ["TXT", "EPUB"],
    hasCover: true,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setup(overrides: Partial<CalibreClient> = {}) {
  const session = useBookSession();
  const importBytes = vi.fn(
    async (
      _bytes: Uint8Array,
      _name: string,
      _encoding: SourceEncoding,
      _options?: ImportBytesOptions,
    ) => true,
  );
  const prepare = vi.fn(async (_blob: Blob, _sourceName?: string): Promise<CoverAsset> => COVER);

  const client: CalibreClient = {
    status: vi.fn(async () => CONNECTED),
    connect: vi.fn(async () => CONNECTED),
    reconnect: vi.fn(async () => CONNECTED),
    disconnect: vi.fn(async () => undefined),
    forget: vi.fn(async () => undefined),
    feed: vi.fn(async (_input: FeedInput) => emptyFeed()),
    textFile: vi.fn(async () => new Blob([new TextEncoder().encode("第一章 开始\n正文")])),
    cover: vi.fn(async () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])])),
    push: vi.fn(async () => undefined),
    ...overrides,
  };

  const confirm = vi.fn<(message: string) => boolean>(() => true);
  const calibre = useCalibre({
    session,
    importer: { importBytes },
    cover: { prepare },
    client,
    confirm,
  });

  return { session, calibre, client, confirm, importBytes, prepare };
}

function linkSource(session: BookSession, source: BookSource = SOURCE_TXT): void {
  session.loadBook(
    { title: source.title, author: "", language: "zh-CN" },
    { volumes: [], chapters: [] },
    source.title,
    { source },
  );
}

function connectedSource(overrides: Partial<BookSource> = {}): BookSource {
  return { ...SOURCE_TXT, ...overrides };
}

describe("useCalibre", () => {
  describe("connect", () => {
    it("saves info, clears the old list and loads the first page", async () => {
      const feed = vi.fn(async (_input: FeedInput) => page([7]));
      const { calibre, client } = setup({ feed });

      calibre.books.value = [book({ id: 99 })];
      const ok = await calibre.connect({
        baseUrl: BASE_URL,
        username: "reader",
        password: "secret",
      });

      expect(ok).toBe(true);
      expect(calibre.info.value).toEqual(CONNECTED);
      expect(calibre.books.value.map((item) => item.id)).toEqual([7]);
      expect(feed).toHaveBeenCalledTimes(1);
      expect(feed).toHaveBeenCalledWith({ offset: 0 });
      expect(calibre.connecting.value).toBe(false);
      expect(calibre.loading.value).toBe(false);
      expect(calibre.error.value).toBe("");
      expect(client.connect).toHaveBeenCalledWith({
        baseUrl: BASE_URL,
        username: "reader",
        password: "secret",
      });
    });

    it("sets an error and returns false when connecting fails", async () => {
      const connect = vi.fn(async () => {
        throw new ApiError(400, "CALIBRE_AUTH_FAILED", "账号或密码错误");
      });
      const { calibre } = setup({ connect });

      const ok = await calibre.connect({ baseUrl: BASE_URL, username: "u", password: "bad" });

      expect(ok).toBe(false);
      expect(calibre.info.value).toBeNull();
      expect(calibre.error.value).toBe("calibre-web 账号或密码错误。");
      expect(calibre.connecting.value).toBe(false);
    });
  });

  describe("loadStatus", () => {
    it("resumes once and loads the first page when credentials are saved", async () => {
      const status = vi.fn(async () => ({
        connected: false,
        saved: true,
        baseUrl: BASE_URL,
        username: "reader",
      }));
      const reconnect = vi.fn(async () => CONNECTED);
      const feed = vi.fn(async (_input: FeedInput) => page([5]));
      const { calibre } = setup({ status, reconnect, feed });

      await calibre.loadStatus();

      expect(reconnect).toHaveBeenCalledTimes(1);
      expect(calibre.info.value).toEqual(CONNECTED);
      expect(calibre.books.value.map((item) => item.id)).toEqual([5]);
      expect(feed).toHaveBeenCalledWith({ offset: 0 });
    });

    it("keeps saved=true and reports an error when automatic resume fails", async () => {
      const status = vi.fn(async () => ({
        connected: false,
        saved: true,
        baseUrl: BASE_URL,
        username: "reader",
      }));
      const reconnect = vi.fn(async () => {
        throw new ApiError(400, "CALIBRE_AUTH_FAILED", "账号或密码错误");
      });
      const feed = vi.fn(async (_input: FeedInput) => page([5]));
      const { calibre } = setup({ status, reconnect, feed });

      await calibre.loadStatus();

      expect(reconnect).toHaveBeenCalledTimes(1);
      expect(calibre.info.value?.saved).toBe(true);
      expect(calibre.info.value?.connected).toBe(false);
      expect(calibre.error.value).toBe("calibre-web 账号或密码错误。");
      expect(feed).not.toHaveBeenCalled();
    });

    it("does not repopulate info or books when status resolves after clearLocal", async () => {
      const pendingStatus = deferred<CalibreSessionInfo>();
      const status = vi.fn(() => pendingStatus.promise);
      const feed = vi.fn(async (_input: FeedInput) => page([1]));
      const { calibre } = setup({ status, feed });

      const pending = calibre.loadStatus();
      calibre.clearLocal();
      pendingStatus.resolve(CONNECTED);
      await pending;

      expect(calibre.info.value).toBeNull();
      expect(calibre.books.value).toEqual([]);
      expect(calibre.nextOffset.value).toBeNull();
      expect(feed).not.toHaveBeenCalled();
    });

    it("marks connecting while auto-resuming and clears it afterwards", async () => {
      const pendingReconnect = deferred<CalibreSessionInfo>();
      const status = vi.fn(async () => ({
        connected: false,
        saved: true,
        baseUrl: BASE_URL,
        username: "reader",
      }));
      const reconnect = vi.fn(() => pendingReconnect.promise);
      const feed = vi.fn(async (_input: FeedInput) => page([5]));
      const { calibre } = setup({ status, reconnect, feed });

      const pending = calibre.loadStatus();
      await vi.waitFor(() => {
        expect(calibre.connecting.value).toBe(true);
      });

      pendingReconnect.resolve(CONNECTED);
      await pending;

      expect(calibre.connecting.value).toBe(false);
      expect(calibre.info.value).toEqual(CONNECTED);
    });

    it("clears the resuming state when resume fails or is superseded by logout", async () => {
      const failing = deferred<CalibreSessionInfo>();
      const reconnect = vi.fn(() => failing.promise);
      const { calibre } = setup({ reconnect });
      calibre.info.value = { connected: false, saved: true, baseUrl: BASE_URL };

      const pending = calibre.resume();
      expect(calibre.connecting.value).toBe(true);

      failing.reject(new ApiError(502, "CALIBRE_UNREACHABLE", "unreachable"));
      await pending;

      expect(calibre.connecting.value).toBe(false);
      expect(calibre.info.value?.saved).toBe(true);

      const pendingAgain = calibre.resume();
      expect(calibre.connecting.value).toBe(true);
      calibre.clearLocal();
      expect(calibre.connecting.value).toBe(false);
      await pendingAgain;
      expect(calibre.connecting.value).toBe(false);
      expect(calibre.info.value).toBeNull();
    });
  });

  describe("refresh and loadMore", () => {
    it("filters books without TXT and advances while pages stay empty", async () => {
      // 第一页完全被过滤，第二页命中后停止。
      const feed = vi.fn(async (input: FeedInput) => {
        if (input.offset === 0) {
          return feedXml(entryXml(1, ["EPUB"]) + entryXml(2, ["EPUB"]), 30);
        }
        return feedXml(entryXml(3, ["TXT"]), 60);
      });
      const { calibre } = setup({ feed });
      calibre.txtOnly.value = true;

      await calibre.refresh();

      expect(feed.mock.calls.map(([input]) => input)).toEqual([
        { offset: 0, format: "txt" },
        { offset: 30, format: "txt" },
      ]);
      expect(calibre.books.value.map((item) => item.id)).toEqual([3]);
      expect(calibre.nextOffset.value).toBe(60);
      expect(calibre.loading.value).toBe(false);
    });

    it("stops after three empty pages and shows a notice", async () => {
      const feed = vi.fn(async (input: FeedInput) => {
        const offset = input.offset ?? 0;
        return feedXml(entryXml(offset + 1, ["EPUB"]), offset + 30);
      });
      const { calibre } = setup({ feed });
      calibre.txtOnly.value = true;

      await calibre.refresh();

      expect(feed).toHaveBeenCalledTimes(3);
      expect(feed.mock.calls.map(([input]) => input.offset)).toEqual([0, 30, 60]);
      expect(calibre.books.value).toEqual([]);
      expect(calibre.nextOffset.value).toBe(90);
      expect(calibre.notice.value).not.toBe("");
      expect(calibre.loading.value).toBe(false);
      expect(calibre.error.value).toBe("");
    });

    it("keeps all books and does not request a format when txtOnly is off", async () => {
      const feed = vi.fn(async (_input: FeedInput) =>
        feedXml(entryXml(1, ["EPUB"]) + entryXml(2, ["TXT"])),
      );
      const { calibre } = setup({ feed });

      await calibre.refresh();

      expect(feed).toHaveBeenCalledWith({ offset: 0 });
      expect(calibre.books.value.map((item) => item.id)).toEqual([1, 2]);
    });

    it("retries without format when the server reports CALIBRE_FORMAT_UNAVAILABLE", async () => {
      const feed = vi
        .fn<(input: FeedInput) => Promise<string>>()
        .mockRejectedValueOnce(new ApiError(404, "CALIBRE_FORMAT_UNAVAILABLE", "格式不可用"))
        .mockResolvedValueOnce(feedXml(entryXml(1, ["EPUB"]) + entryXml(2, ["TXT"])));
      const { calibre } = setup({ feed });
      calibre.txtOnly.value = true;

      await calibre.refresh();

      expect(feed.mock.calls.map(([input]) => input)).toEqual([
        { offset: 0, format: "txt" },
        { offset: 0 },
      ]);
      expect(calibre.books.value.map((item) => item.id)).toEqual([2]);
      expect(calibre.error.value).toBe("");
    });

    it("appends the next page without dropping the current list", async () => {
      const feed = vi.fn(async (input: FeedInput) =>
        input.offset === 0 ? feedXml(entryXml(1, ["TXT"]), 30) : feedXml(entryXml(2, ["TXT"])),
      );
      const { calibre } = setup({ feed });

      await calibre.refresh();
      await calibre.loadMore();

      expect(feed.mock.calls.map(([input]) => input.offset)).toEqual([0, 30]);
      expect(calibre.books.value.map((item) => item.id)).toEqual([1, 2]);
      expect(calibre.nextOffset.value).toBeNull();
    });

    it("sorts a books feed page by updated desc without a query", async () => {
      const entries = [
        entryXml(1, ["TXT"], "旧", { updated: "2026-01-01T00:00:00Z" }),
        entryXml(2, ["TXT"], "新", { updated: "2026-03-01T00:00:00Z" }),
        entryXml(3, ["TXT"], "无时间"),
        entryXml(4, ["TXT"], "坏时间", { updated: "not-a-date" }),
        entryXml(5, ["TXT"], "中间", { updated: "2026-02-01T00:00:00Z" }),
      ].join("");
      const feed = vi.fn(async (_input: FeedInput) =>
        feedXml(entries, 30, "/opds/books/letter/00"),
      );
      const { calibre } = setup({ feed });

      await calibre.refresh();

      expect(calibre.books.value.map((item) => item.id)).toEqual([2, 5, 1, 3, 4]);
      expect(calibre.nextOffset.value).toBe(30);
    });

    it("keeps the upstream order of a new feed", async () => {
      const entries = [
        entryXml(1, ["TXT"], "旧", { updated: "2026-01-01T00:00:00Z" }),
        entryXml(2, ["TXT"], "新", { updated: "2026-03-01T00:00:00Z" }),
      ].join("");
      const feed = vi.fn(async (_input: FeedInput) => feedXml(entries, undefined, "/opds/new"));
      const { calibre } = setup({ feed });

      await calibre.refresh();

      expect(calibre.books.value.map((item) => item.id)).toEqual([1, 2]);
    });

    it("keeps a books feed order when a query is active", async () => {
      const entries = [
        entryXml(1, ["TXT"], "旧", { updated: "2026-01-01T00:00:00Z" }),
        entryXml(2, ["TXT"], "新", { updated: "2026-03-01T00:00:00Z" }),
      ].join("");
      const feed = vi.fn(async (_input: FeedInput) =>
        feedXml(entries, undefined, "/opds/books/letter/00"),
      );
      const { calibre } = setup({ feed });

      calibre.query.value = "三体";
      await calibre.refresh();

      expect(calibre.books.value.map((item) => item.id)).toEqual([1, 2]);
      expect(feed).toHaveBeenCalledWith(expect.objectContaining({ q: "三体" }));
    });
  });

  describe("importBook", () => {
    it("downloads text, prepares the cover and imports with calibre metadata", async () => {
      const coverBlob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]);
      const textFile = vi.fn(async () => new Blob([new TextEncoder().encode("正文")]));
      const cover = vi.fn(async () => coverBlob);
      const { calibre, importBytes, prepare } = setup({ textFile, cover });
      await calibre.loadStatus();

      const target = book({
        id: 7,
        title: "a/b:c",
        authors: ["刘慈欣", "另一位"],
        language: "zho",
        summary: "第一段\n第二段",
        formats: ["TXT", "EPUB"],
        hasCover: true,
      });

      const ok = await calibre.importBook(target);

      expect(ok).toBe(true);
      expect(textFile).toHaveBeenCalledWith(7);
      expect(cover).toHaveBeenCalledWith(7);
      expect(prepare).toHaveBeenCalledWith(coverBlob);
      expect(importBytes).toHaveBeenCalledTimes(1);

      const [bytes, filename, encoding, options] = importBytes.mock.calls[0];
      expect(Array.from(bytes)).toEqual(Array.from(new TextEncoder().encode("正文")));
      expect(filename).toBe("abc.txt");
      expect(encoding).toBe("auto");
      expect(options?.meta).toEqual({
        title: "a/b:c",
        author: "刘慈欣、另一位",
        language: "zh-CN",
        description: "　　第一段\n　　第二段",
      });
      expect(options?.source).toEqual({
        kind: "calibre-web",
        origin: ORIGIN,
        bookId: 7,
        title: "a/b:c",
        formats: ["TXT", "EPUB"],
      });
      expect(options?.cover).toBe(COVER);

      const order = [
        textFile.mock.invocationCallOrder[0],
        cover.mock.invocationCallOrder[0],
        prepare.mock.invocationCallOrder[0],
        importBytes.mock.invocationCallOrder[0],
      ];
      expect(order).toEqual([...order].sort((a, b) => a - b));
    });

    it("imports without a cover and falls back to a safe file name", async () => {
      const cover = vi.fn(async () => new Blob(["x"]));
      const { calibre, importBytes, prepare } = setup({ cover });
      await calibre.loadStatus();

      const ok = await calibre.importBook(
        book({ id: 8, title: "///", hasCover: false, formats: ["TXT"] }),
      );

      expect(ok).toBe(true);
      expect(cover).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
      expect(importBytes.mock.calls[0][1]).toBe("book.txt");
      expect(importBytes.mock.calls[0][3]?.cover).toBeNull();
    });

    it("keeps importing when the cover download or conversion fails", async () => {
      const cover = vi.fn(async () => {
        throw new ApiError(502, "CALIBRE_UNREACHABLE", "无法连接");
      });
      const { calibre, importBytes, prepare } = setup({ cover });
      await calibre.loadStatus();

      const ok = await calibre.importBook(book({ id: 9, hasCover: true }));

      expect(ok).toBe(true);
      expect(prepare).not.toHaveBeenCalled();
      expect(importBytes).toHaveBeenCalledTimes(1);
      expect(importBytes.mock.calls[0][3]?.cover).toBeNull();
      expect(calibre.notice.value).not.toBe("");
      expect(calibre.error.value).toBe("");
    });

    it("refuses to import while disconnected", async () => {
      const textFile = vi.fn(async () => new Blob(["x"]));
      const { calibre } = setup({ textFile });
      calibre.info.value = null;

      const ok = await calibre.importBook(book());

      expect(ok).toBe(false);
      expect(textFile).not.toHaveBeenCalled();
      expect(calibre.error.value).not.toBe("");
    });

    it("shows the imported title after a successful import", async () => {
      const { calibre } = setup();
      await calibre.loadStatus();

      const ok = await calibre.importBook(book({ id: 7, title: "三体" }));

      expect(ok).toBe(true);
      expect(calibre.notice.value).toBe("已从 Calibre-Web 导入「三体」");
    });

    it("drops a deferred import after clearLocal and leaves the session empty", async () => {
      const pendingText = deferred<Blob>();
      const textFile = vi.fn(() => pendingText.promise);
      const { calibre, session, importBytes } = setup({ textFile });
      await calibre.loadStatus();

      const pendingImport = calibre.importBook(book());
      calibre.clearLocal();
      pendingText.resolve(new Blob([new TextEncoder().encode("正文")]));

      await expect(pendingImport).resolves.toBe(false);
      expect(importBytes).not.toHaveBeenCalled();
      expect(session.book.value.source).toBeNull();
      expect(session.book.value.chapters).toEqual([]);
      expect(calibre.info.value).toBeNull();
    });
  });

  describe("push", () => {
    it("pushes with overwrite=false and records the EPUB format", async () => {
      const push = vi.fn(async () => undefined);
      const { calibre, session } = setup({ push });
      await calibre.loadStatus();
      linkSource(session);
      const blob = new Blob(["epub"], { type: "application/epub+zip" });

      const ok = await calibre.push(blob, "三体.epub");

      expect(ok).toBe(true);
      expect(push).toHaveBeenCalledTimes(1);
      expect(push).toHaveBeenCalledWith(42, blob, "三体.epub", false);
      expect(session.book.value.source?.formats).toEqual(["TXT", "EPUB"]);
      expect(calibre.pushing.value).toBe(false);
      expect(calibre.error.value).toBe("");
    });

    it("asks for confirmation and retries with overwrite=true when the EPUB exists", async () => {
      const push = vi
        .fn<(id: number, blob: Blob, filename: string, overwrite: boolean) => Promise<void>>()
        .mockRejectedValueOnce(new ApiError(409, "CALIBRE_EPUB_EXISTS", "该书已有 EPUB"))
        .mockResolvedValueOnce(undefined);
      const { calibre, session, confirm } = setup({ push });
      await calibre.loadStatus();
      linkSource(session);
      const blob = new Blob(["epub"]);

      const ok = await calibre.push(blob, "三体.epub");

      expect(ok).toBe(true);
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(String(confirm.mock.calls[0][0])).toContain("覆盖");
      expect(push.mock.calls.map((call) => call[3])).toEqual([false, true]);
      expect(session.book.value.source?.formats).toEqual(["TXT", "EPUB"]);
    });

    it("does not retry when the overwrite confirmation is rejected", async () => {
      const push = vi
        .fn<(id: number, blob: Blob, filename: string, overwrite: boolean) => Promise<void>>()
        .mockRejectedValueOnce(new ApiError(409, "CALIBRE_EPUB_EXISTS", "该书已有 EPUB"));
      const { calibre, session, confirm } = setup({ push });
      confirm.mockReturnValue(false);
      await calibre.loadStatus();
      linkSource(session);

      const ok = await calibre.push(new Blob(["epub"]), "三体.epub");

      expect(ok).toBe(false);
      expect(push).toHaveBeenCalledTimes(1);
      expect(calibre.notice.value).toBe("已取消推送");
      expect(session.book.value.source?.formats).toEqual(["TXT"]);
      expect(calibre.pushing.value).toBe(false);
    });

    it("maps CALIBRE_PUSH_FORBIDDEN to a Chinese error", async () => {
      const push = vi.fn(async () => {
        throw new ApiError(403, "CALIBRE_PUSH_FORBIDDEN", "forbidden");
      });
      const { calibre, session } = setup({ push });
      await calibre.loadStatus();
      linkSource(session);

      const ok = await calibre.push(new Blob(["epub"]), "三体.epub");

      expect(ok).toBe(false);
      expect(calibre.error.value).toBe(
        "该账号没有上传权限，或 calibre-web 未开启上传功能。",
      );
      expect(calibre.pushing.value).toBe(false);
    });
  });

  describe("canPush", () => {
    it("requires a connection, push permission, a linked source and a matching origin", async () => {
      const { calibre, session } = setup();
      await calibre.loadStatus();
      linkSource(session);

      expect(calibre.canPush.value).toBe(true);

      calibre.info.value = { ...CONNECTED, canPush: false };
      expect(calibre.canPush.value).toBe(false);

      calibre.info.value = { ...CONNECTED, baseUrl: "https://other.example.com/calibre" };
      expect(calibre.canPush.value).toBe(false);

      calibre.info.value = { ...CONNECTED };
      session.loadBook(
        { title: "三体", author: "", language: "zh-CN" },
        { volumes: [], chapters: [] },
        "三体",
        { source: connectedSource({ origin: "https://other.example.com" }) },
      );
      expect(calibre.canPush.value).toBe(false);

      calibre.info.value = { ...CONNECTED, connected: false };
      expect(calibre.canPush.value).toBe(false);
    });

    it("is false without a linked book", async () => {
      const { calibre } = setup();
      await calibre.loadStatus();

      expect(calibre.canPush.value).toBe(false);
    });
  });

  describe("disconnect and forget", () => {
    it("suppresses automatic resume until an explicit connect", async () => {
      const status = vi
        .fn<() => Promise<CalibreSessionInfo>>()
        .mockResolvedValueOnce(CONNECTED)
        .mockResolvedValue({ connected: false, saved: true, baseUrl: BASE_URL, username: "reader" });
      const reconnect = vi.fn(async () => CONNECTED);
      const feed = vi.fn(async (_input: FeedInput) => page([1]));
      const { calibre } = setup({ status, reconnect, feed });

      await calibre.loadStatus();
      expect(calibre.books.value).toHaveLength(1);

      await calibre.disconnect();

      expect(calibre.info.value?.connected).toBe(false);
      expect(calibre.info.value?.saved).toBe(true);
      expect(calibre.books.value).toEqual([]);
      expect(calibre.nextOffset.value).toBeNull();

      await calibre.loadStatus();
      expect(reconnect).not.toHaveBeenCalled();
      expect(calibre.books.value).toEqual([]);
    });

    it("falls back to saved=true when status cannot be refreshed after disconnect", async () => {
      const status = vi.fn(async () => CONNECTED);
      const { calibre } = setup({ status });
      await calibre.loadStatus();
      status.mockRejectedValue(new ApiError(502, "CALIBRE_UNREACHABLE", "unreachable"));

      await calibre.disconnect();

      expect(calibre.info.value).toEqual({ connected: false, saved: true });
      expect(calibre.books.value).toEqual([]);
    });

    it("clears info and books on forget", async () => {
      const status = vi.fn(async () => CONNECTED);
      const feed = vi.fn(async (_input: FeedInput) => page([1]));
      const forget = vi.fn(async () => undefined);
      const { calibre } = setup({ status, feed, forget });

      await calibre.loadStatus();
      expect(calibre.books.value).toHaveLength(1);

      await calibre.forget();

      expect(forget).toHaveBeenCalledTimes(1);
      expect(calibre.info.value).toEqual({ connected: false, saved: false });
      expect(calibre.books.value).toEqual([]);
      expect(calibre.nextOffset.value).toBeNull();
    });
  });

  describe("clearLocal", () => {
    it("resets local state without touching the session book and allows resume again", async () => {
      const status = vi
        .fn<() => Promise<CalibreSessionInfo>>()
        .mockResolvedValueOnce(CONNECTED)
        .mockResolvedValue({ connected: false, saved: true, baseUrl: BASE_URL });
      const reconnect = vi.fn(async () => CONNECTED);
      const feed = vi.fn(async (_input: FeedInput) => page([1]));
      const { calibre, session } = setup({ status, reconnect, feed });

      await calibre.loadStatus();
      linkSource(session);
      calibre.error.value = "旧错误";
      calibre.notice.value = "旧提示";

      calibre.clearLocal();

      expect(calibre.info.value).toBeNull();
      expect(calibre.books.value).toEqual([]);
      expect(calibre.nextOffset.value).toBeNull();
      expect(calibre.error.value).toBe("");
      expect(calibre.notice.value).toBe("");
      expect(session.book.value.source).toEqual(SOURCE_TXT);

      await calibre.loadStatus();
      expect(reconnect).toHaveBeenCalledTimes(1);
    });
  });

  describe("stale responses", () => {
    it("drops a page that resolves after clearLocal", async () => {
      const pendingPage = deferred<string>();
      const feed = vi.fn((_input: FeedInput) => pendingPage.promise);
      const { calibre } = setup({ feed });

      const pending = calibre.refresh();
      expect(calibre.loading.value).toBe(true);

      calibre.clearLocal();
      expect(calibre.loading.value).toBe(false);

      pendingPage.resolve(page([1], 30));
      await pending;

      expect(calibre.books.value).toEqual([]);
      expect(calibre.nextOffset.value).toBeNull();
      expect(calibre.notice.value).toBe("");
    });

    it("drops a page that resolves after disconnect", async () => {
      const pendingPage = deferred<string>();
      const feed = vi.fn((_input: FeedInput) => pendingPage.promise);
      const status = vi.fn(async () => ({
        connected: false,
        saved: true,
        baseUrl: BASE_URL,
      }));
      const { calibre } = setup({ feed, status });

      calibre.info.value = CONNECTED;
      const pending = calibre.refresh();
      await calibre.disconnect();

      pendingPage.resolve(page([1], 30));
      await pending;

      expect(calibre.info.value?.connected).toBe(false);
      expect(calibre.books.value).toEqual([]);
      expect(calibre.nextOffset.value).toBeNull();
    });

    it("runs a new refresh after clearLocal resets the loading latch", async () => {
      const firstPage = deferred<string>();
      const feed = vi
        .fn<(input: FeedInput) => Promise<string>>()
        .mockImplementationOnce(() => firstPage.promise)
        .mockResolvedValueOnce(page([2]));
      const { calibre } = setup({ feed });

      const first = calibre.refresh();
      calibre.clearLocal();
      const second = calibre.refresh();

      await second;

      expect(feed).toHaveBeenCalledTimes(2);
      expect(calibre.books.value.map((item) => item.id)).toEqual([2]);

      firstPage.resolve(page([1], 30));
      await first;

      expect(calibre.books.value.map((item) => item.id)).toEqual([2]);
      expect(calibre.nextOffset.value).toBeNull();
      expect(calibre.loading.value).toBe(false);
    });

    it("lets a second refresh supersede the first", async () => {
      const firstPage = deferred<string>();
      const secondPage = deferred<string>();
      const feed = vi
        .fn<(input: FeedInput) => Promise<string>>()
        .mockImplementationOnce(() => firstPage.promise)
        .mockImplementationOnce(() => secondPage.promise);
      const { calibre } = setup({ feed });

      const first = calibre.refresh();
      const second = calibre.refresh();
      expect(feed).toHaveBeenCalledTimes(2);
      expect(calibre.loading.value).toBe(true);

      firstPage.resolve(page([1], 30));
      await first;

      expect(calibre.books.value).toEqual([]);
      expect(calibre.nextOffset.value).toBeNull();
      expect(calibre.loading.value).toBe(true);

      secondPage.resolve(page([2], 60));
      await second;

      expect(calibre.books.value.map((item) => item.id)).toEqual([2]);
      expect(calibre.nextOffset.value).toBe(60);
      expect(calibre.loading.value).toBe(false);
    });
  });

  describe("error mapping", () => {
    it.each([
      ["CALIBRE_AUTH_FAILED", "calibre-web 账号或密码错误。"],
      ["CALIBRE_TIMEOUT", "calibre-web 响应超时，请稍后重试。"],
      ["CALIBRE_TOO_LARGE", "calibre-web 响应内容过大。"],
      ["CALIBRE_UNREACHABLE", "无法连接 calibre-web 服务。"],
    ])("maps %s to a fixed Chinese message", async (code, message) => {
      const connect = vi.fn(async () => {
        throw new ApiError(400, code, "upstream detail");
      });
      const { calibre } = setup({ connect });

      await calibre.connect({ baseUrl: BASE_URL, username: "u", password: "p" });

      expect(calibre.error.value).toBe(message);
    });

    it("marks the session disconnected when CALIBRE_NOT_CONNECTED is returned", async () => {
      const feed = vi.fn(async (_input: FeedInput) => {
        throw new ApiError(409, "CALIBRE_NOT_CONNECTED", "not connected");
      });
      const { calibre } = setup({ feed });

      await calibre.loadStatus();

      expect(calibre.error.value).toBe("尚未连接 calibre-web，请先配置连接。");
      expect(calibre.info.value?.connected).toBe(false);
    });

    it("keeps a Chinese ApiError message and hides non-Chinese details", async () => {
      const chinese = vi.fn(async () => {
        throw new ApiError(502, "CALIBRE_UPSTREAM", "calibre-web 服务返回了异常响应。");
      });
      const first = setup({ connect: chinese });
      await first.calibre.connect({ baseUrl: BASE_URL, username: "u", password: "p" });
      expect(first.calibre.error.value).toBe("calibre-web 服务返回了异常响应。");

      const raw = vi.fn(async () => {
        throw new ApiError(502, "SOMETHING", "boom");
      });
      const second = setup({ connect: raw });
      await second.calibre.connect({ baseUrl: BASE_URL, username: "u", password: "p" });
      expect(second.calibre.error.value).toBe("操作失败，请稍后重试。");
    });
  });
});
