import { enableAutoUnmount, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App.vue";
import ChapterTree from "../src/components/ChapterTree.vue";
import { useAuth } from "../src/composables/useAuth";
import { useBookSession } from "../src/composables/useBookSession";
import { converterRegistry } from "../src/core/converters";
import type { ConvertOptions } from "../src/core/converters/types";
import { defaultLayoutFor } from "../src/core/render/layout";
import type { BookModel, ThemeId } from "../src/types/book";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 登录态接口用固定的 `/api/auth/me` 响应替代真实服务端。 */
function stubSessionApi(authenticated: boolean, username = "admin"): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (input === "/api/auth/me") return jsonResponse({ authenticated, username });
      if (input === "/api/auth/logout") return new Response(null, { status: 204 });
      return jsonResponse({ error: { code: "NOT_FOUND", message: "未找到" } }, 404);
    }),
  );
}

/** 两章、无卷的最小书籍，供装配用例使用。 */
function seedSession(title = "测试书") {  const session = useBookSession();
  session.loadBook(
    { title, author: "作者", language: "zh-CN" },
    {
      volumes: [],
      chapters: [
        { id: "c1", title: "第一章", kind: "chapter", lines: ["甲"], volumeId: null },
        { id: "c2", title: "第二章", kind: "chapter", lines: ["乙"], volumeId: null },
      ],
    },
    title,
  );
  return session;
}

/** 三章、无卷的书籍，用于验证多次删除后的撤销失效。 */
function seedThree() {
  const session = useBookSession();
  session.loadBook(
    { title: "测试书", author: "作者", language: "zh-CN" },
    {
      volumes: [],
      chapters: [
        { id: "c1", title: "第一章", kind: "chapter", lines: ["甲"], volumeId: null },
        { id: "c2", title: "第二章", kind: "chapter", lines: ["乙"], volumeId: null },
        { id: "c3", title: "第三章", kind: "chapter", lines: ["丙"], volumeId: null },
      ],
    },
    "测试书",
  );
  return session;
}

/** 带一个卷、两章的书籍，用于卷扉页预览用例。 */
function seedVolumeBook() {
  const session = useBookSession();
  session.loadBook(
    { title: "卷书", author: "作者", language: "zh-CN" },
    {
      volumes: [{ id: "v1", title: "第一卷 风起", kind: "volume", lines: ["卷首文字。"] }],
      chapters: [
        { id: "c1", title: "第一章 入卷", kind: "chapter", lines: ["入卷正文。"], volumeId: "v1" },
        { id: "c2", title: "第二章 同行", kind: "chapter", lines: ["同行正文。"], volumeId: "v1" },
      ],
    },
    "卷书",
  );
  return session;
}

const themeStore = new Map<string, string>();

/** 在存储里预置一个自定义背景，模拟从上次会话恢复的排版配置。 */
function seedCustomBackground(themeId: ThemeId = "paper"): void {
  const layout = defaultLayoutFor(themeId);
  themeStore.set(
    `txt2book.layout.${themeId}`,
    JSON.stringify({
      typography: layout.typography,
      background: {
        kind: "custom",
        custom: {
          data: "AQID",
          mimeType: "image/png",
          width: 1,
          height: 1,
          fileName: "bg.png",
        },
      },
    }),
  );
}

/** `useAuth` 是模块级单例：每个用例开始前复位，避免依赖执行顺序。 */
function resetAuth(): void {
  const auth = useAuth();
  auth.clearSession();
  // 上一个用例若留下未完成的 check()，checking 可能是 true。
  auth.checking.value = false;
}

beforeEach(() => {
  resetAuth();
  themeStore.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => themeStore.get(key) ?? null,
    setItem: (key: string, value: string) => {
      themeStore.set(key, value);
    },
    removeItem: (key: string) => {
      themeStore.delete(key);
    },
    clear: () => {
      themeStore.clear();
    },
  });
});

