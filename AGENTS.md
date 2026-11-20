# AGENTS.md

## 项目

txt2book：TXT 小说转电子书工具。Vue 3 前端负责解析、预览与生成文件；Node 服务端负责登录认证、封面抓取/转换、静态托管与 calibre-web 代理。

- 设计文档：`docs/superpowers/specs/2026-11-17-txt2book-design.md`
- 计划与进度：`docs/superpowers/plans/`

## 技术栈

- 前端：Vue 3（Composition API）+ Vite + TypeScript
- 后端：Node 22 + Fastify + TypeScript
- 图片：sharp
- EPUB：JSZip（浏览器端生成，文件不上传）
- 测试：Vitest
- 部署：Docker 多阶段构建 + docker compose

## 命令

```bash
npm run dev        # 前端 Vite 开发服务器
npm run dev:server # 后端 tsx 监听模式
npm run typecheck  # vue-tsc + tsc --noEmit
npm test           # Vitest 全量一次执行
npm run build      # 构建前端与后端
npm run hash-password  # 生成 AUTH_PASSWORD_HASH
```

## 目录约定

```
src/            前端源码
  core/         解析、章节操作、渲染、转换器（纯逻辑，不依赖 DOM 以外的东西）
    calibre/    calibre-web OPDS 解析
  components/   展示组件（含 AppDialog / CalibreSettingsDialog / CalibreLibraryDialog / CalibreBookRow）
server/         后端源码
  lib/calibre/  calibre-web 地址策略、HTTP 客户端、登录/上传与加密配置
  routes/       路由，只做参数校验与响应
tests/          测试与 fixtures
docs/           设计与计划文档
```

- 纯逻辑放 `src/core/`，组件只做展示与事件转发。
- 转换器实现放 `src/core/converters/<format>/`，通过 `converterRegistry` 注册，UI 不写死格式。
- 后端路由只做参数校验与响应，业务逻辑放 `server/lib/`。
- calibre-web 代理只允许已连接的单个 origin；凭据不得写入日志或响应；连接与推送限流必须有测试。
- 样式统一走 `src/styles/tokens.css` 的 CSS 变量，不在模板里堆内联样式。
- 所有用户可见文案用中文；代码、路径、API 字段保持英文。

## 约定

- 提交由用户发起，agent 不执行 commit / push。
- 新增依赖前先说明理由。
- 安全相关代码（SSRF、认证、限流）必须有对应测试。
