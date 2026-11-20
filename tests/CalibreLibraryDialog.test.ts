import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computed, ref } from "vue";
import CalibreLibraryDialog from "../src/components/CalibreLibraryDialog.vue";
import type { UseCalibre } from "../src/composables/useCalibre";
import type { BookSource } from "../src/types/book";
import type { CalibreBook, CalibreSessionInfo } from "../src/types/calibre";

const CONNECTED_INFO: CalibreSessionInfo = {
  connected: true,
  saved: true,
  baseUrl: "https://calibre.example.com",
  username: "reader",
  canPush: true,
};

const DISCONNECTED_INFO: CalibreSessionInfo = {
  connected: false,
  saved: true,
  baseUrl: "https://calibre.example.com",
  username: "reader",
};

const TXT_BOOK: CalibreBook = {
  id: 1,
  title: "第一部",
  authors: ["甲", "乙"],
  summary: "简介不应出现在列表里",
  formats: ["TXT", "EPUB"],
  hasCover: true,
};

const EPUB_BOOK: CalibreBook = {
  id: 2,
  title: "第二部",
  authors: ["丙"],
  summary: "",
  formats: ["EPUB"],
  hasCover: false,
};

const SECOND_TXT_BOOK: CalibreBook = {
  id: 3,
  title: "第三部",
  authors: ["丁"],
  summary: "",
  formats: ["TXT"],
  hasCover: false,
};

const LINKED_SOURCE: BookSource = {
  kind: "calibre-web",
  origin: "https://calibre.example.com",
  bookId: TXT_BOOK.id,
  title: TXT_BOOK.title,
  formats: ["TXT", "EPUB"],
};

function createCalibre(
  options: {
    info?: CalibreSessionInfo | null;
    books?: CalibreBook[];
    query?: string;
    txtOnly?: boolean;
    loading?: boolean;
    error?: string;
    notice?: string;
    nextOffset?: number | null;
    linked?: BookSource | null;
    canPush?: boolean;
  } = {},
) {
  const info = ref<CalibreSessionInfo | null>(options.info ?? null);
  const books = ref<CalibreBook[]>(options.books ?? []);
  const query = ref(options.query ?? "");
  const txtOnly = ref(options.txtOnly ?? false);
  const loading = ref(options.loading ?? false);
  const error = ref(options.error ?? "");
  const notice = ref(options.notice ?? "");
  const nextOffset = ref<number | null>(options.nextOffset ?? null);
  const connecting = ref(false);
  const pushing = ref(false);
  const linked = ref<BookSource | null>(options.linked ?? null);
  const linkedBook = computed<BookSource | null>(() => linked.value);
  const canPush = computed<boolean>(() => options.canPush ?? false);

  const calibre: UseCalibre = {
    info,
    books,
    query,
    txtOnly,
    loading,
    error,
    notice,
    nextOffset,
    connecting,
    pushing,
    linkedBook,
    canPush,
    loadStatus: vi.fn(async () => {}),
    connect: vi.fn(async () => true),
    resume: vi.fn(async () => true),
    disconnect: vi.fn(async () => {}),
    forget: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    loadMore: vi.fn(async () => {}),
    importBook: vi.fn(async () => true),
    push: vi.fn(async () => true),
    clearLocal: vi.fn(),
  };

  return { calibre, refs: { info, books, query, txtOnly, loading, error, notice, nextOffset } };
}

