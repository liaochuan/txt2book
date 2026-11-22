# txt2book 设计文档

日期：2026-11-17
状态：待确认

## 1. 意图与背景

现有的 `txt-to-epub` 是一个纯前端 SPA：读 TXT、按“第 X 章”切章、用 JSZip 拼 EPUB。它验证了核心链路，但有几个硬限制：章节模型是扁平的，不能表达“卷 → 章”；封面只能上传本地文件，webp 能否进 EPUB 取决于阅读器；导出内容的排版只有一套最朴素的样式；没有部署方案。

本项目在它的基础上做一个独立的新工具，目标是把“把下载来的 TXT 小说整理成一本像样的电子书”这件事做完整：识别卷/番外结构、在章节列表里直接删章并自动并入上一章、从在线地址取封面并统一转成 PNG、导出前实时预览、导出时可选择排版主题，并且能用 Docker Compose 一条命令部署。

## 2. 目标 / 非目标

### 目标

- 支持 TXT（UTF-8 / GB18030 / Big5 等）读取与编码自动识别。
- 章节识别覆盖：章、卷、番外、楔子/序章/引子、尾声/后记；保留并兼容现有的自定义正则规则。
- 数据结构支持“卷 → 章”两级，番外作为独立分组排在正文之后。
- 章节列表可直接删除章节，被删章节正文自动并入上一个章节；支持撤销。
- 封面支持本地文件与在线 URL（webp / png / jpg / gif / avif / bmp），统一转换为 PNG 后写入 EPUB。
- 导出前在页面内实时预览正文与排版主题。
- 提供 4 套可选排版主题，预览与导出共用同一套渲染逻辑。
- 输出格式做接口抽象，当前只实现 EPUB，后续加格式不改 UI 和数据结构。
- 提供 Docker Compose 部署，并提供单账号登录认证，避免公开部署后封面抓取接口被任意使用。

### 非目标

- 不做在线书源抓取、不做 TXT 下载。
- 不做用户系统、不做云端存储；服务端无状态。认证只有单账号登录，不做注册、多用户与角色权限。
- 本阶段不实现 EPUB 之外的格式（PDF / MOBI / AZW3 只留接口）。
- 不做竖排排版、不做字体文件嵌入。
- 不做 OCR。

### 反目标（即使能跑也算失败）

- 预览效果与导出效果不一致。
- 在线封面抓取可以被用来访问内网资源。
- 删除章节导致正文丢失或顺序错乱，且无法撤销。
- 解析规则复杂到普通用户无法理解和调整。

## 3. 用户与场景

单一用户场景：手上有几 MB 的 TXT 小说，想快速得到一本有封面、有卷目录、排版舒服的 EPUB，放进阅读器看。

关键路径：上传 TXT → 看解析结果 → 删掉广告/重复章节 → 填书名作者 → 贴封面 URL → 选主题预览 → 导出。

## 4. 技术选型

| 项 | 选择 | 理由 |
|---|---|---|
| 前端 | Vue 3 + Vite + TypeScript | 沿用现有项目，迁移成本最低 |
| 后端 | Node 22 + TypeScript + Fastify + @fastify/cookie | 轻量、TS 同栈；Fastify 自带 schema 校验与 multipart |
| 认证 | 单账号密码 + `node:crypto` scrypt + HMAC 签名 Cookie | 无数据库、无状态；不需要引入完整用户体系 |
| 图片处理 | sharp | webp/avif 转 PNG 的事实标准，Docker 下有预编译产物 |
| ZIP / EPUB | JSZip（前端） | 沿用现有实现，纯前端生成，文件不上传 |
| 状态管理 | Vue `reactive` + composable | 应用规模不需要 Pinia |
| 测试 | Vitest（前端 + 后端） | 现有项目已用，统一 |
| 部署 | 多阶段 Dockerfile + docker compose | 单服务同时托管静态资源与 API |

## 5. 项目结构

