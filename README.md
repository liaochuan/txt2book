# txt2book

把 TXT 小说转换为 EPUB / HTML / TXT / PDF 的 Web 工具。解析、预览、EPUB / HTML / TXT 生成都在浏览器里完成，文件不会上传；Node 服务端负责登录认证、封面抓取/转换、静态资源托管、服务端 PDF 排版，以及代理已连接的 calibre-web（读取书库、回传 EPUB）。

## 功能列表

- 导入本地 TXT，自动识别编码（`jschardet`），也可手动指定 UTF-8 / GB18030 / Big5 / UTF-16LE。
- 自动识别卷、章、番外、楔子、尾声，生成可折叠的目录树。
- 章节编辑：重命名、删除（正文自动并入相邻章节）、删除卷（子章节提升为顶层章节），支持撤销。
- 章节目录搜索过滤。
- 实时预览：单章切换、连页模式与卷扉页预览，预览与 EPUB/HTML 导出共用同一套 XHTML 渲染逻辑；连页模式会在每卷第一章前插入卷扉页（卷名 + 卷首文字），PDF 由服务端另行排版。
- 五套排版主题：素白、纸墨、夜读、古卷、墨水屏，预览与 EPUB/HTML 导出效果一致（PDF 沿用字体与配色倾向）。
- 高级排版与背景图：按元素调整字体、字号、行高、段距、首行缩进、对齐与颜色，支持预设背景与自定义图片；每套主题独立保存。
- 封面：从图片 URL 抓取或上传本地图片，服务端统一转换为 PNG（最长边 1600px）。
- 多格式导出：EPUB 3、单文件 HTML、整理版 TXT 在浏览器端生成；PDF 由服务端 pdfkit 排版后下载。格式通过 `converterRegistry` 注册，UI 不写死。
- 导出 EPUB 3：一个章节一个 XHTML，包含 `nav.xhtml`、`toc.ncx` 与封面，可选目录页、书名页与卷扉页；三个内容选项默认关闭。
- 导出单文件 HTML：主题、排版、封面与背景全部内联，可离线用浏览器打开。
- 导出整理版 TXT：UTF-8 无 BOM，卷/章标题独占一行，保留正文段落。
- 导出 PDF：A4 / A5、标准或窄边距、页脚页码、封面、带页码目录、卷→章书签；服务端内置 Noto CJK 中文字体。
- 单账号登录保护，登录与封面接口均有限流。
- calibre-web 书库连接：填写地址、账号、密码即可浏览书库；连接配置加密保存，重启或换浏览器登录后自动复用。
- 「断开连接」只清连接、保留已保存配置；「忘记凭据」会删除配置，下次必须重新输入密码。
- 书库默认按最近添加浏览，也可关键词搜索与「只看有 TXT 的」过滤，可分页加载；账号看不到「最近」时回退到全部书单（按 calibre-web 默认排序，通常为书名），并按更新时间对当前页近似排序。
- 从书库导入 TXT 时自动填入书名、作者、语言、简介与封面。
- EPUB 导出后可推送回原书（作为新增格式）；目标书已有 EPUB 时需确认覆盖。
- 阅读主题独立于应用界面，仅作用于预览与导出内容。
- 自带站点图标与 PWA manifest，可添加到桌面/主屏。

## 导出格式

| 格式 | 扩展名 | 生成位置 | 用途 | 限制 |
|---|---|---|---|---|
| EPUB | `.epub` | 浏览器 | 电子书阅读器、手机/平板 | 需要阅读器支持 EPUB 3；封面固定输出 PNG |
| HTML | `.html` | 浏览器 | 单文件离线阅读、快速分享 | 所有资源内联，封面/背景大时文件偏大；目录为页内锚点，没有独立导航文件 |
| TXT | `.txt` | 浏览器 | 纯文本备份、再加工 | 无排版、封面、背景与图片；连续空行会折叠 |
| PDF | `.pdf` | 服务端 | 打印、固定版式阅读 | 需登录；网页 CSS 渐变、阴影、圆角不还原；有请求体积、字数、并发与频率限制 |

浏览器端生成的三个格式不出本机；PDF 需要把书稿模型提交到服务端，返回的文件不落盘，直接在内存中下载。EPUB 导出后可以选择「下载并推送」或「仅推送（不下载）」到已关联的 calibre-web 书籍；下载并推送时，推送失败不影响本地文件。

## 界面与操作

- 三栏布局：左侧目录与 TXT 导入，中间实时预览，右侧书籍信息、封面、主题、排版、自定义规则与导出。
- 桌面端左侧栏与中间预览都会吸顶：右侧滚动到排版或导出时，目录和预览仍留在视口内；窄屏自动取消吸顶，并在右下角提供「查看预览」按钮。
- 目录树的折叠箭头与卷名分开：点箭头只折叠/展开，点卷名预览该卷扉页；再次点击同一卷名回到章节。
- 章节行支持双击或 `F2` 重命名，`Enter` 保存、`Esc` 取消；搜索框按标题实时过滤。
- 顶栏「设置」弹窗负责 Calibre-Web 账户配置：未连接时填写地址、账号、密码；连接后显示地址与账号，并提供「打开书库」「修改连接」「断开连接」「忘记凭据」。
- 顶栏「书库」弹窗负责选书：搜索框（300ms 防抖）、「只看有 TXT 的」开关、书籍列表、加载更多与导入；未连接时提示先在设置中连接。两个弹窗同一时刻只打开一个，可用 Esc、遮罩或关闭按钮退出。
- 右侧导出卡片只有在「格式为 EPUB + 当前书籍已关联到当前连接 + 连接可推送」时才显示 Calibre-Web 推送方式，可选「不推送」「下载并推送」「仅推送（不下载）」；目标书已有 EPUB 时提示推送会覆盖原文件。仅推送模式不会生成本地文件。
- 所有阅读排版（主题、高级排版、背景）只作用于预览与导出的电子书，不会改变应用界面。

