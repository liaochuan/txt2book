# txt2book

把 TXT 小说转换为 EPUB 电子书的 Web 工具。前端在浏览器里完成解析、预览与 EPUB 生成，文件不会上传；Node 服务端只负责登录认证、封面抓取/转换与静态资源托管。

## 功能列表

- 导入本地 TXT，自动识别编码（`jschardet`），也可手动指定 UTF-8 / GB18030 / Big5 / UTF-16LE。
- 自动识别卷、章、番外、楔子、尾声，生成可折叠的目录树。
- 章节编辑：重命名、删除（正文自动并入相邻章节）、删除卷（子章节提升为顶层章节），支持撤销。
- 章节目录搜索过滤。
- 实时预览：单章切换、连页模式与卷扉页预览，预览与导出共用同一套 XHTML 渲染逻辑；连页模式会在每卷第一章前插入卷扉页（卷名 + 卷首文字）。
- 五套排版主题：素白、纸墨、夜读、古卷、墨水屏，预览与导出效果一致。
- 高级排版与背景图：按元素调整字体、字号、行高、段距、首行缩进、对齐与颜色，支持预设背景与自定义图片；每套主题独立保存。
- 封面：从图片 URL 抓取或上传本地图片，服务端统一转换为 PNG（最长边 1600px）。
- 导出 EPUB 3：一个章节一个 XHTML，包含 `nav.xhtml`、`toc.ncx` 与封面，可选目录页、书名页与卷扉页；三个内容选项默认关闭。
- 单账号登录保护，登录与封面接口均有限流。
- 阅读主题独立于应用界面，仅作用于预览与导出内容。

## 章节识别规则

导入时先做预处理：按 `\r\n` / `\n` / `\r` 断行，去掉每行行首的半角与全角空白，保留空行与行内缩进。随后逐行判断标题：

- 标题行长度不超过 40 个字符，且不以 `。！？…；` 结尾，避免把正文句子误判成标题。
- 内置规则按 **卷 → 章 → 番外 → 楔子 → 尾声** 的顺序匹配。

### 卷

- `第一卷 风起`、`卷二`、`第三部 少年`、`上部 少年`、`卷三`。
- 卷开启新的分组；卷标题与下一个标题之间的内容作为卷说明，后续章节归入该卷。
- 第一个卷之前的章节不属于任何卷。

### 章

- `第一章 重逢`、`第一章重逢`、`第一回 甄士隐梦幻识通灵`、`Chapter 5`。
- 兼容旧格式：`1.Chapter0---1序` 这类“序号 + 章节名”的行。
- 中文数字支持 `零一二三四五六七八九十百千万两〇○` 与 `壹贰叁肆伍陆柒捌玖拾`，也支持全角阿拉伯数字。

### 番外

- `番外`、`番外篇 小满`、`番外一`、`外传：某某`。
- 番外章节会从原位置抽出，统一追加到目录末尾的“番外”分组。

### 楔子 / 尾声

- 楔子：`楔子`、`序章`、`序幕`、`序言`、`引子`、`序`。
- 尾声：`尾声`、`后记`、`终章`、`尾章`。

### 简介与兜底

- 第一个标题之前的非空内容自动成为“简介”章。
- 全文没有任何可识别标题时，整篇作为单章“正文”，不会丢失内容。
- 纯空白文件会提示没有可解析的正文。

### 自定义规则

在右侧“自定义识别规则”面板中可按正则新增规则，规则保存在浏览器 `localStorage`（键名 `txt2epub:customChapterRules`，兼容旧版数据）。每条规则包含：

- `pattern`：正则源码，不含首尾斜杠；可附加 `flags`。
- `capture`：取哪个捕获分组作为标题，缺省 `0`（整个匹配）；分组为空时回退整行。
- `kind`：命中类型，可选 `volume`、`chapter`、`extra`、`prologue`、`epilogue`。
- `enabled`：是否启用。

自定义规则优先于全部内置规则。单条正则非法时只跳过该条，不会让整本书解析失败；`g` / `y` 标志会被移除，保证逐行匹配行为一致。

