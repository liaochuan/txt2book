# calibre-web 书库对接设计

- 日期：2026-11-19
- 状态：待批准（独立评审已完成，评审问题已处理）
- 关联：`2026-11-17-txt2book-design.md`

## 1. 意图

txt2book 目前只能从本地选择 TXT，转换完成后下载到浏览器。用户的书库在 calibre-web（独立部署，当前与 txt2book 同机 Docker，后续可能迁移；统一通过域名访问）。

希望把「书库 → 转换 → 回库」串起来：

1. 在 txt2book 里填写 calibre-web 的地址、账号、密码并连接。
2. 拉取书库中的书籍列表，可切换「只看有 TXT 的」。
3. 直接取某本书的 TXT 导入转换页面。
4. 如果该书在 calibre-web 里有封面和简介，一并填入书籍信息。
5. 转换成功后把 EPUB 推回**同一本书**下（作为新增格式），不新建书目、不改动原有元数据。

## 2. 目标 / 非目标

### 目标

- 连接配置只填一次；地址、账号、密码都能在界面里修改，密码不回显。
- 连接配置加密保存：重启 txt2book 或从其他浏览器/设备登录后，如果配置已存在，直接复用，无需重新输入密码。
- 书籍列表支持分页、关键词搜索、按是否有 TXT 过滤。
- 一键导入 TXT；自动填写书名、作者、简介、封面。
- EPUB 导出成功后可直接推送回 calibre-web 的当前书籍。
- 所有失败都有中文、可行动的提示；推送失败不影响本地文件下载。
- 读取与推送都只针对「已连接的那个 calibre-web 实例」，不开放任意 URL 代理。

### 非目标（v1 不做）

- 不支持 calibre 原生内容服务器（`calibre-server`）；仅做 calibre-web 适配。
- 不回写元数据（书名、作者、简介、封面）到 calibre-web，只推 EPUB 文件。
- 不在服务端生成 EPUB；EPUB 仍由浏览器生成。
- 不持久化 calibre-web 的登录会话 Cookie；只保存账号密码，每次用时重新登录。
- 不加载书库列表的封面缩略图（避免为每一行发一次代理请求）。
- 不支持多书库、多账号、匿名浏览模式下的推送。
- 不实现 OAuth / LDAP / 反向代理头登录；只支持 calibre-web 的本地账号表单登录。

### 反目标（即使能跑也算失败）

- 变成通用 HTTP 代理，用户可以通过 txt2book 访问任意内网地址。
- 把 calibre-web 密码写进 localStorage、日志、错误响应或 EBUB 元数据。
- 推送失败时静默丢失用户已转换的文件。
- 为了对接 calibre-web 而破坏现有本地导入、封面、四种导出格式的行为。

## 3. 关键决策

标注「我的判断」的项由实现者按此执行；用户可在评审时推翻。

| 决策 | 结论 | 依据 |
|---|---|---|
| 后端范围 | v1 只实现 calibre-web 适配器，接口按可扩展设计 | 用户已确认使用 calibre-web；calibre 原生服务器没有可用的上传接口 |
| 推送语义 | 给**原书**追加 EPUB 格式（`book_id` + `btn-upload-format`） | 避免重复书目；保留 calibre-web 中的元数据与封面 |
| 推送协议 | 模拟网页会话：`POST /login` 取 Cookie → 抓 CSRF token → `POST /upload` | calibre-web 没有公开的写入 API |
| 凭据存放 | 内存连接 + 加密落盘（AES-256-GCM，密钥由 `SESSION_SECRET` 经 HKDF 派生） | 满足「登录后直接复用」，同时避免明文密码躺在磁盘/备份里 |
| 持久化写入 | 连接成功后写 `<storePath>.tmp` 再原子 rename，权限 0600；写失败只降级为内存连接 | 不能因为磁盘不可写就让连接失败 |
| 断开语义 | 「断开连接」只清内存，保留已保存配置；「忘记凭据」删除配置文件 | 用户要的是「下次登录直接可用」，断开不等于忘记 |
| 登出行为 | txt2book 登出只清内存，保留已保存配置 | 下次登录自动复用；单账号应用可接受 |
| 连接测试 | OPDS Basic 读取必须成功；网页登录单独测试，失败时降级为「只读连接」 | 避免把账号错误和推送不可用混在一起 |
| 内网访问 | 允许访问已连接的私网地址（默认），但始终拒绝云元数据与链路本地地址 | calibre-web 通常在内网；只允许已确认的 origin，不开放任意 URL |
| 列表默认 | 默认显示全部书；「只看有 TXT 的」是可选开关，无 TXT 的行禁用导入 | 与用户描述一致：「所有书籍（也可筛选）」 |
| 元数据映射 | 只映射 `title` / `author` / `language` / `description` | `BookMeta` 当前只有这四个字段；series/tags 留待以后 |
| 覆盖已有 EPUB | 该书已有 EPUB 时，推送开关默认关闭并显示覆盖警告 | 覆盖文件属于破坏性操作 |
| 推送失败 | 本地下载照常完成；用错误 Toast 提示，可重新导出推送 | 不让推送阻断主流程 |
| 列表缩略图 | v1 不显示 | 每行一次图片代理，代价与收益不匹配 |
| 关联归属 | 关联写进 `BookModel.source`，随书籍快照一起撤销/恢复 | 避免本地导入、撤销、登出后残留关联把内容推到错误的书 |
| 导入覆盖 | calibre 导入强制覆盖书名/作者/语言/简介/封面；目标书无封面时清空旧封面 | 旧封面和旧书名属于上一本书，必须阻断 |
| 推送预检 | 推送前向 calibre-web 确认是否已有 EPUB；已有且未确认覆盖 → `409 CALIBRE_EPUB_EXISTS` | 快照会过期，覆盖是破坏性操作 |
| 覆盖确认 | 客户端收到 409 后弹确认，确认则带 `overwrite=true` 立即重试（不重新转换） | 一次导出即可完成，且覆盖必须显式同意 |
| 推送超时 | 独立 `CALIBRE_PUSH_TIMEOUT_MS`，默认 120s | 50MB 上传 + 登录在 15s 内必然超时 |
| 搜索 + TXT 过滤 | 搜索走 `/opds/search`，`txtOnly` 在客户端过滤；整页为空时自动续取下一页（最多 3 页） | 上游搜索接口不支持格式过滤，不能让开关静默失效 |
| 连接限流 | 5 次/分钟每 IP，失败也计数；同时只允许 1 个连接尝试 | 连接接口可被用来暴力尝试 calibre-web 账号 |

