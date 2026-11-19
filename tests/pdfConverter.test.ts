import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import ExportPanel from "../src/components/ExportPanel.vue";
import { api } from "../src/core/api";
import { converterRegistry, listConverters } from "../src/core/converters";
import { pdfConverter, type PdfExportPayload } from "../src/core/converters/pdf";
import { defaultLayoutFor } from "../src/core/render/layout";
import type { BookModel } from "../src/types/book";

const book: BookModel = {
  meta: { title: "测试书", author: "作者", language: "zh-CN" },
  volumes: [],
  chapters: [
    { id: "c1", title: "第一章", kind: "chapter", lines: ["正文"], volumeId: null },
  ],
  cover: null,
};

const layout = defaultLayoutFor("paper");

const DEFAULT_FORMAT_OPTIONS = {
  pageSize: "A4",
  margin: "normal",
  pageNumbers: true,
  includeCover: true,
  includeToc: true,
  bookmarks: true,
} as const;

type PdfConvertPayload = PdfExportPayload;

/** 直接调用 `api.exportPdf` 时用的合法请求体；测试不关心字节序列化。 */
function makePayload(): PdfExportPayload {
  return {
    book,
    layout,
    options: {
      themeId: "paper",
      includeTocPage: true,
      includeTitlePage: false,
      includeVolumePages: false,
      ...DEFAULT_FORMAT_OPTIONS,
      formatOptions: DEFAULT_FORMAT_OPTIONS,
    },
  } as unknown as PdfExportPayload;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("api.exportPdf", () => {
  it("posts the payload as JSON with the pdf accept header and returns a blob", async () => {
    const fetchMock = vi.fn(
      async (_input: string, _init?: RequestInit) =>
        new Response(new Uint8Array([37, 80, 68, 70]), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const payload = makePayload();

    const blob = await api.exportPdf(payload);

    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("application/pdf");
    const [input, init] = fetchMock.mock.calls[0];
    expect(input).toBe("/api/export/pdf");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("same-origin");
    expect(init?.headers).toMatchObject({
      "content-type": "application/json",
      accept: "application/pdf",
    });
    expect(JSON.parse(String(init?.body))).toEqual(payload);
  });

  it("forwards an abort signal", async () => {
    const fetchMock = vi.fn(
      async (_input: string, _init?: RequestInit) =>
        new Response(new Uint8Array([37]), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await api.exportPdf(makePayload(), controller.signal);

    const [, init] = fetchMock.mock.calls[0];
    expect(init?.signal).toBe(controller.signal);
  });

  it("rejects an empty PDF response instead of downloading a zero-byte file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array([]), {
            status: 200,
            headers: { "content-type": "application/pdf" },
          }),
      ),
    );

    await expect(api.exportPdf(makePayload())).rejects.toMatchObject({
      status: 200,
      code: "BAD_RESPONSE",
    });
  });

  it("rejects a non-pdf content type", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>login</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      ),
    );

    await expect(api.exportPdf(makePayload())).rejects.toMatchObject({
      status: 200,
      code: "BAD_RESPONSE",
    });
  });
});