## 主题

| id | 名称 | 说明 |
|---|---|---|
| `minimal` | 素白 | 无背景色、无衬线，适合快速浏览 |
| `paper` | 纸墨 | 米黄纸色、宋体、首行缩进，接近纸质书（默认） |
| `night` | 夜读 | 深灰底浅灰字、低对比，适合夜间阅读 |
| `classic` | 古卷 | 暖褐纸色、衬线、双线标题，古典排版 |
| `eink` | 墨水屏 | 高对比、无背景图、适合电纸书 |

主题只作用于 EPUB 内容与预览 iframe，不影响应用界面。新增主题在 `src/core/render/themes.ts` 中注册即可。

## 高级排版与背景

「排版」卡片中的高级排版按元素分别调整：卷标题、卷首文字、章标题、正文、简介与目录。可改字体、字号、行高、段间距、首行缩进、对齐、颜色与上下留白；改动即时反映到预览，导出时使用同一份 CSS。

- 每套主题独立保存排版与背景配置，键名 `txt2book.layout.<themeId>`；「恢复默认」只重置当前主题的排版，不影响其它主题。
- 背景支持纯 CSS 预设（纸纹、网格、点阵、亚麻）与自定义图片。自定义图上传后由服务端统一转码（最长边 1600px、上限 10MB），预览与 EPUB 使用同一张图。
- 墨水屏主题禁用背景图，并关闭卷扉页底线、连页分隔线等装饰，减少灰阶抖动与残影。

## 预览与卷扉页

- 预览覆盖正文、主题、高级排版与背景；封面页、书名页、简介页与目录页不在预览内，导出后才会出现。
- 点击目录树中的卷名可预览卷扉页：卷标题、卷首文字与该卷章节数；再次点击同一卷名，或点击任意章节，回到章节预览。
- 番外分组没有独立扉页，点击其名称只负责展开/折叠。连页模式仍按导出顺序在每卷第一章前插入卷扉页。

## 导出内容选项

| 选项 | 默认 | 说明 |
|---|---|---|
| 目录页 | 关闭 | 在正文前插入一页可翻阅的目录。关闭后阅读器自带的导航目录仍然可用，只是书里不出现目录页。 |
| 书名页 | 关闭 | 在封面后插入书名与作者页；有简介时仍会单独生成简介页。关闭后直接从正文开始。 |
| 卷扉页 | 关闭 | 为每个卷生成独立标题页，并展示卷首文字。关闭后卷首文字会以居中样式并入该卷第一章开头，不会丢失。 |

三个选项都不勾选时，EPUB 从正文开始；关闭卷扉页后，卷标题与卷首文字仍会以 `.volume-note-block` 区块出现在该卷第一章顶部，并继续应用卷首文字的高级排版。零章卷的卷首文字会并入其后第一章；若全书没有章节，仍会为这些卷生成卷扉页，避免文字丢失。

## 快速开始（npm）

要求 Node.js >= 22。

```bash
npm install
```

本地开发需要一份 `.env`（从 `.env.example` 复制并填写 `AUTH_PASSWORD_HASH`、`SESSION_SECRET`）：

```powershell
Copy-Item .env.example .env
```

```bash
# 终端 1：后端 API，监听 3000，自动加载 .env
npm run dev:server

# 终端 2：前端 Vite 开发服务器，/api 自动代理到 3000
npm run dev
```

本地开发可以先关闭登录（仅限本机）：

```bash
AUTH_DISABLED=true npm run dev:server
```

Windows PowerShell：

```powershell
$env:AUTH_DISABLED="true"; npm run dev:server
```

生产构建与启动：

```bash
npm run build          # 生成 dist/（前端）与 server-dist/（后端）
npm start              # 自动加载 .env，并以生产模式启动
```

服务端启动时会校验配置：缺少 `AUTH_PASSWORD_HASH` 或 `SESSION_SECRET`（少于 32 字符）将拒绝启动，只有显式设置 `AUTH_DISABLED=true` 才能跳过认证，且启动时会打印警告。