## 4. calibre-web 接口事实

以下均已对照 calibre-web 源码（`master`）确认：

- 列表（最近添加）：`GET /opds/new?offset=N` 按加入时间倒序返回书籍（分页大小由 `config_books_per_page` 决定）；账号不可见「最近添加」栏目时返回 404。
- 全量兜底：`GET /opds/books/letter/00?offset=N` 返回全部书籍（按书名排序）。
- 过滤：`GET /opds/formats/txt` 返回含 TXT 的书；若账号不可见「格式」栏目会 404。
- 搜索：`GET /opds/search/<关键词>`。
- 下载：`GET /opds/download/<book_id>/<format>/`，需要账号有 `download` 权限。
- 封面：`GET /opds/cover/<book_id>`。
- 认证：OPDS 走 HTTP Basic（`requires_basic_auth_if_no_ano`）。账号密码即 calibre-web 的登录账号。
- OPDS entry 字段：`title`、多个 `author/name`、`dc:language`、`category`（标签）、`content`（含评分、标签、系列与 `<p>` 简介）、封面链接、每个格式的 acquisition 链接。entry 的 `<id>` 是 `urn:uuid:...`，数字 `book_id` 需要从链接路径中提取。
- 推送：`POST /upload`，multipart 字段：
  - 给已有书加格式：`book_id` + 文件字段 `btn-upload-format`；
  - 新增整本书：文件字段 `btn-upload`。
- 推送前置条件：Flask 会话 Cookie、CSRF token、账号有上传权限、calibre-web 已开启「允许上传」、EPUB 在允许的扩展名内。
- 登录：`POST /login`，表单字段 `username`、`password`、`remember_me`，外加 Flask-WTF 的 `csrf_token`。
- 覆盖行为：格式已存在时 calibre-web 覆盖磁盘文件，但不更新数据库中的文件大小；功能正常，体积显示可能偏旧。

## 5. 架构

```
浏览器
  CalibreSettingsDialog / CalibreLibraryDialog ──/api/calibre/*──▶ Node（Fastify）
      │                              │  已连接 origin + Basic/Cookie
      │                              ▼
      │                          calibre-web
      ├── 导入 TXT（字节）
      ├── 封面（PNG）
      └── 导出 EPUB ──/api/calibre/books/:id/epub──▶ 推送
```

- 浏览器不直连 calibre-web：跨域、混合内容、Cookie 都无法处理。
- Node 只做代理与协议适配，不解析 OPDS（列表 XML 原样给浏览器，由 `DOMParser` 解析）。
- 推送时 Node 负责登录、CSRF、multipart 组装与结果确认。

## 6. 服务端设计

### 6.1 文件结构

```
server/lib/calibre/
  types.ts      连接、上游响应、错误类型
  target.ts     base URL 校验、地址策略、DNS 固定
  client.ts     node:http(s) 请求封装（方法、Cookie、重定向、大小/超时）
  opds.ts       构造上游 OPDS 路径（纯函数）
  login.ts      登录、CSRF 提取、上传表单组装（纯函数 + 请求）
  store.ts      进程内连接（含 Cookie）+ 加密配置的读写
  crypto.ts     配置文件的加密/解密（HKDF + AES-256-GCM）
  service.ts    对路由暴露：connect / resume / feed / download / cover / push
server/routes/calibre.ts
```

`buildServer` 增加 `calibreDeps`（`service` 注入），沿用 `exportDeps` 的测试模式。

### 6.2 连接与地址策略

`POST /api/calibre/session` 入参 `{ baseUrl, username, password }`。

校验（`target.ts`）：

- 仅 `http` / `https`；不允许 URL 内嵌用户名密码、query、fragment。
- 长度 ≤ 2048；路径前缀规范化（去掉尾部 `/`，保留子路径，如 `https://host/calibre`）。
- 端口沿用现有规则：80/443/8080/8443，或 ≥1024 且不在服务端口黑名单内（8083 可用）。
- 解析全部 A/AAAA：
  - `CALIBRE_ALLOW_PRIVATE=false`：沿用 `isBlockedIp`，任何私网/回环地址都拒绝。
  - `CALIBRE_ALLOW_PRIVATE=true`（默认）：允许 RFC1918、回环、CGNAT，**始终拒绝** 链路本地 `169.254.0.0/16`、`fe80::/10`、`0.0.0.0/8`、组播、保留段，以及云元数据地址（`169.254.169.254`、`100.100.100.200`）。
- 连接成功后固定一个解析出的 IP + family；后续请求使用该 IP，Host 头保持原域名。DNS 变化需要重新连接。

测试顺序：

1. `GET {base}/opds/`（Basic）→ 必须 200 且内容像 Atom feed。401/403 统一报「账号或密码错误」，不回传主机名。
2. `POST {base}/login` 走完整登录流程 → 成功则 `canPush=true`；失败则连接仍成立，`canPush=false` 并记录原因「该账号无法通过网页表单登录（可能使用 LDAP / OAuth），只能读取」。

连接信息（进程内）：

```ts
interface CalibreConnection {
  baseUrl: string;      // 不含尾部斜杠，含子路径
  origin: string;       // scheme://host:port
  basePath: string;     // "" 或 "/calibre"
  hostIp: string;
  family: 4 | 6;
  username: string;
  password: string;
  cookies: Map<string, string>;
  canPush: boolean;
  pushReason?: string;
  connectedAt: number;
}
```

保存到磁盘的配置：

```ts
interface SavedCalibreConfig {
  version: 1;
  iv: string;      // base64，12 字节
  tag: string;     // base64，16 字节
  data: string;    // base64，AES-256-GCM 密文
}
// 明文载荷（只存在于内存）：{ baseUrl, username, password }
```

