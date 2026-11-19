# 导出进度条 Implementation Plan

**Goal:** 导出时显示阶段进度：EPUB 真实百分比，HTML/TXT 阶段提示，PDF 不确定进度 + 已用时间。

**Spec:** 本次需求由用户确认（方案 1），无独立设计文档。

## Global Constraints

- 在 worktree `E:\Code\txt-epub\txt2book\.worktree\task-20261119-progress` 内工作；不提交。
- 不新增依赖；不修改服务端协议。
- 不人为延迟 HTML/TXT 导出。
- 无内联样式；中文 UI 文案。

## 共享接口

```ts
// src/core/converters/types.ts
export type ExportPhase = "preparing" | "generating" | "writing" | "downloading";
export interface ExportProgress {
  phase: ExportPhase;
  /** 0–100；null 表示不确定进度 */
  percent: number | null;
  message: string;
}
export interface ConvertHooks {
  onProgress?: (progress: ExportProgress) => void;
}
export interface BookConverter {
  convert(book: BookModel, options?: ConvertOptions, hooks?: ConvertHooks): Promise<Blob>;
}
```

行为：

| 格式 | 进度 |
|---|---|
| EPUB | `preparing` 0 → `generating` 使用 JSZip `metadata.percent` → `writing` 100 |
| HTML / TXT | `preparing` 10 → `writing` 80 → `writing` 100「正在准备下载…」 |
| PDF | `generating` percent null「正在生成 PDF，可能需要几十秒…」→ `downloading` 100 |

---

### Task 1: hooks 与各转换器上报

**Files:**
- Modify: `src/core/converters/types.ts`
- Modify: `src/core/converters/epub/index.ts`
- Modify: `src/core/converters/html/index.ts`
- Modify: `src/core/converters/txt/index.ts`
- Modify: `src/core/converters/pdf/index.ts`
- Create: `tests/exportProgress.test.ts`

- [ ] 给 `BookConverter.convert` 增加可选 `hooks`；EPUB 的 `buildEpub` 接受 hooks，并在 `zip.generateAsync` 的 onUpdate 回报 `metadata.percent`。
- [ ] HTML/TXT 在开始与完成处上报；PDF 在 fetch 前后上报不确定/下载。
- [ ] 测试：EPUB 的进度单调不减且最终 100；HTML/TXT 至少包含 preparing 与 writing；PDF 第一次 percent 为 null、最后为 100。

---

### Task 2: App 状态与导出面板进度 UI

**Files:**
- Modify: `src/App.vue`
- Modify: `src/components/ExportPanel.vue`
- Modify: `src/styles/app.css`
- Modify: `tests/App.test.ts`
- Modify: `tests/ExportPanel.test.ts`

- [ ] App：`exportProgress: Ref<ExportProgress | null>`，`exporting` 由它派生；导出前设为 preparing，hooks 更新，`finally` 清空；传给 ExportPanel。
- [ ] ExportPanel：新增 `progress` prop；busy 时在按钮下方渲染 `<progress>` + 消息 + 已用秒数；`percent === null` 时使用不确定样式。
- [ ] 已用时间：busy 变 true 时启动 1s 定时器，变 false 或卸载时清理；显示「已用 Ns」。
- [ ] `role="progressbar"` / `aria-live="polite"`；CSS 样式含 indeterminate 条纹，支持 `prefers-reduced-motion`。
- [ ] 测试：percent=40 时 `<progress value="40">`；percent=null 时无 value；消息与计时更新（fake timers）；导出完成/失败后进度消失。

## 完成标准

- 导出 EPUB 时进度条从 0 增长到 100。
- HTML/TXT 显示阶段并快速完成。
- PDF 显示不确定进度条与已用时间。
- 导出失败或完成后进度条消失，按钮恢复可用。
- 全量测试、typecheck、build 通过。
