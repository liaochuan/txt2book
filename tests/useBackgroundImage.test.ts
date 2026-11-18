import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../src/core/api";
import { useBackgroundImage } from "../src/composables/useBackgroundImage";
import type { BackgroundConfig } from "../src/core/render/layout";

vi.mock("../src/core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      coverFromFile: vi.fn(),
    },
  };
});

const PNG_MAGIC = [137, 80, 78, 71, 13, 10, 26, 10];
const JPEG_BYTES = [255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** 构造带 IHDR 宽高的最小 PNG 头，供宽高解析使用。 */
function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set(PNG_MAGIC, 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function pngBlob(width = 800, height = 1200): Blob {
  const bytes = pngBytes(width, height);
  return new Blob([bytes.buffer as ArrayBuffer], { type: "image/png" });
}

function jpegBlob(): Blob {
  return new Blob([new Uint8Array(JPEG_BYTES)], { type: "image/jpeg" });
}

function imageFile(name = "cover.webp", type = "image/webp"): File {
  return new File([new Uint8Array([1, 2, 3, 4])], name, { type });
}

beforeEach(() => {
  vi.mocked(api.coverFromFile).mockReset();
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(() => {
      throw new Error("useBackgroundImage 不应调用 createImageBitmap");
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useBackgroundImage", () => {
  it("requests jpeg and stores the returned bytes without decoding dimensions", async () => {
    vi.mocked(api.coverFromFile).mockResolvedValue(jpegBlob());
    const setBackground = vi.fn<(bg: BackgroundConfig) => void>();
    const { fromFile, busy, error } = useBackgroundImage(setBackground);

    const ok = await fromFile(imageFile("cover.webp", "image/webp"));

    expect(ok).toBe(true);
    expect(busy.value).toBe(false);
    expect(error.value).toBe("");
    expect(api.coverFromFile).toHaveBeenCalledTimes(1);
    const [uploaded, options] = vi.mocked(api.coverFromFile).mock.calls[0] ?? [];
    expect(uploaded).toBeInstanceOf(File);
    expect(uploaded?.name).toBe("cover.webp");
    expect(options).toEqual({ format: "jpeg", signal: expect.any(AbortSignal) });

    expect(setBackground).toHaveBeenCalledTimes(1);
    const background = setBackground.mock.calls[0][0];
    expect(background).toEqual({
      kind: "custom",
      custom: {
        data: expect.any(Uint8Array),
        mimeType: "image/jpeg",
        width: 0,
        height: 0,
        fileName: "cover.webp",
      },
    });
    expect(Array.from(background.custom?.data ?? [])).toEqual(JPEG_BYTES);
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it("keeps PNG responses working and reads their IHDR dimensions", async () => {
    vi.mocked(api.coverFromFile).mockResolvedValue(pngBlob(1600, 900));
    const setBackground = vi.fn<(bg: BackgroundConfig) => void>();
    const { fromFile } = useBackgroundImage(setBackground);

    const ok = await fromFile(imageFile("transparent.png", "image/png"));

    expect(ok).toBe(true);
    const background = setBackground.mock.calls[0][0];
    expect(background.custom?.mimeType).toBe("image/png");
    expect(background.custom?.width).toBe(1600);
    expect(background.custom?.height).toBe(900);
    expect(Array.from(background.custom?.data ?? [])).toEqual(Array.from(pngBytes(1600, 900)));
  });

  it("accepts a pasted blob and keeps the provided file name", async () => {
    vi.mocked(api.coverFromFile).mockResolvedValue(jpegBlob());
    const setBackground = vi.fn<(bg: BackgroundConfig) => void>();
    const { fromBlob } = useBackgroundImage(setBackground);

    const ok = await fromBlob(new Blob([new Uint8Array([9, 9])], { type: "image/png" }), "pasted.png");

    expect(ok).toBe(true);
    const uploaded = vi.mocked(api.coverFromFile).mock.calls[0]?.[0];
    expect(uploaded).toBeInstanceOf(File);
    expect(uploaded?.name).toBe("pasted.png");
    expect(uploaded?.type).toBe("image/png");
    expect(setBackground.mock.calls[0][0].custom?.fileName).toBe("pasted.png");
  });

  it("strips path separators and parent segments from file names", async () => {
    vi.mocked(api.coverFromFile).mockResolvedValue(jpegBlob());
    const setBackground = vi.fn<(bg: BackgroundConfig) => void>();
    const { fromBlob } = useBackgroundImage(setBackground);

    const ok = await fromBlob(
      new Blob([new Uint8Array([1])], { type: "image/png" }),
      "../evil\\..\\nested/cover.png",
    );

    expect(ok).toBe(true);
    expect(setBackground.mock.calls[0][0].custom?.fileName).toBe("cover.png");
  });

  it("derives a file name from the mime type when the pasted blob has no name", async () => {
    vi.mocked(api.coverFromFile).mockResolvedValue(jpegBlob());
    const setBackground = vi.fn<(bg: BackgroundConfig) => void>();
    const { fromBlob } = useBackgroundImage(setBackground);

    const ok = await fromBlob(new Blob([new Uint8Array([1])], { type: "image/jpeg" }));

    expect(ok).toBe(true);
    expect(vi.mocked(api.coverFromFile).mock.calls[0]?.[0].name).toBe("background.jpg");
    expect(setBackground.mock.calls[0][0].custom?.fileName).toBe("background.jpg");
  });

  it("rejects non-image files before uploading", async () => {
    const setBackground = vi.fn<(bg: BackgroundConfig) => void>();
    const { fromFile, error, busy } = useBackgroundImage(setBackground);

    const ok = await fromFile(imageFile("notes.txt", "text/plain"));

    expect(ok).toBe(false);
    expect(api.coverFromFile).not.toHaveBeenCalled();
    expect(setBackground).not.toHaveBeenCalled();
    expect(busy.value).toBe(false);
    expect(error.value).toBe("请选择图片文件");
  });

  it("rejects images larger than 10MB before uploading", async () => {
    const setBackground = vi.fn<(bg: BackgroundConfig) => void>();
    const { fromFile, error, busy } = useBackgroundImage(setBackground);
    const file = new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], "big.png", { type: "image/png" });

    const ok = await fromFile(file);

    expect(ok).toBe(false);
    expect(api.coverFromFile).not.toHaveBeenCalled();
    expect(busy.value).toBe(false);
    expect(error.value).toBe("图片不能超过 10MB");
  });

  it.each([
    [new ApiError(401, "UNAUTHORIZED", "请先登录"), "登录已失效，请重新登录"],
    [new ApiError(415, "UNSUPPORTED_IMAGE", "不支持的图片格式"), "图片格式不支持"],
    [new ApiError(429, "RATE_LIMITED", "请求过于频繁"), "请求过于频繁，请稍后再试"],
    [new ApiError(0, "NETWORK", "网络请求失败"), "网络异常，请检查网络后重试"],
    [new ApiError(500, "INTERNAL", "背景图处理失败"), "背景图处理失败"],
    [new ApiError(500, "INTERNAL", "internal error"), "背景图处理失败，请稍后重试。"],
  ])("maps %s to a friendly message", async (cause, expected) => {
    vi.mocked(api.coverFromFile).mockRejectedValue(cause);
    const setBackground = vi.fn<(bg: BackgroundConfig) => void>();
    const { fromFile, error, busy } = useBackgroundImage(setBackground);

    const ok = await fromFile(imageFile());

    expect(ok).toBe(false);
    expect(error.value).toBe(expected);
    expect(busy.value).toBe(false);
    expect(setBackground).not.toHaveBeenCalled();
  });

  it("rejects a response with an unknown content type", async () => {
    vi.mocked(api.coverFromFile).mockResolvedValue(
      new Blob([new Uint8Array([1, 2, 3, 4])], { type: "text/plain" }),
    );
    const setBackground = vi.fn<(bg: BackgroundConfig) => void>();
    const { fromFile, error, busy } = useBackgroundImage(setBackground);

    const ok = await fromFile(imageFile());

    expect(ok).toBe(false);
    expect(error.value).toBe("服务器返回的图片格式异常");
    expect(busy.value).toBe(false);
    expect(setBackground).not.toHaveBeenCalled();
  });

  it("rejects a png response with a bad header", async () => {
    vi.mocked(api.coverFromFile).mockResolvedValue(
      new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" }),
    );
    const setBackground = vi.fn<(bg: BackgroundConfig) => void>();
    const { fromFile, error } = useBackgroundImage(setBackground);

    const ok = await fromFile(imageFile());

    expect(ok).toBe(false);
    expect(error.value).toBe("服务器返回的图片格式异常");
    expect(setBackground).not.toHaveBeenCalled();
  });

  it("reports busy while the upload is running", async () => {
    let release: (blob: Blob) => void = () => {};
    const gate = new Promise<Blob>((resolve) => {
      release = resolve;
    });
    vi.mocked(api.coverFromFile).mockReturnValue(gate);
    const setBackground = vi.fn<(bg: BackgroundConfig) => void>();
    const { fromFile, busy } = useBackgroundImage(setBackground);

    const pending = fromFile(imageFile());
    expect(busy.value).toBe(true);

    release(jpegBlob());
    await expect(pending).resolves.toBe(true);
    expect(busy.value).toBe(false);
  });

  it("rejects a second upload while one is running", async () => {
    let release: (blob: Blob) => void = () => {};
    const gate = new Promise<Blob>((resolve) => {
      release = resolve;
    });
    vi.mocked(api.coverFromFile).mockReturnValue(gate);
    const setBackground = vi.fn<(bg: BackgroundConfig) => void>();
    const { fromFile, busy } = useBackgroundImage(setBackground);

    const first = fromFile(imageFile("one.webp"));
    expect(busy.value).toBe(true);

    await expect(fromFile(imageFile("two.webp"))).resolves.toBe(false);
    expect(api.coverFromFile).toHaveBeenCalledTimes(1);

    release(jpegBlob());
    await expect(first).resolves.toBe(true);
    expect(busy.value).toBe(false);
  });

  it("discards an in-flight response after clear", async () => {
    let release: (blob: Blob) => void = () => {};
    const gate = new Promise<Blob>((resolve) => {
      release = resolve;
    });
    vi.mocked(api.coverFromFile).mockReturnValue(gate);
    const setBackground = vi.fn<(bg: BackgroundConfig) => void>();
    const { fromFile, clear, busy } = useBackgroundImage(setBackground);

    const pending = fromFile(imageFile());
    const signal = vi.mocked(api.coverFromFile).mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);

    clear();
    expect(signal?.aborted).toBe(true);
    expect(busy.value).toBe(false);

    release(jpegBlob());
    await expect(pending).resolves.toBe(false);

    expect(setBackground).toHaveBeenCalledTimes(1);
    expect(setBackground).toHaveBeenLastCalledWith({ kind: "none" });
    expect(busy.value).toBe(false);
  });

  it("cancel aborts the upload without touching the current background", async () => {
    let release: (blob: Blob) => void = () => {};
    const gate = new Promise<Blob>((resolve) => {
      release = resolve;
    });
    vi.mocked(api.coverFromFile).mockReturnValue(gate);
    const setBackground = vi.fn<(bg: BackgroundConfig) => void>();
    const { fromFile, cancel, busy } = useBackgroundImage(setBackground);

    const pending = fromFile(imageFile());
    const signal = vi.mocked(api.coverFromFile).mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    expect(busy.value).toBe(true);

    cancel();

    expect(signal?.aborted).toBe(true);
    expect(busy.value).toBe(false);

    release(jpegBlob());
    await expect(pending).resolves.toBe(false);

    expect(setBackground).not.toHaveBeenCalled();
    expect(busy.value).toBe(false);
  });

  it("ignores cancel when no upload is running", () => {
    const setBackground = vi.fn<(bg: BackgroundConfig) => void>();
    const { cancel, busy } = useBackgroundImage(setBackground);

    expect(() => cancel()).not.toThrow();

    expect(busy.value).toBe(false);
    expect(setBackground).not.toHaveBeenCalled();
  });

  it("aborts a stalled upload after 15 seconds and reports a network error", async () => {
    vi.useFakeTimers();
    vi.mocked(api.coverFromFile).mockImplementation(
      (_file, options) =>
        new Promise<Blob>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    const setBackground = vi.fn<(bg: BackgroundConfig) => void>();
    const { fromFile, error, busy } = useBackgroundImage(setBackground);

    const pending = fromFile(imageFile());
    expect(busy.value).toBe(true);

    await vi.advanceTimersByTimeAsync(15_000);

    await expect(pending).resolves.toBe(false);
    expect(error.value).toBe("网络异常，请检查网络后重试");
    expect(busy.value).toBe(false);
    expect(setBackground).not.toHaveBeenCalled();
    const signal = vi.mocked(api.coverFromFile).mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(true);
  });

  it("clears the background and the previous error", async () => {
    vi.mocked(api.coverFromFile).mockRejectedValue(new ApiError(415, "BAD", "x"));
    const setBackground = vi.fn<(bg: BackgroundConfig) => void>();
    const { fromFile, clear, error } = useBackgroundImage(setBackground);
    await fromFile(imageFile());
    expect(error.value).toBe("图片格式不支持");

    clear();

    expect(setBackground).toHaveBeenCalledWith({ kind: "none" });
    expect(error.value).toBe("");
  });
});