## calibre-web 书库对接

txt2book 可以通过顶栏「设置」弹窗连接一个 calibre-web 实例，再从「书库」弹窗浏览书库、把含 TXT 的图书导入转换，并在导出 EPUB 后推送回原书。

### 前置条件

- calibre-web 需开启 OPDS；账号至少要有 `download` 权限才能读取列表与 TXT。
- 推送要求账号能通过 calibre-web 的网页表单登录，并具有上传/编辑权限；calibre-web 需开启「允许上传」，且 EPUB 在允许的扩展名内。
- v1 只适配 calibre-web，不支持 calibre 原生的内容服务器（`calibre-server`）。

### 连接与地址

- 填写站点根地址，例如 `https://books.example.com`；反向代理到子路径时填写完整前缀，例如 `https://example.com/calibre`。不要带结尾 `/`、查询参数、`#` 或 URL 内嵌账号。
- 地址只允许 `http` / `https`；端口沿用封面抓取规则（80/443/8080/8443，或 ≥1024 且不在常见服务端口黑名单内）。
- 连接时先做 OPDS Basic 认证确认可读，再单独尝试网页登录确认可推送。网页登录失败不影响浏览，只是隐藏推送入口。
- 域名只解析一次并固定 IP；DNS 变化后需「修改连接」重新保存。所有请求只发往这个已连接的 origin，不跨 origin 重定向。

### TLS 与自签证书

- 服务端使用 Node 默认的 TLS 校验，没有「跳过证书校验」开关。
- 自签或私有 CA 签发证书时，在启动 txt2book 前设置 `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`。该变量只在进程启动时读取；Docker 部署需要把证书文件挂进容器并设置同名环境变量。
- 证书需覆盖填写的域名；使用子路径反向代理不影响证书校验。

### 凭据保存与复用

- 连接成功后，地址、账号、密码会加密写入 `CALIBRE_STORE_PATH`：AES-256-GCM，密钥由 `SESSION_SECRET` 经 HKDF 派生，文件权限 0600，先写临时文件再原子替换。
- txt2book 重启或换浏览器登录后，只要配置存在且能解密，会自动尝试恢复连接；失败时保留地址与账号、只需补密码，不会循环重试，也不会打爆 calibre-web。
- 更换 `SESSION_SECRET` 会使已保存配置无法解密，需要重新连接。设置 `CALIBRE_PERSIST_CREDENTIALS=false` 可完全关闭落盘，此时重启即失效。
- 「断开连接」只清空服务端内存中的连接与 Cookie，保留已保存配置，下次登录仍会自动恢复；「忘记凭据」会删除配置文件，下次必须重新输入密码。两者都有确认提示。
- 同一 txt2book 实例只维护一个连接，多个浏览器/标签页共享。连接尝试与推送各自全局串行（同一时刻只允许一个），避免并发请求同时压向 calibre-web。

### 浏览与导入

- 默认按最近添加列出书籍（`/opds/new`）；账号看不到「最近」栏目时自动回退到全部书单（按 calibre-web 默认排序，通常为书名），并在没有搜索词时按 entry 的 `<updated>` 对当前页倒序近似排序。打开「只看有 TXT 的」后隐藏没有 TXT 的书。搜索走 calibre-web 的 OPDS 搜索，TXT 过滤在浏览器端完成；若整页都被过滤且还有下一页，会自动续取（最多 3 页）。
- 简介会把 calibre-web 的 HTML 段落、`<br>` 与常见实体转换为纯文本换行，导入后 EPUB / HTML / TXT / PDF 的简介页都能按段落显示。
- 列表不加载封面缩略图，导入时才按需拉取该书封面。
- 点击「导入」会用书库数据覆盖当前书籍：书名、作者、语言、简介强制采用 calibre-web 的值；有封面时一并替换，没有封面或封面下载失败时清空旧封面。
- 导入后的书籍会记住来源（实例 origin + `bookId`），导出时据此确认推送目标。从本地重新导入会立即清除关联，撤销会随书籍快照一起回滚。

### 导出后推送

