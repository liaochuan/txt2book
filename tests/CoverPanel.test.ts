import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import CoverPanel from "../src/components/CoverPanel.vue";
import { useBookSession } from "../src/composables/useBookSession";
import { ApiError, api } from "../src/core/api";

vi.mock("../src/core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      coverFromUrl: vi.fn(),
      coverFromFile: vi.fn(),
    },
  };
});

const PNG_BYTES = [137, 80, 78, 71, 13, 10, 26, 10];

function pngBlob(): Blob {
  return new Blob([new Uint8Array(PNG_BYTES)], { type: "image/png" });
}

let urlSequence = 0;

beforeEach(() => {
  urlSequence = 0;
  vi.mocked(api.coverFromUrl).mockReset();
  vi.mocked(api.coverFromFile).mockReset();
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
    urlSequence += 1;
    return `blob:cover-${urlSequence}`;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 600, height: 900, close: vi.fn() })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mountPanel() {
  const session = useBookSession();
  const wrapper = mount(CoverPanel, { props: { session } });
  return { session, wrapper };
}

async function pickFile(
  wrapper: ReturnType<typeof mount>,
  file: File,
): Promise<void> {
  const input = wrapper.get('[data-test="cover-file"]');
  Object.defineProperty(input.element, "files", {
    value: [file],
    configurable: true,
  });
  await input.trigger("change");
}

