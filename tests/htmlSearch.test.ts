import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { buildHtml } from "../src/core/converters/html";
import type { BookModel } from "../src/types/book";

const book: BookModel = {
  meta: { title: "搜索测试", author: "作者", language: "zh-CN" },
  volumes: [{ id: "v1", title: "第一卷", kind: "volume" }],
  chapters: [
    {
      id: "c1",
      title: "江南春",
      kind: "chapter",
      lines: ["春风又绿江南岸，明月何时照我还。"],
      volumeId: "v1",
    },
    {
      id: "c2",
      title: "第二章",
      kind: "chapter",
      lines: ["另一个故事，包含关键词星光。"],
      volumeId: "v1",
    },
    {
      id: "c3",
      title: "Moonlight Sonata",
      kind: "chapter",
      lines: ["The quick brown fox jumps over the lazy dog."],
      volumeId: "v1",
    },
  ],
  cover: null,
};

const options = {
  themeId: "paper" as const,
  includeTocPage: false,
  includeVolumePages: false,
};

const xssBook: BookModel = {
  meta: { title: "安全测试", author: "作者", language: "zh-CN" },
  volumes: [],
  chapters: [
    {
      id: "c1",
      title: "<script>alert(1)</script>",
      kind: "chapter",
      lines: ["<img src=x onerror=alert(2)> 危险正文"],
      volumeId: null,
    },
  ],
  cover: null,
};

interface LoadedBook {
  window: Window;
  document: Document;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 把生成的 HTML 装进 happy-dom；脚本不依赖外部资源。 */
async function loadHtml(model: BookModel, mobile = false): Promise<LoadedBook> {
  const html = await (await buildHtml(model, options)).text();
  const window = new Window({ url: "file:///book.html" });
  if (mobile) window.innerWidth = 600;
  window.document.write(html);
  window.document.close();

  const script = /<script>([\s\S]*?)<\/script>/i.exec(html)?.[1];
  if (!script) throw new Error("generated html has no inline sidebar script");
  // happy-dom 的 document.write 不保证执行内联脚本，显式 eval；脚本自带初始化幂等守卫。
  window.eval(script);

  return { window, document: window.document as unknown as Document };
}

async function search(input: HTMLInputElement, value: string): Promise<void> {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await delay(260);
}

describe("html search", () => {
  it("finds chapter titles and body text with debounce", async () => {
    const { window, document } = await loadHtml(book);
    const input = document.getElementById("book-search") as HTMLInputElement;
    const results = document.getElementById("book-search-results") as HTMLElement;

    input.value = "关键词星光";
    input.dispatchEvent(new Event("input"));
    expect(results.querySelectorAll("li")).toHaveLength(0);

    await delay(260);
    const items = results.querySelectorAll("li");
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].textContent).toContain("第二章");
    expect(items[0].querySelector("mark")?.textContent).toBe("关键词星光");
  });

  it("matches case-insensitively and puts title matches first", async () => {
    const { document } = await loadHtml(book);
    const input = document.getElementById("book-search") as HTMLInputElement;
    const results = document.getElementById("book-search-results") as HTMLElement;

    await search(input, "MOON");
    const moonItems = results.querySelectorAll("li");
    expect(moonItems.length).toBe(1);
    expect(moonItems[0].textContent).toContain("Moonlight Sonata");

    await search(input, "QUICK");
    const bodyItems = results.querySelectorAll("li");
    expect(bodyItems.length).toBe(1);
    expect(bodyItems[0].querySelector("mark")?.textContent?.toLowerCase()).toBe("quick");
  });

  it("limits results to 50", async () => {
    const many: BookModel = {
      meta: book.meta,
      volumes: [],
      chapters: Array.from({ length: 60 }, (_, index) => ({
        id: `c${index + 1}`,
        title: `章节 ${index + 1}`,
        kind: "chapter" as const,
        lines: ["共同关键词出现在这里"],
        volumeId: null,
      })),
      cover: null,
    };
    const { document } = await loadHtml(many);
    const input = document.getElementById("book-search") as HTMLInputElement;
    const results = document.getElementById("book-search-results") as HTMLElement;

    await search(input, "共同关键词");
    expect(results.querySelectorAll("li")).toHaveLength(50);
  });