- 只有导出格式为 EPUB、当前书籍已关联到当前连接、且连接可推送时，右侧导出卡片才显示 Calibre-Web 推送方式，可选「不推送」「下载并推送」「仅推送（不下载）」；推送进行中按钮显示「正在推送」。
- 推送前服务端会先确认目标书是否已有 EPUB。已有且未确认覆盖时返回 `409 CALIBRE_EPUB_EXISTS`，界面弹确认；确认后带 `overwrite=true` 立即重试上传，不会重新生成 EPUB。目标书已有 EPUB 时推送方式默认设为「不推送」。
- 「仅推送（不下载）」只在内存中完成转换并上传，不调用本地下载；失败或取消覆盖时不会生成本地文件，可切换到「下载并推送」后重试。
- 推送成功会提示已推送到 Calibre-Web 并带上书名，「下载并推送」会保留本地文件。推送失败或超时只影响回传，界面会提示可行动原因，可重新导出重试。
- 推送通过模拟 calibre-web 网页表单完成：`POST /login` 取会话与 CSRF token，再 `POST /upload`，以 `book_id` + `btn-upload-format` 给原书追加格式；不新增书目，也不改动原有元数据与封面。
- 覆盖同名格式时，calibre-web 会覆盖磁盘文件但可能不更新数据库中的文件大小；功能不受影响，体积显示可能偏旧。

### 资源与限流

- 单个 TXT 下载上限 50MB（`CALIBRE_MAX_FILE_BYTES`），单次 EPUB 推送上限 50MB（`CALIBRE_MAX_PUSH_BYTES`），超限返回 `413 CALIBRE_TOO_LARGE`。
- 普通上游请求（列表、封面、登录、推送预检）默认 15 秒超时（`CALIBRE_TIMEOUT_MS`）；上传 EPUB 使用独立的 120 秒超时（`CALIBRE_PUSH_TIMEOUT_MS`）。推送超时返回 `504`，结果视为未确认。
- 同一时刻只允许 1 个连接尝试和 1 次推送，占用时返回 `429 CALIBRE_BUSY`。
- 默认按客户端 IP 限流：读取类 120 次/分钟、推送 6 次/分钟、连接尝试 5 次/分钟；连接失败也计数。
- TXT 与 EPUB 只经过服务端内存转发，不写入磁盘；唯一新增的落盘数据是加密后的连接配置。

### Docker 与网络

- 镜像默认把配置写到 `/data/calibre-connection.json`，`docker-compose.yml` 用命名卷 `txt2book-data:/data` 持久化。不挂载卷时，容器重建会丢失配置；`docker compose down` 不会删除该卷，`docker compose down -v` 才会。
- txt2book 与 calibre-web 同机 Docker、又用公网域名访问时，容器内可能无法回环到该域名。优先让域名在内网解析到 calibre-web（内部 DNS 或 hosts），或直接填写容器可达的内网地址；容器内的 `127.0.0.1` 指向容器自身，不是宿主机。
- `CALIBRE_ALLOW_PRIVATE` 默认 `true`，允许连接局域网与回环地址，适合自建书库。若 txt2book 暴露在公网、calibre-web 也在公网，建议设为 `false`；无论该开关如何，云元数据地址与链路本地地址始终拒绝。

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
- 背景支持纯 CSS 预设（纸纹、网格、点阵、亚麻）与自定义图片。自定义图上传或粘贴后由服务端统一转为 JPEG（质量 82、最长边 1600px、上限 10MB），预览与 EPUB 使用同一张图；透明图会保留为 PNG。
- 墨水屏主题禁用背景图，并关闭卷扉页底线、连页分隔线等装饰，减少灰阶抖动与残影。

## 预览与卷扉页

- 预览覆盖正文、主题、高级排版与背景；封面页、书名页、简介页与目录页不在预览内，导出后才会出现。
- 点击目录树中的卷名可预览卷扉页：只展示卷标题与卷首文字；再次点击同一卷名，或点击任意章节，回到章节预览。
- 番外分组没有独立扉页，点击其名称只负责展开/折叠。连页模式仍按导出顺序在每卷第一章前插入卷扉页。

## 导出内容选项

| 选项 | 默认 | 说明 |
|---|---|---|
| 目录页 | 关闭 | 在正文前插入一页可翻阅的目录。关闭后阅读器自带的导航目录仍然可用，只是书里不出现目录页。 |
| 书名页 | 关闭 | 在封面后插入书名与作者页；有简介时仍会单独生成简介页。关闭后直接从正文开始。 |
| 卷扉页 | 关闭 | 为每个卷生成独立标题页，并展示卷首文字。关闭后卷首文字会以居中样式并入该卷第一章开头，不会丢失。 |

三个选项都不勾选时，EPUB 从正文开始；关闭卷扉页后，卷标题与卷首文字仍会以 `.volume-note-block` 区块出现在该卷第一章顶部，并继续应用卷首文字的高级排版。零章卷的卷首文字会并入其后第一章；若全书没有章节，仍会为这些卷生成卷扉页，避免文字丢失。

## 导出结构

生成的 EPUB 3 结构：

```text
mimetype                       application/epub+zip（未压缩，ZIP 首项）
META-INF/container.xml
OEBPS/
  content.opf                  元数据、manifest、spine
  nav.xhtml                    EPUB 3 导航目录（卷 → 章嵌套）
  toc.ncx                      兼容旧阅读器的目录
  styles/theme.css             主题 CSS + 高级排版 CSS
  images/cover.png             封面（始终 PNG）
  images/background.jpg        自定义背景（可选，JPEG 或 PNG）
  cover.xhtml                  封面页
  titlepage.xhtml              书名页（可选）
  description.xhtml            简介页（有简介时）
  volume-N.xhtml               卷扉页（可选）
  text/chapter-N.xhtml         一章一个 XHTML
```

