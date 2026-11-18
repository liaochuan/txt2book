import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import UploadPanel from "../src/components/UploadPanel.vue";
import { useBookSession } from "../src/composables/useBookSession";

const GB18030_SAMPLE = new Uint8Array([
  0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 0x20, 0xbf, 0xaa, 0xca, 0xbc, 0x0a, 0xd5, 0xfd, 0xce,
  0xc4,
]);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mountPanel() {
  const session = useBookSession();
  const wrapper = mount(UploadPanel, { props: { session, rules: [] } });
  return { session, wrapper };
}

async function pickFile(
  wrapper: ReturnType<typeof mount>,
  file: File,
): Promise<void> {
  const input = wrapper.get('[data-test="file-input"]');
  Object.defineProperty(input.element, "files", {
    value: [file],
    configurable: true,
  });
  await input.trigger("change");
}

async function dropFile(
  wrapper: ReturnType<typeof mount>,
  file: File,
  items?: unknown[],
): Promise<void> {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { files: [file], ...(items ? { items } : {}) },
  });
  wrapper.get('[data-test="drop-zone"]').element.dispatchEvent(event);
  await nextTick();
}

async function dropDirectory(wrapper: ReturnType<typeof mount>): Promise<void> {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      files: [],
      items: [
        {
          kind: "file",
          webkitGetAsEntry: () => ({ isDirectory: true }),
        },
      ],
    },
  });
  wrapper.get('[data-test="drop-zone"]').element.dispatchEvent(event);
  await nextTick();
}

