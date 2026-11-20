// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  buildAllBooksPath,
  buildCoverPath,
  buildDownloadPath,
  buildFeedPath,
} from "../../server/lib/calibre/opds";
import {
  buildLoginBody,
  buildMultipartBody,
  extractCsrfToken,
  sanitizeEpubFilename,
} from "../../server/lib/calibre/login";

/** 断言回调抛出指定错误码与状态码的 CalibreError。 */
function expectCalibreError(run: () => unknown, code: string, statusCode: number): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ name: "CalibreError", code, statusCode });
}

describe("buildFeedPath", () => {
  it("defaults to the recently added feed", () => {
    expect(buildFeedPath({})).toBe("/opds/new");
  });

  it("appends offset only when it is positive", () => {
    expect(buildFeedPath({ offset: 30 })).toBe("/opds/new?offset=30");
    expect(buildFeedPath({ offset: 0 })).toBe("/opds/new");
  });

  it("builds a lowercased format feed and keeps the offset", () => {
    expect(buildFeedPath({ format: "TXT" })).toBe("/opds/formats/txt");
    expect(buildFeedPath({ format: "txt", offset: 60 })).toBe("/opds/formats/txt?offset=60");
  });

  it("encodes the search query once with encodeURIComponent and prefers it over format", () => {
    expect(buildFeedPath({ q: "三体 & 地球", format: "txt" })).toBe(
      "/opds/search/%E4%B8%89%E4%BD%93%20%26%20%E5%9C%B0%E7%90%83",
    );
    expect(buildFeedPath({ q: "a b&c" })).toBe("/opds/search/a%20b%26c");
  });

  it("ignores offset when searching and ignores a blank q", () => {
    expect(buildFeedPath({ q: "三体", offset: 30 })).toBe("/opds/search/%E4%B8%89%E4%BD%93");
    expect(buildFeedPath({ q: "   ", format: "txt" })).toBe("/opds/formats/txt");
  });

  it("rejects an invalid format with CALIBRE_INVALID_REQUEST", () => {
    for (const format of ["", "  ", "a/b", "ep ub", "toolongformat"]) {
      expectCalibreError(() => buildFeedPath({ format }), "CALIBRE_INVALID_REQUEST", 400);
    }
  });

  it("rejects an invalid offset with CALIBRE_INVALID_REQUEST", () => {
    for (const offset of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectCalibreError(() => buildFeedPath({ offset }), "CALIBRE_INVALID_REQUEST", 400);
    }
  });

  it("does not validate format when a search query wins", () => {
    expect(buildFeedPath({ q: "三体", format: "../../etc" })).toBe(
      "/opds/search/%E4%B8%89%E4%BD%93",
    );
  });
});

describe("buildAllBooksPath", () => {
  it("builds the fallback all-books path and appends a positive offset", () => {
    expect(buildAllBooksPath()).toBe("/opds/books/letter/00");
    expect(buildAllBooksPath(0)).toBe("/opds/books/letter/00");
    expect(buildAllBooksPath(30)).toBe("/opds/books/letter/00?offset=30");
  });

  it("rejects an invalid offset with CALIBRE_INVALID_REQUEST", () => {
    for (const offset of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectCalibreError(() => buildAllBooksPath(offset), "CALIBRE_INVALID_REQUEST", 400);
    }
  });
});

