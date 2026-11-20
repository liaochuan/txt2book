# calibre-web 文档与最终验收计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐用户文档、项目约定与最终验证，确保 calibre-web 对接可部署、可复用、可回滚。

**Architecture:** 仅修改文档，不改业务代码；验证覆盖类型、全量测试、构建、凭据泄露检查与真实实例手测清单。

**Tech Stack:** Markdown、npm scripts、Docker Compose（可选）。

**Spec:** `docs/superpowers/specs/2026-11-19-calibre-web-integration-design.md`

## 全局约束

- 不执行 `git add` / `commit` / `push`。
- 文档中的命令必须能在项目根目录直接执行。
- 不修改 `server/**` 与 `src/**`；发现问题回到对应计划修复。
- 所有用户可见文案中文。

## Review Focus

- 文档不得保留「重启后需要重新输入」的旧表述，必须与「加密保存 + 自动复用」一致。
- 命令必须能在 PowerShell 与 bash 下直接执行，避免 `**` 递归等平台差异。
- 安全章节必须写清私网开关、凭据落盘与轮换、覆盖确认三件事。

---

### Task D1: README 与 AGENTS

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`

**Interfaces:**
- 无代码接口。

- [ ] **Step 1: 更新 README 功能列表与界面说明**

在功能列表加入：
- calibre-web 书库连接（地址/账号/密码，配置加密保存）；
- 书库浏览、搜索、只看 TXT；
- 导入 TXT 时自动填入书名、作者、语言、简介、封面；
- EPUB 导出后推送回原书（已有 EPUB 需确认覆盖）；
- 连接配置在重启或其他浏览器登录后自动复用；断开/忘记凭据的区别。

在界面与操作部分补充左侧书库面板的操作路径，以及推送开关出现条件（EPUB + 已关联 + canPush）。

- [ ] **Step 2: 新增「calibre-web 书库对接」专节**

必须包含：
- calibre-web 侧前置条件：账号有 download 权限；推送需要上传/编辑权限与「允许上传」开启；EPUB 在允许扩展名内。
- 地址格式：`https://books.example.com` 或带子路径 `https://example.com/calibre`；同机 Docker 用域名时的 DNS/NAT 回流注意事项。
- TLS：自签证书需要 `NODE_EXTRA_CA_CERTS`；不提供跳过校验开关。
- 凭据保存：`CALIBRE_STORE_PATH`、AES-256-GCM、密钥来自 `SESSION_SECRET`；更换 `SESSION_SECRET` 后需重新连接；`CALIBRE_PERSIST_CREDENTIALS=false` 可关闭。
- 断开/忘记语义。
- Docker 部署：`/data` 命名卷；不挂载会在容器重建后丢失配置。
- 安全边界：只代理已连接 origin、私网开关、云元数据始终拒绝、限流。
- 已知限制：登录方式限本地表单；calibre 原生内容服务器不支持；推送依赖网页表单，版本升级可能失效。

- [ ] **Step 3: 更新配置表与目录结构**

- 配置表加入 10 个 `CALIBRE_*` 变量（值、默认、说明）。
- 目录结构加入 `server/lib/calibre/` 与 `src/core/calibre/`、`src/composables/useCalibre.ts`、`src/components/Calibre*.vue`。
- 「不落盘」说明改为：TXT/EPUB 只在内存中处理；唯一落盘的是加密后的 calibre-web 连接配置。

- [ ] **Step 4: 更新 AGENTS.md 目录与安全约定**

- 目录约定补 `server/lib/calibre/`、`src/core/calibre/`。
- 增加一行：calibre-web 代理只允许已连接 origin；凭据不得写日志/响应；连接与推送限流必须有测试。
- 不改变现有提交约定（agent 不 commit）。

- [ ] **Step 5: 检查文档链接与命令**

Run: `Select-String -Path README.md -Pattern "CALIBRE_|calibre-web|/data|NODE_EXTRA_CA_CERTS"`
Expected: 10 个变量与关键主题都能找到；无遗留「重启后需要重新输入」的旧表述。