- 密钥：`HKDF-SHA256(SESSION_SECRET, salt="txt2book", info="calibre-credentials")` 派生 32 字节。更换 `SESSION_SECRET` 会让已保存配置无法解密，表现为「需要重新连接」，不报错、不损坏其他数据。
- `AUTH_DISABLED=true` 且未设置 `SESSION_SECRET` 时无法派生密钥，自动降级为内存连接并在启动时打印警告。
- 保存时机：`POST /session` 验证成功后写入；连接失败不覆盖已有配置。
- 读取时机：`GET /session` 解密并返回 `saved`、`baseUrl`、`username`（不含密码）；`POST /session/reconnect` 用保存的密码重新连接。
- 写入：先写 `<storePath>.tmp`（权限 0600），再 `rename` 覆盖；写入或加密失败只记录警告，连接继续以内存方式工作。
- 文件损坏或解密失败：按「未保存」处理，保留原文件不自动删除，打印不含密钥/密码的警告。
- 保存与删除串行执行，避免并发请求互相覆盖。
- 单个 txt2book 实例只维护一个连接；多个 txt2book 副本各自保存，不共享配置。
- 连接尝试全局串行：已有尝试在途时新的 `POST /session` 返回 `429 CALIBRE_BUSY`；并按 IP 限流（默认 5 次/分钟，失败也计数）。
- `DELETE /api/calibre/session` 只清内存；`DELETE /api/calibre/credentials` 同时删除配置文件；txt2book 登出只清内存。
- 任何接口发现未连接但存在可恢复配置时，先尝试一次 `resume`（受连接限流与串行约束）；成功则继续，失败返回 `409 CALIBRE_NOT_CONNECTED` 并附可行动原因（如「已保存的连接无法登录，请更新密码」）。完全没有任何配置时才直接返回 409。

### 6.3 HTTP 客户端

`client.ts` 基于 `node:http` / `node:https`，提供：

- `method`、`headers`、`body`（Buffer）；
- 自定义 `lookup` 固定 IP（复用封面现有做法）；
- 总超时；
- 响应体上限（超限立即 `destroy`）；
- `redirect: "manual"`，仅允许同 origin 重定向，最多 3 次，每次重新校验 origin 与地址策略；
- 收集 `Set-Cookie`（按 `name=value` 存入连接，删除带 `Max-Age=0` 的项）；
- 不透传上游 `Set-Cookie` 到浏览器。

### 6.4 路由与契约