```
txt2book/
  src/                        # 前端
    main.ts
    App.vue
    types/book.ts             # BookModel / Volume / Chapter / Theme
    core/
      textReader.ts           # 编码识别与读取（沿用）
      preprocess.ts           # 行预处理（沿用，增强）
      chapterParser.ts        # 卷/章/番外识别
      chapterOps.ts           # 删除合并、重命名、撤销
      cover.ts                # 封面获取与本地预览
      converters/
        types.ts              # BookConverter 接口 + 注册表
        epub/
          index.ts            # EPUB 转换器入口
          xhtml.ts            # XHTML 生成
          opf.ts              # OPF / nav / container
          themes.ts           # 主题 → CSS
      render/
        renderChapter.ts      # 预览与导出共用的正文 HTML 渲染
    components/
      AppHeader.vue
      UploadPanel.vue
      ChapterTree.vue
      ChapterPreview.vue
      BookMetaPanel.vue
      CoverPanel.vue
      ThemePanel.vue
      PreviewPane.vue
      ExportPanel.vue
      ToastStack.vue
    styles/
      tokens.css
      app.css
  server/
    index.ts                  # Fastify 入口 + 静态托管
    routes/auth.ts            # 登录 / 登出 / 当前用户
    routes/cover.ts           # 封面抓取 / 转换（需登录）
    lib/session.ts            # HMAC 签名 Cookie 签发与校验
    lib/password.ts           # scrypt 哈希与常量时间校验
    lib/ssrf.ts               # URL 与 IP 校验
    lib/image.ts              # sharp 转换
    lib/rateLimit.ts
    scripts/hash-password.ts  # 生成 AUTH_PASSWORD_HASH
  tests/
    parser.test.ts
    chapterOps.test.ts
    epub.test.ts
    render.test.ts
    server/ssrf.test.ts
    server/cover.test.ts
  Dockerfile
  docker-compose.yml
  vite.config.ts
  package.json
  README.md
```

## 6. 核心数据模型

```ts
type ChapterKind = "intro" | "chapter" | "extra" | "prologue" | "epilogue";

interface Chapter {
  id: string;
  title: string;
  originalTitle?: string;
  kind: ChapterKind;
  lines: string[];          // 正文行，已 trim
  volumeId?: string | null; // 所属卷
}

interface Volume {
  id: string;
  title: string;
  originalTitle?: string;
  kind: "volume" | "extra-group";
  lines?: string[];         // 卷首文字（可选）
}

interface BookModel {
  meta: { title: string; author: string; language: "zh-CN" | "en"; description?: string };
  volumes: Volume[];        // 允许为空：无卷的书
  chapters: Chapter[];      // 扁平存储 + volumeId 归属，渲染时再分组
  cover?: { png: Uint8Array; width: number; height: number } | null;
}
```

采用“扁平 chapters + volumeId”而不是嵌套数组，是为了删除/合并/排序只操作一个数组，避免深层递归。

## 7. 章节识别

### 7.1 规则来源与优先级

用户自定义规则优先，内置规则兜底。任意一条命中即视为标题行。

自定义规则新增可选字段 `kind: "volume" | "chapter" | "extra" | "prologue" | "epilogue"`，缺省为 `chapter`，与现有 localStorage 中已保存的规则向后兼容（旧规则读入时补 `chapter`）。用户在规则面板里可以声明“这条规则命中的是卷 / 番外 / 章”。

改规则不自动重解析：点「重新解析」时才生效，且若已有改名/删除/合并操作，先弹确认（会丢弃这些操作，但可通过撤销恢复）。

标题行判定统一加严：整行匹配（允许标题后的短书名/副题）、去掉首尾空白后长度不超过 40 字、且不以 `。！？…；` 结尾。这样 `序辦腊…` 这类正文不会被误判为“序”。

内置规则覆盖：

| 类型 | 示例 |
|---|---|
| 卷 | `第一卷 风起`、`卷三`、`第3卷`、`第一部 少年` |
| 章 | `第一章 重逢`、`第12章`、`Chapter 5` |
| 番外 | `番外`、`番外篇 小满`、`番外一`、`外传：某某` |
| 楔子 | `楔子`、`序章`、`序`、`引子` |
| 尾声 | `尾声`、`后记`、`终章` |
| 上部/中部/下部 | 识别为卷 |

### 7.2 结构装配