- 封面与背景都会进入 OPF manifest；背景不会进入 spine。
- 墨水屏主题不输出任何背景图。
- 所有文本按纯文本转义后写入 XHTML，并剔除 XML 非法控制字符。

## PDF 导出（服务端）

PDF 由服务端用 `pdfkit` 手动排版，前端只负责组装书稿模型、提交请求并下载结果；不使用浏览器打印，也不引入 headless Chromium。

### 版式

- 纸张：A4（595×842pt）或 A5（420×595pt）。
- 页边距：标准 56pt / 窄 36pt；封面单独按 36pt 边距等比缩放居中。
- 结构顺序与 EPUB spine 一致：封面（可选）→ 书名页（可选）→ 简介页（有简介时）→ 目录页（可选）→ 卷扉页（可选）→ 章节。
- 页脚页码默认开启，封面不显示页码；关闭后所有页面都不绘制。
- 目录页带真实页码：先测量排版，再回填页码。
- 书签：按“卷 → 章”生成两级 PDF 导航书签；部分阅读器不显示书签面板。
- 高级排版映射到 PDF：字号、行高、段距、首行缩进、对齐、颜色与标题上下留白；主题只取其字体倾向与配色。
- 中文断行按字符宽度累加，并做标点避头尾；网页的 CSS 渐变、阴影、圆角不会进入 PDF。

### 中文字体

字体只从环境变量与固定候选路径解析，不接受请求参数：

1. `PDF_FONT_PATH` 指定的字体文件（可配 `PDF_FONT_FAMILY`）；
2. 当前系统的固定候选：
   - Docker / Linux：`/usr/share/fonts/noto/NotoSerifCJK-Regular.ttc`（衬线）、`/usr/share/fonts/noto/NotoSansCJK-Regular.ttc`（无衬线）；
   - Windows：`simsun.ttc`、`simhei.ttf`、`simkai.ttf`；
   - macOS：`Songti.ttc`、`PingFang.ttc`。

Docker 运行镜像已通过 `apk add --no-cache font-noto-cjk` 内置 Noto CJK，开箱即用。Linux 镜像通常没有楷体，楷体配置会回退到衬线字体。

`PDF_FONT_PATH` 会同时覆盖衬线、无衬线、楷体三个角色。TTC / DFont 是字体集合，必须再用 `PDF_FONT_FAMILY` 指定集合内的 PostScript 名（例如宋体 `SimSun`、Noto `NotoSerifCJKsc-Regular`），否则 pdfkit 无法选中字面；普通 `.ttf` / `.otf` 单字体文件可只写路径。

找不到任何可用中文字体时返回 `500` 与错误码 `PDF_FONT_MISSING`，提示安装 Noto CJK 或设置 `PDF_FONT_PATH`。成功响应带 `X-PDF-Font` 头，记录实际字族，不含字体路径。

### 背景与限制

- 预设的 CSS 渐变纹理（纸纹、网格、点阵、亚麻）不会进入 PDF；只有自定义背景图会以 8% 不透明度铺满每页后再绘制文字。
- PDF 在服务端生成，需要登录；生成结果不落盘，直接在内存中返回。
- 请求体上限 20MB（超出返回 `413` 与 `PAYLOAD_TOO_LARGE`）；章节数 ≤ 2000，单章 ≤ 200 万字符，全书 ≤ 2000 万字符，超出返回 `400`。
- 同一时刻只允许 1 个 PDF 任务，占用期间新请求返回 `429`（`Retry-After: 5`）。
- 单次生成 60 秒超时，超时返回 `504`。pdfkit 没有安全的取消接口，已开始的渲染不会被中断，会继续执行到结束；这期间并发位保持占用，新请求仍返回 `429`。
- 按客户端 IP 限流 6 次 / 分钟，超出返回 `429`（`Retry-After: 60`）。
- 大书会显著占用 CPU 与内存，Docker 部署建议限制为 1GB（见下文）。

## npm 脚本

| 命令 | 作用 |
|---|---|
| `npm run dev` | 前端 Vite 开发服务器（`/api` 代理到 3000） |
| `npm run dev:server` | 后端开发模式，自动加载 `.env` |
| `npm run build` | 构建前端与后端 |
| `npm run build:web` / `npm run build:server` | 单独构建前端 / 后端 |
| `npm start` | 以生产模式启动，自动加载 `.env` |
| `npm run typecheck` | `vue-tsc` + 服务端 `tsc --noEmit` |
| `npm test` | Vitest 全量执行 |
| `npm run hash-password` | 生成 `AUTH_PASSWORD_HASH`（需要开发依赖） |


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

### 容器内存建议

PDF 在服务端完成排版，峰值内存随章节数与字号变化。建议给容器 1GB 上限，避免大书导出时拖垮宿主机。`docker-compose.yml` 中二选一：

```yaml
services:
  txt2book:
    mem_limit: 1g
```

或使用 `deploy.resources`（Swarm 模式，以及支持该字段的 Compose v2）：

```yaml
services:
  txt2book:
    deploy:
      resources:
        limits:
          memory: 1g
```

`mem_limit` 是容器级硬限制；不要与 `deploy.resources.limits.memory` 重复设置。低于 512MB 时，较大的书可能被 OOM kill，表现为容器重启或导出失败。

常用命令：

```bash
docker compose ps                      # 查看状态与健康检查
docker compose logs -f txt2book        # 跟踪日志
docker compose down                    # 停止并移除容器
docker compose up -d --build           # 更新代码后重建
```