`npm run dev:server` 与 `npm start` 都会自动加载项目根目录的 `.env`（已存在时；不覆盖 shell 中已有的变量）。只有手动执行 `node server-dist/index.js` 时不会读取 `.env`，此时请改用 `node --env-file=.env server-dist/index.js`，或先在 shell 中导出变量（PowerShell 用 `$env:SESSION_SECRET="..."` 等）。

## 生成密码哈希

密码以 scrypt 哈希形式保存，不存明文。本地生成：

```bash
printf '%s' '你的密码' | npm run hash-password
```

或把密码作为参数：

```bash
npm run hash-password -- '你的密码'
```

把输出的哈希写入 `.env` 的 `AUTH_PASSWORD_HASH`。哈希本身含 `$` 字符，**写入 `.env` 时必须用单引号包裹**，否则 `docker compose` 会把 `$` 当作变量展开、导致哈希损坏、登录始终失败：

```dotenv
AUTH_PASSWORD_HASH='scrypt$16384$8$1$...'
```

生成命令里的密码也建议用单引号包住，避免 `$` 等字符被 shell 展开。

已构建镜像后，在 Docker 中生成（`-T` 关闭 TTY，标准输入才能正确传入）：

```bash
printf '%s' '你的密码' | docker compose run --rm -T txt2book node server-dist/scripts/hash-password.js
```

镜像内使用的是编译后的 `node server-dist/scripts/hash-password.js`，生产镜像不含 devDependency `tsx`，因此不能在容器里执行 `npm run hash-password`；该 npm 脚本需要完整 `npm install` 的开发环境。

### Windows PowerShell 等价命令

```powershell
# 生成密码哈希（需先 npm install）
npm run hash-password -- '你的密码'

# 生成 SESSION_SECRET
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"

# 复制配置示例
Copy-Item .env.example .env
```

镜像内生成哈希（参数形式）：

```powershell
docker compose run --rm -T txt2book node server-dist/scripts/hash-password.js '你的密码'
```

不要使用 `'密码' | npm run hash-password`：Windows PowerShell 5.1 会把管道文本转成控制台代码页，中文密码可能静默变成 `??`。PowerShell 7（`pwsh`）或先执行 `[Console]::OutputEncoding = [Text.Encoding]::UTF8` 时，管道形式也可以正常使用。

## Docker Compose 部署

1. 准备配置：

   ```bash
   cp .env.example .env
   ```

   PowerShell：`Copy-Item .env.example .env`。

2. 编辑 `.env`，至少填写：

   - `AUTH_USERNAME`：登录用户名。
   - `AUTH_PASSWORD_HASH`：上一步生成的哈希，务必用单引号包裹（见“生成密码哈希”）。本机没有 Node 时，先执行 `docker compose build`，再用上文的 Docker 命令生成。
   - `SESSION_SECRET`：运行 `openssl rand -base64 32` 生成，至少 32 字符。
   - `COOKIE_SECURE`：直接 http 访问时保持 `false`；HTTPS 反代后改为 `true`。
   - `TRUST_PROXY`：只有反向代理会覆盖 `X-Forwarded-For` / `X-Forwarded-Proto` 时才设为 `true`。

3. 构建并启动：

   ```bash
   docker compose up -d --build
   ```

   如果 `.env` 中的 `AUTH_PASSWORD_HASH` 或 `SESSION_SECRET` 仍未填写（或 `SESSION_SECRET` 少于 32 字符），服务会 fail-closed 拒绝启动；配合 `restart: unless-stopped`，容器会表现为反复重启。此时先执行 `docker compose logs --tail=100 txt2book` 查看缺失的配置项，补齐后重新 `docker compose up -d`。

4. 访问 `http://<服务器地址>:8080`，用配置的用户名与密码登录。

常用命令：

```bash
docker compose ps                      # 查看状态与健康检查
docker compose logs -f txt2book        # 跟踪日志
docker compose down                    # 停止并移除容器
docker compose up -d --build           # 更新代码后重建
```