function mountDialog(calibre: UseCalibre) {
  return mount(CalibreLibraryDialog, {
    props: { calibre },
    global: { stubs: { teleport: true } },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CalibreLibraryDialog not connected", () => {
  it("prompts to connect first and opens the settings dialog", async () => {
    const { calibre } = createCalibre({ info: DISCONNECTED_INFO });
    const wrapper = mountDialog(calibre);

    expect(wrapper.get('[data-test="calibre-not-connected"]').text()).toBe(
      "请先在设置中连接 Calibre-Web",
    );
    expect(wrapper.find('[data-test="calibre-search"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="calibre-row"]').exists()).toBe(false);

    await wrapper.get('[data-test="calibre-go-settings"]').trigger("click");

    expect(wrapper.emitted("open-settings")).toHaveLength(1);
  });
});

describe("CalibreLibraryDialog search and filter", () => {
  it("refreshes the library once when opened while connected", () => {
    const { calibre } = createCalibre({ info: CONNECTED_INFO });
    mountDialog(calibre);

    expect(calibre.refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes once when the connection arrives after opening", async () => {
    const { calibre, refs } = createCalibre({ info: DISCONNECTED_INFO });
    const wrapper = mountDialog(calibre);

    expect(calibre.refresh).not.toHaveBeenCalled();

    refs.info.value = CONNECTED_INFO;
    await wrapper.vm.$nextTick();

    expect(calibre.refresh).toHaveBeenCalledTimes(1);
  });

  it("debounces the search input for 300ms before updating the query", async () => {
    vi.useFakeTimers();
    const { calibre, refs } = createCalibre({ info: CONNECTED_INFO });
    const wrapper = mountDialog(calibre);
    expect(calibre.refresh).toHaveBeenCalledTimes(1);

    await wrapper.get('[data-test="calibre-search"]').setValue("三体");
    vi.advanceTimersByTime(299);

    expect(refs.query.value).toBe("");
    expect(calibre.refresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);

    expect(refs.query.value).toBe("三体");
    expect(calibre.refresh).toHaveBeenCalledTimes(2);
  });

  it("clears the pending search timer on unmount", async () => {
    vi.useFakeTimers();
    const { calibre, refs } = createCalibre({ info: CONNECTED_INFO });
    const wrapper = mountDialog(calibre);
    expect(calibre.refresh).toHaveBeenCalledTimes(1);

    await wrapper.get('[data-test="calibre-search"]').setValue("三体");
    wrapper.unmount();
    vi.advanceTimersByTime(300);

    expect(refs.query.value).toBe("");
    expect(calibre.refresh).toHaveBeenCalledTimes(1);
  });

  it("binds the txt-only checkbox and refreshes on change", async () => {
    const { calibre, refs } = createCalibre({ info: CONNECTED_INFO });
    const wrapper = mountDialog(calibre);
    expect(calibre.refresh).toHaveBeenCalledTimes(1);

    await wrapper.get('[data-test="calibre-txt-only"]').setValue(true);

    expect(refs.txtOnly.value).toBe(true);
    expect(calibre.refresh).toHaveBeenCalledTimes(2);
  });
});

describe("CalibreLibraryDialog list", () => {
  it("renders book rows, upper-case format badges and import actions", async () => {
    const { calibre } = createCalibre({
      info: CONNECTED_INFO,
      books: [TXT_BOOK, EPUB_BOOK],
    });
    const wrapper = mountDialog(calibre);

    const rows = wrapper.findAll('[data-test="calibre-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.text()).toContain("第一部");
    expect(rows[0]?.text()).toContain("甲、乙");
    expect(rows[0]?.text()).not.toContain("简介不应出现在列表里");
    expect(rows[0]?.findAll('[data-test="calibre-format"]').map((badge) => badge.text())).toEqual([
      "TXT",
      "EPUB",
    ]);

    const importButtons = rows.map((row) => row.get('[data-test="calibre-import"]'));
    expect(importButtons[0]?.attributes("disabled")).toBeUndefined();
    expect(importButtons[1]?.attributes("disabled")).toBeDefined();
    expect(rows[1]?.get('[data-test="calibre-no-txt"]').text()).toBe("无 TXT");

    await importButtons[0]?.trigger("click");
    await flushPromises();

    expect(calibre.importBook).toHaveBeenCalledWith(TXT_BOOK);
  });

  it("emits imported then close after a successful import", async () => {
    const { calibre } = createCalibre({ info: CONNECTED_INFO, books: [TXT_BOOK] });
    const wrapper = mountDialog(calibre);

    await wrapper.get('[data-test="calibre-import"]').trigger("click");
    await flushPromises();

    expect(wrapper.emitted("imported")).toEqual([[TXT_BOOK]]);
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("stays open and shows the error when the import fails", async () => {
    const { calibre, refs } = createCalibre({ info: CONNECTED_INFO, books: [TXT_BOOK] });
    vi.mocked(calibre.importBook).mockImplementationOnce(async () => {
      refs.error.value = "TXT 下载失败";
      return false;
    });
    const wrapper = mountDialog(calibre);

    await wrapper.get('[data-test="calibre-import"]').trigger("click");
    await flushPromises();

    expect(wrapper.emitted("imported")).toBeUndefined();
    expect(wrapper.emitted("close")).toBeUndefined();
    expect(wrapper.get('[data-test="calibre-error"]').text()).toBe("TXT 下载失败");
  });

  it("disables all rows while one import is in progress", async () => {
    let resolveImport: ((value: boolean) => void) | undefined;
    const { calibre } = createCalibre({
      info: CONNECTED_INFO,
      books: [TXT_BOOK, SECOND_TXT_BOOK],
    });
    vi.mocked(calibre.importBook).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveImport = resolve;
        }),
    );
    const wrapper = mountDialog(calibre);

    await wrapper.findAll('[data-test="calibre-import"]')[0].trigger("click");
    await wrapper.vm.$nextTick();

    const button = wrapper.findAll('[data-test="calibre-import"]')[0];
    expect(button.text()).toBe("导入中…");
    expect(button.attributes("disabled")).toBeDefined();

    const other = wrapper.findAll('[data-test="calibre-import"]')[1];
    expect(other.text()).toBe("导入");
    expect(other.attributes("disabled")).toBeDefined();

    resolveImport?.(true);
    await flushPromises();

    expect(wrapper.emitted("imported")).toHaveLength(1);
  });

  it("shows load more only while another page exists", async () => {
    const { calibre, refs } = createCalibre({
      info: CONNECTED_INFO,
      books: [TXT_BOOK],
      nextOffset: 50,
    });
    const wrapper = mountDialog(calibre);

    await wrapper.get('[data-test="calibre-load-more"]').trigger("click");
    expect(calibre.loadMore).toHaveBeenCalledTimes(1);

    refs.nextOffset.value = null;
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-test="calibre-load-more"]').exists()).toBe(false);
  });

  it("shows loading, error, notice and empty states", async () => {
    const { calibre, refs } = createCalibre({ info: CONNECTED_INFO });
    const wrapper = mountDialog(calibre);

    expect(wrapper.get('[data-test="calibre-empty"]').text()).toContain("没有可显示的书");

    refs.loading.value = true;
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-test="calibre-loading"]').text()).toContain("正在加载书库");
    expect(wrapper.find('[data-test="calibre-empty"]').exists()).toBe(false);

    refs.loading.value = false;
    refs.error.value = "书库加载失败";
    refs.notice.value = "连续 3 页没有含 TXT 的图书";
    await wrapper.vm.$nextTick();

    expect(wrapper.get('[data-test="calibre-error"]').attributes("role")).toBe("alert");
    expect(wrapper.get('[data-test="calibre-error"]').text()).toBe("书库加载失败");
    expect(wrapper.get('[data-test="calibre-notice"]').attributes("role")).toBe("status");
    expect(wrapper.get('[data-test="calibre-notice"]').text()).toBe(
      "连续 3 页没有含 TXT 的图书",
    );
    expect(wrapper.find('[data-test="calibre-empty"]').exists()).toBe(false);
  });

  it("disables load more while loading", () => {
    const { calibre } = createCalibre({
      info: CONNECTED_INFO,
      books: [TXT_BOOK],
      nextOffset: 50,
      loading: true,
    });
    const wrapper = mountDialog(calibre);

    expect(wrapper.get('[data-test="calibre-load-more"]').attributes("disabled")).toBeDefined();
  });
});

