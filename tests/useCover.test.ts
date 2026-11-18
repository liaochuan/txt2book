import { nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../src/core/api";
import { useBookSession } from "../src/composables/useBookSession";
import { useCover } from "../src/composables/useCover";

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

/** 完整 PNG 文件头，校验逻辑依赖前 8 字节。 */
const PNG_BYTES = [137, 80, 78, 71, 13, 10, 26, 10];

function pngBlob(bytes: number[] = PNG_BYTES): Blob {
  return new Blob([new Uint8Array(bytes)], { type: "image/png" });
}

function coverAsset(bytes: number[] = PNG_BYTES, width = 10, height = 20) {
  return { png: new Uint8Array(bytes), width, height };
}

let urlSequence = 0;

beforeEach(() => {
  urlSequence = 0;
  vi.mocked(api.coverFromUrl).mockReset();
  vi.mocked(api.coverFromFile).mockReset();
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
    urlSequence += 1;
    return `blob:mock-${urlSequence}`;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 600, height: 900, close: vi.fn() })),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useCover", () => {
  it("stores png bytes and exposes dimensions when the server returns png", async () => {
    const session = useBookSession();
    const { cover, previewUrl, fromUrl, busy, error } = useCover(session);
    vi.mocked(api.coverFromUrl).mockResolvedValue(pngBlob());

    const ok = await fromUrl("https://example.com/a.webp");

    expect(ok).toBe(true);
    expect(busy.value).toBe(false);
    expect(error.value).toBe("");
    expect(cover.value?.png).toBeInstanceOf(Uint8Array);
    expect(Array.from(cover.value?.png ?? [])).toEqual(PNG_BYTES);
    expect(cover.value?.width).toBe(600);
    expect(cover.value?.height).toBe(900);
    expect(session.book.value.cover).not.toBeNull();
    expect(Array.from(session.book.value.cover?.png ?? [])).toEqual(PNG_BYTES);
    expect(previewUrl.value).toBe("blob:mock-1");
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(api.coverFromUrl).toHaveBeenCalledWith(
      "https://example.com/a.webp",
      expect.any(AbortSignal),
    );
  });

  it("trims the url before calling the api", async () => {
    vi.mocked(api.coverFromUrl).mockResolvedValue(pngBlob());

    await useCover(useBookSession()).fromUrl("  https://example.com/a.png  ");

    expect(api.coverFromUrl).toHaveBeenCalledWith(
      "https://example.com/a.png",
      expect.any(AbortSignal),
    );
  });

  it("uploads a local file and records its name", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "cover.webp", {
      type: "image/webp",
    });
    vi.mocked(api.coverFromFile).mockResolvedValue(pngBlob());
    const { cover, fromFile } = useCover(useBookSession());

    const ok = await fromFile(file);

    expect(ok).toBe(true);
    expect(api.coverFromFile).toHaveBeenCalledWith(file, { signal: expect.any(AbortSignal) });
    expect(cover.value?.sourceName).toBe("cover.webp");
  });

  it("revokes the previous object url when the cover is replaced", async () => {
    vi.mocked(api.coverFromUrl).mockResolvedValue(pngBlob());
    const { previewUrl, fromUrl } = useCover(useBookSession());

    await fromUrl("https://example.com/one.png");
    expect(previewUrl.value).toBe("blob:mock-1");

    await fromUrl("https://example.com/two.png");

    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-1");
    expect(previewUrl.value).toBe("blob:mock-2");
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
  });

  it("clears the preview, the asset and the session cover", async () => {
    vi.mocked(api.coverFromUrl).mockResolvedValue(pngBlob());
    const session = useBookSession();
    const { cover, previewUrl, fromUrl, clear } = useCover(session);
    await fromUrl("https://example.com/a.png");

    clear();

    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-1");
    expect(previewUrl.value).toBe("");
    expect(cover.value).toBeNull();
    expect(session.book.value.cover).toBeNull();
  });

  it("revokes the current object url on dispose without clearing the session cover", async () => {
    vi.mocked(api.coverFromUrl).mockResolvedValue(pngBlob());
    const session = useBookSession();
    const { previewUrl, fromUrl, dispose } = useCover(session);
    await fromUrl("https://example.com/a.png");

    dispose();

    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-1");
    expect(previewUrl.value).toBe("");
    expect(session.book.value.cover).not.toBeNull();
  });

  it("builds a preview from an existing session cover", () => {
    const session = useBookSession();
    session.setCover(coverAsset(PNG_BYTES, 10, 20));

    const { cover, previewUrl } = useCover(session);

    expect(cover.value?.width).toBe(10);
    expect(previewUrl.value).toBe("blob:mock-1");
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("follows external cover changes such as undo", async () => {
    const session = useBookSession();
    const first = coverAsset(PNG_BYTES, 10, 20);
    session.setCover(first);
    vi.mocked(api.coverFromUrl).mockResolvedValue(pngBlob([...PNG_BYTES, 1]));
    const { cover, previewUrl, fromUrl } = useCover(session);
    expect(previewUrl.value).toBe("blob:mock-1");

    await fromUrl("https://example.com/b.png");
    expect(cover.value).not.toBe(first);
    expect(previewUrl.value).toBe("blob:mock-2");

    session.undo();
    await nextTick();

    expect(cover.value).toBe(first);
    expect(previewUrl.value).toBe("blob:mock-3");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-2");
  });

  it.each([
    [new ApiError(401, "UNAUTHORIZED", "请先登录"), "登录已失效，请重新登录"],
    [new ApiError(415, "UNSUPPORTED_IMAGE", "不支持的图片格式"), "图片格式不支持"],
    [new ApiError(429, "RATE_LIMITED", "请求过于频繁"), "请求过于频繁，请稍后再试"],
    [new ApiError(0, "NETWORK", "网络请求失败"), "网络异常，请检查网络后重试"],
    [new ApiError(408, "TIMEOUT", "请求超时"), "网络异常，请检查网络后重试"],
    [new ApiError(504, "GATEWAY_TIMEOUT", "网关超时"), "网络异常，请检查网络后重试"],
    [new ApiError(500, "INTERNAL", "服务器开小差了"), "服务器开小差了"],
    [new ApiError(500, "INTERNAL", "internal error"), "封面处理失败，请稍后重试。"],
  ])("maps %s to a friendly message", async (cause, expected) => {
    vi.mocked(api.coverFromUrl).mockRejectedValue(cause);
    const { error, fromUrl, busy } = useCover(useBookSession());

    const ok = await fromUrl("https://example.com/a.png");

    expect(ok).toBe(false);
    expect(busy.value).toBe(false);
    expect(error.value).toBe(expected);
  });

  it("rejects a non-png response and keeps the previous cover", async () => {
    const session = useBookSession();
    const first = coverAsset();
    session.setCover(first);
    vi.mocked(api.coverFromUrl).mockResolvedValue(
      new Blob([new Uint8Array(PNG_BYTES)], { type: "image/jpeg" }),
    );
    const { cover, previewUrl, error, fromUrl } = useCover(session);
    const before = previewUrl.value;

    const ok = await fromUrl("https://example.com/a.jpg");

    expect(ok).toBe(false);
    expect(error.value).toBe("服务器返回的封面格式异常");
    expect(cover.value).toBe(first);
    expect(session.book.value.cover).toBe(first);
    expect(previewUrl.value).toBe(before);
    // 失败路径不应创建或回收预览地址。
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it("rejects png content with a bad magic header", async () => {
    vi.mocked(api.coverFromUrl).mockResolvedValue(
      pngBlob([1, 2, 3, 4, 5, 6, 7, 8]),
    );
    const session = useBookSession();
    const { error, cover, fromUrl } = useCover(session);

    const ok = await fromUrl("https://example.com/fake.png");

    expect(ok).toBe(false);
    expect(error.value).toBe("服务器返回的封面格式异常");
    expect(cover.value).toBeNull();
    expect(session.book.value.cover).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("rejects an empty png body", async () => {
    vi.mocked(api.coverFromUrl).mockResolvedValue(new Blob([], { type: "image/png" }));
    const { error, fromUrl } = useCover(useBookSession());

    const ok = await fromUrl("https://example.com/empty.png");

    expect(ok).toBe(false);
    expect(error.value).toBe("服务器返回的封面格式异常");
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("keeps the previous cover when the next request fails", async () => {
    vi.mocked(api.coverFromUrl).mockResolvedValueOnce(pngBlob());
    vi.mocked(api.coverFromUrl).mockRejectedValueOnce(new ApiError(415, "BAD", "x"));
    const session = useBookSession();
    const { cover, previewUrl, fromUrl } = useCover(session);
    await fromUrl("https://example.com/a.png");
    const first = cover.value;

    await fromUrl("https://example.com/b.png");

    expect(cover.value).toBe(first);
    expect(session.book.value.cover).toBe(first);
    expect(previewUrl.value).toBe("blob:mock-1");
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it("rejects an empty url without calling the api", async () => {
    const { error, fromUrl, busy } = useCover(useBookSession());

    const ok = await fromUrl("   ");

    expect(ok).toBe(false);
    expect(api.coverFromUrl).not.toHaveBeenCalled();
    expect(busy.value).toBe(false);
    expect(error.value).toBe("请输入图片地址");
  });

  it("falls back to 0x0 when the bitmap cannot be decoded but still stores the png", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        throw new Error("decode failed");
      }),
    );
    vi.mocked(api.coverFromUrl).mockResolvedValue(pngBlob());
    const { cover, fromUrl } = useCover(useBookSession());

    const ok = await fromUrl("https://example.com/a.png");

    expect(ok).toBe(true);
    expect(cover.value?.width).toBe(0);
    expect(cover.value?.height).toBe(0);
    expect(cover.value?.png.length).toBe(PNG_BYTES.length);
  });

  it("aborts a stalled request after 15 seconds and reports a network error", async () => {
    vi.useFakeTimers();
    vi.mocked(api.coverFromUrl).mockImplementation(
      (_url, signal) =>
        new Promise<Blob>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    const { error, fromUrl, busy } = useCover(useBookSession());

    const pending = fromUrl("https://example.com/slow.png");
    expect(busy.value).toBe(true);

    await vi.advanceTimersByTimeAsync(15_000);

    await expect(pending).resolves.toBe(false);
    expect(error.value).toBe("网络异常，请检查网络后重试");
    expect(busy.value).toBe(false);
    const signal = vi.mocked(api.coverFromUrl).mock.calls[0]?.[1];
    expect(signal?.aborted).toBe(true);
  });

  it("ignores a second request while one is running", async () => {
    let release: (blob: Blob) => void = () => {};
    const gate = new Promise<Blob>((resolve) => {
      release = resolve;
    });
    vi.mocked(api.coverFromUrl).mockReturnValue(gate);
    const { busy, fromUrl } = useCover(useBookSession());

    const first = fromUrl("https://example.com/a.png");
    expect(busy.value).toBe(true);

    expect(await fromUrl("https://example.com/b.png")).toBe(false);
    expect(api.coverFromUrl).toHaveBeenCalledTimes(1);

    release(pngBlob());
    await expect(first).resolves.toBe(true);
    expect(busy.value).toBe(false);
  });

  it("discards an in-flight response after clear", async () => {
    let release: (blob: Blob) => void = () => {};
    const gate = new Promise<Blob>((resolve) => {
      release = resolve;
    });
    vi.mocked(api.coverFromUrl).mockReturnValue(gate);
    const session = useBookSession();
    const { busy, cover, previewUrl, fromUrl, clear } = useCover(session);

    const pending = fromUrl("https://example.com/a.png");
    clear();
    release(pngBlob());

    await expect(pending).resolves.toBe(false);
    expect(cover.value).toBeNull();
    expect(session.book.value.cover).toBeNull();
    expect(previewUrl.value).toBe("");
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(busy.value).toBe(false);
  });

  it("discards an in-flight response after dispose", async () => {
    let release: (blob: Blob) => void = () => {};
    const gate = new Promise<Blob>((resolve) => {
      release = resolve;
    });
    vi.mocked(api.coverFromUrl).mockReturnValue(gate);
    const session = useBookSession();
    const { busy, previewUrl, fromUrl, dispose } = useCover(session);

    const pending = fromUrl("https://example.com/a.png");
    dispose();
    release(pngBlob());

    await expect(pending).resolves.toBe(false);
    expect(session.book.value.cover).toBeNull();
    expect(previewUrl.value).toBe("");
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(busy.value).toBe(false);
  });

  it("keeps create and revoke calls balanced across replace and clear", async () => {
    vi.mocked(api.coverFromUrl).mockResolvedValue(pngBlob());
    const { fromUrl, clear } = useCover(useBookSession());

    await fromUrl("https://example.com/a.png");
    await fromUrl("https://example.com/b.png");
    clear();

    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });
});