健康检查请求 `GET /api/health`，正常返回 `{"ok":true}`；该接口无需登录，供容器与反向代理探活。

### calibre-web 配置持久化与自签证书

`docker-compose.yml` 已把命名卷 `txt2book-data` 挂到 `/data`，镜像默认将 calibre-web 连接配置写到 `/data/calibre-connection.json`。`docker compose down` 不会删除该卷，容器重建后配置仍在；只有 `docker compose down -v` 才会连同配置一起删除。自行修改 `CALIBRE_STORE_PATH` 时，请确保目标目录位于持久化卷上且对容器内 uid 1000 可写，否则只会降级为内存连接。

calibre-web 使用自签或私有 CA 证书时，把 CA 证书挂进容器并设置 `NODE_EXTRA_CA_CERTS`。仓库的 `docker-compose.yml` **已经配置**了 `- txt2book-data:/data` 挂载项和顶层 `volumes: txt2book-data:`，不要再添加 `txt2book-data`、`/data` 挂载或第二个顶层 `volumes` 键。只需在现有 `txt2book` 服务中：把环境变量加到该服务的 `environment` 下；把证书挂载项追加到该服务现有的 `volumes` 列表末尾。不要用下面的片段替换整个服务定义：

```yaml
services:
  txt2book:
    environment:
      NODE_EXTRA_CA_CERTS: /certs/calibre-ca.pem
    volumes:
      # 追加到现有列表；已有的 txt2book-data:/data 必须保留，不要重复添加。
      - ./certs/calibre-ca.pem:/certs/calibre-ca.pem:ro
```

`NODE_EXTRA_CA_CERTS` 只在进程启动时读取，改完需要 `docker compose up -d` 重建容器。项目不提供跳过 TLS 校验的开关。

## HTTPS 反向代理

把服务放在 Nginx、Caddy、Traefik 等反向代理后时：

1. `.env` 中设置 `COOKIE_SECURE=true` 与 `TRUST_PROXY=true`。
2. 反向代理必须**覆盖**（而不是追加）`X-Forwarded-For` 与 `X-Forwarded-Proto`。若代理采用追加方式，客户端可以自带伪造头绕过按 IP 的登录限流。
3. 反向代理到容器 `3000` 端口（compose 映射到宿主机的 `8080`）。

Nginx 关键配置示例：

