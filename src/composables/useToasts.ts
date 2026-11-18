import { getCurrentScope, onScopeDispose, ref, type Ref } from "vue";
import type { Toast, ToastKind } from "../types/toast";

/** 同时最多保留的提示数量，超出时丢弃最旧的一条。 */
export const TOAST_LIMIT = 5;
/** 提示自动消失时间；同文案重复推送会重置计时。 */
export const TOAST_TTL_MS = 10_000;

export interface ToastOptions {
  message: string;
  kind?: ToastKind;
  /** 操作按钮文案；与 `action` 同时提供时才显示按钮。 */
  actionLabel?: string;
  action?: () => void;
}

export interface ToastStore {
  toasts: Ref<Toast[]>;
  push(options: ToastOptions): string;
  dismiss(id: string): void;
  /** 先关闭提示，再执行挂载的回调（如撤销删除）。 */
  action(id: string): void;
}

/**
 * 轻提示队列。
 *
 * `Toast` 只保存可渲染的数据，回调放在独立 Map 中，
 * 避免把函数混进对外展示的提示对象。所有提示共享同一套
 * 数量上限、自动消失与同文案去重规则。
 */
export function useToasts(): ToastStore {
  const toasts = ref<Toast[]>([]);
  const actions = new Map<string, () => void>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let sequence = 0;

  function clearTimer(id: string): void {
    const timer = timers.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    timers.delete(id);
  }

  function dismiss(id: string): void {
    clearTimer(id);
    actions.delete(id);
    if (toasts.value.some((toast) => toast.id === id)) {
      toasts.value = toasts.value.filter((toast) => toast.id !== id);
    }
  }

  function scheduleDismiss(id: string): void {
    clearTimer(id);
    timers.set(
      id,
      setTimeout(() => {
        dismiss(id);
      }, TOAST_TTL_MS),
    );
  }

  function push(options: ToastOptions): string {
    // 同文案去重：先撤掉旧提示（含其回调与计时器），再按新提示重新计时。
    const duplicate = toasts.value.find((toast) => toast.message === options.message);
    if (duplicate) dismiss(duplicate.id);

    sequence += 1;
    const toast: Toast = {
      id: `toast-${sequence}`,
      message: options.message,
      kind: options.kind ?? "info",
    };
    if (options.actionLabel && options.action) {
      toast.actionLabel = options.actionLabel;
      actions.set(toast.id, options.action);
    }

    toasts.value = [...toasts.value, toast];
    while (toasts.value.length > TOAST_LIMIT) {
      const oldest = toasts.value[0];
      if (!oldest) break;
      dismiss(oldest.id);
    }

    scheduleDismiss(toast.id);
    return toast.id;
  }

  function action(id: string): void {
    const callback = actions.get(id);
    dismiss(id);
    callback?.();
  }

  // 组件销毁时清掉计时器，避免测试或热更新后残留回调。
  if (getCurrentScope()) {
    onScopeDispose(() => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      actions.clear();
    });
  }

  return { toasts, push, dismiss, action };
}