---

### Task D2: 凭据与安全泄露检查

**Files:**
- 不修改文件（只读检查）；发现问题回到计划 1 修复。

- [ ] **Step 1: 检查代码中无明文凭据输出**

Run:

```powershell
Get-ChildItem -Path server -Recurse -Filter *.ts | Select-String -Pattern "password|Authorization|Basic " -CaseSensitive
```

Expected: 只出现在 calibre 的请求构造与类型定义中；没有 `console.log`、错误消息插值或 Fastify logger 输出。

- [ ] **Step 2: 检查配置文件不含明文**

Run（需要本地已有保存的配置时）：

```bash
node -e "const fs=require('fs');const p=process.env.CALIBRE_STORE_PATH||'./data/calibre-connection.json';if(fs.existsSync(p)){const s=fs.readFileSync(p,'utf8');console.log(s); if(/password|username|https?:/i.test(s)) process.exit(1)}"
```

Expected: 输出仅含 `version/iv/tag/data`；退出码 0。没有文件时跳过。

- [ ] **Step 3: 检查构建产物与 git 状态**

Run:

```bash
git status --porcelain
git check-ignore -v data/calibre-connection.json
```

Expected: `data/` 被忽略；`git status` 不出现 `data/` 下的文件；改动仅在本次任务文件内。

- [ ] **Step 4: 检查日志与错误文案**

Run:

```bash
Select-String -Path server\lib\calibre\*.ts,server\routes\calibre.ts -Pattern "error\.message|String\(error\)|JSON\.stringify\(.*password"
```

Expected: 无命中，或仅命中经过白名单映射的分支。

---

### Task D3: 全量验证与手测清单

**Files:**
- 不修改文件；验证结果记录在 ledger。

- [ ] **Step 1: 类型检查**

Run: `npm run typecheck`
Expected: 0 errors。

- [ ] **Step 2: 全量测试**

Run: `npm test`
Expected: 全部通过；记录用例数与耗时。

- [ ] **Step 3: 生产构建**

Run: `npm run build`
Expected: `dist/` 与 `server-dist/` 生成成功。

- [ ] **Step 4: 真实 calibre-web 手测**

按顺序执行并记录结果：

1. 填写域名 + 账号 + 密码 → 连接成功，显示书库。
2. 打开「只看有 TXT 的」→ 列表只含 TXT；关闭后无 TXT 的行禁用导入。
3. 搜索书名 → 结果正确；过滤开关仍生效。
4. 导入一本有封面/简介的书 → 书名、作者、语言、简介、封面正确。
5. 切换编码后「重新解析」→ 上述元数据与关联不变。
6. 导出 EPUB 并勾选推送 → calibre-web 原书下出现 EPUB，TXT 仍在。
7. 再次导出同一本 → 推送默认关闭并显示覆盖警告；手动勾选 → 弹确认；确认后覆盖成功。
8. 重启 txt2book → 打开页面自动恢复连接，无需密码。
9. 点「断开连接」→ 推送入口消失；刷新页面后自动恢复。
10. 点「忘记凭据」→ 刷新后显示连接表单，需要重新输入密码。
11. 换一个浏览器登录 txt2book → 自动恢复同一连接。
12. 输入错误密码 → 提示账号或密码错误，不清空已保存的有效配置。

- [ ] **Step 5: 回归检查**

- 本地导入、封面 URL/上传、EPUB/HTML/TXT/PDF 导出各走一遍。
- 登出后当前书籍清空，重新登录不会看到上一会话的书。
- 401 只由 txt2book 会话触发；错误 calibre 密码不会把用户踢出登录。

- [ ] **Step 6: 记录结果**

在 `docs/superpowers/plans/2026-11-19-calibre-web-docs.ledger.md` 记录每一步的命令、结果与未验证项（例如本机无 Docker 时的 compose 检查）。