```nginx
location / {
    # 封面本地上传上限 10MB，multipart 还有少量开销；PDF 导出请求体上限 20MB。
    # Nginx 默认只允许 1m，不放开会在上传封面或导出 PDF 时直接返回 413。
    client_max_body_size 22m;

    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

`client_max_body_size` 建议至少 `22m`（PDF 导出请求体上限 20MB，封面 10MB）；若只放在 `location` 中，对其他 location 不生效，也可以放到 `server` 或 `http` 块统一设置。

不要在 HTTPS 反代场景下保留 `COOKIE_SECURE=false`，否则会话 Cookie 可能经明文 HTTP 泄露；反之，直接 http 访问时设为 `true` 会导致浏览器不保存 Cookie、始终无法登录。

`TRUST_PROXY=true` 时，Fastify 会采用转发头中的客户端 IP 与协议；仅当你确认代理会覆盖这两个头时开启。

## 安全说明

- **登录认证**：单账号，密码使用 scrypt 哈希；会话 Cookie 为 HMAC-SHA256 签名的无状态令牌，`HttpOnly`、`SameSite=Strict`，可选 `Secure`；Cookie 内不含用户可修改的权限字段，签名校验使用常量时间比较。
- **登录限流**：同一 IP 与同一用户名各 5 次 / 15 分钟，超限返回 `429` 与 `Retry-After`；用户名不存在时也执行一次 scrypt 校验，避免通过响应时间枚举账号；失败文案统一。
- **封面接口限流**：抓取与上传共用同一个按 IP 的桶，默认 30 次 / 分钟（`RATE_LIMIT_PER_MIN`）。
- **PDF 导出防护**：接口需要登录，请求体 20MB、章节/字数上限、并发 1、60 秒超时与 6 次 / 分钟按 IP 限流；字体路径只来自固定候选与环境变量，错误文案不泄露路径与堆栈。
- **calibre-web 代理边界**：只代理已连接的单个 origin，路径、`book_id` 与格式全部白名单，不跨 origin 重定向；`CALIBRE_ALLOW_PRIVATE` 控制是否允许私网/回环地址，云元数据与链路本地地址始终拒绝；错误文案不含主机名、IP 或上游 HTML；连接尝试与推送全局串行，并分别限流。
- **calibre-web 凭据**：密码只在服务端内存与加密配置文件中出现，接口不回显、不写日志、不进入 localStorage；配置文件使用 AES-256-GCM（密钥由 `SESSION_SECRET` 经 HKDF 派生）、权限 0600、原子写入，也可用 `CALIBRE_PERSIST_CREDENTIALS=false` 完全关闭落盘。
- **SSRF 防护**：封面 URL 只允许 `http` / `https`；端口只允许 80/443/8080/8443 或不低于 1024 的常规端口，并排除常见内网服务端口（6379 Redis、9200/9300 Elasticsearch、27017/27018/27019 MongoDB、11211 Memcached、2375/2376 Docker、5432 PostgreSQL、3306 MySQL 等）；拒绝本机、内网、链路本地、CGNAT、组播、保留地址与 `localhost`、`*.local`、`*.internal`、`metadata` 等域名；DNS 解析后固定 IP 连接，并在每次重定向前重新校验，防止 DNS rebinding 与重定向绕过。
- **资源限制**：封面下载默认 10MB 上限、8 秒超时、输入不超过 4000 万像素，输出最长边缩放到 1600px；本地封面上传同为 10MB 上限。
- **CSRF**：会话 Cookie 使用 `SameSite=Strict`；带 `Origin` 头的非 GET/HEAD/OPTIONS 请求会校验同源。
- **XSS / 点击劫持**：正文按纯文本转义后生成 XHTML，预览 iframe 使用 sandbox；所有响应附带 `Content-Security-Policy`、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`。
- **配置失败即拒绝启动**：缺少密码哈希或过短的会话密钥时服务不会裸奔启动；`AUTH_DISABLED=true` 仅用于本地开发并会打印警告。
- **不落盘**：TXT、封面、PDF 与 calibre-web 的 TXT/EPUB 转发都在内存中处理，服务端不写用户文件，也不提供上传目录；唯一持久化的是加密后的 calibre-web 连接配置（可用 `CALIBRE_PERSIST_CREDENTIALS=false` 关闭）。

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
| `PDF_FONT_PATH` | 无 | 可选，PDF 中文字体文件路径；覆盖系统候选 |
| `PDF_FONT_FAMILY` | 无 | 可选，TTC/DFont 集合内的 PostScript 名；仅在 `PDF_FONT_PATH` 指向集合文件时需要 |
| `CALIBRE_ALLOW_PRIVATE` | `true` | 允许连接内网/回环地址；云元数据与链路本地地址始终拒绝 |
| `CALIBRE_PERSIST_CREDENTIALS` | `true` | 加密保存连接配置；`false` 时只保留在内存，重启失效 |
| `CALIBRE_STORE_PATH` | `./data/calibre-connection.json` | 加密配置路径；Docker 镜像内默认为 `/data/calibre-connection.json` |
| `CALIBRE_TIMEOUT_MS` | `15000` | 列表、封面、登录与推送预检的上游超时（毫秒） |
| `CALIBRE_PUSH_TIMEOUT_MS` | `120000` | 上传 EPUB 的独立超时（毫秒） |
| `CALIBRE_MAX_FILE_BYTES` | `52428800` | 单个 TXT 下载上限（字节，50MB） |
| `CALIBRE_MAX_PUSH_BYTES` | `52428800` | 单次 EPUB 推送上限（字节，50MB） |
| `CALIBRE_RATE_LIMIT_PER_MIN` | `120` | calibre-web 读取类接口每 IP 每分钟次数 |
| `CALIBRE_PUSH_RATE_LIMIT_PER_MIN` | `6` | 推送每 IP 每分钟次数 |
| `CALIBRE_CONNECT_RATE_LIMIT_PER_MIN` | `5` | 连接尝试每 IP 每分钟次数（失败也计数） |

`PORT` 是容器内监听端口，默认 `3000`。`docker-compose.yml` 的 `8080:3000` 与 healthcheck 里的 `127.0.0.1:3000` 都固定写死 `3000`；修改 `PORT` 时必须同步修改这两处（并按需调整 Dockerfile 的 `EXPOSE`），否则浏览器访问与健康检查都会失败。

calibre-web 的加密密钥由 `SESSION_SECRET` 派生，更换 `SESSION_SECRET` 会让整份已保存的连接配置无法解密（按未保存处理，不会报错或损坏其他数据），需要重新填写地址、账号和密码并重新连接。`CALIBRE_ALLOW_PRIVATE` 与 `CALIBRE_PERSIST_CREDENTIALS` 只有显式写 `false` 才关闭，留空视为 `true`。

## 目录结构

