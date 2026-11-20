import { describe, expect, it } from "vitest";
import { mapCalibreLanguage, parseOpdsFeed } from "../src/core/calibre/feed";

const ATOM_NS = "http://www.w3.org/2005/Atom";
const DC_NS = "http://purl.org/dc/terms/";

function feedXml(entries: string, links = ""): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<feed xmlns="${ATOM_NS}" xmlns:dc="${DC_NS}">`,
    "<title>书库</title>",
    links,
    entries,
    "</feed>",
  ].join("");
}

function acquisition(id: number, format: string): string {
  return `<link rel="http://opds-spec.org/acquisition" href="/opds/download/${id}/${format}/" type="application/octet-stream"/>`;
}

const COMPLETE_ENTRY = [
  "<entry>",
  "<id>urn:uuid:complete</id>",
  "<title>三体</title>",
  "<author><name>刘慈欣</name></author>",
  "<author><name>另一位</name></author>",
  `<dc:language>zho</dc:language>`,
  '<content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">TAGS: 科幻, 小说<p>真正的简介</p></div></content>',
  acquisition(42, "txt"),
  acquisition(42, "epub"),
  '<link rel="http://opds-spec.org/image" href="/opds/cover/42" type="image/png"/>',
  "</entry>",
].join("");

const NAVIGATION_ENTRY = [
  "<entry>",
  "<id>urn:uuid:nav</id>",
  "<title>按字母浏览</title>",
  '<link rel="subsection" href="/opds/books/letter/00" type="application/atom+xml"/>',
  "</entry>",
].join("");

const BAD_ENTRY = [
  "<entry>",
  "<id>urn:uuid:bad</id>",
  "<title>坏条目</title>",
  '<link rel="http://opds-spec.org/image" href="/opds/cover/7" type="image/png"/>',
  "</entry>",
].join("");

const NEXT_LINK = '<link rel="next" href="/opds/books/letter/00?offset=30" type="application/atom+xml"/>';

function selfLink(path: string): string {
  return `<link rel="self" href="${path}" type="application/atom+xml"/>`;
}

describe("parseOpdsFeed", () => {
  it("保留完整 entry，跳过导航与无 acquisition 的条目", () => {
    const feed = parseOpdsFeed(
      feedXml(COMPLETE_ENTRY + NAVIGATION_ENTRY + BAD_ENTRY, selfLink("/opds/new") + NEXT_LINK),
    );

    expect(feed.books).toHaveLength(1);
    expect(feed.books[0]).toEqual({
      id: 42,
      title: "三体",
      authors: ["刘慈欣", "另一位"],
      language: "zho",
      summary: "真正的简介",
      formats: ["TXT", "EPUB"],
      hasCover: true,
    });
    expect(feed.nextOffset).toBe(30);
    expect(feed.source).toBe("new");
  });

  it("解析 entry 的直接子元素 updated", () => {
    const entry = [
      "<entry>",
      "<id>urn:uuid:updated</id>",
      "<title>有时间</title>",
      "<updated>2026-02-01T08:00:00+00:00</updated>",
      '<content type="text"><updated>2026-03-01T00:00:00Z</updated></content>',
      acquisition(11, "txt"),
      "</entry>",
    ].join("");
    const feed = parseOpdsFeed(feedXml(entry));

    expect(feed.books[0]?.updated).toBe("2026-02-01T08:00:00+00:00");
  });

  it("缺少 updated 时保持 undefined", () => {
    const feed = parseOpdsFeed(feedXml(COMPLETE_ENTRY));
    expect(feed.books[0]?.updated).toBeUndefined();
  });

  it.each([
    ["/opds/new", "new"],
    ["/opds/books/letter/00", "books"],
    ["/opds/formats/txt", "format"],
    ["/opds/search/%E4%B8%89%E4%BD%93", "search"],
    ["https://books.example.com/calibre/opds/new?offset=30", "new"],
    ["/opds/", "unknown"],
  ] as const)("从 self 链接 %s 推断来源为 %s", (href, source) => {
    const feed = parseOpdsFeed(feedXml("", selfLink(href)));
    expect(feed.source).toBe(source);
  });

  it("没有 self 链接时来源为 unknown", () => {
    const feed = parseOpdsFeed(feedXml(""));
    expect(feed.source).toBe("unknown");
  });

  it("没有 next 链接时 nextOffset 为 null", () => {
    const feed = parseOpdsFeed(feedXml(COMPLETE_ENTRY));
    expect(feed.nextOffset).toBeNull();
  });

  it("nextOffset 非数字时为 null", () => {
    const feed = parseOpdsFeed(
      feedXml(COMPLETE_ENTRY, '<link rel="next" href="/opds/books/letter/00?offset=abc"/>'),
    );
    expect(feed.nextOffset).toBeNull();
  });

  it.each(["-5", "1e2", "0x10", "3.5", " 30", "30 "])(
    "nextOffset 只接受纯数字，拒绝 %s",
    (offset) => {
      const feed = parseOpdsFeed(
        feedXml(
          COMPLETE_ENTRY,
          `<link rel="next" href="/opds/books/letter/00?offset=${encodeURIComponent(offset)}"/>`,
        ),
      );
      expect(feed.nextOffset).toBeNull();
    },
  );

  it("缺少 language 时保持 undefined", () => {
    const entry =
      "<entry><id>urn:uuid:no-lang</id><title>无语言</title>" +
      "<author><name>作者</name></author>" +
      acquisition(9, "txt") +
      "</entry>";
    const feed = parseOpdsFeed(feedXml(entry));

    expect(feed.books).toHaveLength(1);
    expect(feed.books[0]?.language).toBeUndefined();
  });

  it("解码 HTML 实体", () => {
    const entry =
      "<entry><id>urn:uuid:entity</id><title>三体 &amp; 黑暗森林</title>" +
      "<author><name>A &amp; B</name></author>" +
      `<dc:language>zho</dc:language>` +
      '<content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>a &amp; b &lt;c&gt;</p></div></content>' +
      acquisition(5, "txt") +
      "</entry>";
    const feed = parseOpdsFeed(feedXml(entry));

    expect(feed.books[0]?.title).toBe("三体 & 黑暗森林");
    expect(feed.books[0]?.authors).toEqual(["A & B"]);
    expect(feed.books[0]?.summary).toBe("a & b");
  });

  it("summary 超过 5000 字被截断", () => {
    const longText = "字".repeat(6000);
    const entry =
      "<entry><id>urn:uuid:long</id><title>长简介</title>" +
      acquisition(6, "txt") +
      `<content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>${longText}</p></div></content>` +
      "</entry>";
    const feed = parseOpdsFeed(feedXml(entry));

    expect(feed.books[0]?.summary).toHaveLength(5000);
    expect(feed.books[0]?.summary).toBe("字".repeat(5000));
  });

  function summaryOf(content: string): string {
    const entry =
      "<entry><id>urn:uuid:summary</id><title>简介</title>" +
      acquisition(12, "txt") +
      content +
      "</entry>";
    return parseOpdsFeed(feedXml(entry)).books[0]?.summary ?? "";
  }

  it("多个真实 p 元素之间保留空行", () => {
    expect(
      summaryOf(
        '<content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>第一段</p><p>第二段</p></div></content>',
      ),
    ).toBe("第一段\n\n第二段");
  });

  it("保留 p 元素内部的 br 换行", () => {
    expect(
      summaryOf(
        '<content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>第一行<br/>第二行</p></div></content>',
      ),
    ).toBe("第一行\n第二行");
  });

  it("嵌套行内标签只保留文字", () => {
    expect(
      summaryOf(
        '<content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>第一<em>行</em><strong>加粗</strong></p></div></content>',
      ),
    ).toBe("第一行加粗");
  });

  it("br 后紧跟源码换行时只保留一个换行", () => {
    expect(
      summaryOf(
        '<content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>a<br/>\nb</p></div></content>',
      ),
    ).toBe("a\nb");
    expect(summaryOf('<content type="text">a&lt;br&gt;\nb</content>')).toBe("a\nb");
  });

  it("剥离文本中的字面 p 标签并保留段落空行", () => {
    expect(summaryOf('<content type="text">&lt;p&gt;第一段&lt;/p&gt;&lt;p&gt;第二段&lt;/p&gt;</content>')).toBe(
      "第一段\n\n第二段",
    );
  });

  it("解码后出现的标签同样被剥离，标签内文字保留", () => {
    expect(
      summaryOf(
        '<content type="text">&lt;script&gt;alert(1)&lt;/script&gt;&lt;font&gt;文本&lt;/font&gt;</content>',
      ),
    ).toBe("alert(1)文本");
  });

  it("把字面 br 转为单个换行", () => {
    expect(summaryOf('<content type="text">第一行&lt;br&gt;第二行</content>')).toBe(
      "第一行\n第二行",
    );
  });

  it("把字面 div 关闭标签转为空行、li 关闭标签转为换行", () => {
    expect(
      summaryOf(
        '<content type="text">&lt;div&gt;第一段&lt;/div&gt;&lt;li&gt;第二项&lt;/li&gt;</content>',
      ),
    ).toBe("第一段\n\n第二项");
  });

  it("把 CRLF 归一为换行", () => {
    expect(summaryOf('<content type="text">第一行&#13;&#10;第二行</content>')).toBe(
      "第一行\n第二行",
    );
  });

  it("折叠 3 个以上换行为一个空行", () => {
    expect(summaryOf('<content type="text">第一段\n\n\n\n第二段</content>')).toBe(
      "第一段\n\n第二段",
    );
  });

  it("没有 p 元素时也保留 div 内的 br", () => {
    expect(
      summaryOf(
        '<content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">第一行<br/>第二行</div></content>',
      ),
    ).toBe("第一行\n第二行");
  });

  it("解码字面 nbsp 与 amp 实体", () => {
    expect(summaryOf('<content type="text">A&amp;nbsp;B&amp;amp;C</content>')).toBe("A B&C");
  });

  it("没有 HTML 时保持原文", () => {
    expect(summaryOf('<content type="text">普通简介&amp;内容</content>')).toBe("普通简介&内容");
  });

  it("无法解析的 XML 返回空结果", () => {
    const feed = parseOpdsFeed("<feed><entry>");
    expect(feed).toEqual({ books: [], nextOffset: null, source: "unknown" });
  });
});

describe("mapCalibreLanguage", () => {
  it("把中文语言映射为 zh-CN", () => {
    expect(mapCalibreLanguage("zho")).toBe("zh-CN");
    expect(mapCalibreLanguage("zh")).toBe("zh-CN");
    expect(mapCalibreLanguage("chi")).toBe("zh-CN");
  });

  it("把英文语言映射为 en", () => {
    expect(mapCalibreLanguage("eng")).toBe("en");
    expect(mapCalibreLanguage("en")).toBe("en");
  });

  it("未知或缺失时回退 zh-CN", () => {
    expect(mapCalibreLanguage(undefined)).toBe("zh-CN");
    expect(mapCalibreLanguage("fra")).toBe("zh-CN");
  });
});