- 第 X 卷 开启一个新卷，后续章节归属该卷，直到下一个卷。
- 第一个卷之前的章节 `volumeId = null`，渲染时位于目录根部。
- 番外类标题归入“番外”分组，`kind = "extra"`。该分组在解析时就物化为 `Volume{kind:"extra-group"}`，并且**无论番外出现在哪一卷，都从原卷抽出、统一排到全书末尾**；`chapters` 数组的顺序即为最终顺序，spine 与 nav 都按这个顺序生成，避免“目录顺序与翻页顺序不一致”。
- 楔子 / 序 / 序章 / 引子 / 序幕 → `kind = "prologue"`，正文按原位置参与排序。
- 尾声 / 后记 / 终章 → `kind = "epilogue"`，按原位置排序（通常位于正文之后、番外之前）。
- 文件开头到第一个标题之间的非空内容 → “简介”章（`kind = "intro"`），不参与卷归属。
- 若完全没有识别到任何标题：整篇作为单章，标题“正文”。

### 7.3 当前章的边界

一行是标题，则它的正文是下一个标题行之前的全部内容。

### 7.4 编码

自动识别之外保留手动覆盖：`auto / UTF-8 / GB18030 / Big5 / UTF-16LE`。前端保留原始 `ArrayBuffer`，切换编码后重新解码并重新解析（沿用现有 `textReader` 的能力，签名增加“返回原始字节”）。jschardet 对 Big5 与 GB18030 的区分不可靠，手动切换是必要的兜底。

## 8. 章节操作

| 操作 | 行为 |
|---|---|
| 重命名 | 直接改 `title`，保留 `originalTitle` 供“恢复原名” |
| 删除并合并到上一章 | 被删章节的正文追加到全书顺序上的上一个章节末尾；若它已经是全书第一章，则并入下一个章节开头；全书只有一章时禁用删除 |
| 删除卷 | 卷下章节提升到根级、正文不合并；卷标题丢弃；可撤销 |
| 删除番外分组 | 同删除卷 |
| 撤销 | 维护最近 20 步快照，Toast 提供“撤销” |

关于卷边界：删除某卷的第一章时，正文会并入**上一卷的最后一章**（而不是同卷下一章），因为用户的心智模型是“并到上一章”。若该卷是全书第一卷，则并入同卷下一章开头。合并时正文以空行分隔追加，不重排段落。

撤销快照的对象是整个 `BookModel`（`meta`、`volumes`、`chapters`、`cover` 引用）。`cover` 存的是不可变对象引用，快照只复制引用，不复制 PNG 字节。

删除按钮直接出现在章节列表每一行，不弹确认框，靠撤销兜底。删除后若当前选中项是它，自动选中相邻章节。

## 9. 预览

- 右侧（移动端在下方）预览面板，用 `<iframe srcdoc>` 渲染，隔离主题 CSS，避免影响应用自身样式。
- 顶部可切换章节；主题面板切换主题时预览即时更新。
- 预览复用 `renderChapter.ts`，导出时同一函数输出 XHTML body 片段，保证“所见即所得”。
- 预览额外提供“连页模式”：按顺序拼接全部章节，模拟阅读器滚动效果（只渲染当前主题，不做分页）。

## 10. 排版主题

共 4 套，均为纯 CSS，不嵌入字体，使用系统字体栈：

1. **素白 minimal**：无背景色、无衬线、段间距 0.6em、标题左对齐细线。
2. **纸墨 paper**：米黄纸色、宋体、首行缩进 2em、标题居中、章节页上方装饰线。默认主题。
3. **夜读 night**：深灰底浅灰字、低对比、行高 1.9、标题不抢眼。
4. **古卷 classic**：暖褐纸色、衬线、章节标题带双线边框、场景分隔符使用 `❖`。

每套主题定义：`body` 背景/文字色、字体栈、字号、行高、段间距、首行缩进、标题样式、分隔线样式、封面页样式。

主题同时作用于：正文页、卷首页、目录页、封面页、简介页。

## 11. 内容美化

导出与预览共用的正文处理：