```text
src/                    前端源码
  components/           展示组件（目录树、预览、封面、主题、排版、导出、登录等）
    AppDialog.vue       通用弹窗容器（遮罩、Esc、焦点与滚动锁）
    CalibreSettingsDialog.vue calibre-web 账户配置弹窗
    CalibreLibraryDialog.vue  calibre-web 书库选择弹窗
    CalibreBookRow.vue  calibre-web 单本书的导入行
  composables/          组件共享状态（认证、导入、封面、主题、排版、背景、提示）
    useCalibre.ts       calibre-web 浏览、导入与推送状态编排
  core/                 纯逻辑
    chapterParser.ts    内置章节识别
    customRules.ts      自定义规则存储与编译
    chapterOps.ts       重命名、删除、合并、撤销
    preprocess.ts       断行与行首清理
    textReader.ts       编码识别与手动重解码
    api.ts              前端 API 客户端
    exportFileName.ts   导出文件名清洗（Windows 保留名等）
    imageDataUrl.ts     背景字节转 data URL
    calibre/            calibre-web OPDS 解析（feed.ts）
    render/             章节 XHTML 渲染、主题与高级排版 CSS
    converters/         格式转换器注册表
      epub/             EPUB 3（浏览器端）
      html/             单文件 HTML（浏览器端）
      txt/              整理版 TXT（浏览器端）
      pdf/              服务端 PDF 请求组装
  styles/               CSS 变量与全局样式
  types/                前端类型（含 calibre.ts）
  App.vue               主界面装配
server/                 后端源码
  app.ts                Fastify 实例组装
  index.ts              启动入口（读取配置并监听）
  lib/                  配置、认证、会话、限流、SSRF、图片处理
    calibre/            calibre-web 地址策略、HTTP 客户端、登录/上传与加密配置
    pdf/                PDF 字体解析、断行、排版与书签
  routes/               认证、封面、导出与 calibre-web 路由
  scripts/              密码哈希脚本
public/                 站点图标、PWA manifest 等静态资源
tests/                  Vitest 测试与 fixtures
docs/                   设计与计划文档
data/                   calibre-web 加密配置（生成，已忽略）
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

测试覆盖章节解析（卷、番外、楔子、尾声混排）、章节操作与撤销、XHTML 渲染、EPUB 结构、单文件 HTML、整理版 TXT、PDF 生成与字体回退、PDF 接口限制（未登录、超限、并发、限流）、SSRF 黑名单与重定向校验、认证与会话篡改、限流以及完整的导入导出集成流程；calibre-web 部分覆盖 OPDS 解析、连接与地址策略、加密配置读写、推送预检/覆盖确认、登录与 CSRF、上游错误映射、并发与限流。

## 常见问题

**配置了 `.env`，启动仍提示缺少 `SESSION_SECRET` / `AUTH_PASSWORD_HASH`？**

确认使用的是 `npm run dev:server` 或 `npm start`，这两条命令会自动加载项目根目录的 `.env`。手动执行 `node server-dist/index.js` 不会读取 `.env`，需要加 `--env-file=.env`。启动错误信息在检测到 `.env` 时会给出同样提示。

**`npm run dev` 下登录或封面接口返回 403？**

开发代理必须保留浏览器的 `Host`。`vite.config.ts` 已移除 `changeOrigin`，请不要改回去；否则后端 Origin 校验会认为请求跨站。生产环境由同一个服务托管前端与 API，不受影响。

**上传封面或背景、导出 PDF 返回 413？**

反向代理（常见是 Nginx 默认 `client_max_body_size 1m`）先于应用拒绝了请求。按「HTTPS 反向代理」示例调到 `22m` 以上。应用自身的上限是封面 10MB、PDF 请求体 20MB。

**登录一直失败，但用户名密码没错？**

检查 `.env` 里的 `AUTH_PASSWORD_HASH` 是否用单引号包裹。哈希含多个 `$`，未加引号会被 `docker compose` 当作变量展开，导致哈希损坏。PowerShell 5.1 下不要用管道传中文密码（会被转成 `??`），请用参数形式 `npm run hash-password -- '你的密码'`。

**电纸书上背景图没显示？**

很多电纸书/阅读器会忽略 EPUB 的 `body` 背景图。墨水屏主题本身不使用背景；如果目标设备是 Kindle 或老款 Kobo，建议优先使用无背景主题。

**换浏览器或清理缓存后，主题排版怎么恢复默认了？**

主题偏好、高级排版与背景都保存在浏览器 `localStorage`（`txt2book.layout.<themeId>`），不随账号同步。清除站点数据或换浏览器会回到默认值。

**导出的书里为什么没有目录页？**

「目录页」默认关闭。它只影响书中那一页可见目录；阅读器自带的导航目录（`nav.xhtml` / `toc.ncx`）始终存在。

**导出 PDF 提示缺少中文字体？**

Docker 运行镜像已内置 Noto CJK，通常不会出现。本机运行依赖系统字体：Windows 的宋体/黑体/楷体、macOS 的宋体/苹方；Linux 需安装 `fonts-noto-cjk`（Debian/Ubuntu）或 `font-noto-cjk`（Alpine）。也可以设置 `PDF_FONT_PATH`；如果指向 `.ttc` / `.dfont` 集合，还需用 `PDF_FONT_FAMILY` 指定内部 PostScript 名。

**PDF 里的纸纹、网格背景不见了？**

预设背景由 CSS 渐变生成，不会进入 PDF；只有自定义背景图会以 8% 不透明度铺在页面上。需要纸色质感时可改用主题底色，或上传一张自定义背景图。

**导出 PDF 返回 429 或 504？**

`429` 表示同一时刻已有 PDF 任务（`Retry-After: 5`）或超过 6 次 / 分钟限流（`Retry-After: 60`）；`504` 表示单次生成超过 60 秒。超时不会取消已开始的渲染：任务会继续到结束，期间并发位保持占用，因此后续请求仍可能返回 `429`。减少章节或字数、稍后重试即可；大书还会占用较多内存，建议容器限制 1GB。

**calibre-web 连接提示「地址无效或不可访问」？**

先检查地址是否带协议（`http://` / `https://`）、是否误带结尾 `/`、查询参数或 `#`；使用反向代理子路径时要填写完整前缀（如 `https://example.com/calibre`）。端口需为 80/443/8080/8443 或 ≥1024 且不在常见服务端口黑名单内。连接局域网或回环地址需要 `CALIBRE_ALLOW_PRIVATE=true`（默认）。使用自签证书时设置 `NODE_EXTRA_CA_CERTS` 指向 CA 文件。

**能浏览书库，但导出卡片没有推送选项？**

