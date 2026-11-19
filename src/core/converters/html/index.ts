import type { BookMeta, BookModel, Chapter, Language, Volume } from "../../../types/book";
import { bytesToDataUrl } from "../../imageDataUrl";
import { defaultLayoutFor, layoutCss, normalizeLayout } from "../../render/layout";
import { renderChapterBody, renderVolumeBody } from "../../render/renderChapter";
import { themes, type Theme } from "../../render/themes";
import {
  resolveConvertOptions,
  type BookConverter,
  type ConvertHooks,
  type ConvertOptions,
  type ExportProgress,
} from "../types";

/** 已分配锚点的章节；编号与目录中的 `chapter-N` 一致。 */
interface PlannedChapter {
  chapter: Chapter;
  number: number;
}

/** 阅读顺序中的一块：卷分组（可能有扉页）或章节。 */
type Block =
  | { kind: "volume"; volume: Volume; ordinal: number; hasPage: boolean }
  | { kind: "chapter"; entry: PlannedChapter };

/** 目录树节点：卷/番外分组带 `children`，章节点为叶子。 */
interface TocItem {
  title: string;
  href: string;
  children?: TocItem[];
}

/** 关闭卷扉页时，并入章节顶部的卷标题与卷首文字。 */
interface VolumeNote {
  title: string;
  lines: string[];
}