健康检查请求 `GET /api/health`，正常返回 `{"ok":true}`；该接口无需登录，供容器与反向代理探活。

## HTTPS 反向代理

把服务放在 Nginx、Caddy、Traefik 等反向代理后时：

1. `.env` 中设置 `COOKIE_SECURE=true` 与 `TRUST_PROXY=true`。
2. 反向代理必须**覆盖**（而不是追加）`X-Forwarded-For` 与 `X-Forwarded-Proto`。若代理采用追加方式，客户端可以自带伪造头绕过按 IP 的登录限流。
3. 反向代理到容器 `3000` 端口（compose 映射到宿主机的 `8080`）。

Nginx 关键配置示例：

```nginx
location / {
    # 封面本地上传上限 10MB，multipart 还有少量开销；Nginx 默认只允许 1m，
    # 不放开会在上传封面时直接返回 413。
    client_max_body_size 12m;

    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

`client_max_body_size` 建议至少 `12m`；若只放在 `location` 中，对其他 location 不生效，也可以放到 `server` 或 `http` 块统一设置。

不要在 HTTPS 反代场景下保留 `COOKIE_SECURE=false`，否则会话 Cookie 可能经明文 HTTP 泄露；反之，直接 http 访问时设为 `true` 会导致浏览器不保存 Cookie、始终无法登录。

`TRUST_PROXY=true` 时，Fastify 会采用转发头中的客户端 IP 与协议；仅当你确认代理会覆盖这两个头时开启。

## 安全说明

- **登录认证**：单账号，密码使用 scrypt 哈希；会话 Cookie 为 HMAC-SHA256 签名的无状态令牌，`HttpOnly`、`SameSite=Strict`，可选 `Secure`；Cookie 内不含用户可修改的权限字段，签名校验使用常量时间比较。
- **登录限流**：同一 IP 与同一用户名各 5 次 / 15 分钟，超限返回 `429` 与 `Retry-After`；用户名不存在时也执行一次 scrypt 校验，避免通过响应时间枚举账号；失败文案统一。
- **封面接口限流**：抓取与上传共用同一个按 IP 的桶，默认 30 次 / 分钟（`RATE_LIMIT_PER_MIN`）。
- **SSRF 防护**：封面 URL 只允许 `http` / `https`；端口只允许 80/443/8080/8443 或不低于 1024 的常规端口，并排除常见内网服务端口（6379 Redis、9200/9300 Elasticsearch、27017/27018/27019 MongoDB、11211 Memcached、2375/2376 Docker、5432 PostgreSQL、3306 MySQL 等）；拒绝本机、内网、链路本地、CGNAT、组播、保留地址与 `localhost`、`*.local`、`*.internal`、`metadata` 等域名；DNS 解析后固定 IP 连接，并在每次重定向前重新校验，防止 DNS rebinding 与重定向绕过。
- **资源限制**：封面下载默认 10MB 上限、8 秒超时、输入不超过 4000 万像素，输出最长边缩放到 1600px；本地封面上传同为 10MB 上限。
- **CSRF**：会话 Cookie 使用 `SameSite=Strict`；带 `Origin` 头的非 GET/HEAD/OPTIONS 请求会校验同源。
- **XSS / 点击劫持**：正文按纯文本转义后生成 XHTML，预览 iframe 使用 sandbox；所有响应附带 `Content-Security-Policy`、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`。
- **配置失败即拒绝启动**：缺少密码哈希或过短的会话密钥时服务不会裸奔启动；`AUTH_DISABLED=true` 仅用于本地开发并会打印警告。
- **不落盘**：TXT、封面与导出文件均在内存中处理，服务端不写用户文件，也不提供上传目录。

