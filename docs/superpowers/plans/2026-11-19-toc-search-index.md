# PDF 目录跳转与 HTML 目录搜索实施计划索引

**Goal:** 让 PDF 目录页可点击跳转，并把单文件 HTML 升级为带侧栏目录与搜索的离线阅读页。

**Spec:** 用户确认的方案，无独立设计文档。

## 执行顺序

| 顺序 | 计划 | 交付 |
|---|---|---|
| 1 | `2026-11-19-pdf-toc-links.md` | PDF 目录链接注释 + 命名目标 + 测试 |
| 2 | `2026-11-19-html-sidebar.md` | HTML 侧栏目录 + 全文搜索 + 移动端折叠 |

## 全局约束

- 在 worktree `.worktree/task-20261119-toc-search` 内工作；不提交。
- 不新增依赖。
- HTML 仍为单文件、无外部网络请求；脚本只能操作自身 DOM，不得使用 `innerHTML` 插入书内容。
- PDF 不改变现有分页、目录页码、书签与字体逻辑。
- 现有 956 个用例必须保持通过。

## 共享约定

- PDF 目标名：`chapter-<N>`、`volume-<N>`，仅 ASCII。
- HTML 侧栏元素 id：`book-sidebar`、`book-search`、`book-search-results`、`book-sidebar-toggle`。
- 搜索范围：章节标题 + 正文；最多显示 50 条；输入防抖 200ms；片段 60 字。

## Review Focus

- PDF 链接注释的目标页是否与目录页码一致。
- HTML 搜索是否出现 XSS（书内容不得进入 innerHTML）；超大书是否卡死主线程。
- 移动端侧栏是否遮挡正文、能否关闭。
- 单文件是否仍无外链。