describe("buildDownloadPath", () => {
  it("builds a lowercased download path with a trailing slash", () => {
    expect(buildDownloadPath(12, "TXT")).toBe("/opds/download/12/txt/");
    expect(buildDownloadPath(7, "EPUB")).toBe("/opds/download/7/epub/");
  });

  it("rejects a non-positive or non-integer book id with CALIBRE_NOT_FOUND", () => {
    for (const bookId of [0, -1, 0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectCalibreError(() => buildDownloadPath(bookId, "txt"), "CALIBRE_NOT_FOUND", 404);
    }
  });

  it("rejects an invalid format with CALIBRE_INVALID_REQUEST", () => {
    for (const format of ["", "a/b", "ep ub", "toolongformat", 'x"\r\n']) {
      expectCalibreError(() => buildDownloadPath(1, format), "CALIBRE_INVALID_REQUEST", 400);
    }
  });
});

describe("buildCoverPath", () => {
  it("builds the cover path", () => {
    expect(buildCoverPath(12)).toBe("/opds/cover/12");
  });

  it("rejects a non-positive or non-integer book id with CALIBRE_NOT_FOUND", () => {
    for (const bookId of [0, -1, 0.5, 1.5, Number.NaN]) {
      expectCalibreError(() => buildCoverPath(bookId), "CALIBRE_NOT_FOUND", 404);
    }
  });
});

describe("extractCsrfToken", () => {
  it("reads an input token regardless of quote style and attribute order", () => {
    expect(extractCsrfToken('<input name="csrf_token" value="a">')).toBe("a");
    expect(extractCsrfToken('<input value="b" name="csrf_token">')).toBe("b");
    expect(extractCsrfToken("<input type='hidden' name='csrf_token' value='c'>")).toBe("c");
    expect(extractCsrfToken('<input value=unquoted name=csrf_token>')).toBe("unquoted");
  });

  it("trims the extracted value", () => {
    expect(extractCsrfToken('<input name="csrf_token" value="  a\t ">')).toBe("a");
  });

  it("falls back to the meta tag when no input carries a token", () => {
    expect(extractCsrfToken('<meta name="csrf_token" content="b">')).toBe("b");
    expect(extractCsrfToken("<meta content='b' name='csrf_token'>")).toBe("b");
  });

  it("prefers the input token over the meta token", () => {
    expect(
      extractCsrfToken('<meta name="csrf_token" content="meta"><input name="csrf_token" value="input">'),
    ).toBe("input");
  });

  it("ignores unrelated inputs and returns null when no token exists", () => {
    expect(extractCsrfToken('<input name="q" value="csrf_token">')).toBeNull();
    expect(extractCsrfToken("<html><body>no token</body></html>")).toBeNull();
    expect(extractCsrfToken("")).toBeNull();
  });
});

describe("buildLoginBody", () => {
  it("encodes the form fields in the expected order", () => {
    expect(buildLoginBody("a b", "p&=", "t")).toBe(
      "username=a+b&password=p%26%3D&remember_me=on&csrf_token=t",
    );
  });

  it("keeps an empty csrf token as an empty field", () => {
    expect(buildLoginBody("u", "p", "")).toBe(
      "username=u&password=p&remember_me=on&csrf_token=",
    );
  });
});

describe("sanitizeEpubFilename", () => {
  it("removes forbidden characters and keeps the rest", () => {
    expect(sanitizeEpubFilename('a/b:c*?"<>|d')).toBe("abcd.epub");
    expect(sanitizeEpubFilename('a/b:c*?"<>| d')).toBe("abc d.epub");
  });

  it("collapses whitespace and trims surrounding dots and spaces", () => {
    expect(sanitizeEpubFilename("  ..书名   第二部.  ")).toBe("书名 第二部.epub");
    expect(sanitizeEpubFilename("a   b\tc")).toBe("a b c.epub");
  });

  it("removes control characters", () => {
    expect(sanitizeEpubFilename("a\u0000b\u001fc")).toBe("abc.epub");
  });

  it("falls back to book.epub for an empty result", () => {
    expect(sanitizeEpubFilename("")).toBe("book.epub");
    expect(sanitizeEpubFilename("   ")).toBe("book.epub");
    expect(sanitizeEpubFilename("...")).toBe("book.epub");
    expect(sanitizeEpubFilename('/\\:*?"<>|')).toBe("book.epub");
  });

  it("keeps the filename at most 124 characters including the extension", () => {
    const result = sanitizeEpubFilename("书".repeat(200));
    expect(result.length).toBe(124);
    expect(result).toBe(`${"书".repeat(119)}.epub`);
  });
});

describe("buildMultipartBody", () => {
  const file = {
    field: "btn-upload-format",
    filename: "book.epub",
    contentType: "application/epub+zip",
    data: Buffer.from("EPUBDATA"),
  };

  it("assembles fields in insertion order followed by the file part", () => {
    const body = buildMultipartBody({
      boundary: "BOUNDARY",
      fields: { csrf_token: "tok", book_id: "12" },
      file,
    });

    expect(body.toString("utf8")).toBe(
      "--BOUNDARY\r\n" +
        'Content-Disposition: form-data; name="csrf_token"\r\n' +
        "\r\n" +
        "tok\r\n" +
        "--BOUNDARY\r\n" +
        'Content-Disposition: form-data; name="book_id"\r\n' +
        "\r\n" +
        "12\r\n" +
        "--BOUNDARY\r\n" +
        'Content-Disposition: form-data; name="btn-upload-format"; filename="book.epub"\r\n' +
        "Content-Type: application/epub+zip\r\n" +
        "\r\n" +
        "EPUBDATA\r\n" +
        "--BOUNDARY--\r\n",
    );
    expect(body.toString("utf8").endsWith("--BOUNDARY--\r\n")).toBe(true);
  });

  it("uses CRLF everywhere and preserves binary file data", () => {
    const data = Buffer.from([0x00, 0x0d, 0x0a, 0xff, 0x61]);
    const body = buildMultipartBody({
      boundary: "BOUNDARY",
      fields: { csrf_token: "tok" },
      file: { ...file, data },
    });
    const text = body.toString("latin1");

    expect(text.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
    expect(body.includes(data)).toBe(true);
  });

  it("escapes CR/LF and quotes in field names and filenames", () => {
    const body = buildMultipartBody({
      boundary: "BOUNDARY",
      fields: { 'bad"\r\nname': "v" },
      file: { ...file, field: "up\r\nload", filename: 'a"\r\nX-Injected: 1.epub' },
    });
    const text = body.toString("utf8");

    expect(text).not.toContain("\r\nX-Injected");
    expect(text).not.toContain('name="bad"');
    expect(text).toContain('name="bad%22%0D%0Aname"');
    expect(text).toContain('name="up%0D%0Aload"');
    expect(text).toContain('filename="a%22%0D%0AX-Injected: 1.epub"');
  });
});