describe("pdfConverter", () => {
  it("sends book, top-level layout and the default format options", async () => {
    const spy = vi
      .spyOn(api, "exportPdf")
      .mockResolvedValue(new Blob(["%PDF"], { type: "application/pdf" }));

    const blob = await pdfConverter.convert(book, { themeId: "paper", layout });

    expect(blob.type).toBe("application/pdf");
    expect(spy).toHaveBeenCalledTimes(1);
    const [payload] = spy.mock.calls[0] as [PdfConvertPayload];
    expect(payload.book).toEqual(book);
    expect(payload.layout).toEqual(layout);
    expect("layout" in payload.options).toBe(false);
    expect(payload.options).toMatchObject({
      themeId: "paper",
      includeTocPage: true,
      includeTitlePage: false,
      includeVolumePages: false,
      pageSize: "A4",
      margin: "normal",
      pageNumbers: true,
      includeCover: true,
      bookmarks: true,
      formatOptions: DEFAULT_FORMAT_OPTIONS,
    });
  });

  it("forwards the user's PDF options instead of the defaults", async () => {
    const spy = vi
      .spyOn(api, "exportPdf")
      .mockResolvedValue(new Blob(["%PDF"], { type: "application/pdf" }));

    await pdfConverter.convert(book, {
      themeId: "night",
      layout,
      includeTocPage: false,
      includeTitlePage: true,
      includeVolumePages: true,
      formatOptions: {
        pageSize: "A5",
        margin: "narrow",
        pageNumbers: false,
        includeCover: false,
        includeToc: false,
        bookmarks: false,
      },
    });

    const [payload] = spy.mock.calls[0] as [PdfConvertPayload];
    expect(payload.options).toMatchObject({
      themeId: "night",
      includeTocPage: false,
      includeTitlePage: true,
      includeVolumePages: true,
      pageSize: "A5",
      margin: "narrow",
      pageNumbers: false,
      includeCover: false,
      bookmarks: false,
      formatOptions: {
        pageSize: "A5",
        margin: "narrow",
        pageNumbers: false,
        includeCover: false,
        includeToc: false,
        bookmarks: false,
      },
    });
  });

  it("lets the PDF includeToc option alone control includeTocPage", async () => {
    const spy = vi
      .spyOn(api, "exportPdf")
      .mockResolvedValue(new Blob(["%PDF"], { type: "application/pdf" }));

    await pdfConverter.convert(book, {
      includeTocPage: true,
      formatOptions: { includeToc: false },
    });

    const [payload] = spy.mock.calls[0] as [PdfConvertPayload];
    expect(payload.options.includeTocPage).toBe(false);
  });

  it("accepts no/off as false booleans", async () => {
    const spy = vi
      .spyOn(api, "exportPdf")
      .mockResolvedValue(new Blob(["%PDF"], { type: "application/pdf" }));

    await pdfConverter.convert(book, {
      formatOptions: { pageNumbers: " OFF ", includeCover: "no", bookmarks: "0" },
    });

    const [payload] = spy.mock.calls[0] as [PdfConvertPayload];
    expect(payload.options.pageNumbers).toBe(false);
    expect(payload.options.includeCover).toBe(false);
    expect(payload.options.bookmarks).toBe(false);
  });

  it("base64-encodes the cover without mutating the book", async () => {
    const png = new Uint8Array(1024 * 1024);
    png[0] = 137;
    png[1] = 80;
    png[2] = 78;
    png[3] = 71;
    const withCover: BookModel = {
      ...book,
      cover: { png, width: 1200, height: 1600, sourceName: "cover.png" },
    };
    const fetchMock = vi.fn(
      async (_input: string, _init?: RequestInit) =>
        new Response(new Uint8Array([37, 80, 68, 70]), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await pdfConverter.convert(withCover, { layout });

    const [, init] = fetchMock.mock.calls[0];
    const body = String(init?.body);
    // 1MB 原始字节直接序列化会超过 13MB；base64 后仍应低于 2MB。
    expect(body.length).toBeLessThan(2 * 1024 * 1024);
    const payload = JSON.parse(body) as PdfConvertPayload;
    const sent = payload.book.cover?.png;
    expect(typeof sent).toBe("string");
    if (typeof sent !== "string") throw new Error("expected base64 cover");
    expect(sent).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    // 解码后长度不变，且前四个字节仍是 PNG 签名，服务端可直接解析。
    expect(atob(sent).length).toBe(png.length);
    expect(atob(sent).slice(0, 4)).toBe("\x89PNG");
    // 原对象保持 Uint8Array，不能被序列化过程改写。
    expect(withCover.cover?.png).toBe(png);
    expect(png[0]).toBe(137);
  });

  it("base64-encodes a custom background without mutating the layout", async () => {
    const data = new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70, 73, 70]);
    const customLayout = defaultLayoutFor("paper");
    customLayout.background = {
      kind: "custom",
      custom: {
        data,
        mimeType: "image/jpeg",
        width: 800,
        height: 600,
        fileName: "bg.jpg",
      },
    };
    const spy = vi
      .spyOn(api, "exportPdf")
      .mockResolvedValue(new Blob(["%PDF"], { type: "application/pdf" }));

    await pdfConverter.convert(book, { layout: customLayout });

    const [payload] = spy.mock.calls[0] as [PdfConvertPayload];
    expect(payload.layout).toBeDefined();
    const background = payload.layout?.background;
    if (!background || background.kind !== "custom") {
      throw new Error("expected custom background");
    }
    expect(typeof background.custom.data).toBe("string");
    expect(atob(background.custom.data).length).toBe(data.length);
    expect(customLayout.background).toMatchObject({ kind: "custom" });
    if (customLayout.background.kind !== "custom") throw new Error("expected custom background");
    expect(customLayout.background.custom.data).toBe(data);
  });

  it("is registered as a server-side converter with six options", () => {
    expect(listConverters().map((converter) => converter.id)).toContain("pdf");
    const pdf = converterRegistry.pdf;
    expect(pdf).toBeDefined();
    expect(pdf.id).toBe("pdf");
    expect(pdf.label).toBe("PDF");
    expect(pdf.extension).toBe("pdf");
    expect(pdf.mimeType).toBe("application/pdf");
    expect(pdf.available).toBe(true);
    expect(pdf.runtime).toBe("server");

    expect(pdf.options?.map((option) => option.key)).toEqual([
      "pageSize",
      "margin",
      "pageNumbers",
      "includeCover",
      "includeToc",
      "bookmarks",
    ]);
    expect(
      Object.fromEntries(pdf.options?.map((option) => [option.key, option.defaultValue]) ?? []),
    ).toEqual(DEFAULT_FORMAT_OPTIONS);
  });
});