所有路由受全局登录守卫保护；错误统一 `{error:{code,message}}`，中文文案，不包含主机名、IP、上游 HTML。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/calibre/session` | `{connected, saved, baseUrl?, username?, canPush?, pushReason?}`；`saved` 表示存在可复用的加密配置 |
| POST | `/api/calibre/session` | 用提交的地址/账号/密码建立连接；成功后保存配置 |
| POST | `/api/calibre/session/reconnect` | 用已保存配置重新连接（无需密码） |
| DELETE | `/api/calibre/session` | 断开当前连接，保留已保存配置，204 |
| DELETE | `/api/calibre/credentials` | 断开并删除已保存配置，204 |
| GET | `/api/calibre/feed?offset=&q=&format=` | 原样返回 OPDS XML |
| GET | `/api/calibre/books/:id/file?format=txt` | 返回书籍文件字节 |
| GET | `/api/calibre/books/:id/cover` | 返回 PNG 封面 |
| POST | `/api/calibre/books/:id/epub?overwrite=` | multipart `file`，推送 EPUB |

**feed 路径构造**（`opds.ts`，纯函数）：

- `q` 非空 → `/opds/search/<encodeURIComponent(q)>`；
- 否则 `format` 非空 → `/opds/formats/<小写格式>`（calibre-web 已按加入时间倒序）；
- 否则 `/opds/new`（最近添加，按加入时间倒序）；
- `offset > 0` 时追加 `?offset=N`。
- `/opds/new` 返回 404（账号不可见「最近添加」）时回退到 `/opds/books/letter/00`（按 calibre-web 默认排序，通常为书名）；前端按 entry 的 `<updated>` 倒序做页面内近似排序。
- 上游 `Accept: application/atom+xml, application/xml;q=0.9`。
- 返回 `application/atom+xml; charset=utf-8`、`cache-control: no-store`，上限 8MB。
- 上游 404 且是格式 feed → `404 CALIBRE_FORMAT_UNAVAILABLE`（前端回退到全部书籍并本地过滤）。
- 上游 401 → **不要**返回 401（会导致本应用误判登录失效而退出），改为 `400 CALIBRE_AUTH_FAILED`。

**file**：

- `format` 白名单：v1 只允许 `txt`。
- 路径 `/opds/download/<id>/<format>/`。
- 返回 `application/octet-stream`，上限 `CALIBRE_MAX_FILE_BYTES`（默认 50MB），超时 60s。
- 文件名由前端根据书名生成，服务端不解析。

**cover**：

- 路径 `/opds/cover/<id>`，上游上限 10MB。
- 复用 `server/lib/image.ts` 的 `toImage(bytes, {maxBytes, format:"png"})`。
- 无封面或上游 404 → `404 CALIBRE_NO_COVER`，前端静默忽略。

**push**：

请求：`POST /api/calibre/books/:id/epub?overwrite=true|false`，multipart 字段 `file`（默认 false）。

1. 确认连接 `canPush`；否则 `403 CALIBRE_PUSH_UNAVAILABLE`（附原因）。
2. **预检**：`GET /opds/download/<id>/epub/`，只读响应头后立即中止响应体：
   - 200/206 → 该书已有 EPUB；
     - `overwrite=false` → `409 CALIBRE_EPUB_EXISTS`，不执行上传；
     - `overwrite=true` → 继续；
   - 404 → 没有 EPUB，继续；
   - 401/403/其他 → 无法判断，继续走上传，由上传结果决定。
3. 若 Cookie 中没有会话，或上传返回登录页 → 登录：
   - `GET /login` → 提取 `csrf_token`（`<input name="csrf_token" value="...">`，兼容属性顺序与引号；再尝试 `<meta name="csrf_token" content="...">`）。找不到 token 时仍发送空的 `csrf_token` 字段，交给上游判定（calibre-web 可能关闭了 CSRF）。
   - `POST /login`（`application/x-www-form-urlencoded`）：`csrf_token`、`username`、`password`、`remember_me=on`。
   - 成功判定：收到 `session` Cookie，且响应不是登录页（3xx 且 `Location` 不含 `/login`，或 200 且页面不含密码输入框）。
4. 取新的 CSRF token：`GET /admin/book/<id>`（无编辑权限时退回 `/`），提取 token；失败则用登录页 token。
5. 组装 multipart（Buffer）：
   - 字段 `csrf_token`、`book_id`；
   - 文件字段 `btn-upload-format`，文件名 `<清洗后的书名>.epub`，`Content-Type: application/epub+zip`；
   - 同时发送请求头 `X-CSRFToken`。
6. `POST /upload`；2xx/3xx 视为提交成功。
7. 确认：再次请求 `GET /opds/download/<id>/epub/`，只读响应头后立即中止响应体；未就绪时等 300ms 重试一次。
   - 预检时不存在、现在 200/206 → 成功；
   - 预检时已存在（覆盖场景）：还要求 `content-length` 或 `last-modified` 与预检时不同，否则视为未确认；
   - 404 → `502 CALIBRE_PUSH_UNVERIFIED`，文案提示「已提交但未确认，请到 calibre-web 检查」；
   - 其他状态同样按未确认处理。
8. 会话失效/CSRF 错误时，自动重新登录并重试一次；仍失败则报错。
9. 全局同时只允许 1 次推送（占用时 `429 CALIBRE_BUSY`）；推送单独限流（默认 6 次/分钟）。
10. 超时：登录与预检用 `CALIBRE_TIMEOUT_MS`，上传用 `CALIBRE_PUSH_TIMEOUT_MS`（默认 120s）；上传超时返回 `504 CALIBRE_TIMEOUT`，文案说明结果未确认。

**错误码映射**：

| 场景 | 状态码 | code |
|---|---|---|
| 未连接 | 409 | `CALIBRE_NOT_CONNECTED` |
| 账号密码错误 | 400 | `CALIBRE_AUTH_FAILED` |
| 上游不可达 / TLS 失败 | 502 | `CALIBRE_UNREACHABLE` |
| 上游超时 | 504 | `CALIBRE_TIMEOUT` |
| 书籍或格式不存在 | 404 | `CALIBRE_NOT_FOUND` |
| 格式 feed 不可见 | 404 | `CALIBRE_FORMAT_UNAVAILABLE` |
| 无封面 | 404 | `CALIBRE_NO_COVER` |
| 只读连接（登录失败） | 403 | `CALIBRE_PUSH_UNAVAILABLE` |
| 账号无上传权限 / 未开启上传 | 403 | `CALIBRE_PUSH_FORBIDDEN` |
| 推送未确认 | 502 | `CALIBRE_PUSH_UNVERIFIED` |
| 该书已有 EPUB 且未确认覆盖 | 409 | `CALIBRE_EPUB_EXISTS` |
| 正在推送 | 429 | `CALIBRE_BUSY` |
| 文件过大 | 413 | `CALIBRE_TOO_LARGE` |
| 其余 | 502 | `CALIBRE_UPSTREAM` |

### 6.5 配置项

| 变量 | 默认 | 说明 |
|---|---|---|
| `CALIBRE_ALLOW_PRIVATE` | `true` | 允许连接私网/回环地址；云元数据与链路本地始终拒绝 |
| `CALIBRE_PERSIST_CREDENTIALS` | `true` | 加密保存连接配置；`false` 时只保留在内存 |
| `CALIBRE_STORE_PATH` | `./data/calibre-connection.json` | 加密配置文件路径；Docker 镜像内默认为 `/data/calibre-connection.json` |
| `CALIBRE_TIMEOUT_MS` | `15000` | 列表/封面/登录/预检的上游超时 |
| `CALIBRE_PUSH_TIMEOUT_MS` | `120000` | 上传 EPUB 的独立超时 |
| `CALIBRE_MAX_FILE_BYTES` | `52428800` | TXT 下载上限（50MB） |
| `CALIBRE_MAX_PUSH_BYTES` | `52428800` | EPUB 推送上限（50MB） |
| `CALIBRE_RATE_LIMIT_PER_MIN` | `120` | 读取类接口每 IP 每分钟次数 |
| `CALIBRE_PUSH_RATE_LIMIT_PER_MIN` | `6` | 推送每 IP 每分钟次数 |
| `CALIBRE_CONNECT_RATE_LIMIT_PER_MIN` | `5` | 连接尝试每 IP 每分钟次数（失败也计数） |

`CALIBRE_ALLOW_PRIVATE` 是安全开关：calibre-web 在公网域名时建议设为 `false`；同机/内网部署保持 `true`。

## 7. 前端设计

### 7.1 类型与解析

`src/types/calibre.ts`：

```ts
interface CalibreBook {
  id: number;
  title: string;
  authors: string[];
  language?: string; // 原始 dc:language 值，如 "zho" / "eng"
  summary: string;
  formats: string[];
  hasCover: boolean;
}
interface CalibreFeed {
  books: CalibreBook[];
  nextOffset: number | null;
}
interface CalibreSessionInfo {
  connected: boolean;
  saved: boolean;   // 是否存在可复用的加密配置
  baseUrl?: string;
  username?: string;
  canPush?: boolean;
  pushReason?: string;
}
```

关联不放在 `useCalibre` 的独立状态里，而是写进书籍本身：

```ts
// src/types/book.ts
interface BookSource {
  kind: "calibre-web";
  origin: string;   // 已连接实例的 origin，用于校验连接是否一致
  bookId: number;
  title: string;
  formats: string[];
}
interface BookModel {
  meta: BookMeta;
  volumes: Volume[];
  chapters: Chapter[];
  cover: CoverAsset | null;
  /** 可选，旧数据与本地导入为 undefined。 */
  source?: BookSource | null;
}
```

- `source` 随书籍快照保存，撤销/重做后自动回到正确的归属。
- 本地导入传 `source: null`；calibre 导入写入新 source。
- 推送资格 = `book.source?.kind === "calibre-web"` 且 `source.origin === 当前连接.origin`。
- 断开连接不清空书籍，但推送入口消失。

`src/core/calibre/feed.ts`：`parseOpdsFeed(xml: string): CalibreFeed`

- 只用 `DOMParser`，不新增依赖。
- 只保留带 acquisition 链接的 `entry`（自动排除导航/分栏 entry）。
- `book_id` 从链接路径 `/opds/(download|cover)/(\d+)` 提取；提取不到则跳过该条。
- `formats` 从 acquisition 链接路径的最后一段转大写。
- `language` 取 `dc:language` / `dcterms:language` 的文本（按 `tagName` 后缀匹配命名空间），保留原始值；映射规则见 §7.3。
- `summary` 优先取 `content` 内所有 `<p>` 文本，其次取 `content` 全文；把 `<br>`、`</p>`、`</div>` 等块级标签转换为实际换行（段落之间空一行），剥离其余标签与常见 HTML 实体，压缩行内空白、保留换行，限 5000 字。这样导入到简介后，EPUB/HTML/TXT/PDF 的简介页都能按段落显示。
- 作者用 `、` 连接。
- `nextOffset` 从 `<link rel="next">` 的 `offset` 查询参数读取。
- 忽略格式异常条目，不因单条坏数据整页失败。

### 7.2 状态与组件

`src/composables/useCalibre.ts`：

```ts
useCalibre({ session, importer, cover })
```

- 状态：`info`、`books`、`query`、`txtOnly`、`loading`、`error`、`nextOffset`、`connecting`、`pushing`、`autoResumeSuppressed`。
- 关联状态由 `session.book.source` 派生：`linkedBook = computed(() => book.source?.kind === "calibre-web" ? book.source : null)`。
- 动作：`loadStatus`、`connect`、`resume`、`disconnect`、`forget`、`refresh`、`loadMore`、`importBook`、`push`。
- 自动复用：
  - App 完成登录后调用 `loadStatus()`；
  - 若 `saved && !connected`，自动调用一次 `resume()`，成功则加载书库数据（不会自动打开书库弹窗）；
  - 当前标签页执行「断开连接」后，设置 `autoResumeSuppressed`，不再自动重连，直到用户点「连接」或刷新页面；
  - `resume()` 失败不循环重试，展示带已保存地址/账号的表单与错误提示，用户只需补密码；
  - 页面刷新或多个标签页各自触发时，服务端串行连接与限流保证不会打爆 calibre-web。
- 分页与过滤：
  - `refresh` 清空列表，从 `offset=0` 取第一页；
  - `txtOnly` 打开时，对每页结果做本地过滤（没有 `TXT` 的条目丢弃）；
  - 过滤后整页为空且还有 `nextOffset` 时，自动续取下一页，最多连续 3 页，避免用户看到空白列表；
  - `loadMore` 沿用同一套过滤与续取逻辑；
  - 走到末尾仍为空时显示「没有更多含 TXT 的书籍」。
- `importBook(book)`：
  1. 拉取 TXT 字节；
  2. 若 `hasCover`，用 `cover.prepare(await api.calibreCover(id))` 得到 `CoverAsset`；请求失败或无封面时使用 `null`（**不保留上一本书的封面**）；
  3. 组装 `BookMeta`：`title` / `author` / `language` / `description` 全部来自 calibre，缺省时用空值或默认语言；
  4. 包装为 `File`（`<书名>.txt`），调用 `importer.importBytes(file, "auto", meta, { source, cover })`；
  5. 成功后提示「已从 Calibre-Web 导入」；封面失败另给一条非阻断提示。
- `push(blob, filename)`：
  1. 调用 `POST /api/calibre/books/:id/epub`；
  2. 若返回 `CALIBRE_EPUB_EXISTS`，`window.confirm("该书已有 EPUB，推送会覆盖原文件，是否继续？")`，确认后带 `overwrite=true` 立即重试（不重新转换）；取消则返回「已取消推送」；
  3. 成功后把 `EPUB` 写入 `book.source.formats`（不新增撤销历史）。
- 任何接口返回 `CALIBRE_NOT_CONNECTED` → 自动回到未连接状态并展示表单。
- `connect` 成功后自动刷新第一页。

组件（2026-11-20 UI 调整）：

- 顶栏：登录后显示「书库」「设置」两个入口，与「跳到导出」并列；同一时刻最多打开一个弹窗。
- `src/components/AppDialog.vue`：通用弹窗容器，负责遮罩、`role="dialog"` / `aria-modal`、标题关联、Esc 关闭、焦点进入与归还、打开时锁定页面滚动。
- `src/components/CalibreSettingsDialog.vue`（账户配置独立到设置）：
  - 未连接：连接表单（地址、账号、密码）；存在已保存配置时地址与账号预填、密码留空，并显示「已保存连接」；只有确实处于恢复请求中时才显示「正在恢复…」，主动断开后不得显示；
  - 已连接：显示地址与账号，提供「修改连接」「断开连接」「忘记凭据」；
  - 「修改连接」展开表单并预填地址与账号，密码留空；提交成功后覆盖已保存配置；
  - 断开与忘记都要有确认提示，忘记凭据额外说明「下次需要重新输入密码」。
- `src/components/CalibreLibraryDialog.vue`（书库选择独立到弹窗）：
  - 未连接时显示「请先在设置中连接 Calibre-Web」和「前往设置」；
  - 搜索框（300ms 防抖）、只看 TXT、书籍列表、加载更多、当前关联信息；
  - 导入成功后关闭弹窗并提示已导入；导入失败留在弹窗内展示错误。
- `src/components/CalibreBookRow.vue`：单行展示与导入按钮；无 TXT 时禁用并标注「无 TXT」。格式徽标显示 TXT/EPUB；已关联时显示「已关联」。
- `src/components/UploadPanel.vue` / `CoverPanel.vue`：新增可选注入的 `importer` / `cover` 控制器；不传时保持现有内部创建行为，保证旧测试不受影响。
- `src/App.vue`：创建共享的 `importer`、`cover`、`calibre`；管理顶栏与两个弹窗的开合；不再在左侧栏常驻书库面板。
- `src/components/ExportPanel.vue`：
  - 新增 props：`canPush`、`pushMode`（`"off" | "download-and-push" | "push-only"`）、`calibreTitle`、`hasEpub`、`pushing`；
  - 仅当格式为 EPUB 且已关联书籍时显示「Calibre-Web」推送选项；
  - 推送模式为三选一：「不推送」「下载并推送」「仅推送（不下载）」；
  - `hasEpub` 时显示「该书已有 EPUB，推送会覆盖原文件」，并默认不推送；
  - 仅推送时按钮文案为「仅推送 EPUB」，并提示不会生成本地文件；
  - `pushing` 时按钮显示「正在推送」，进度区显示推送文案。

### 7.3 导入、元数据与封面

- `useImport` 新增：

  ```ts
  importBytes(
    bytes: Uint8Array,
    name: string,
    encoding: SourceEncoding,
    options?: {
      meta?: Partial<BookMeta>;
      source?: BookSource | null;
      cover?: CoverAsset | null;
    },
  ): Promise<boolean>;
  ```

  `importFile` 读取字节后调用它，行为保持不变（`meta` 仅含文件名标题、空作者、`zh-CN`）。
- `useBookSession.loadBook` 增加可选第 4 参数：

  ```ts
  loadBook(meta, parsed, title, options?: {
    source?: BookSource | null; // 缺省 null
    cover?: CoverAsset | null;  // 缺省沿用当前封面；显式传 null 表示清空
    forceTitle?: boolean;       // calibre 导入为 true
  })
  ```

  - `forceTitle` 为 true 时无条件采用传入标题，并同步 `lastAutoTitle`；
  - `source`、`cover` 写入新的 `BookModel`；
  - 现有调用方不传第 4 参数时，除 `source` 变 `null` 外行为不变（现有测试需确认并补一条 source 断言）。

- `reparse` 显式传 `source: session.book.value.source`，因此从 calibre 导入后重新解析仍保持关联；本地导入传 `source: null`。
- 标题不再依赖 `metaSource` 标记：`reparse` 用当前 `meta` 重建标题，`forceTitle` 只用于导入瞬间。
- `parseChapters` 的 `language` 跟随书籍语言：

  - `parseText(text, rules, language)`；
  - 本地文件为 `zh-CN`；calibre 导入按 `dc:language` 映射：`zh*` / `zho` / `chi` → `zh-CN`，`en*` / `eng` → `en`，其余默认 `zh-CN`；
  - 该参数决定「前言 / 番外 / 正文」等默认标题的语言。

- 封面：

  - `useCover` 新增 `prepare(blob, sourceName?): Promise<CoverAsset | null>`：做现有 PNG 校验与尺寸测量，但**不写会话**；校验失败时抛错，由调用方捕获并按无封面处理；
  - 新增 `fromBlob(blob, sourceName?)`：`prepare` 后调用 `setCover`，供手动换封面等场景复用；
  - calibre 导入流程用 `prepare` 得到封面后随 `loadBook` 一次写入，避免多出一条撤销历史；
  - 目标书没有封面或封面请求失败时传 `cover: null`，**清空上一本书遗留的封面**，并给一条不阻断导入的提示。

### 7.4 导出与推送

`App.vue` 的 `onExport`：

1. 转换（现有逻辑不变）。
2. 根据推送模式决定是否下载：
   - `"off"` 或非 EPUB：下载，行为与现有导出一致；
   - `"download-and-push"`：先下载，再推送；
   - `"push-only"`：不调用 `downloadBlob`，只推送；转换仍在内存中完成。
3. 若推送：
   - 独立 `pushing` 状态；
   - 调用 `calibre.push(blob, filename)`（409 覆盖确认在 composable 内完成）；
   - 成功 Toast：`已推送到 Calibre-Web「书名」`；
   - 下载并推送时取消覆盖：Toast `已取消推送，本地文件已下载`；
   - 仅推送时取消覆盖：Toast `已取消推送，未生成本地文件`；
   - 下载并推送失败：`已下载，但推送失败：<可行动原因>`；
   - 仅推送失败：`推送失败，未生成本地文件：<可行动原因>；可切换到「下载并推送」后重试`；
4. 推送结束后恢复按钮状态。

- 推送使用 `FormData`，字段名 `file`，文件名沿用导出的 `.epub` 文件名。
- 成功推送后 `source.formats` 加入 `EPUB`；下次导出时推送模式按「已有 EPUB」默认设为 `"off"` 并显示覆盖警告。
- `linkedBook` 与当前连接 origin 不一致时（重新连接到了另一个实例），不显示推送入口，并在书库弹窗显示「当前书籍来自另一个 Calibre-Web 实例」。
- 仅推送且失败时不会自动下载；用户可切换到「下载并推送」重试。

## 8. 安全风险评估

按 dev-rules 规则三，实现前需用户确认。等级按「已登录的单用户实例」这一前提评估。

### 8.1 SSRF / 内网探测（中）

- 风险点：`POST /api/calibre/session` 接受任意 base URL；连接后 feed/file/cover 会由服务端发起请求，可被用来探测和读取内网服务（`server/lib/calibre/target.ts`、`server/routes/calibre.ts`）。
- 攻击路径：能登录 txt2book 的人（或利用本应用 XSS 的人）把地址填成内网 IP/端口，再通过列表、下载接口读取响应。
- 影响：内网资产暴露、云元数据凭据泄露、被当作跳板；响应错误若包含主机信息还会辅助扫描。
- 缓解方案（本设计已包含）：只允许已连接的单个 origin；路径、book_id、format 全部白名单；始终拒绝云元数据与链路本地地址；不跨 origin 重定向；限流与响应上限；错误文案不含主机/IP；提供 `CALIBRE_ALLOW_PRIVATE=false` 收紧。代价是少了「随便填一个地址就能连」的便利。

### 8.2 calibre-web 凭据泄露（内存 + 落盘，中）

- 风险点：密码经浏览器提交给 txt2book，并在 Node 内存中长期保留，同时以可解密形式写入 `CALIBRE_STORE_PATH`（`server/lib/calibre/store.ts`、`server/lib/calibre/crypto.ts`）。
- 攻击路径：txt2book 自身被攻破、内存转储、XSS 读取前端状态、错误日志误记，或宿主/卷/备份被读取后再用 `SESSION_SECRET` 解密。
- 影响：calibre-web 账号被盗，可能进一步读取/删除书库；如果用户在别处复用同一密码，影响会扩散。
- 缓解方案：接口永不回显密码、不写日志；落盘使用 AES-256-GCM，密钥由 `SESSION_SECRET` 经 HKDF 派生；文件权限 0600、原子写入；`data/` 同时加入 `.gitignore` 与 `.dockerignore`；可通过 `CALIBRE_PERSIST_CREDENTIALS=false` 完全关闭落盘；文档提示使用独立密码。代价是更换 `SESSION_SECRET` 后需要重新输入 calibre-web 密码；宿主完全失守时仍无法保护凭据。

### 8.3 覆盖已有 EPUB（中）

- 风险点：calibre-web 对同名格式直接覆盖磁盘文件（`server/lib/calibre/login.ts` 的推送流程）。
- 攻击路径：用户误勾推送或不知道该书已有 EPUB。
- 影响：原 EPUB 丢失，且 calibre-web 数据库中的文件大小不会更新。
- 缓解方案：推送前向 calibre-web 预检该格式是否已存在；已存在时开关默认关闭，服务端在未显式 `overwrite=true` 时直接拒绝，客户端弹确认后才覆盖。代价是覆盖多一步确认。

### 8.4 上传表单模拟失效（低）

- 风险点：calibre-web 版本升级、反向代理改变子路径、启用 LDAP/OAuth 后，登录/CSRF/上传流程可能失败（`server/lib/calibre/login.ts`）。
- 攻击路径：不是攻击，是兼容性风险。
- 影响：推送不可用；错误提示可能误导。
- 缓解方案：连接时区分「可读」「可推」；推送失败给出权限/上传开关/登录方式三类提示；保留本地下载作为兜底。代价是可能需要按实际实例调一次。

### 8.5 资源耗尽（中）

- 风险点：50MB 下载与 50MB 推送经过 Node 内存；并发请求可叠加。
- 攻击路径：已登录用户反复触发下载/推送。
- 影响：内存上涨、容器 OOM、服务不可用。
- 缓解方案：读写大小上限、超时、每 IP 限流、全局单并发推送、响应超限即断开。代价是大文件需要更长时间或被拒绝。

### 8.6 元数据注入（低）

- 风险点：书名、作者、简介来自 calibre-web，属于外部输入。
- 攻击路径：恶意书库内容写入 XSS 或破坏 EPUB 结构。
- 影响：界面 XSS 或生成的 EPUB 损坏。
- 缓解方案：Vue 默认转义，不使用 `v-html`；简介按纯文本处理；EPUB 渲染已有转义与非法字符剔除。

### 8.7 连接接口被用作账号暴力尝试（中）

- 风险点：`POST /api/calibre/session` 会用提交的账号密码向 calibre-web 发起真实登录（`server/routes/calibre.ts`、`server/lib/calibre/service.ts`）。
- 攻击路径：已登录 txt2book 的攻击者反复提交不同的 calibre-web 密码，把本应用当作密码爆破代理；calibre-web 侧只会看到来自 txt2book 的请求。
- 影响：calibre-web 账号被撞库成功；上游可能对本应用 IP 触发封禁。
- 缓解方案：连接尝试单独限流（默认 5 次/分钟每 IP，失败也计数）；同时只允许一个连接尝试；错误文案不区分「账号不存在」与「密码错误」。代价是用户连续输错时需要等待。

## 9. 测试策略

### 9.1 前端

- `tests/calibreFeed.test.ts`（happy-dom）：多格式 entry、导航 entry 排除、HTML 简介转文本、多作者、`language` 提取、`nextOffset`、坏 entry 跳过、实体转义。
- `tests/useCalibre.test.ts`：连接成功/失败、断线回到未连接、TXT 过滤、过滤为空时自动续取下一页、导入调用顺序（TXT → 封面 prepare → loadBook）、推送调用与错误码映射、409 覆盖确认后重试、取消覆盖、origin 不一致时不可推送。
- `tests/CalibreSettingsDialog.test.ts` 与 `tests/CalibreLibraryDialog.test.ts`：连接表单与状态、书库空/加载/错误态、无 TXT 行禁用、搜索防抖、加载更多、导入成功关闭、未连接提示、关联状态、密码不回显、来自另一实例的书籍提示。
- `tests/ExportPanel.test.ts` 增补：EPUB + 已关联才显示推送；推送方式三选一（不推送 / 下载并推送 / 仅推送），已有 EPUB 时默认 `off` 并警告；推送中按钮状态。
- `tests/useImport.test.ts` 增补：`importBytes` + `meta`/`source`/`cover`；calibre 导入后 `reparse` 保留 source 与书名；本地导入清空 source；英文语言默认章节标题。
- `tests/useBookSession.test.ts` 增补：`loadBook` 的 `source`、`cover: null` 清空、`forceTitle` 覆盖用户改过的书名、撤销后 source 回滚。
- `tests/useCover.test.ts` 增补：`prepare` 不写会话、`fromBlob` 成功/非 PNG 拒绝。

### 9.2 服务端

用本地 `node:http` 假 calibre-web（沿用 `tests/server/cover.test.ts` 的模式），覆盖：

- 连接：Basic 成功、401、上游超时、非 Atom 响应、子路径 base URL、私网地址策略、元数据地址始终拒绝、`CALIBRE_ALLOW_PRIVATE=false` 时拒绝私网、连接接口限流（失败也计数）。
- feed：路径与 query 构造、offset、搜索、格式 404 映射、XML 透传、响应不含 `Set-Cookie`。
- file：格式白名单、大小上限、上游 404、上游 401 映射为 400 而不是 401。
- cover：PNG 转换、无封面 404。
- push：
  - 完整流程：预检 → 登录页 token → 登录 Cookie → 书籍页 token → 上传字段与文件名正确 → 确认请求；
  - 预检：已有 EPUB 且 `overwrite=false` 返回 409 且不发生上传；`overwrite=true` 继续；
  - 密码错误、上传被拒（403）、CSRF 过期后重试一次、确认失败返回 `CALIBRE_PUSH_UNVERIFIED`；
  - 上传超时返回 504；
  - 并发推送返回 429；
  - 凭据不出现在响应体。
- 配置保存：
  - 连接成功后生成文件，内容不含明文密码与用户名；
  - 模拟重启：新建 service 从同一路径加载并 `resume`；
  - 更换 `SESSION_SECRET` 后按未保存处理，不抛异常；
  - 文件损坏/截断时忽略且不删除原文件；
  - 目标目录不可写时连接仍成功（降级内存）；
  - 连接失败不覆盖已有有效配置；
  - `DELETE /session` 保留文件，`DELETE /credentials` 删除文件；
  - 登出（清空 txt2book 会话）后配置仍可被下一次登录恢复。
- 认证：所有 `/api/calibre/*` 未登录返回 401。
- 回归：现有封面、PDF 导出、认证测试全部通过。

## 10. 文档与部署

- `README.md`：功能列表新增「calibre-web 书库对接」；新增专节说明连接方式、权限要求（上传开关、download/edit 权限）、域名与 HTTPS、子路径、Docker 同机访问公网域名的回流问题、`NODE_EXTRA_CA_CERTS`、凭据保存与轮换、`/data` 持久化卷。
- 「不落盘」表述更新：TXT 与 EPUB 会经过服务端内存（不写磁盘），与 PDF 导出的表述保持一致；calibre-web 连接配置是唯一新增的落盘数据。
- `.env.example` 与配置表新增 `CALIBRE_*` 变量，并注明更换 `SESSION_SECRET` 会使已保存的配置失效。
- `AGENTS.md`：目录约定补 `server/lib/calibre/`，说明新增安全边界（内网访问、凭据落盘）。
- `Dockerfile`：创建 `/data` 并 `chown node:node`，`ENV CALIBRE_STORE_PATH=/data/calibre-connection.json`。
- `docker-compose.yml`：新增命名卷 `txt2book-data:/data`，保证容器重建后配置仍在。
- `.gitignore` / `.dockerignore`：加入 `data/`，避免本地配置进入版本库或镜像。
- 非 Docker 运行：默认相对路径 `./data/calibre-connection.json`，首次保存时创建目录；目录创建失败只降级为内存连接。

## 11. 验收标准

1. 填入 calibre-web 地址、账号、密码后能连接；地址错误、账号错误、网络不通各有明确提示。
2. 能浏览全部书籍并翻页；搜索关键词能过滤；「只看有 TXT 的」生效。
3. 点击导入后，TXT 正文、书名、作者、简介、语言进入转换页面；calibre 中的书名/作者/简介**强制覆盖**当前值；有封面时封面替换，无封面或封面失败时清空旧封面。
4. 从 calibre-web 导入后再切换编码「重新解析」，书名、作者、简介、语言与关联都不被覆盖；之后从本地导入另一本书，关联立即失效，推送入口消失。
5. 导入后执行「撤销」回到上一本书时，关联与书籍内容一起回滚，不会把新内容推到旧书。
6. 导出 EPUB 且勾选推送后，calibre-web 原书下出现 EPUB，原 TXT 仍在；推送成功后该书标记为已有 EPUB，再次导出时推送默认关闭并显示覆盖警告。
7. 目标书在上次列表之后新增了 EPUB：推送前预检返回「已有 EPUB」，界面弹确认；确认后覆盖成功，取消则只保留本地文件。
8. 推送失败或超时时本地文件已下载，提示可行动原因；不会误报成功。
9. 搜索时打开「只看有 TXT 的」仍能正确过滤；当前页全被过滤且还有下一页时自动续取，不出现空白列表。
10. 在未连接、只读连接（登录失败）、已有 EPUB 三种情况下，推送入口的表现符合第 3 节决策。
11. 现有本地导入、封面抓取/上传、EPUB/HTML/TXT/PDF 导出、登录与限流测试全部通过；`npm run typecheck` 与 `npm run build` 通过。
12. calibre-web 密码不出现在任何响应、日志、localStorage 或配置文件明文中；配置文件中只有 `iv`、`tag` 与密文。
13. 重启 txt2book 或从另一浏览器/设备登录后，如果存在已保存配置，自动恢复连接，无需重新输入密码；更换 `SESSION_SECRET` 后明确提示需要重新连接。
14. 「断开连接」保留已保存配置，「忘记凭据」删除配置；两种操作后的界面与自动恢复行为正确。

## 12. 遗留决定（实现者判断）

- 列表每页条数不固定（由 calibre-web 配置决定），前端只依赖 `rel="next"`；无需猜测。
- 搜索接口的排序与匹配规则由 calibre-web 决定，前端不做二次排序。
- 简介超过 5000 字截断；截断处不加省略号，避免污染元数据。
- 作者多于 3 人时不额外提示，直接以 `、` 连接。
- 推送文件名只用于扩展名识别，calibre-web 会按书名重命名；服务端清洗 `/\:*?"<>|` 与控制字符，限制 120 字符。
- 连接信息不随浏览器会话隔离（单账号应用），多个标签页共享同一连接。
- 是否在「只看有 TXT」打开时隐藏无 TXT 的书：隐藏（与开关语义一致），关闭时显示但禁用导入。

## 13. 评审问题处理记录（2026-11-19）

独立评审提出 7 个实现前必须明确的问题，处理如下：

| # | 问题 | 处理 |
|---|---|---|
| 1 | `linkedBook` 何时失效 | 关联写入 `BookModel.source`，随快照撤销/恢复；本地导入写 `null`，登出 `reset()` 清空；连接 origin 不一致时禁止推送（§7.1、§7.2、§7.4） |
| 2 | 是否覆盖书名/封面 | calibre 导入强制覆盖标题与四项元数据；封面先 `prepare` 再随 `loadBook` 一次写入；无封面或失败传 `null` 清空旧封面（§7.2、§7.3） |
| 3 | 语言来源 | `CalibreBook` 增加 `language`；`parseChapters` 跟随映射后的语言；英文书默认章节标题为英文（§7.1、§7.3） |
| 4 | EPUB 状态是否可信 | 推送前服务端预检；已有且未 `overwrite=true` 返回 409；客户端弹确认后立即重试；成功后更新 `source.formats`（§6.4、§7.2、§7.4） |
| 5 | 推送超时 | 新增 `CALIBRE_PUSH_TIMEOUT_MS`，默认 120s；超时返回 504 并说明结果未确认（§6.4、§6.5） |
| 6 | 搜索时 TXT 过滤 | 客户端本地过滤；整页被过滤空时自动续取下一页，最多 3 页（§7.2） |
| 7 | 连接接口限流 | 新增 `CALIBRE_CONNECT_RATE_LIMIT_PER_MIN`，默认 5 次/分钟，失败计数，同时只允许一个连接尝试（§6.5、§8.7） |

用户已确认：`CALIBRE_ALLOW_PRIVATE` 默认保持 `true`（§6.5、§8.1）。

追加需求（2026-11-19）：calibre-web 连接配置需要加密保存，重启或从其他浏览器/设备登录后可直接复用；「断开」与「忘记凭据」区分语义（§6.2、§6.4、§7.2、§8.2、§10）。
