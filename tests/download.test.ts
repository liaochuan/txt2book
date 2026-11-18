import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadBlob, REVOKE_DELAY_MS } from "../src/core/download";

const original = {
  create: Object.getOwnPropertyDescriptor(URL, "createObjectURL"),
  revoke: Object.getOwnPropertyDescriptor(URL, "revokeObjectURL"),
};

let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  createObjectURL = vi.fn(() => "blob:mock");
  revokeObjectURL = vi.fn();
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
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (original.create) Object.defineProperty(URL, "createObjectURL", original.create);
  else Reflect.deleteProperty(URL, "createObjectURL");
  if (original.revoke) Object.defineProperty(URL, "revokeObjectURL", original.revoke);
  else Reflect.deleteProperty(URL, "revokeObjectURL");
});

describe("downloadBlob", () => {
  it("clicks an attached link with the filename and removes it afterwards", () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const append = vi.spyOn(document.body, "appendChild");
    const blob = new Blob(["zip"], { type: "application/epub+zip" });

    downloadBlob(blob, "测试书.epub");

    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(append).toHaveBeenCalledTimes(1);
    const link = append.mock.calls[0]?.[0] as HTMLAnchorElement;
    expect(link.download).toBe("测试书.epub");
    expect(link.getAttribute("href")).toBe("blob:mock");
    expect(click).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector("a")).toBeNull();
  });

  it("revokes the object URL only after the delay", () => {
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    downloadBlob(new Blob(["zip"]), "书.epub");

    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(REVOKE_DELAY_MS - 1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock");
  });

  it("supports a custom revoke delay", () => {
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    downloadBlob(new Blob(["zip"]), "书.epub", 0);
    vi.advanceTimersByTime(0);

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock");
  });
});