- 行 trim、连续空行折叠为段落分隔。
- 每个非空行生成 `<p>`；诗歌/短行保持原样。
- 仅含 `***`、`* * *`、`———`、`◇◇◇` 等的行识别为场景分隔符，渲染为 `<hr class="scene-break">`。
- 章节标题不再重复写进正文首行（解析时已剥离）。
- 章节页只包含一份可见标题；目录锚点由外层 `<section id="chapter-N">` 承担。
- 全书增加：封面页、书名页（书名/作者）、简介页（有简介时）、目录页。
- OPF 补全 `dc:creator`、`dc:description`、`dc:language`、`dcterms:modified`、`cover-image` 属性。
- `nav.xhtml` 使用嵌套 `<ol>` 表达卷 → 章；番外分组同样嵌套；同时生成 `toc.ncx` 兼容旧阅读器。

## 12. 封面

### 12.1 前端

- 上传本地文件，或粘贴 URL。
- 本地文件也走后端转换，保证输出 100% 是 PNG（统一路径，避免前端 canvas 的跨域与色彩差异）。
- 预览区显示后端返回的 PNG，并展示原始尺寸 → 转换后尺寸。

### 12.2 后端接口

```
POST /api/cover/from-url   { url: string }        -> image/png
POST /api/cover/from-file  multipart(file)        -> image/png
GET  /api/health                                   -> { ok: true }
```

处理流程：校验来源 → 下载（流式，限 10MB，超时 8s）→ 校验 content-type 与文件头 → sharp 解码（限制像素数 40MP）→ 缩放到最长边不超过 1600px → 输出 PNG（无损）。

### 12.3 SSRF 防护（必须实现，不是可选项）

- 仅允许 `http:` / `https:`，禁止带用户名密码的 URL。
- 解析域名得到全部 IP，任一 IP 命中私有/回环/链路本地/CGNAT/组播/保留段即拒绝。
- 用校验后的 IP 固定连接（自定义 `lookup`），防止 DNS 重绑定。
- 最多跟随 3 次重定向，每次重新校验。
- 只接受 `image/*`；按文件头判断真实格式，不信任 `Content-Type`。
- 响应体上限 10MB，超时 8s，sharp `limitInputPixels` 40MP。
- 按 IP 限流 30 次/分钟；返回统一错误，不暴露内网细节。
- 不返回上游响应头，只返回 PNG 字节。

## 13. 认证与访问控制

### 13.1 模型

单账号，无数据库、无注册、无多用户：

- `AUTH_USERNAME`（默认 `admin`）
- `AUTH_PASSWORD_HASH` 必填，格式 `scrypt$N$r$p$salt$hash`
- `SESSION_SECRET` 必填，用于签名会话 Cookie

缺少 `AUTH_PASSWORD_HASH` 或 `SESSION_SECRET` 时服务**拒绝启动**（fail closed）。本地开发可显式设 `AUTH_DISABLED=true` 关闭，启动日志打印醒目警告。提供 `npm run hash-password` 生成哈希。

### 13.2 登录与会话

```
POST /api/auth/login   { username, password }
POST /api/auth/logout
GET  /api/auth/me
```

- 密码用 `node:crypto` 的 scrypt 校验，`timingSafeEqual` 比较。
- 会话 Cookie `txt2book_session`：HttpOnly、SameSite=Strict、Path=/、`COOKIE_SECURE` 控制 Secure、有效期 30 天。
- 会话内容 `{ sub, iat, exp }` 用 HMAC-SHA256 + `SESSION_SECRET` 签名，服务端不保存会话表。
- 登录失败统一返回“用户名或密码错误”，不区分账号不存在与密码错误。
- 登录限流：每 IP 5 次 / 15 分钟，每用户名 5 次 / 15 分钟，超限 429。

### 13.3 访问控制

- 公开：`POST /api/auth/login`、`GET /api/auth/me`、`GET /api/health`。
- 其余 `/api/*`（含封面抓取与转换）必须携带有效会话，否则 401。
- 静态资源不做鉴权（不含敏感数据）；未登录时前端只渲染登录页，不加载主界面数据。
- 所有 POST 校验 `Origin` 与 Host 同源；配合 SameSite=Strict 防 CSRF。
- 认证失败与限流错误不区分具体原因，不记录密码或 Cookie 到日志。

### 13.4 与反向代理的关系

