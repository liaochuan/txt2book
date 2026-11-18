export type ToastKind = "info" | "success" | "error";

export interface Toast {
  id: string;
  message: string;
  kind: ToastKind;
  /** 可选的操作按钮文案，点击后触发 `action` 事件（如「撤销」）。 */
  actionLabel?: string;
}