  it("closes the drawer and updates the hash when a result is clicked", async () => {
    const { window, document } = await loadHtml(book, true);
    const input = document.getElementById("book-search") as HTMLInputElement;
    const results = document.getElementById("book-search-results") as HTMLElement;
    const toggle = document.getElementById("book-sidebar-toggle") as HTMLButtonElement;

    toggle.click();
    expect(document.body.classList.contains("nav-open")).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    await search(input, "关键词星光");
    const button = results.querySelector("li button") as HTMLButtonElement;
    button.click();

    expect(document.body.classList.contains("nav-open")).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(window.location.hash).toBe("#chapter-2");
  });

  it("hides the closed mobile drawer from focus and assistive tech", async () => {
    const { document } = await loadHtml(book, true);
    const sidebar = document.getElementById("book-sidebar") as HTMLElement;
    const toggle = document.getElementById("book-sidebar-toggle") as HTMLButtonElement;

    expect(sidebar.getAttribute("aria-hidden")).toBe("true");
    expect(sidebar.hasAttribute("inert")).toBe(true);

    toggle.click();
    expect(sidebar.getAttribute("aria-hidden")).toBe("false");
    expect(sidebar.hasAttribute("inert")).toBe(false);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(sidebar.getAttribute("aria-hidden")).toBe("true");
    expect(sidebar.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(toggle);
  });

  it("keeps the query and results on desktop after choosing a result", async () => {
    const { window, document } = await loadHtml(book);
    const input = document.getElementById("book-search") as HTMLInputElement;
    const results = document.getElementById("book-search-results") as HTMLElement;

    await search(input, "关键词星光");
    const before = results.querySelectorAll("li").length;
    expect(before).toBeGreaterThan(0);

    (results.querySelector("li button") as HTMLButtonElement).click();

    expect(input.value).toBe("关键词星光");
    expect(results.querySelectorAll("li")).toHaveLength(before);
    expect(document.body.classList.contains("nav-open")).toBe(false);
    expect(window.location.hash).toBe("#chapter-2");
  });

  it("shows an empty message when nothing matches", async () => {
    const { document } = await loadHtml(book);
    const input = document.getElementById("book-search") as HTMLInputElement;
    const results = document.getElementById("book-search-results") as HTMLElement;

    await search(input, "没有这个关键词");

    const empty = results.querySelector("li.book-search-empty");
    expect(empty?.textContent).toBe("没有匹配结果");
    expect(results.querySelector("button")).toBeNull();
  });

  it("closes the drawer with Escape and the overlay", async () => {
    const { document } = await loadHtml(book, true);
    const toggle = document.getElementById("book-sidebar-toggle") as HTMLButtonElement;
    const overlay = document.getElementById("book-sidebar-overlay") as HTMLElement;

    toggle.click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.body.classList.contains("nav-open")).toBe(false);

    toggle.click();
    overlay.click();
    expect(document.body.classList.contains("nav-open")).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("renders malicious titles as text, never as executable markup", async () => {
    const { document } = await loadHtml(xssBook);
    const input = document.getElementById("book-search") as HTMLInputElement;
    const results = document.getElementById("book-search-results") as HTMLElement;
    const scriptsBefore = document.querySelectorAll("script").length;

    await search(input, "script");

    expect(results.querySelectorAll("script")).toHaveLength(0);
    expect(document.querySelectorAll("script")).toHaveLength(scriptsBefore);
    expect(results.textContent).toContain("<script>alert(1)</script>");
    expect(results.innerHTML).not.toContain("<script>alert(1)</script>");
    expect(results.querySelector("img")).toBeNull();
  });
});