登录放在应用内，用户可直接获得登录页；反向代理仍建议追加一层限流。若由反代做 TLS 终止，需要设置 `TRUST_PROXY=true` 且只信任明确的反代地址，否则 IP 限流可被 `X-Forwarded-For` 伪造绕过。

## 14. 输出格式抽象

```ts
interface ConverterMeta {
  id: string;             // "epub"
  label: string;          // "EPUB"
  extension: string;      // "epub"
  mimeType: string;
  available: boolean;     // false 时 UI 显示“即将支持”
}

interface BookConverter extends ConverterMeta {
  convert(book: BookModel, options: ConvertOptions): Promise<Blob>;
}

interface ConvertOptions {
  themeId: ThemeId;
  includeTocPage: boolean;     // 默认 true
  includeTitlePage: boolean;   // 默认 true
  includeVolumePages: boolean; // 默认 true：为每个卷生成卷扉页
}
```

EPUB 内部结构固定：**一个章节一个 XHTML**，卷只生成卷扉页与目录分组，不把整卷合并成一个文件。这样导航锚点、主题作用域、阅读器分页都最简单。`nav.xhtml` 始终生成并在 manifest 中声明（EPUB 3 必需）；`includeTocPage = false` 时不进 spine，避免忽略 `linear="no"` 的阅读器把目录当成第一章正文。书名页与卷扉页同样可关闭。

`renderChapter.ts` 的输出契约是“XHTML body 片段”，预览时直接注入 iframe，导出时包进完整 XHTML 文档，两条路径共用。

注册表 `converterRegistry` 按 id 暴露；`ExportPanel` 只读注册表，不写死 EPUB。后续新增格式只需新增实现并注册。

## 15. 界面

单页，三栏响应式：

- 顶部：品牌标题、格式选择、导出按钮、状态。
- 左栏：章节目录树（卷可折叠、每行删除/重命名/合并按钮、搜索过滤）。
- 中栏：预览面板（章节切换、连页模式、主题切换）。
- 右栏：书籍信息、封面、排版主题、导出选项、自定义识别规则（折叠）。

视觉方向：浅色底 + 深墨绿主色 + 细边框卡片，去装饰化；移动端折叠为纵向单列。统一 CSS 变量，避免散落内联样式（现有项目大量内联样式，这次重构掉）。

状态处理：空态（未上传）、加载态（解析中/取封面中/导出中）、错误态（文件读失败/URL 被拒/封面解码失败）、未登录态（登录页），均有明确文案。

登录页：单卡片居中，用户名 + 密码 + 登录按钮，失败提示统一文案；登录后进入主界面，右上角显示用户名与退出。

## 16. 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | 服务端口 |
| `AUTH_USERNAME` | `admin` | 登录用户名 |
| `AUTH_PASSWORD_HASH` | 无 | scrypt 密码哈希，必填 |
| `SESSION_SECRET` | 无 | 会话签名密钥，必填，至少 32 字符 |
| `SESSION_TTL_DAYS` | `30` | 会话有效期 |
| `COOKIE_SECURE` | `false` | HTTPS 部署时设为 true |
| `AUTH_DISABLED` | `false` | 仅本地开发；true 时跳过登录并打印警告 |
| `MAX_COVER_BYTES` | `10485760` | 封面下载上限 |
| `COVER_TIMEOUT_MS` | `8000` | 下载超时 |
| `RATE_LIMIT_PER_MIN` | `30` | 单 IP 封面接口限流 |
| `TRUST_PROXY` | `false` | 是否信任反向代理的 X-Forwarded-For |

## 17. 部署

多阶段 Dockerfile：

1. `node:22-alpine` 安装依赖、构建前端 `dist/`、编译后端 `server-dist/`。
2. 运行阶段只保留 `dist/`、`server-dist/`、生产依赖，非 root 用户运行。

`docker-compose.yml`：

```yaml
services:
  txt2book:
    build: .
    ports: ["8080:3000"]
    env_file: [.env]
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
```

`.env.example` 提供 `AUTH_USERNAME`、`AUTH_PASSWORD_HASH`、`SESSION_SECRET` 三个占位与生成命令；`SESSION_SECRET` 用 `openssl rand -base64 32` 生成，密码哈希用 `docker compose run --rm txt2book node server-dist/scripts/hash-password.js`。

