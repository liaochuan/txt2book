import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TOAST_LIMIT,
  TOAST_TTL_MS,
  useToasts,
} from "../src/composables/useToasts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useToasts", () => {
  it("auto-dismisses a toast after the TTL", () => {
    const store = useToasts();
    store.push({ message: "已保存" });

    expect(store.toasts.value).toHaveLength(1);
    vi.advanceTimersByTime(TOAST_TTL_MS - 1);
    expect(store.toasts.value).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(store.toasts.value).toHaveLength(0);
  });

  it("keeps at most five toasts, dropping the oldest", () => {
    const store = useToasts();

    for (let index = 0; index < TOAST_LIMIT + 2; index += 1) {
      store.push({ message: `消息 ${index}` });
    }

    expect(store.toasts.value).toHaveLength(TOAST_LIMIT);
    expect(store.toasts.value.map((toast) => toast.message)).toEqual([
      "消息 2",
      "消息 3",
      "消息 4",
      "消息 5",
      "消息 6",
    ]);
  });

  it("dedupes the same message and restarts its timer", () => {
    const store = useToasts();
    store.push({ message: "已删除" });

    vi.advanceTimersByTime(TOAST_TTL_MS - 1000);
    store.push({ message: "已删除" });
    expect(store.toasts.value).toHaveLength(1);

    // 旧计时器若未清理，再过 1 秒就会把新提示一并移除。
    vi.advanceTimersByTime(TOAST_TTL_MS - 1);
    expect(store.toasts.value).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(store.toasts.value).toHaveLength(0);
  });

  it("runs the action once and dismisses the toast", () => {
    const store = useToasts();
    const action = vi.fn();
    const id = store.push({ message: "已删除", actionLabel: "撤销", action });

    store.action(id);

    expect(action).toHaveBeenCalledTimes(1);
    expect(store.toasts.value).toHaveLength(0);

    store.action(id);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("keeps toasts without an action until dismissed or expired", () => {
    const store = useToasts();
    const id = store.push({ message: "提示" });

    expect(store.toasts.value[0]?.actionLabel).toBeUndefined();
    store.dismiss(id);
    expect(store.toasts.value).toHaveLength(0);
  });
});