describe("CoverPanel", () => {
  it("starts empty with the fetch action disabled", () => {
    const { wrapper } = mountPanel();

    expect(wrapper.find('[data-test="cover-url"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="cover-file"]').exists()).toBe(true);
    expect(wrapper.get('[data-test="fetch-cover"]').attributes("disabled")).toBeDefined();
    expect(wrapper.find('[data-test="clear-cover"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="cover-preview"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="cover-empty"]').text()).toContain("尚未设置封面");
  });

  it("fetches a cover from a url and shows the png preview and size", async () => {
    vi.mocked(api.coverFromUrl).mockResolvedValue(pngBlob());
    const { session, wrapper } = mountPanel();

    await wrapper.get('[data-test="cover-url"]').setValue(" https://example.com/a.webp ");
    expect(wrapper.get('[data-test="fetch-cover"]').attributes("disabled")).toBeUndefined();
    await wrapper.get('[data-test="fetch-cover"]').trigger("click");

    await vi.waitFor(() => expect(wrapper.find('[data-test="cover-preview"]').exists()).toBe(true));
    expect(api.coverFromUrl).toHaveBeenCalledWith(
      "https://example.com/a.webp",
      expect.any(AbortSignal),
    );
    expect(wrapper.get('[data-test="cover-preview"]').attributes("alt")).toBe("封面预览");
    expect(wrapper.get('[data-test="cover-preview"]').attributes("src")).toBe("blob:cover-1");
    expect(wrapper.get('[data-test="cover-size"]').text()).toBe("PNG 600×900");
    expect(session.book.value.cover?.width).toBe(600);
    expect(wrapper.find('[data-test="clear-cover"]').exists()).toBe(true);
  });

  it("shows the original and converted sizes for a local file", async () => {
    vi.mocked(api.coverFromFile).mockResolvedValue(pngBlob());
    vi.mocked(globalThis.createImageBitmap)
      .mockResolvedValueOnce({ width: 1200, height: 1800, close: vi.fn() } as ImageBitmap)
      .mockResolvedValueOnce({ width: 600, height: 900, close: vi.fn() } as ImageBitmap);
    const { session, wrapper } = mountPanel();
    const file = new File([new Uint8Array([1, 2, 3])], "cover.webp", {
      type: "image/webp",
    });

    await pickFile(wrapper, file);

    await vi.waitFor(() => expect(wrapper.find('[data-test="cover-preview"]').exists()).toBe(true));
    expect(api.coverFromFile).toHaveBeenCalledWith(file, { signal: expect.any(AbortSignal) });
    expect(wrapper.get('[data-test="cover-size"]').text()).toBe(
      "原图 1200×1800 → PNG 600×900",
    );
    expect(session.book.value.cover?.sourceName).toBe("cover.webp");
  });

  it("shows a friendly message for an unsupported image", async () => {
    vi.mocked(api.coverFromUrl).mockRejectedValue(
      new ApiError(415, "UNSUPPORTED_IMAGE", "不支持的图片格式"),
    );
    const { wrapper } = mountPanel();

    await wrapper.get('[data-test="cover-url"]').setValue("https://example.com/a.bmp");
    await wrapper.get('[data-test="fetch-cover"]').trigger("click");

    await vi.waitFor(() =>
      expect(wrapper.get('[data-test="cover-error"]').text()).toBe("图片格式不支持"),
    );
    expect(wrapper.get('[data-test="cover-error"]').attributes("role")).toBe("alert");
    expect(wrapper.find('[data-test="cover-preview"]').exists()).toBe(false);
  });

  it("shows a login hint on 401", async () => {
    vi.mocked(api.coverFromUrl).mockRejectedValue(
      new ApiError(401, "UNAUTHORIZED", "请先登录"),
    );
    const { wrapper } = mountPanel();

    await wrapper.get('[data-test="cover-url"]').setValue("https://example.com/a.png");
    await wrapper.get('[data-test="fetch-cover"]').trigger("click");

    await vi.waitFor(() =>
      expect(wrapper.get('[data-test="cover-error"]').text()).toBe("登录已失效，请重新登录"),
    );
  });

  it("disables the actions while fetching and ignores duplicates", async () => {
    let release: (blob: Blob) => void = () => {};
    const gate = new Promise<Blob>((resolve) => {
      release = resolve;
    });
    vi.mocked(api.coverFromUrl).mockReturnValue(gate);
    const { wrapper } = mountPanel();

    await wrapper.get('[data-test="cover-url"]').setValue("https://example.com/a.png");
    await wrapper.get('[data-test="fetch-cover"]').trigger("click");

    expect(wrapper.find('[data-test="cover-busy"]').exists()).toBe(true);
    expect(wrapper.get('[data-test="cover-busy"]').attributes("role")).toBe("status");
    expect(wrapper.get('[data-test="fetch-cover"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-test="pick-cover"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-test="cover-url"]').attributes("disabled")).toBeDefined();

    await wrapper.get('[data-test="fetch-cover"]').trigger("click");
    expect(api.coverFromUrl).toHaveBeenCalledTimes(1);

    release(pngBlob());
    await vi.waitFor(() => expect(wrapper.find('[data-test="cover-preview"]').exists()).toBe(true));
    expect(wrapper.find('[data-test="cover-busy"]').exists()).toBe(false);
  });

  it("shows an existing session cover and clears it", async () => {
    const session = useBookSession();
    session.setCover({ png: new Uint8Array(PNG_BYTES), width: 300, height: 400 });
    const wrapper = mount(CoverPanel, { props: { session } });

    expect(wrapper.get('[data-test="cover-preview"]').attributes("src")).toBe("blob:cover-1");
    expect(wrapper.get('[data-test="cover-size"]').text()).toBe("PNG 300×400");

    await wrapper.get('[data-test="clear-cover"]').trigger("click");

    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:cover-1");
    expect(wrapper.find('[data-test="cover-preview"]').exists()).toBe(false);
    expect(session.book.value.cover).toBeNull();
  });

  it("revokes the preview url when unmounted", async () => {
    vi.mocked(api.coverFromUrl).mockResolvedValue(pngBlob());
    const { wrapper } = mountPanel();
    await wrapper.get('[data-test="cover-url"]').setValue("https://example.com/a.png");
    await wrapper.get('[data-test="fetch-cover"]').trigger("click");
    await vi.waitFor(() => expect(wrapper.find('[data-test="cover-preview"]').exists()).toBe(true));

    wrapper.unmount();

    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:cover-1");
  });

  it("rejects a non-http url before calling the api", async () => {
    const { wrapper } = mountPanel();
    await wrapper.get('[data-test="cover-url"]').setValue("ftp://example.com/a.png");

    await wrapper.get('[data-test="fetch-cover"]').trigger("click");

    expect(wrapper.get('[data-test="cover-error"]').text()).toBe(
      "仅支持 http/https 图片地址",
    );
    expect(api.coverFromUrl).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("clears the previous error when the url changes", async () => {
    vi.mocked(api.coverFromUrl).mockRejectedValue(
      new ApiError(415, "UNSUPPORTED_IMAGE", "不支持的图片格式"),
    );
    const { wrapper } = mountPanel();
    const input = wrapper.get('[data-test="cover-url"]');
    await input.setValue("https://example.com/a.bmp");
    await wrapper.get('[data-test="fetch-cover"]').trigger("click");
    await vi.waitFor(() =>
      expect(wrapper.get('[data-test="cover-error"]').text()).toBe("图片格式不支持"),
    );

    await input.setValue("https://example.com/b.png");

    expect(wrapper.find('[data-test="cover-error"]').exists()).toBe(false);
  });

  it("follows an external cover change and resets the original size", async () => {
    vi.mocked(api.coverFromUrl).mockResolvedValue(pngBlob());
    const { session, wrapper } = mountPanel();
    await wrapper.get('[data-test="cover-url"]').setValue("https://example.com/a.png");
    await wrapper.get('[data-test="fetch-cover"]').trigger("click");
    await vi.waitFor(() => expect(wrapper.find('[data-test="cover-preview"]').exists()).toBe(true));

    session.setCover({ png: new Uint8Array(PNG_BYTES), width: 100, height: 200 });
    await nextTick();

    expect(wrapper.get('[data-test="cover-preview"]').attributes("src")).toBe("blob:cover-2");
    expect(wrapper.get('[data-test="cover-size"]').text()).toBe("PNG 100×200");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:cover-1");
  });

  it("keeps the cover figure when the preview url cannot be created", () => {
    vi.mocked(URL.createObjectURL).mockImplementation(() => {
      throw new Error("no object url");
    });
    const session = useBookSession();
    session.setCover({ png: new Uint8Array(PNG_BYTES), width: 300, height: 400 });
    const wrapper = mount(CoverPanel, { props: { session } });

    expect(wrapper.find('[data-test="cover-preview"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="cover-size"]').text()).toBe("PNG 300×400");
    expect(wrapper.find('[data-test="cover-empty"]').exists()).toBe(false);
  });
});
