import { afterEach, describe, expect, it, vi } from "vitest";
import { buildEpub } from "../src/core/converters/epub";
import { buildHtml } from "../src/core/converters/html";
import { buildPdf } from "../src/core/converters/pdf";
import { buildTxt } from "../src/core/converters/txt";
import type { ConvertHooks, ExportProgress } from "../src/core/converters/types";
import type { BookModel } from "../src/types/book";

const book: BookModel = {
  meta: { title: "进度测试", author: "作者", language: "zh-CN" },
  volumes: [{ id: "v1", title: "第一卷", kind: "volume" }],
  chapters: [
    { id: "c1", title: "第一章", kind: "chapter", lines: ["正文一"], volumeId: "v1" },
    { id: "c2", title: "第二章", kind: "chapter", lines: ["正文二"], volumeId: "v1" },
  ],
  cover: null,
};

/** 收集转换器上报的所有进度事件。 */
function collect(): { events: ExportProgress[]; hooks: ConvertHooks } {
  const events: ExportProgress[] = [];
  return {
    events,
    hooks: {
      onProgress: (progress) => events.push({ ...progress }),
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("导出进度上报", () => {
  it("EPUB 以 preparing 开始，generating 单调不减并最终 writing 100", async () => {
    const { events, hooks } = collect();

    await buildEpub(book, {}, hooks);

    expect(events[0]).toMatchObject({ phase: "preparing", percent: 0 });
    const generating = events.filter((event) => event.phase === "generating");
    expect(generating.length).toBeGreaterThan(0);
    for (const [index, event] of generating.entries()) {
      expect(event.percent).not.toBeNull();
      expect(event.percent!).toBeGreaterThanOrEqual(0);
      expect(event.percent!).toBeLessThanOrEqual(100);
      if (index > 0) {
        expect(event.percent!).toBeGreaterThanOrEqual(generating[index - 1]!.percent!);
      }
      expect(event.message).toContain(`${event.percent}%`);
    }
    expect(events[events.length - 1]).toMatchObject({ phase: "writing", percent: 100 });
  });

  it("HTML 依次上报 preparing 10 → writing 80 → writing 100", async () => {
    const { events, hooks } = collect();

    await buildHtml(book, {}, hooks);

    expect(events.map(({ phase, percent }) => ({ phase, percent }))).toEqual([
      { phase: "preparing", percent: 10 },
      { phase: "writing", percent: 80 },
      { phase: "writing", percent: 100 },
    ]);
    expect(events[events.length - 1]!.message).toBe("正在准备下载…");
  });

  it("TXT 依次上报 preparing 10 → writing 80 → writing 100", async () => {
    const { events, hooks } = collect();

    await buildTxt(book, {}, hooks);

    expect(events.map(({ phase, percent }) => ({ phase, percent }))).toEqual([
      { phase: "preparing", percent: 10 },
      { phase: "writing", percent: 80 },
      { phase: "writing", percent: 100 },
    ]);
    expect(events[events.length - 1]!.message).toBe("正在准备下载…");
  });

  it("PDF 先上报不确定进度，响应后上报 downloading 100", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array([37, 80, 68, 70]), {
            status: 200,
            headers: { "content-type": "application/pdf" },
          }),
      ),
    );
    const { events, hooks } = collect();

    await buildPdf(book, {}, hooks);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ phase: "generating", percent: null });
    expect(events[0]!.message).toContain("可能需要几十秒");
    expect(events[1]).toMatchObject({ phase: "downloading", percent: 100 });
  });

  it("PDF 在序列化失败前已上报进度，并把错误继续抛出", async () => {
    const source: BookModel = { ...book, cover: null };
    Object.defineProperty(source, "cover", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("封面序列化失败");
      },
    });
    const { events, hooks } = collect();

    await expect(buildPdf(source, {}, hooks)).rejects.toThrow("封面序列化失败");
    expect(events).toEqual([
      {
        phase: "generating",
        percent: null,
        message: "正在生成 PDF，可能需要几十秒…",
      },
    ]);
  });

  it("未提供 hooks 时不报错且仍返回文件", async () => {
    const blob = await buildHtml(book);
    expect(blob.type).toBe("text/html");
  });
});
