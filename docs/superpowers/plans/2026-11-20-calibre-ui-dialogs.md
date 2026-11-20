# calibre-web UI 调整（设置与书库弹窗、仅推送）实施计划

**Goal:** 把 calibre-web 账户配置移到独立的「设置」弹窗，把书库选择移到独立的「书库」弹窗；导出面板增加「仅推送（不下载）」模式。

**Spec:** `docs/superpowers/specs/2026-11-19-calibre-web-integration-design.md` §7.2、§7.4（2026-11-20 调整）。

**Tech:** Vue 3 + TypeScript + Vitest + happy-dom；无新依赖。

## 全局约束

- 不 commit/push；沿用当前 worktree。
- 所有用户可见文案中文；代码/路径/字段英文。
- 弹窗必须可键盘关闭（Esc）、焦点进入/归还、遮罩点击关闭、`role="dialog"` + `aria-modal` + 标题关联。
- 不改变 `useCalibre` 的连接/分页/导入/推送逻辑；只改 UI 装配与导出模式。
- 现有本地导入、封面、EPUB/HTML/TXT/PDF 导出行为不变。

## 任务

1. **`AppDialog.vue` + 样式 + 测试**：通用弹窗容器；Teleport、遮罩、Esc、焦点、滚动锁。
2. **`CalibreSettingsDialog.vue` + 测试**：从 `CalibrePanel` 拆出账户表单/状态/修改/断开/忘记；提供「打开书库」。
3. **`CalibreLibraryDialog.vue` + 测试**：从 `CalibrePanel` 拆出搜索/TXT 过滤/列表/加载更多/导入；未连接时提示前往设置；导入成功关闭并 emit。
4. **`App.vue` 顶栏与装配**：新增「书库」「设置」按钮、弹窗状态、移除 `CalibrePanel`、登出/401 关闭弹窗、导入成功 Toast；更新 App 测试。
5. **`ExportPanel.vue` 推送模式**：`pushMode: "off" | "download-and-push" | "push-only"`；替换复选框；按钮与提示随模式变化；更新测试。
6. **`App.vue` `onExport` 仅推送**：`push-only` 不调用 `downloadBlob`；失败/取消提示不生成文件；更新 App 测试。
7. **文档与全量验证**：README 界面说明、设计文档已更新；`npm run typecheck`、`npm test`、`npm run build`。

## 文件

- Create: `src/components/AppDialog.vue`、`CalibreSettingsDialog.vue`、`CalibreLibraryDialog.vue`
- Modify: `src/App.vue`、`src/components/ExportPanel.vue`、`src/components/CalibreBookRow.vue`（importing 态）、`src/types/calibre.ts`、`src/styles/app.css`、`README.md`
- Delete: `src/components/CalibrePanel.vue`、`tests/CalibrePanel.test.ts`（拆成两个测试文件）
- Tests: `tests/AppDialog.test.ts`、`tests/CalibreSettingsDialog.test.ts`、`tests/CalibreLibraryDialog.test.ts`、`tests/App.test.ts`、`tests/ExportPanel.test.ts`

## 验收

- 顶栏「书库」「设置」可打开对应弹窗；同一时刻只开一个；Esc/遮罩/关闭按钮都能关。
- 账户信息只在「设置」弹窗；书库列表只在「书库」弹窗；左侧栏不再有常驻面板。
- 未连接时打开书库能看到「前往设置」并可跳转。
- 导入成功关闭书库弹窗并提示；失败留在弹窗内显示错误。
- 推送模式三选一；仅推送时不下载本地文件；成功/失败/取消提示准确。
- 全量测试、typecheck、build 通过。