## 配置项

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | 服务端口 |
| `AUTH_USERNAME` | `admin` | 登录用户名 |
| `AUTH_PASSWORD_HASH` | 无 | scrypt 密码哈希，必填 |
| `SESSION_SECRET` | 无 | 会话签名密钥，必填，至少 32 字符 |
| `SESSION_TTL_DAYS` | `30` | 会话有效期（天） |
| `COOKIE_SECURE` | `false` | HTTPS 部署时设为 `true` |
| `AUTH_DISABLED` | `false` | 仅本地开发；`true` 时跳过登录并打印警告 |
| `MAX_COVER_BYTES` | `10485760` | 封面下载上限（字节） |
| `COVER_TIMEOUT_MS` | `8000` | 封面下载超时（毫秒） |
| `RATE_LIMIT_PER_MIN` | `30` | 单 IP 封面接口每分钟次数 |
| `TRUST_PROXY` | `false` | 是否信任反向代理的 `X-Forwarded-For` / `X-Forwarded-Proto` |

`PORT` 是容器内监听端口，默认 `3000`。`docker-compose.yml` 的 `8080:3000` 与 healthcheck 里的 `127.0.0.1:3000` 都固定写死 `3000`；修改 `PORT` 时必须同步修改这两处（并按需调整 Dockerfile 的 `EXPOSE`），否则浏览器访问与健康检查都会失败。

## 目录结构

```text
src/                    前端源码
  components/           展示组件（目录树、预览、封面、导出、登录等）
  composables/          组件共享状态（认证、导入、封面、主题、提示）
  core/                 纯逻辑
    chapterParser.ts    内置章节识别
    customRules.ts      自定义规则存储与编译
    chapterOps.ts       重命名、删除、合并、撤销
    preprocess.ts       断行与行首清理
    render/             章节 XHTML 渲染与主题
    converters/         格式转换器注册表与 EPUB 实现
  styles/               CSS 变量与全局样式
  types/                前端类型
server/                 后端源码
  app.ts                Fastify 实例组装
  index.ts              启动入口（读取配置并监听）
  lib/                  配置、认证、会话、限流、SSRF、图片处理
  routes/               认证与封面路由
  scripts/              密码哈希脚本
tests/                  Vitest 测试与 fixtures
docs/                   设计与计划文档
dist/                   前端构建产物（生成）
server-dist/            后端编译产物（生成）
Dockerfile              多阶段构建
docker-compose.yml      单服务编排
.env.example            配置示例
```

## 测试

```bash
npm test        # Vitest 全量一次执行
npm run typecheck  # vue-tsc + tsc --noEmit
npm run build   # 构建前端与后端
```

测试覆盖章节解析（卷、番外、楔子、尾声混排）、章节操作与撤销、XHTML 渲染、EPUB 结构、SSRF 黑名单与重定向校验、认证与会话篡改、限流以及完整的导入导出集成流程。

## 已知限制

- **大文件在内存中处理**：TXT 由浏览器整体读入并解析，导出时整套书模型与 ZIP 也在内存中；封面在服务端内存中解码、缩放。超大的单文件可能触发浏览器或容器内存上限，建议单本控制在数十 MB 以内。
- **限流状态按进程保存**：限流桶存在内存中。多副本或多实例部署时每个副本独立计数，实际额度会随副本数放大；需要严格全局限流时应在反向代理层另加限流。
- **无服务端会话吊销**：会话是无状态签名 Cookie，退出登录只清除浏览器 Cookie，服务端不维护黑名单。已签发的 Cookie 在过期前仍可使用；更换 `SESSION_SECRET` 或密码后需要让所有旧会话失效时，重启服务并更换密钥。
- **仅实现 EPUB**：转换器注册表已预留多格式扩展，但当前只有 EPUB 可用，AZW3、MOBI、PDF 等格式尚未实现。
- **封面只输出 PNG**：为保证阅读器兼容性，所有封面统一转为 PNG，超大封面会被缩放并可能增大文件体积。
- **依赖漏洞待升级**：当前 `npm audit --omit=dev` 报告 2 high + 2 moderate。high 来自 `sharp` 及其 libvips/libheif/librsvg 依赖；moderate 来自 `@fastify/static` 传递依赖的 `minimatch`/`glob`。修复需要 breaking 升级（`sharp@0.35.5`、`@fastify/static@10`），升级后应重跑全量测试与封面 URL/上传转换验证，再更新镜像。