/** XML 1.0 / HTML 不允许的控制字符（NUL、退格、垂直制表等），脏 TXT 里常见。 */
const INVALID_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/** 转义文本节点与属性值，避免书名、章节名里的标签进入文档结构。 */
function escapeHtml(value: string): string {
  return value
    .replace(INVALID_CONTROL_CHARS, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function bookTitle(meta: BookMeta): string {
  return meta.title.trim() || "未命名";
}

/** 取中文或英文文案：用户可见字符串随书籍语言切换。 */
function labelFor(language: Language, zh: string, en: string): string {
  return language === "zh-CN" ? zh : en;
}

function chapterAnchor(number: number): string {
  return `#chapter-${number}`;
}

/**
 * 侧栏目录与全文搜索样式：桌面固定在左侧，≤900px 变为抽屉；
 * 打印时隐藏侧栏与开关，正文恢复整页宽度。
 */
const SIDEBAR_CSS = `
/* 侧栏目录与全文搜索（单文件 HTML，无外链） */
.book-sidebar-toggle {
  position: fixed;
  top: 1rem;
  left: 1rem;
  z-index: 70;
  display: none;
  padding: 0.4rem 0.8rem;
  border: 1px solid currentColor;
  border-radius: 4px;
  background: inherit;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.book-sidebar {
  position: fixed;
  top: 0;
  bottom: 0;
  left: 0;
  z-index: 60;
  box-sizing: border-box;
  width: 280px;
  padding: 1.25rem 1rem;
  overflow-y: auto;
  border-right: 1px solid currentColor;
  background: inherit;
  color: inherit;
  font-family: inherit;
}
.book-sidebar-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.book-sidebar-title {
  font-size: 1.1rem;
  letter-spacing: 0.1em;
}
.book-sidebar-close {
  padding: 0.1rem 0.5rem;
  border: 1px solid currentColor;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.book-search-label {
  display: block;
  margin: 0.9rem 0 0.3rem;
  font-size: 0.85rem;
  opacity: 0.8;
}
#book-search {
  box-sizing: border-box;
  width: 100%;
  padding: 0.45rem 0.6rem;
  border: 1px solid currentColor;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font: inherit;
}
#book-search:focus {
  outline: 2px solid currentColor;
  outline-offset: 2px;
}
.book-search-results {
  max-height: 40vh;
  margin: 0.5rem 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}
.book-search-results:empty {
  display: none;
}
.book-search-empty {
  padding: 0.4rem;
  font-size: 0.85rem;
  opacity: 0.7;
}
.book-search-result {
  display: block;
  box-sizing: border-box;
  width: 100%;
  padding: 0.4rem;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.book-search-result:hover,
.book-search-result:focus {
  background: rgba(127, 127, 127, 0.16);
}
.book-search-title {
  display: block;
  font-weight: 600;
}
.book-search-snippet {
  display: block;
  margin-top: 0.15rem;
  font-size: 0.85rem;
  line-height: 1.5;
  opacity: 0.78;
}
.book-search-snippet mark {
  background: #ffd76a;
  color: #1f2328;
}
.book-toc {
  margin-top: 0.75rem;
}
.book-toc ol {
  margin: 0;
  padding: 0;
  list-style: none;
}
.book-toc ol ol {
  margin: 0.25rem 0 0.25rem 0.8rem;
}
.book-toc li {
  margin: 0.3rem 0;
}
.book-toc a {
  color: inherit;
  text-decoration: none;
}
.book-toc a:hover,
.book-toc a:focus,
.book-toc a[aria-current="true"] {
  text-decoration: underline;
}
.book-sidebar-overlay {
  display: none;
}
@media (min-width: 901px) {
  body.txt2book {
    margin-left: 280px;
  }
  /* 桌面侧栏常驻，关闭按钮没有意义；直接隐藏，避免用户误以为可折叠。 */
  .book-sidebar-close {
    display: none;
  }
}
@media (max-width: 900px) {
  .book-sidebar-toggle {
    display: block;
  }
  .book-sidebar {
    box-shadow: 0 0 1rem rgba(0, 0, 0, 0.25);
    visibility: hidden;
    transform: translateX(-100%);
    /* 关闭动画结束后再隐藏，避免过渡期间侧栏被读屏或 Tab 命中。 */
    transition: transform 0.2s ease, visibility 0s linear 0.2s;
  }
  body.nav-open .book-sidebar {
    visibility: visible;
    transform: translateX(0);
    transition: transform 0.2s ease;
  }
  body.nav-open .book-sidebar-toggle {
    display: none;
  }
  .book-sidebar-overlay {
    position: fixed;
    inset: 0;
    z-index: 55;
    display: none;
    background: rgba(0, 0, 0, 0.45);
  }
  body.nav-open .book-sidebar-overlay {
    display: block;
  }
  body.nav-open {
    overflow: hidden;
  }
}
@media print {
  .book-sidebar,
  .book-sidebar-toggle,
  .book-sidebar-overlay {
    display: none !important;
  }
  body.txt2book {
    margin-left: 0 !important;
  }
  /* 抽屉打开时 body 会 lock 滚动；打印必须解除，否则可能只输出第一页。 */
  body {
    overflow: visible !important;
  }
}
`.trim();

/**
 * 内联搜索与抽屉脚本：章节内容只通过 `textContent` / `createTextNode`
 * 进入 DOM，搜索片段用 `createElement("mark")` 高亮，避免书名或正文注入 HTML。
 */
const SIDEBAR_SCRIPT = `
(function () {
  "use strict";

  var win = window;
  if (win.__txt2bookSidebarReady) return;
  win.__txt2bookSidebarReady = true;

  var sidebar = document.getElementById("book-sidebar");
  var toggle = document.getElementById("book-sidebar-toggle");
  var closeButton = sidebar ? sidebar.querySelector(".book-sidebar-close") : null;
  var overlay = document.getElementById("book-sidebar-overlay");
  var searchInput = document.getElementById("book-search");
  var resultsList = document.getElementById("book-search-results");
  if (!sidebar || !toggle || !searchInput || !resultsList) return;
  var emptyLabel = resultsList.getAttribute("data-empty-label") || "没有匹配结果";

  var chapterSections = document.querySelectorAll("section.chapter");
  var observedSections = document.querySelectorAll("section.chapter, section.volume-page");
  var chapters = [];
  var index;
  for (index = 0; index < chapterSections.length; index += 1) {
    var section = chapterSections[index];
    var heading = section.querySelector("h1");
    var title = heading && heading.textContent ? heading.textContent.trim() : "";
    var bodyText = section.textContent || "";
    chapters.push({
      id: section.id,
      title: title,
      titleLower: title.toLowerCase(),
      body: bodyText,
      bodyLower: bodyText.toLowerCase()
    });
  }

  function isMobileLayout() {
    if (typeof win.matchMedia === "function") {
      var query = win.matchMedia("(max-width: 900px)");
      if (query && typeof query.matches === "boolean") return query.matches;
    }
    return typeof win.innerWidth === "number" ? win.innerWidth <= 900 : false;
  }

  function applyDrawerState(open) {
    if (isMobileLayout()) {
      sidebar.setAttribute("aria-hidden", open ? "false" : "true");
      if (open) {
        sidebar.removeAttribute("inert");
      } else {
        sidebar.setAttribute("inert", "");
      }
    } else {
      // 桌面侧栏常驻，不能对读屏隐藏，也不能加 inert。
      sidebar.removeAttribute("aria-hidden");
      sidebar.removeAttribute("inert");
    }
  }

  function setOpen(open, restoreFocus) {
    var mobile = isMobileLayout();
    var next = mobile && open;
    document.body.classList.toggle("nav-open", next);
    toggle.setAttribute("aria-expanded", next ? "true" : "false");
    applyDrawerState(next);
    if (mobile && !next && restoreFocus) toggle.focus();
  }

  function closeNav(restoreFocus) {
    if (!isMobileLayout()) return;
    if (!document.body.classList.contains("nav-open")) return;
    setOpen(false, restoreFocus !== false);
  }

  function clearResults() {
    while (resultsList.firstChild) {
      resultsList.removeChild(resultsList.firstChild);
    }
  }

  function appendSnippet(container, item, term) {
    var bodyText = item.body;
    var matchIndex = term ? item.bodyLower.indexOf(term) : -1;
    var radius = 30;
    var start = matchIndex > -1 ? Math.max(0, matchIndex - radius) : 0;
    var end =
      matchIndex > -1
        ? Math.min(bodyText.length, matchIndex + term.length + radius)
        : Math.min(bodyText.length, 60);
    if (start > 0) container.appendChild(document.createTextNode("…"));
    if (matchIndex > -1) {
      container.appendChild(document.createTextNode(bodyText.slice(start, matchIndex)));
      var mark = document.createElement("mark");
      mark.textContent = bodyText.slice(matchIndex, matchIndex + term.length);
      container.appendChild(mark);
      container.appendChild(document.createTextNode(bodyText.slice(matchIndex + term.length, end)));
    } else {
      container.appendChild(document.createTextNode(bodyText.slice(start, end)));
    }
    if (end < bodyText.length) container.appendChild(document.createTextNode("…"));
  }

  function goToChapter(id) {
    var target = document.getElementById(id);
    if (!target) return;
    if (typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    try {
      if (win.history && typeof win.history.replaceState === "function") {
        win.history.replaceState(null, "", "#" + id);
      } else {
        win.location.hash = id;
      }
    } catch (error) {
      win.location.hash = id;
    }
    if (isMobileLayout()) {
      closeNav(true);
      searchInput.value = "";
      clearResults();
    }
  }

  function createResult(item, term) {
    var li = document.createElement("li");
    var button = document.createElement("button");
    button.type = "button";
    button.className = "book-search-result";
    var title = document.createElement("span");
    title.className = "book-search-title";
    title.textContent = item.title || item.id;
    var snippet = document.createElement("span");
    snippet.className = "book-search-snippet";
    appendSnippet(snippet, item, term);
    button.appendChild(title);
    button.appendChild(snippet);
    button.addEventListener("click", function () {
      goToChapter(item.id);
    });
    li.appendChild(button);
    return li;
  }

  function createEmptyResult() {
    var empty = document.createElement("li");
    empty.className = "book-search-empty";
    empty.textContent = emptyLabel;
    return empty;
  }

  function renderResults(term) {
    var query = term.toLowerCase();
    var titleMatches = [];
    var bodyMatches = [];
    var itemIndex;
    for (itemIndex = 0; itemIndex < chapters.length; itemIndex += 1) {
      var item = chapters[itemIndex];
      if (item.titleLower.indexOf(query) > -1) {
        titleMatches.push(item);
      } else if (item.bodyLower.indexOf(query) > -1) {
        bodyMatches.push(item);
      }
    }
    var matches = titleMatches.concat(bodyMatches).slice(0, 50);
    clearResults();
    if (matches.length === 0) {
      resultsList.appendChild(createEmptyResult());
      return;
    }
    for (itemIndex = 0; itemIndex < matches.length; itemIndex += 1) {
      resultsList.appendChild(createResult(matches[itemIndex], query));
    }
  }

  var timer = null;
  function scheduleSearch() {
    if (timer !== null) win.clearTimeout(timer);
    timer = win.setTimeout(function () {
      timer = null;
      var term = searchInput.value.trim();
      if (!term) {
        clearResults();
        return;
      }
      renderResults(term);
    }, 200);
  }

  toggle.addEventListener("click", function () {
    setOpen(!document.body.classList.contains("nav-open"), false);
  });
  if (closeButton) {
    closeButton.addEventListener("click", function () {
      closeNav(true);
    });
  }
  if (overlay) {
    overlay.addEventListener("click", function () {
      closeNav(true);
    });
  }
  searchInput.addEventListener("input", scheduleSearch);
  searchInput.addEventListener("search", scheduleSearch);

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" || event.key === "Esc") closeNav(true);
  });

  var tocLinks = sidebar.querySelectorAll(".book-toc a");
  for (index = 0; index < tocLinks.length; index += 1) {
    tocLinks[index].addEventListener("click", function () {
      closeNav(true);
    });
  }

  function setActiveTocLink(targetId) {
    for (var linkIndex = 0; linkIndex < tocLinks.length; linkIndex += 1) {
      var link = tocLinks[linkIndex];
      if (targetId && link.getAttribute("href") === "#" + targetId) {
        link.setAttribute("aria-current", "true");
      } else {
        link.removeAttribute("aria-current");
      }
    }
  }

  var visibleIds = {};
  if (typeof win.IntersectionObserver === "function") {
    try {
      var observer = new win.IntersectionObserver(function (entries) {
        for (var entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
          var entry = entries[entryIndex];
          if (entry.isIntersecting) {
            visibleIds[entry.target.id] = true;
          } else {
            delete visibleIds[entry.target.id];
          }
        }
        var activeId = null;
        for (var sectionIndex = 0; sectionIndex < observedSections.length; sectionIndex += 1) {
          var sectionId = observedSections[sectionIndex].id;
          if (sectionId && visibleIds[sectionId]) {
            activeId = sectionId;
            break;
          }
        }
        setActiveTocLink(activeId);
      }, { rootMargin: "-40% 0px -55% 0px", threshold: 0 });
      for (index = 0; index < observedSections.length; index += 1) {
        observer.observe(observedSections[index]);
      }
    } catch (error) {
      /* IntersectionObserver 不可用时跳过高亮。 */
      setActiveTocLink(null);
    }
  } else {
    setActiveTocLink(null);
  }

  if (typeof win.addEventListener === "function") {
    win.addEventListener("resize", function () {
      setOpen(document.body.classList.contains("nav-open"), false);
    });
  }

  // 初始化抽屉状态：移动端默认隐藏且不可聚焦，桌面端保持可见。
  setOpen(false, false);
})();
`.trim();

/** 侧栏结构：目录复用正文目录的卷/章锚点，搜索控件始终存在。 */
function sidebar(items: TocItem[], language: Language): string {
  const contents = labelFor(language, "目录", "Contents");
  const tocLabel = labelFor(language, "章节目录", "Contents");
  return [
    `<button type="button" id="book-sidebar-toggle" class="book-sidebar-toggle" aria-controls="book-sidebar" aria-expanded="false">${escapeHtml(contents)}</button>`,
    '<div id="book-sidebar-overlay" class="book-sidebar-overlay" aria-hidden="true"></div>',
    `<aside id="book-sidebar" class="book-sidebar" aria-label="${escapeHtml(labelFor(language, "侧栏", "Sidebar"))}">`,
    '<div class="book-sidebar-head">',
    `<strong class="book-sidebar-title">${escapeHtml(contents)}</strong>`,
    `<button type="button" class="book-sidebar-close" aria-label="${escapeHtml(labelFor(language, "关闭目录", "Close contents"))}">×</button>`,
    "</div>",
    `<label class="book-search-label" for="book-search">${escapeHtml(labelFor(language, "搜索", "Search"))}</label>`,
    `<input id="book-search" type="search" placeholder="${escapeHtml(labelFor(language, "搜索章节或正文", "Search chapters or text"))}" autocomplete="off" />`,
    `<ul id="book-search-results" class="book-search-results" aria-live="polite" data-empty-label="${escapeHtml(labelFor(language, "没有匹配结果", "No results found"))}"></ul>`,
    `<nav class="book-toc" aria-label="${escapeHtml(tocLabel)}">`,
    renderTocList(items),
    "</nav>",
    "</aside>",
  ].join("\n");
}

/** 按阅读顺序规划卷分组：卷首次出现时生成分组块，扉页只给真正的卷。 */
function planBlocks(
  book: BookModel,
  includeVolumePages: boolean,
  forcedVolumePages: Set<string>,
): Block[] {
  const volumeById = new Map(book.volumes.map((volume) => [volume.id, volume]));
  const volumeOrdinal = new Map(book.volumes.map((volume, index) => [volume.id, index + 1]));
  const planned: PlannedChapter[] = book.chapters.map((chapter, index) => ({
    chapter,
    number: index + 1,
  }));

  const blocks: Block[] = [];
  const emitted = new Set<string>();
  let currentVolumeId: string | null = null;

  for (const entry of planned) {
    const volumeId = entry.chapter.volumeId;
    const volume = volumeId ? volumeById.get(volumeId) : undefined;
    if (!volume) {
      // 无卷或卷已被删除的章节直接挂在根目录下，并打断当前卷分组。
      currentVolumeId = null;
    } else if (volume.id !== currentVolumeId) {
      currentVolumeId = volume.id;
      const firstAppearance = !emitted.has(volume.id);
      emitted.add(volume.id);
      blocks.push({
        kind: "volume",
        volume,
        ordinal: volumeOrdinal.get(volume.id) ?? entry.number,
        hasPage:
          firstAppearance &&
          (forcedVolumePages.has(volume.id) || (includeVolumePages && volume.kind === "volume")),
      });
    }
    blocks.push({ kind: "chapter", entry });
  }

  // 零章卷没有自己的章节承载扉页，插在它后面那个卷之前（没有则放在末尾）。
  // 即使不输出扉页也保留分组块，目录需要为它生成节点。
  book.volumes.forEach((volume, index) => {
    if (emitted.has(volume.id)) return;
    const laterVolumeIds = new Set(book.volumes.slice(index + 1).map((item) => item.id));
    const insertAt = blocks.findIndex((block) => {
      const volumeId = block.kind === "volume" ? block.volume.id : block.entry.chapter.volumeId;
      return volumeId !== null && volumeId !== undefined && laterVolumeIds.has(volumeId);
    });
    blocks.splice(insertAt === -1 ? blocks.length : insertAt, 0, {
      kind: "volume",
      volume,
      ordinal: index + 1,
      hasPage:
        volume.kind === "volume" && (includeVolumePages || forcedVolumePages.has(volume.id)),
    });
  });

  return blocks;
}

/**
 * 关闭卷扉页时按 EPUB 规则为每个有卷首文字的卷寻找承载章节：
 * 该卷首个章节 → 后续第一个章节 → 全书最后一个章节。
 * 同一章可承载多个卷的 note，按卷在 `book.volumes` 中的顺序追加。
 */
function buildVolumeNotes(book: BookModel): Map<string, VolumeNote[]> {
  const notesByChapter = new Map<string, VolumeNote[]>();
  if (book.chapters.length === 0) return notesByChapter;

  const volumeOrder = new Map(book.volumes.map((volume, index) => [volume.id, index]));
  const chapterVolumeOrder = book.chapters.map((chapter) =>
    chapter.volumeId === null ? null : (volumeOrder.get(chapter.volumeId) ?? null),
  );
  const lastChapter = book.chapters[book.chapters.length - 1];

  book.volumes.forEach((volume, index) => {
    if (volume.kind !== "volume" || !volume.lines || volume.lines.length === 0) return;

    const carrier =
      book.chapters.find((_, chapterIndex) => {
        const order = chapterVolumeOrder[chapterIndex];
        return order !== null && order >= index;
      }) ?? lastChapter;
    if (!carrier) return;

    const notes = notesByChapter.get(carrier.id) ?? [];
    notes.push({ title: volume.title, lines: volume.lines });
    notesByChapter.set(carrier.id, notes);
  });

  return notesByChapter;
}

/** 全书没有章节时，即使关闭卷扉页也必须输出扉页，否则卷首文字无处承载。 */
function findForcedVolumePages(book: BookModel, includeVolumePages: boolean): Set<string> {
  const forced = new Set<string>();
  if (includeVolumePages || book.chapters.length > 0) return forced;
  for (const volume of book.volumes) {
    if (volume.kind === "volume") forced.add(volume.id);
  }
  return forced;
}

/** 目录：卷与番外分组为一层，其下章节为二层；根级章节直接放在外层 `<ol>`。 */
function buildTocItems(blocks: Block[], knownVolumeIds: Set<string>): TocItem[] {
  const items: TocItem[] = [];
  let currentGroup: TocItem | null = null;

  const lastChapterNumber = (): number | null => {
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const block = blocks[index];
      if (block.kind === "chapter") return block.entry.number;
    }
    return null;
  };

  blocks.forEach((block, index) => {
    if (block.kind === "volume") {
      let href: string | null = null;
      if (block.hasPage) {
        href = `#volume-${block.ordinal}`;
      } else {
        // 没有扉页时指向本卷首个章节；零章卷退到后续第一个章节或全书最后一章。
        const next = blocks.slice(index + 1).find((item) => item.kind === "chapter");
        if (next && next.kind === "chapter") {
          href = chapterAnchor(next.entry.number);
        } else {
          const last = lastChapterNumber();
          if (last !== null) href = chapterAnchor(last);
        }
      }

      if (!href) {
        // 既没有扉页也没有任何章节落点，跳过该卷。
        currentGroup = null;
        return;
      }

      currentGroup = {
        title: block.volume.title,
        href,
        children: [],
      };
      items.push(currentGroup);
      return;
    }

    const entry = block.entry;
    const volumeId = entry.chapter.volumeId;
    if (volumeId === null || !knownVolumeIds.has(volumeId)) {
      // 根级章节必须断开卷分组，否则会错误地嵌套进上一卷的 <ol>。
      currentGroup = null;
    }
    const item: TocItem = {
      title: entry.chapter.title,
      href: chapterAnchor(entry.number),
    };
    if (currentGroup) {
      currentGroup.children!.push(item);
    } else {
      items.push(item);
    }
  });

  return items;
}

function renderTocList(items: TocItem[]): string {
  const lines: string[] = ["<ol>"];
  for (const item of items) {
    const href = escapeHtml(item.href);
    const title = escapeHtml(item.title);
    if (item.children && item.children.length > 0) {
      lines.push(`<li><a href="${href}">${title}</a>`);
      lines.push(renderTocList(item.children));
      lines.push("</li>");
    } else {
      lines.push(`<li><a href="${href}">${title}</a></li>`);
    }
  }
  lines.push("</ol>");
  return lines.join("\n");
}

function coverPage(book: BookModel): string | null {
  if (!book.cover) return null;
  const title = bookTitle(book.meta);
  const alt = `${title} ${labelFor(book.meta.language, "封面", "cover")}`;
  const src = bytesToDataUrl(book.cover.png, "image/png");
  return [
    '<header class="txt2book cover-page">',
    '<section class="cover" id="cover">',
    `<img class="cover-image" src="${src}" alt="${escapeHtml(alt)}">`,
    "</section>",
    "</header>",
  ].join("\n");
}

function titlePage(meta: BookMeta): string {
  const parts = [
    '<section class="title-page">',
    `<h1 class="book-title">${escapeHtml(bookTitle(meta))}</h1>`,
  ];
  const author = meta.author.trim();
  if (author) {
    parts.push(`<p class="book-author">${escapeHtml(author)}</p>`);
  }
  parts.push("</section>");
  return parts.join("\n");
}

/** 简介页：空行分隔的段落用 `paragraph-start` 标记，保留作者原始分段。 */
function descriptionPage(meta: BookMeta): string | null {
  const description = meta.description?.trim();
  if (!description) return null;

  const title = labelFor(meta.language, "简介", "Description");
  const parts = [
    '<section class="description-page">',
    `<h1 class="description-title">${escapeHtml(title)}</h1>`,
  ];

  let inParagraph = false;
  for (const rawLine of description.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (!line) {
      inParagraph = false;
      continue;
    }
    const startsParagraph = !inParagraph && parts.length > 2;
    inParagraph = true;
    const className = startsParagraph ? ' class="paragraph-start"' : "";
    parts.push(`<p${className}>${escapeHtml(line)}</p>`);
  }

  parts.push("</section>");
  return parts.join("\n");
}

function tocPage(items: TocItem[], language: Language): string {
  return [
    '<nav class="toc-page" id="toc">',
    `<h1 class="toc-title">${labelFor(language, "目录", "Contents")}</h1>`,
    renderTocList(items),
    "</nav>",
  ].join("\n");
}

function volumeNoteBlock(note: VolumeNote): string {
  const parts = [
    '<section class="volume-note-block">',
    `<h2 class="volume-title">${escapeHtml(note.title)}</h2>`,
  ];
  for (const rawLine of note.lines) {
    const line = rawLine.trim();
    if (!line) continue;
    parts.push(`<p class="volume-note">${escapeHtml(line)}</p>`);
  }
  parts.push("</section>");
  return parts.join("\n");
}

function chapterPage(entry: PlannedChapter, theme: Theme, notes: VolumeNote[] = []): string {
  const parts = [`<section class="chapter" id="chapter-${entry.number}">`];
  for (const note of notes) {
    parts.push(volumeNoteBlock(note));
  }
  parts.push(renderChapterBody(entry.chapter, theme), "</section>");
  return parts.join("\n");
}

/**
 * 生成单文件 HTML：主题、排版、封面与背景全部内联，
 * 不引用任何外部 `http(s)` 资源，可离线直接用浏览器打开。
 */
export async function buildHtml(
  book: BookModel,
  options: ConvertOptions = {},
  hooks?: ConvertHooks,
): Promise<Blob> {
  const report = (progress: ExportProgress): void => {
    hooks?.onProgress?.(progress);
  };
  report({ phase: "preparing", percent: 10, message: "正在准备 HTML 内容…" });

  const opts = resolveConvertOptions(options);
  const theme = themes[opts.themeId];
  const layout = options.layout ?? defaultLayoutFor(opts.themeId);
  const normalizedLayout = normalizeLayout(layout, opts.themeId);

  let backgroundSrc: string | undefined;
  const { background } = normalizedLayout;
  if (background.kind === "custom" && opts.themeId !== "eink") {
    backgroundSrc = bytesToDataUrl(background.custom.data, background.custom.mimeType);
  }

  const css = `${theme.css}\n\n${layoutCss(opts.themeId, normalizedLayout, { backgroundSrc })}\n\n${SIDEBAR_CSS}`;
  const forcedVolumePages = findForcedVolumePages(book, opts.includeVolumePages);
  const blocks = planBlocks(book, opts.includeVolumePages, forcedVolumePages);
  const volumeNotes = opts.includeVolumePages
    ? new Map<string, VolumeNote[]>()
    : buildVolumeNotes(book);
  const meta = book.meta;

  const body: string[] = [];
  const cover = coverPage(book);
  if (cover) body.push(cover);
  if (opts.includeTitlePage) body.push(titlePage(meta));
  const description = descriptionPage(meta);
  if (description) body.push(description);

  const tocItems = buildTocItems(blocks, new Set(book.volumes.map((volume) => volume.id)));
  // 侧栏始终生成；正文目录页仍由 includeTocPage 控制，二者共用同一批锚点。
  const sidebarHtml = sidebar(tocItems, meta.language);
  if (opts.includeTocPage) body.push(tocPage(tocItems, meta.language));

  for (const block of blocks) {
    if (block.kind === "volume") {
      if (block.hasPage) {
        body.push(renderVolumeBody(block.volume, { id: `volume-${block.ordinal}` }));
      }
      continue;
    }
    body.push(
      chapterPage(block.entry, theme, volumeNotes.get(block.entry.chapter.id) ?? []),
    );
  }

  report({ phase: "writing", percent: 80, message: "正在生成 HTML 文件…" });

  const html = [
    "<!DOCTYPE html>",
    `<html lang="${escapeHtml(meta.language)}">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(bookTitle(meta))}</title>`,
    "<style>",
    css,
    "</style>",
    "</head>",
    '<body class="txt2book">',
    sidebarHtml,
    body.join("\n"),
    "<script>",
    SIDEBAR_SCRIPT,
    "</script>",
    "</body>",
    "</html>",
    "",
  ].join("\n");

  report({ phase: "writing", percent: 100, message: "正在准备下载…" });
  return new Blob([html], { type: "text/html" });
}

export const htmlConverter: BookConverter = {
  id: "html",
  label: "HTML",
  extension: "html",
  mimeType: "text/html",
  available: true,
  runtime: "browser",
  convert: buildHtml,
};
