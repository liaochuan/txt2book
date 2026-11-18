import { describe, expect, it } from "vitest";
import type { BookModel } from "../src/types/book";

describe("book model", () => {
  it("supports a book without volumes", () => {
    const book: BookModel = {
      meta: { title: "测试", author: "作者", language: "zh-CN" },
      volumes: [],
      chapters: [{ id: "c1", title: "第一章", kind: "chapter", lines: ["正文"], volumeId: null }],
      cover: null,
    };
    expect(book.chapters[0].volumeId).toBeNull();
  });
});