describe("UploadPanel", () => {
  it("offers every encoding and disables reparse before a file is chosen", () => {
    const { wrapper } = mountPanel();

    expect(wrapper.findAll('[data-test="encoding"] option')).toHaveLength(5);
    expect(wrapper.get('[data-test="encoding-hint"]').text()).toContain(
      "切换后需点击“重新解析”生效",
    );
    expect(wrapper.get('[data-test="reparse"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-test="no-file"]').text()).toContain("尚未导入");
  });

  it("imports a file from the file input and shows its encoding", async () => {
    const { session, wrapper } = mountPanel();
    const file = new File(["第一章 开始\n正文"], "a.txt", { type: "text/plain" });

    await pickFile(wrapper, file);

    await vi.waitFor(() =>
      expect(wrapper.get('[data-test="file-name"]').text()).toBe("a.txt"),
    );
    expect(session.book.value.chapters[0].title).toBe("第一章 开始");
    expect(wrapper.get('[data-test="used-encoding"]').text()).toContain("utf-8");
    expect(wrapper.get('[data-test="reparse"]').attributes("disabled")).toBeUndefined();
  });

  it("imports a dropped file", async () => {
    const { session, wrapper } = mountPanel();

    await dropFile(wrapper, new File(["第一章 开始\n正文"], "drop.txt"));

    await vi.waitFor(() => expect(session.book.value.meta.title).toBe("drop"));
    expect(wrapper.get('[data-test="drop-zone"]').classes()).not.toContain(
      "upload-drop-active",
    );
  });

  it("keeps the drop highlight while dragging over nested children", async () => {
    const { wrapper } = mountPanel();
    const zone = wrapper.get('[data-test="drop-zone"]');

    await zone.trigger("dragenter");
    await zone.trigger("dragenter");
    expect(zone.classes()).toContain("upload-drop-active");

    await zone.trigger("dragleave");
    expect(zone.classes()).toContain("upload-drop-active");

    await zone.trigger("dragleave");
    expect(zone.classes()).not.toContain("upload-drop-active");
  });

  it("rejects a dropped folder with a hint", async () => {
    const { session, wrapper } = mountPanel();

    await dropDirectory(wrapper);

    expect(wrapper.get('[data-test="notice"]').text()).toContain("文件夹");
    expect(wrapper.find('[data-test="file-name"]').exists()).toBe(false);
    expect(session.hasBook.value).toBe(false);
  });

  it("ignores a second drop while importing without faking an edit", async () => {
    const { session, wrapper } = mountPanel();
    let release: (buffer: ArrayBuffer) => void = () => {};
    const gate = new Promise<ArrayBuffer>((resolve) => {
      release = resolve;
    });
    const pending = {
      name: "first.txt",
      arrayBuffer: () => gate,
    } as unknown as File;

    await dropFile(wrapper, pending);
    expect(wrapper.find('[data-test="busy"]').exists()).toBe(true);

    await dropFile(wrapper, new File(["第二章 其他\n正文"], "second.txt"));
    expect(wrapper.get('[data-test="notice"]').text()).toContain("正在解析");

    release(new TextEncoder().encode("第一章 开始\n正文").buffer as ArrayBuffer);

    await vi.waitFor(() => expect(session.book.value.meta.title).toBe("first"));
    expect(wrapper.find('[data-test="edited-warning"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="notice"]').exists()).toBe(false);
  });

  it("resets the encoding selector to auto after a successful import", async () => {
    const { session, wrapper } = mountPanel();
    await wrapper.get('[data-test="encoding"]').setValue("gb18030");

    await pickFile(wrapper, new File(["第一章 开始\n正文"], "auto.txt"));
    await vi.waitFor(() =>
      expect(wrapper.get('[data-test="file-name"]').text()).toBe("auto.txt"),
    );

    expect(
      (wrapper.get('[data-test="encoding"]').element as HTMLSelectElement).value,
    ).toBe("auto");

    await wrapper.get('[data-test="reparse"]').trigger("click");
    await vi.waitFor(() =>
      expect(session.book.value.chapters[0].title).toBe("第一章 开始"),
    );
  });

  it("re-decodes with the selected encoding when reparsing", async () => {
    const { session, wrapper } = mountPanel();
    await wrapper.get('[data-test="encoding"]').setValue("utf-8");
    await pickFile(wrapper, new File([GB18030_SAMPLE], "c.txt"));
    await vi.waitFor(() =>
      expect(wrapper.get('[data-test="file-name"]').text()).toBe("c.txt"),
    );
    expect(session.book.value.chapters[0].title).toBe("正文");

    await wrapper.get('[data-test="encoding"]').setValue("gb18030");
    await wrapper.get('[data-test="reparse"]').trigger("click");

    await vi.waitFor(() =>
      expect(session.book.value.chapters[0].title).toBe("第一章 开始"),
    );
    expect(wrapper.get('[data-test="used-encoding"]').text()).toContain("gb18030");
  });

  it("warns about edits and honors the confirm prompt before reparsing", async () => {
    const { session, wrapper } = mountPanel();
    await pickFile(wrapper, new File(["第一章 开始\n正文"], "e.txt"));
    await vi.waitFor(() =>
      expect(wrapper.get('[data-test="file-name"]').text()).toBe("e.txt"),
    );

    session.rename(session.book.value.chapters[0].id, "改过的标题");
    await nextTick();
    expect(wrapper.find('[data-test="edited-warning"]').exists()).toBe(true);

    const confirmMock = vi.fn((_message?: string) => false);
    vi.stubGlobal("confirm", confirmMock);
    await wrapper.get('[data-test="reparse"]').trigger("click");

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(String(confirmMock.mock.calls[0]?.[0])).toContain(
      "书籍信息会保留，但章节编辑（改名/删除）会被丢弃",
    );
    expect(session.book.value.chapters[0].title).toBe("改过的标题");

    confirmMock.mockReturnValue(true);
    await wrapper.get('[data-test="reparse"]').trigger("click");

    await vi.waitFor(() =>
      expect(session.book.value.chapters[0].title).toBe("第一章 开始"),
    );
    expect(wrapper.find('[data-test="edited-warning"]').exists()).toBe(false);
  });

  it("shows an alert and keeps the previous book when a file is empty", async () => {
    const { session, wrapper } = mountPanel();
    await pickFile(wrapper, new File(["第一章 开始\n正文"], "ok.txt"));
    await vi.waitFor(() =>
      expect(wrapper.get('[data-test="file-name"]').text()).toBe("ok.txt"),
    );

    await pickFile(wrapper, new File([], "empty.txt"));

    await vi.waitFor(() =>
      expect(wrapper.get('[data-test="error"]').attributes("role")).toBe("alert"),
    );
    expect(wrapper.get('[data-test="error"]').text()).toContain("正文");
    expect(wrapper.get('[data-test="file-name"]').text()).toBe("ok.txt");
    expect(session.book.value.chapters[0].title).toBe("第一章 开始");
  });
});