describe("ExportPanel with PDF", () => {
  it("shows the six PDF options with their defaults when PDF is selected", async () => {
    const wrapper = mount(ExportPanel);

    await wrapper.get('[data-test="format-pdf"]').trigger("click");

    for (const key of [
      "pageSize",
      "margin",
      "pageNumbers",
      "includeCover",
      "includeToc",
      "bookmarks",
    ]) {
      expect(wrapper.find(`[data-test="format-opt-${key}"]`).exists()).toBe(true);
    }
    // 服务端格式只保留 PDF 自己的目录入口，避免两个目录开关。
    expect(wrapper.find('[data-test="opt-toc"]').exists()).toBe(false);

    expect(
      (wrapper.get('[data-test="format-opt-pageSize"]').element as HTMLSelectElement).value,
    ).toBe("A4");
    expect(
      (wrapper.get('[data-test="format-opt-margin"]').element as HTMLSelectElement).value,
    ).toBe("normal");
    for (const key of ["pageNumbers", "includeCover", "includeToc", "bookmarks"]) {
      expect(
        (wrapper.get(`[data-test="format-opt-${key}"]`).element as HTMLInputElement).checked,
      ).toBe(true);
    }

    await wrapper.get('[data-test="export"]').trigger("click");
    const events = wrapper.emitted("export");
    const payload = events?.at(-1)?.[0] as { options: { formatOptions: unknown } };
    expect(payload.options.formatOptions).toEqual(DEFAULT_FORMAT_OPTIONS);
  });

  it("warns that server-side formats send the book to the server", async () => {
    const wrapper = mount(ExportPanel);

    expect(wrapper.get('[data-test="export-hint"]').text()).toBe(
      "文件在浏览器本地生成，不会上传到服务器。",
    );

    await wrapper.get('[data-test="format-pdf"]').trigger("click");
    expect(wrapper.get('[data-test="export-hint"]').text()).toBe(
      "该格式由服务器生成，书籍内容会发送到服务器。",
    );
  });

  it("emits changed PDF values in the export payload", async () => {
    const wrapper = mount(ExportPanel);

    await wrapper.get('[data-test="format-pdf"]').trigger("click");
    await wrapper.get('[data-test="format-opt-pageSize"]').setValue("A5");
    await wrapper.get('[data-test="format-opt-margin"]').setValue("narrow");
    await wrapper.get('[data-test="format-opt-pageNumbers"]').setValue(false);
    await wrapper.get('[data-test="format-opt-includeToc"]').setValue(false);

    await wrapper.get('[data-test="export"]').trigger("click");

    const events = wrapper.emitted("export");
    const payload = events?.at(-1)?.[0] as { options: { formatOptions: unknown } };
    expect(payload.options.formatOptions).toEqual({
      pageSize: "A5",
      margin: "narrow",
      pageNumbers: false,
      includeCover: true,
      includeToc: false,
      bookmarks: true,
    });
  });

  it("restores the generic toc checkbox after switching back to a browser format", async () => {
    const wrapper = mount(ExportPanel);

    await wrapper.get('[data-test="format-pdf"]').trigger("click");
    expect(wrapper.find('[data-test="opt-toc"]').exists()).toBe(false);

    await wrapper.get('[data-test="format-epub"]').trigger("click");
    expect(wrapper.find('[data-test="opt-toc"]').exists()).toBe(true);
  });

  it("applies the PDF defaults again after switching formats", async () => {
    const wrapper = mount(ExportPanel);

    await wrapper.get('[data-test="format-pdf"]').trigger("click");
    await wrapper.get('[data-test="format-opt-pageSize"]').setValue("A5");
    await wrapper.get('[data-test="format-epub"]').trigger("click");

    expect(wrapper.find('[data-test="format-opt-pageSize"]').exists()).toBe(false);

    await wrapper.get('[data-test="format-pdf"]').trigger("click");
    expect(
      (wrapper.get('[data-test="format-opt-pageSize"]').element as HTMLSelectElement).value,
    ).toBe("A4");
  });
});