// 每个用例结束后卸载组件：注销全局 401 回调、清理定时器与 DOM。
enableAutoUnmount(afterEach);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** happy-dom 没有实现对象 URL；测试里替换成可断言的桩并允许恢复原描述符。 */
function stubObjectUrl() {
  const createObjectURL = vi.fn(() => "blob:mock");
  const revokeObjectURL = vi.fn();
  const original = {
    create: Object.getOwnPropertyDescriptor(URL, "createObjectURL"),
    revoke: Object.getOwnPropertyDescriptor(URL, "revokeObjectURL"),
  };
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: createObjectURL,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: revokeObjectURL,
  });
  return {
    createObjectURL,
    revokeObjectURL,
    restore(): void {
      if (original.create) Object.defineProperty(URL, "createObjectURL", original.create);
      else Reflect.deleteProperty(URL, "createObjectURL");
      if (original.revoke) Object.defineProperty(URL, "revokeObjectURL", original.revoke);
      else Reflect.deleteProperty(URL, "revokeObjectURL");
    },
  };
}

/** 跑通一次导出所需的桩：转换器、对象 URL 与下载点击；返回捕获到的文件名。 */
function stubExport(): { downloads: string[]; restore(): void } {
  const converter = converterRegistry.epub;
  const originalConvert = converter.convert;
  converter.convert = vi.fn(
    async (_book: BookModel, _options?: ConvertOptions) =>
      new Blob(["zip"], { type: "application/epub+zip" }),
  );

  const urls = stubObjectUrl();
  const downloads: string[] = [];
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });

  return {
    downloads,
    restore(): void {
      converter.convert = originalConvert;
      click.mockRestore();
      urls.restore();
    },
  };
}

/** 触发一次导出后冲刷微任务；配合假定时器使用。 */
async function settle(wrapper: VueWrapper): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
    await wrapper.vm.$nextTick();
  }
}

/**
 * 以给定书名跑一次导出并返回下载文件名。
 * `downloadBlob` 会挂一个 1s 的 revoke 定时器，这里在收尾时推进假时间释放它。
 */
async function exportWithTitle(title: string): Promise<string> {
  stubSessionApi(true);
  const exportStub = stubExport();
  const wrapper = mount(App, { props: { session: seedSession(title) } });
  await vi.waitFor(() =>
    expect(wrapper.find('[data-test="workspace"]').exists()).toBe(true),
  );

  vi.useFakeTimers();
  try {
    await wrapper.get('[data-test="export"]').trigger("click");
    await settle(wrapper);
    expect(exportStub.downloads).toHaveLength(1);
    return exportStub.downloads[0]!;
  } finally {
    vi.advanceTimersByTime(1000);
    vi.useRealTimers();
    exportStub.restore();
  }
}