describe("CalibreLibraryDialog linked book", () => {
  it("marks the linked book and shows the push hint", () => {
    const { calibre } = createCalibre({
      info: CONNECTED_INFO,
      books: [TXT_BOOK, EPUB_BOOK],
      linked: LINKED_SOURCE,
      canPush: true,
    });
    const wrapper = mountDialog(calibre);

    expect(wrapper.get('[data-test="calibre-linked-book"]').text()).toContain(TXT_BOOK.title);
    expect(wrapper.find('[data-test="calibre-push-hint"]').exists()).toBe(true);

    const rows = wrapper.findAll('[data-test="calibre-row"]');
    expect(rows[0]?.find('[data-test="calibre-linked"]').text()).toBe("已关联");
    expect(rows[1]?.find('[data-test="calibre-linked"]').exists()).toBe(false);
  });

  it("warns when the linked book comes from another instance", () => {
    const { calibre } = createCalibre({
      info: { ...CONNECTED_INFO, baseUrl: "https://other.example.com" },
      books: [TXT_BOOK],
      linked: LINKED_SOURCE,
      canPush: true,
    });
    const wrapper = mountDialog(calibre);

    expect(wrapper.get('[data-test="calibre-other-instance"]').text()).toBe(
      "当前书籍来自另一个 Calibre-Web 实例",
    );
    expect(wrapper.find('[data-test="calibre-push-hint"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="calibre-linked"]').exists()).toBe(false);
  });
});