推送要求账号能通过 calibre-web 网页表单登录、具有上传/编辑权限，并且 calibre-web 已开启「允许上传」、EPUB 在允许的扩展名内。若连接是只读（网页登录失败），或当前书籍来自另一个实例，推送入口会隐藏；可在「书库」弹窗确认「已关联」的书籍与当前地址是否一致。

**重启后仍要求输入 calibre-web 密码？**

按顺序检查：`CALIBRE_PERSIST_CREDENTIALS` 是否为 `false`；`SESSION_SECRET` 是否更换过（换了会导致已保存配置无法解密）；Docker 是否挂载了 `/data` 命名卷且目录可写；`CALIBRE_STORE_PATH` 是否指向了非持久化路径。配置文件损坏时会被按未保存处理，原文件保留但不会自动删除。

**推送超时或提示「已提交但未确认」？**

大文件上传可能超过默认 120 秒，可调大 `CALIBRE_PUSH_TIMEOUT_MS` 后重试。超时或确认失败时 calibre-web 可能已经收到文件，先到书库确认再决定是否重试，避免误覆盖。calibre-web 版本升级导致登录/CSRF/上传流程变化时，推送也可能失效，此时本地下载仍可用。

**Docker 里连不上同机的 calibre-web？**

容器内的 `127.0.0.1` 是容器自身。若用公网域名访问且该域名在容器内无法回环到宿主机，请改用容器可达的内网地址，或让域名通过内部 DNS / hosts 解析到 calibre-web。连接成功后服务端会固定解析出的 IP，网络变更后需要「修改连接」重新保存。


## 已知限制

- **大文件在内存中处理**：TXT 由浏览器整体读入并解析，导出时整套书模型与 ZIP 也在内存中；封面在服务端内存中解码、缩放。超大的单文件可能触发浏览器或容器内存上限，建议单本控制在数十 MB 以内。
- **限流状态按进程保存**：限流桶存在内存中。多副本或多实例部署时每个副本独立计数，实际额度会随副本数放大；需要严格全局限流时应在反向代理层另加限流。
- **无服务端会话吊销**：会话是无状态签名 Cookie，退出登录只清除浏览器 Cookie，服务端不维护黑名单。已签发的 Cookie 在过期前仍可使用；更换 `SESSION_SECRET` 或密码后需要让所有旧会话失效时，重启服务并更换密钥。
- **PDF 不是网页预览的像素级复制**：PDF 由 pdfkit 重新排版，CSS 渐变纹理、阴影、圆角与复杂背景不会出现；只有自定义背景图会以 8% 不透明度叠加。目录页码与书签依赖两遍排版，超大书更慢。
- **PDF 需要服务端资源**：服务端生成且需要登录，受 20MB 请求体、2000 章 / 2000 万字、并发 1、60 秒超时与 6 次 / 分钟限流约束；容器内存建议 1GB。
- **未实现 AZW3 / MOBI / DOCX**：转换器注册表可扩展，但这三种格式暂未实现。
- **封面只输出 PNG**：为保证阅读器兼容性，所有封面统一转为 PNG，超大封面会被缩放并可能增大文件体积。
- **依赖漏洞待升级**：当前 `npm audit --omit=dev` 报告 2 high + 2 moderate。high 来自 `sharp` 及其 libvips/libheif/librsvg 依赖；moderate 来自 `@fastify/static` 传递依赖的 `minimatch`/`glob`。修复需要 breaking 升级（`sharp@0.35.5`、`@fastify/static@10`），升级后应重跑全量测试与封面 URL/上传转换验证，再更新镜像。
- **背景图依赖阅读器**：EPUB 的 `body` 背景图在部分阅读器（尤其电纸书）会被忽略；自定义背景会统一转成 JPEG 并缩放，透明图转为 PNG。
- **预览不包含所有结构页**：预览覆盖正文、排版主题、卷扉页与背景，但封面页、书名页、简介页、目录页只在导出的 EPUB 中出现。
- **墨水屏的分页策略需实机确认**：章标题设置了 `page-break-before`，个别旧阅读器可能在每章前多出一张空白页。
- **排版配置不跨设备同步**：主题、高级排版与背景保存在浏览器本地，换浏览器或清理站点数据后需要重新设置。
- **calibre-web 只支持本地表单登录**：LDAP、OAuth 或反向代理头登录的账号只能读取书库，不能推送；推送入口会隐藏。
- **推送依赖模拟网页表单**：登录、CSRF token 与 `/upload` 字段随 calibre-web 版本或反向代理改动可能失效；失败只影响回传：下载并推送时本地文件已下载，仅推送时不会生成本地文件。
- **不写回元数据**：推送只在原书下追加 EPUB，不改书名、作者、简介、封面，也不新建书目。
- **列表不显示封面缩略图**：避免每行一次代理请求；封面只在导入时拉取。
- **连接是全局单实例**：同一 txt2book 实例只维护一个 calibre-web 连接，所有浏览器共享；多副本部署需要各自连接，配置不跨实例同步。
- **覆盖 EPUB 不更新体积**：calibre-web 覆盖同名格式时可能保留旧的文件大小显示，内容本身正常。
- **连接固定 DNS 结果**：连接成功后固定一个解析出的 IP；calibre-web 迁移或 DNS 变更后需要「修改连接」重新保存。