describe("App", () => {
  it("shows a pending state instead of the login card during the session check", async () => {
    let release: (response: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      ),
    );
    const wrapper = mount(App);

    try {
      expect(wrapper.get('[data-test="auth-pending"]').text()).toContain("正在验证登录状态");
      expect(wrapper.find("form.login-card").exists()).toBe(false);
    } finally {
      // 无论断言是否失败都释放挂起的请求，避免污染后续用例。
      release(jsonResponse({ authenticated: false }));
    }

    await vi.waitFor(() => expect(wrapper.find("form.login-card").exists()).toBe(true));
    expect(wrapper.find('[data-test="auth-pending"]').exists()).toBe(false);
  });

  it("shows the login view when the session check fails", async () => {
    stubSessionApi(false);
    const wrapper = mount(App);

    await vi.waitFor(() => expect(wrapper.find("form.login-card").exists()).toBe(true));
    expect(wrapper.find('[data-test="workspace"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="logout"]').exists()).toBe(false);
  });

  it("shows the three-column workspace after the session check succeeds", async () => {
    stubSessionApi(true);
    const wrapper = mount(App, { props: { session: seedSession() } });

    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="workspace"]').exists()).toBe(true),
    );

    expect(wrapper.find("main.app-shell").exists()).toBe(true);
    expect(wrapper.get(".header-user").text()).toContain("admin");
    expect(wrapper.find('[data-test="logout"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="chapter-row"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="preview-pane"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="theme-picker"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="rules-panel"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="export-panel"]').exists()).toBe(true);
    expect(wrapper.find("form.login-card").exists()).toBe(false);
  });

  it("keeps the preview and the tree selection in sync", async () => {
    stubSessionApi(true);
    const session = seedSession();
    const wrapper = mount(App, { props: { session } });

    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="workspace"]').exists()).toBe(true),
    );
    expect(session.selectedId.value).toBe("c1");

    await wrapper.get('[data-test="preview-next"]').trigger("click");

    expect(session.selectedId.value).toBe("c2");
  });

  it("previews a volume page from the tree and returns to a chapter", async () => {
    stubSessionApi(true);
    const session = seedVolumeBook();
    const wrapper = mount(App, { props: { session } });

    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="workspace"]').exists()).toBe(true),
    );

    await wrapper.get(".volume-name").trigger("click");

    expect(session.selectedVolumeId.value).toBe("v1");
    const volumeDoc = wrapper.get('[data-test="preview-iframe"]').attributes("srcdoc") ?? "";
    expect(volumeDoc).toContain('<h1 class="volume-title">第一卷 风起</h1>');
    expect(volumeDoc).toContain("卷首文字。");
    expect(volumeDoc).not.toContain("入卷正文。");

    await wrapper.findAll('[data-test="chapter-row"] .chapter-title')[1].trigger("click");

    expect(session.selectedVolumeId.value).toBeNull();
    expect(session.selectedId.value).toBe("c2");
    const chapterDoc = wrapper.get('[data-test="preview-iframe"]').attributes("srcdoc") ?? "";
    expect(chapterDoc).toContain("第二章 同行");
    expect(chapterDoc).toContain("同行正文。");
    expect(chapterDoc).not.toContain("卷首文字。");
  });

  it("deselects the volume when its name is clicked again", async () => {
    stubSessionApi(true);
    const session = seedVolumeBook();
    const wrapper = mount(App, { props: { session } });

    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="workspace"]').exists()).toBe(true),
    );

    const volumeName = () => wrapper.findAll('[data-test="volume"]')[0].get(".volume-name");

    await volumeName().trigger("click");
    expect(session.selectedVolumeId.value).toBe("v1");
    expect(session.selectedId.value).toBeNull();

    await volumeName().trigger("click");

    expect(session.selectedVolumeId.value).toBeNull();
    expect(session.selectedId.value).toBe("c1");
    const chapterDoc = wrapper.get('[data-test="preview-iframe"]').attributes("srcdoc") ?? "";
    expect(chapterDoc).toContain("第一章 入卷");
    expect(chapterDoc).toContain("入卷正文。");
  });

  it("toasts a chapter deletion and restores it through undo", async () => {
    stubSessionApi(true);
    const session = seedSession();
    const wrapper = mount(App, { props: { session } });

    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="workspace"]').exists()).toBe(true),
    );

    await wrapper.findAll('[data-test="delete-chapter"]')[0].trigger("click");

    expect(session.book.value.chapters).toHaveLength(1);
    const toast = wrapper.get(".toast");
    expect(toast.text()).toContain("撤销");

    await toast.get(".toast-action").trigger("click");

    expect(session.book.value.chapters).toHaveLength(2);
    expect(wrapper.find(".toast").exists()).toBe(false);
  });

  it("refuses to undo an older delete after later edits", async () => {
    stubSessionApi(true);
    const session = seedThree();
    const wrapper = mount(App, { props: { session } });

    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="workspace"]').exists()).toBe(true),
    );

    const deleteFirstRow = async (): Promise<void> => {
      await wrapper.findAll('[data-test="delete-chapter"]')[0].trigger("click");
    };
    await deleteFirstRow();
    await deleteFirstRow();

    expect(session.book.value.chapters).toHaveLength(1);
    expect(wrapper.findAll(".toast")).toHaveLength(2);

    // 较早的 toast 对应第一次删除，此时版本已被第二次删除推进。
    await wrapper.findAll(".toast")[0].get(".toast-action").trigger("click");

    expect(session.book.value.chapters).toHaveLength(1);
    expect(wrapper.get(".toast-error").text()).toContain("该操作已被后续编辑覆盖，无法撤销");

    // 较新的 toast 仍能撤销，恢复到两次删除之前。
    await wrapper.findAll(".toast-action")[0].trigger("click");

    expect(session.book.value.chapters).toHaveLength(2);
  });

  it("returns to the login view and toasts when a request gets 401", async () => {
    let authenticated = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (input !== "/api/auth/me") return new Response(null, { status: 204 });
        return authenticated
          ? jsonResponse({ authenticated: true, username: "admin" })
          : jsonResponse({ error: { code: "UNAUTHORIZED", message: "请先登录" } }, 401);
      }),
    );
    const session = seedSession();
    const wrapper = mount(App, { props: { session } });

    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="workspace"]').exists()).toBe(true),
    );

    authenticated = false;
    await useAuth().check();

    await vi.waitFor(() => expect(wrapper.find("form.login-card").exists()).toBe(true));
    expect(wrapper.get(".toast-error").text()).toContain(
      "登录已失效，当前书籍已清空，请重新登录。",
    );
    expect(wrapper.find('[data-test="workspace"]').exists()).toBe(false);
    // 与登出行为一致：会话失效后书籍、书名与撤销历史一并清空。
    expect(session.book.value.chapters).toEqual([]);
    expect(session.book.value.meta.title).toBe("");
    expect(session.canUndo.value).toBe(false);
  });

  it("clears the book when a cover request gets 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (input === "/api/auth/me") {
          return jsonResponse({ authenticated: true, username: "admin" });
        }
        if (input === "/api/cover/from-url") {
          return jsonResponse(
            { error: { code: "UNAUTHORIZED", message: "请先登录" } },
            401,
          );
        }
        return new Response(null, { status: 204 });
      }),
    );
    const session = seedSession();
    const wrapper = mount(App, { props: { session } });

    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="workspace"]').exists()).toBe(true),
    );

    await wrapper.get('[data-test="cover-url"]').setValue("https://example.com/a.png");
    await wrapper.get('[data-test="fetch-cover"]').trigger("click");

    await vi.waitFor(() =>
      expect(wrapper.get(".toast-error").text()).toContain("当前书籍已清空"),
    );
    expect(session.book.value.chapters).toEqual([]);
    expect(wrapper.find('[data-test="workspace"]').exists()).toBe(false);
  });

  it("clears the loaded book on logout", async () => {
    stubSessionApi(true);
    const session = seedSession();
    const wrapper = mount(App, { props: { session } });

    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="workspace"]').exists()).toBe(true),
    );

    await wrapper.get('[data-test="logout"]').trigger("click");

    await vi.waitFor(() => expect(wrapper.find("form.login-card").exists()).toBe(true));
    expect(session.book.value.chapters).toEqual([]);
    expect(session.canUndo.value).toBe(false);
  });

  it("exports through the converter registry and toasts the file name", async () => {
    stubSessionApi(true);
    const session = seedSession();
    const converter = converterRegistry.epub;
    const originalConvert = converter.convert;
    const convert = vi.fn(
      async (_book: BookModel, _options?: ConvertOptions) =>
        new Blob(["zip"], { type: "application/epub+zip" }),
    );
    converter.convert = convert;

    const urls = stubObjectUrl();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    try {
      const wrapper = mount(App, { props: { session } });
      await vi.waitFor(() =>
        expect(wrapper.find('[data-test="workspace"]').exists()).toBe(true),
      );

      await wrapper.get('[data-test="export"]').trigger("click");

      await vi.waitFor(() => expect(wrapper.find(".toast-success").exists()).toBe(true));
      expect(convert).toHaveBeenCalledTimes(1);
      expect(convert.mock.calls[0]?.[1]).toMatchObject({
        themeId: "paper",
        includeTocPage: false,
        includeTitlePage: false,
        includeVolumePages: false,
        layout: expect.any(Object),
      });
      expect(urls.createObjectURL).toHaveBeenCalledTimes(1);
      expect(click).toHaveBeenCalledTimes(1);
      // 对象 URL 延迟释放：下载开始时仍在，节点已从文档移除。
      expect(urls.revokeObjectURL).not.toHaveBeenCalled();
      expect(document.body.querySelector("a")).toBeNull();
      await vi.waitFor(() => expect(urls.revokeObjectURL).toHaveBeenCalledWith("blob:mock"), {
        timeout: 2000,
      });
      expect(wrapper.get(".toast-success").text()).toContain("测试书.epub");
    } finally {
      converter.convert = originalConvert;
      urls.restore();
    }
  });

  it("exports PDF through the server converter and names the file .pdf", async () => {
    stubSessionApi(true);
    const session = seedSession();
    const converter = converterRegistry.pdf;
    const originalConvert = converter.convert;
    converter.convert = vi.fn(
      async () => new Blob(["%PDF"], { type: "application/pdf" }),
    );
    const urls = stubObjectUrl();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    try {
      const wrapper = mount(App, { props: { session } });
      await vi.waitFor(() =>
        expect(wrapper.find('[data-test="workspace"]').exists()).toBe(true),
      );

      await wrapper.get('[data-test="format-pdf"]').trigger("click");
      await wrapper.get('[data-test="export"]').trigger("click");

      await vi.waitFor(() => expect(wrapper.find(".toast-success").exists()).toBe(true));
      expect(converter.convert).toHaveBeenCalledTimes(1);
      expect(click).toHaveBeenCalledTimes(1);
      expect(wrapper.get(".toast-success").text()).toContain("测试书.pdf");
      await vi.waitFor(() => expect(urls.revokeObjectURL).toHaveBeenCalledWith("blob:mock"), {
        timeout: 2000,
      });
    } finally {
      converter.convert = originalConvert;
      urls.restore();
      click.mockRestore();
    }
  });

  it("toasts a PDF export failure", async () => {
    stubSessionApi(true);
    const session = seedSession();
    const converter = converterRegistry.pdf;
    const originalConvert = converter.convert;
    converter.convert = vi.fn(async () => {
      throw new Error("PDF 生成失败，请稍后再试。");
    });

    try {
      const wrapper = mount(App, { props: { session } });
      await vi.waitFor(() =>
        expect(wrapper.find('[data-test="workspace"]').exists()).toBe(true),
      );

      await wrapper.get('[data-test="format-pdf"]').trigger("click");
      await wrapper.get('[data-test="export"]').trigger("click");

      await vi.waitFor(() => expect(wrapper.find(".toast-error").exists()).toBe(true));
      expect(wrapper.get(".toast-error").text()).toContain(
        "导出失败：PDF 生成失败，请稍后再试。",
      );
    } finally {
      converter.convert = originalConvert;
    }
  });

  it("disables export and hints when no chapters are loaded", async () => {
    stubSessionApi(true);
    const wrapper = mount(App, { props: { session: useBookSession() } });

    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="workspace"]').exists()).toBe(true),
    );

    expect(wrapper.get('[data-test="export"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-test="export-blocked"]').text()).toContain("导入 TXT");
  });

  it("toasts a fallback when the chapter to delete no longer exists", async () => {
    stubSessionApi(true);
    const session = seedSession();
    const wrapper = mount(App, { props: { session } });

    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="workspace"]').exists()).toBe(true),
    );

    wrapper.findComponent(ChapterTree).vm.$emit("remove-chapter", "missing");
    await wrapper.vm.$nextTick();

    expect(wrapper.get(".toast").text()).toContain("找不到该章节");
    expect(session.book.value.chapters).toHaveLength(2);
  });

  it("refuses to delete the only remaining chapter", async () => {
    stubSessionApi(true);
    const session = seedSession();
    const wrapper = mount(App, { props: { session } });

    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="workspace"]').exists()).toBe(true),
    );

    // 第一次删除后只剩一章；再删最后一章应被 App 兜底拒绝。
    wrapper.findComponent(ChapterTree).vm.$emit("remove-chapter", "c1");
    await wrapper.vm.$nextTick();
    wrapper.findComponent(ChapterTree).vm.$emit("remove-chapter", "c2");
    await wrapper.vm.$nextTick();

    const messages = wrapper.findAll(".toast").map((toast) => toast.text());
    expect(messages.some((text) => text.includes("至少保留一章"))).toBe(true);
    expect(session.book.value.chapters).toHaveLength(1);
  });

  it("sanitizes invalid characters and trailing dots in the export file name", async () => {
    // 9 个非法字符替换为下划线，结尾的「. .」被清理。
    await expect(exportWithTitle('X:/<>|?"*\\. .')).resolves.toBe("X_________.epub");
  });

  it("truncates the export file name before trimming trailing dots", async () => {
    // 第 80 个字符是点号，先截断再去尾，文件名不会以「.」结尾。
    await expect(exportWithTitle(`${"a".repeat(79)}.尾巴`)).resolves.toBe(
      `${"a".repeat(79)}.epub`,
    );
  });

  it.each(["CON", "con", "Prn.txt", "AUX", "NUL", "COM1", "com9.log", "LPT1", "lpt9"])(
    "prefixes the Windows reserved name %s with an underscore",
    async (title) => {
      await expect(exportWithTitle(title)).resolves.toBe(`_${title}.epub`);
    },
  );

  it("falls back to 未命名 when the title cleans up to nothing", async () => {
    await expect(exportWithTitle(". . .")).resolves.toBe("未命名.epub");
  });

  it("restores the saved theme and persists theme changes", async () => {
    stubSessionApi(true);
    themeStore.set("txt2book.theme", "night");

    const wrapper = mount(App, { props: { session: seedSession() } });
    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="workspace"]').exists()).toBe(true),
    );

    expect(wrapper.get('[data-test="theme-night"]').attributes("aria-checked")).toBe("true");
    expect(wrapper.get("iframe").attributes("srcdoc")).toContain("#23262b");

    await wrapper.get('[data-test="theme-classic"]').trigger("click");

    expect(themeStore.get("txt2book.theme")).toBe("classic");
    expect(wrapper.get('[data-test="theme-classic"]').attributes("aria-checked")).toBe("true");
    expect(wrapper.get("iframe").attributes("srcdoc")).toContain("#f3e6d0");
  });

  it("falls back to the default theme for an unknown saved value", async () => {
    stubSessionApi(true);
    themeStore.set("txt2book.theme", "missing");

    const wrapper = mount(App, { props: { session: seedSession() } });
    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="workspace"]').exists()).toBe(true),
    );

    expect(wrapper.get('[data-test="theme-paper"]').attributes("aria-checked")).toBe("true");
    expect(wrapper.get("iframe").attributes("srcdoc")).toContain("#f7f1e3");
  });

  it("wires the layout panels to the preview and disables backgrounds on e-ink", async () => {
    stubSessionApi(true);
    const wrapper = mount(App, { props: { session: seedSession() } });

    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="workspace"]').exists()).toBe(true),
    );

    expect(wrapper.find('[data-test="layout-card"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="typography-panel"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="background-panel"]').exists()).toBe(true);

    await wrapper.get('[data-test="type-fontSize-body"]').setValue("1.4");

    expect(wrapper.get("iframe").attributes("srcdoc")).toContain("font-size: 1.4em");

    await wrapper.get('[data-test="theme-eink"]').trigger("click");

    expect(wrapper.get('[data-test="background-disabled-hint"]').text()).toContain(
      "墨水屏主题不使用背景图",
    );
  });

  it("applies a background preset to the preview", async () => {
    stubSessionApi(true);
    const wrapper = mount(App, { props: { session: seedSession() } });

    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="workspace"]').exists()).toBe(true),
    );

    await wrapper.get('[data-test="background-preset-grid"]').trigger("click");

    expect(wrapper.get("iframe").attributes("srcdoc")).toContain("repeating-linear-gradient(0deg");
  });

  it("encodes a custom background once as a data URL for the preview", async () => {
    stubSessionApi(true);
    seedCustomBackground();
    const btoaSpy = vi.spyOn(globalThis, "btoa");
    const wrapper = mount(App, { props: { session: seedSession() } });

    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="workspace"]').exists()).toBe(true),
    );

    const srcdoc = wrapper.get("iframe").attributes("srcdoc") ?? "";
    // 预览 iframe 是空 sandbox 的不透明源，blob: URL 会被拒绝；改用 data URL。
    expect(srcdoc).toContain('background-image: url("data:image/png;base64,AQID")');
    expect(srcdoc).not.toContain("blob:");

    const encodedAfterMount = btoaSpy.mock.calls.length;
    await wrapper.get('[data-test="type-fontSize-body"]').setValue("1.4");

    // 改字号会重建 layout 对象，但背景字节不变，不应重新编码。
    expect(btoaSpy.mock.calls.length).toBe(encodedAfterMount);
  });

  it("drops the custom background data URL when switching to a preset", async () => {
    stubSessionApi(true);
    seedCustomBackground();
    const wrapper = mount(App, { props: { session: seedSession() } });

    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="workspace"]').exists()).toBe(true),
    );

    await wrapper.get('[data-test="background-preset-grid"]').trigger("click");

    const srcdoc = wrapper.get("iframe").attributes("srcdoc") ?? "";
    expect(srcdoc).toContain("repeating-linear-gradient");
    expect(srcdoc).not.toContain("data:image/png;base64,");
  });

  it("drops the custom background data URL when clearing the background", async () => {
    stubSessionApi(true);
    seedCustomBackground();
    const wrapper = mount(App, { props: { session: seedSession() } });

    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="workspace"]').exists()).toBe(true),
    );

    await wrapper.get('[data-test="background-clear"]').trigger("click");

    expect(wrapper.get("iframe").attributes("srcdoc")).not.toContain("background-image");
  });

  it("resets typography from the panel without dropping the custom background", async () => {
    stubSessionApi(true);
    seedCustomBackground();
    const wrapper = mount(App, { props: { session: seedSession() } });

    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="workspace"]').exists()).toBe(true),
    );

    await wrapper.get('[data-test="type-fontSize-body"]').setValue("1.4");
    expect(wrapper.get("iframe").attributes("srcdoc")).toContain("font-size: 1.4em");

    await wrapper.get('[data-test="typography-reset"]').trigger("click");

    const srcdoc = wrapper.get("iframe").attributes("srcdoc") ?? "";
    // 排版回到主题默认值，背景仍是自定义图的 data URL。
    expect(srcdoc).toContain("font-size: 1.05em");
    expect(srcdoc).not.toContain("font-size: 1.4em");
    expect(srcdoc).toContain('background-image: url("data:image/png;base64,AQID")');
  });

  it("links to the export card for narrow layouts", async () => {
    stubSessionApi(true);
    const wrapper = mount(App, { props: { session: seedSession() } });

    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="workspace"]').exists()).toBe(true),
    );

    expect(wrapper.get('[data-test="jump-export"]').attributes("href")).toBe("#export-card");
    expect(wrapper.get('[data-test="export-panel"]').attributes("id")).toBe("export-card");
    // 锚点目标可编程聚焦，跳转后才能把焦点交给导出卡片。
    expect(wrapper.get('[data-test="export-panel"]').attributes("tabindex")).toBe("-1");
  });

  it("links to the preview pane for narrow layouts", async () => {
    stubSessionApi(true);
    const wrapper = mount(App, { props: { session: seedSession() } });

    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="workspace"]').exists()).toBe(true),
    );

    // 固定按钮本身常驻 DOM，桌面端由 CSS 隐藏、窄屏显示（媒体查询在 happy-dom 中不可测）。
    const jump = wrapper.get('[data-test="jump-preview"]');
    expect(jump.attributes("href")).toBe("#preview-pane");
    expect(jump.classes()).toContain("jump-preview");
    expect(wrapper.get('[data-test="preview-pane"]').attributes("id")).toBe("preview-pane");
  });

  it("keeps the whole left column sticky, including the upload panel", async () => {
    stubSessionApi(true);
    const wrapper = mount(App, { props: { session: seedSession() } });

    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="workspace"]').exists()).toBe(true),
    );

    const side = wrapper.get('[data-test="workspace-side"]');
    expect(side.classes()).toContain("workspace-col-side");
    expect(side.findComponent(ChapterTree).exists()).toBe(true);
    // 上传面板与目录在同一个吸顶列中，不再互相遮挡。
    expect(side.find(".upload-panel").exists()).toBe(true);
    expect(wrapper.find(".workspace-col-side > .upload-panel").exists()).toBe(true);
  });

  it("collapses the typography card from its summary", async () => {
    stubSessionApi(true);
    const wrapper = mount(App, { props: { session: seedSession() } });

    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="workspace"]').exists()).toBe(true),
    );

    const card = wrapper.get('[data-test="layout-card"]');
    expect(card.element.tagName).toBe("DETAILS");
    expect((card.element as HTMLDetailsElement).open).toBe(true);
    expect(card.get("summary").find(".disclosure-caret").exists()).toBe(true);
    expect(wrapper.find(".layout-card-caret").exists()).toBe(false);
    expect(card.get("summary").text()).toContain("排版");
    expect(card.get(".layout-card-hint").text()).toBe(
      "说明：这里的设置只影响预览和导出的电子书，不会改变应用界面。",
    );

    await card.get("summary").trigger("click");

    expect((card.element as HTMLDetailsElement).open).toBe(false);
  });
});