README 写明 `docker compose up -d --build`、首次配置、HTTPS 反向代理（`COOKIE_SECURE=true` + `TRUST_PROXY=true`）与限流注意事项。

## 18. 测试策略

| 范围 | 用例 |
|---|---|
| 章节解析 | 卷、章、番外、楔子、尾声混排；无标题兜底；简介提取；自定义规则优先 |
| 章节操作 | 删除中间章并入上一章、删除首章并入下一章、删除卷提升子章、撤销恢复 |
| 渲染 | 段落/空行/场景分隔符输出；主题 CSS 变量落地；XHTML 转义 |
| EPUB | 解压校验 mimetype、container、opf manifest/spine、nav 嵌套、封面 PNG、toc.ncx |
| 服务端 | SSRF 黑名单（127.0.0.1、10.x、169.254.169.254、::1、内网域名）、重定向校验、超大文件拒绝、webp→png 转换 |
| 认证 | 正确/错误密码；scrypt 哈希格式；会话签名篡改被拒；过期会话被拒；未登录访问封面接口返回 401；登录限流触发 429；缺少 `SESSION_SECRET` 时启动失败 |
| 集成 | 复用现有 `tests/fixtures` 的两份 TXT 跑完整解析，另外新增一份手工编写的 `structured.txt` fixture，覆盖卷 / 番外 / 楔子 / 尾声 / 卷内番外 / 误判诱饵行 |

命令：`npm test`、`npm run typecheck`、`npm run build`。

## 19. 安全风险

| 风险 | 等级 | 说明与缓解 |
|---|---|---|
| SSRF（封面代理） | 高 | 任意 URL 抓取可被用于探测内网。缓解：**必须登录**、IP 黑名单 + 解析后固定 IP + 重定向复检、限流 |
| 认证绕过 | 高 | 会话伪造或密码爆破。缓解：HMAC-SHA256 签名 + 常量时间比较、scrypt 哈希、HttpOnly + SameSite=Strict、登录限流、失败文案统一；Cookie 不含用户可改字段 |
| 资源耗尽 | 中 | 大图/超大文件打爆内存。缓解：10MB 上限、8s 超时、40MP 限制、sharp 缩放 |
| 公开部署被滥用 | 中 | 登录账号仍可把代理当图片中转。缓解：限流、无缓存、不返回原始字节、单账号便于整体封禁 |
| 配置失误 | 中 | 忘记设 `AUTH_PASSWORD_HASH`/`SESSION_SECRET` 导致裸奔。缓解：缺配置拒绝启动；`AUTH_DISABLED=true` 必须显式设置且启动告警 |
| CSRF | 低 | 跨站诱导已登录用户发起请求。缓解：SameSite=Strict + Origin 校验 |
| 上传路径穿越 | 低 | 不落盘，全部内存处理，不拼路径 |
| XSS | 低 | 正文按纯文本转义后生成 XHTML；预览 iframe 使用 sandbox |

## 20. 遗留决定（由实现者判断）

- 卷内章节超过 500 时目录虚拟滚动的实现方式。
- 是否把自定义规则面板做成一屏可见（默认折叠）。
- 封面 1600px 上限是否对超长条封面额外限制比例。

## 21. 验收标准

1. 用新增的 `structured.txt` 能正确解析出卷、章、番外、楔子、尾声，目录层级正确；现有两份 fixture 解析结果不劣化。
2. 在章节列表点删除，正文进入上一章，可撤销。
3. 粘贴一个 webp 封面 URL，返回 PNG 并在预览中显示。
4. 切换 4 套主题，预览即时变化；导出的 EPUB 在阅读器中效果与预览一致。
5. 导出的 EPUB 通过 epubcheck（无致命错误）。
6. `docker compose up -d --build` 后浏览器可访问，未登录时只能看到登录页，登录后可完成一次完整导出。
7. 内网地址（`127.0.0.1`、`10.0.0.1`、`169.254.169.254`）请求封面接口被拒绝；未登录调用同一接口返回 401。
