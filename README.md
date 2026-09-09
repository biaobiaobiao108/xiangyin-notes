# Lumen Notes

Lumen Notes 是一款运行在 Cloudflare Workers 上的单所有者 Markdown 笔记软件。项目使用 Bun 管理依赖、执行脚本、构建前端和 Worker、运行类型检查与测试；生产环境由 Cloudflare 的 `workerd` 运行时执行。

项目刻意不把生产 D1 数据库 ID、KV namespace ID 或其他账号级资源标识写入 `wrangler.jsonc`。生产资源在 Cloudflare Dashboard 中创建和绑定，仓库只保留不含账号标识的部署配置。

## 功能概览

- 三栏式笔记工作区：导航、笔记列表、编辑器。
- Markdown 作为唯一持久化源，使用 Tiptap 提供所见即所得编辑体验。
- 支持段落、H1–H3、粗体、斜体、删除线、行内代码、列表、任务列表、引用、代码块、链接和分隔线。
- 编辑后自动保存，并使用版本号防止多标签页静默覆盖。
- 使用 `Ctrl + /` 或 `Command + /` 打开命令菜单。
- 编辑器右下角显示字数、字符数和可展开的大纲。
- 支持收件箱、全部笔记、收藏、已分享、回收站和自定义笔记本。
- 分享笔记时生成 7 天有效的只读快照；快照写入 KV 后不会随原笔记修改而改变。
- 分享链接读取时先检查 D1 中的撤销和过期状态，再读取 KV，因此撤销可以立即生效。
- 响应式布局支持桌面、平板和手机；界面不依赖浏览器原生菜单完成核心操作。
- 浏览器标签页使用 `app/favicon.svg` 作为图标。

## 技术架构

```text
浏览器
  │
  ├── /api/* ─────── Cloudflare Worker + Hono ─── D1
  │                                             └── KV（分享快照）
  │
  └── 其他请求 ──── Worker Assets（dist/client）
```

### 运行时边界

- Bun 是开发工具链：依赖管理、脚本执行、前端构建、Worker 构建、类型检查和测试。
- 前端入口是 `app/index.html`，由 Bun bundler 构建到 `dist/client`。
- Worker 入口是 `worker/index.ts`，由 Bun bundler 构建到 `dist/worker/index.js`。
- Cloudflare 生产环境不运行 Bun runtime。Worker 代码只能使用 Fetch、Web Crypto、D1、KV 和其他 Cloudflare Worker/Web API。
- `wrangler.jsonc` 只配置 Worker 名称、兼容日期、Worker 入口、静态资源，以及部署时继承 Dashboard 绑定的元数据；不要向其中添加生产 D1/KV ID。配置还声明了 `LUMEN_USERNAME` 和 `LUMEN_PASSWORD` 为必需 Secret，缺少时部署应直接失败。

### 数据存储

D1 使用 `migrations/0001_initial.sql` 创建以下表：

| 表 | 用途 |
| --- | --- |
| `users` | 由 Worker 环境变量映射的所有者身份和密码派生值 |
| `sessions` | 30 天会话的哈希值和过期时间 |
| `notebooks` | 系统收件箱和自定义笔记本 |
| `notes` | 笔记标题、Markdown 正文、收藏、回收站状态和版本号 |
| `shares` | 分享索引、撤销状态和过期时间 |
| `notes_fts` | SQLite FTS5 搜索索引 |

笔记更新会在同一个 D1 batch 中同时更新 `notes` 和 `notes_fts`。`PATCH /api/notes/:id` 必须携带当前 `version`，版本不一致时返回 `409 VERSION_CONFLICT`。

分享快照保存在 KV 的以下键中：

```text
share:{token}
```

快照结构为：

```ts
type ShareSnapshot = {
  schemaVersion: 1;
  title: string;
  contentMarkdown: string;
  createdAt: number;
  expiresAt: number;
};
```

KV 写入使用 `expirationTtl: 604800`，也就是 7 天。D1 中的 `shares.revoked_at` 是撤销的权威状态，KV 的最终一致性不会阻止撤销立即生效。

## 目录结构

```text
app/
  index.html          Bun HTML 入口和 favicon 引用
  entry.tsx           React 启动入口
  app.tsx             路由入口
  workspace.tsx       三栏工作区和分享弹窗
  editor.tsx          Tiptap 编辑器、统计和大纲
  editor-metrics.ts   编辑器统计和大纲纯函数
  auth.tsx            首次初始化和登录页面
  share.tsx           只读分享页面
  styles.css          全局视觉和响应式样式

worker/
  index.ts            Hono API、鉴权、D1/KV 读写和 Assets 分流
  env.ts              Worker 环境绑定类型

shared/
  types.ts            前后端共享类型

migrations/
  0001_initial.sql    D1 初始迁移

scripts/
  dev.ts              同时启动 Bun watch 和 Wrangler local
  preview.ts          启动本地预览
  migrate-local.ts    应用本地 D1 迁移
  migrate-remote.ts   使用临时配置应用远程 D1 迁移
  cloudflare-config.ts 生成被忽略的临时 Wrangler 配置

dist/
  client/             Bun 生成的前端静态资源，不提交
  worker/             Bun 生成的 Worker bundle，不提交
```

## 环境要求

- Bun 最新稳定版。
- Cloudflare 账号，并具有 Workers、D1 和 KV 的使用权限。
- 已安装 Git；提交代码时需要配置 Git 用户名和邮箱。
- 能够在浏览器中完成 `wrangler login`，或在本机提供 Cloudflare API 认证信息。

检查 Bun 和 Wrangler 版本：

```bash
bun --version
bunx wrangler --version
```

Windows、macOS 和 Linux 的 Bun 安装方式请以 [Bun 官方安装文档](https://bun.sh/docs/installation) 为准。项目统一使用 Bun，不要用 npm、yarn 或 pnpm 替代项目脚本。

## 安装依赖

在仓库根目录执行：

```bash
bun install
```

`bun.lock` 是依赖版本的唯一锁定来源。安装依赖后建议立即执行：

```bash
bun run typecheck
bun test
```

## 本地开发

### 初始化本地 D1

首次开发或新增本地迁移后执行：

```bash
bun run db:migrate:local
```

这个脚本会生成被 `.gitignore` 忽略的 `.wrangler.local.jsonc`，其中只包含本地模拟所需的虚拟 D1/KV 配置。它不会连接生产 D1，也不会修改生产数据。

本地 D1 的数据由 Wrangler 保存在 `.wrangler/` 下，同样不会提交到仓库。首次初始化账号和笔记的数据也只存在于本地数据库。

### 启动开发服务器

```bash
bun run dev
```

开发脚本会同时启动：

1. `bun build ./app/index.html ... --watch`：监听前端 TypeScript、TSX、CSS 和静态资源。
2. `bun build ./worker/index.ts ... --watch`：监听 Worker 源码。
3. `wrangler dev --local`：使用本地 `workerd`、本地 D1 和本地 KV 提供服务。

默认访问地址：

```text
http://127.0.0.1:8787/app
```

首次访问前，先在项目根目录创建本地配置文件 `.dev.vars`：

```dotenv
LUMEN_USERNAME=lumen
LUMEN_PASSWORD=请替换为至少12位的本地密码
```

然后运行 `bun run dev`。首次成功登录会自动在本地 D1 创建身份、收件箱和欢迎笔记；网页不再提供创建账号表单。用户名只能使用 3–32 位字母、数字、下划线和短横线；密码长度必须为 12–128 位。`.dev.vars` 已被 Git 忽略，不要把真实密码提交到仓库。

按 `Ctrl + C` 可以同时停止三个开发进程。

### 本地预览

如果只想运行已经构建好的产物，不需要 watch：

```bash
bun run build
bun run preview
```

`bun run preview` 仍然使用本地 D1/KV，不会连接生产绑定。

## 认证环境变量

Lumen Notes 使用 Cloudflare Worker 的运行时 Secrets 管理唯一所有者凭据。登录时，Worker 只信任下面两个变量；D1 中的 `users.password_hash` 和 `users.password_salt` 仅用于满足现有数据结构并保留派生身份数据，不再作为登录密码来源：

| Secret 名称 | 要求 |
| --- | --- |
| `LUMEN_USERNAME` | 3–32 位，只能包含字母、数字、下划线和短横线 |
| `LUMEN_PASSWORD` | 12–128 位，建议使用密码管理器生成的长密码 |

生产环境必须在 Cloudflare Dashboard 的目标 Worker 中添加这两个 **Secret**，不要添加为会暴露在构建日志或配置文件中的普通公开变量，也不要写入 `wrangler.jsonc`：

1. 打开 **Workers & Pages**，进入目标 Worker。
2. 打开 **Settings → Variables & Secrets**。
3. 在生产环境添加 `LUMEN_USERNAME` 和 `LUMEN_PASSWORD`，类型选择 **Secret**。
4. 保存后重新部署 Worker，使新的运行时配置生效。

本地开发使用 `.dev.vars`，内容示例：

```dotenv
LUMEN_USERNAME=lumen
LUMEN_PASSWORD=请替换为至少12位的本地密码
```

首次用这两个值登录时，如果 D1 还是空的，Worker 会自动创建唯一用户、收件箱和欢迎笔记。修改 Secret 中的用户名或密码后，旧会话会失效；已有笔记不会被删除。

## Cloudflare 生产部署

下面的流程是本项目推荐的生产部署流程。最重要的约束是：生产 D1 和 KV 在 Cloudflare Dashboard 绑定，不把账号级 ID 写进仓库。

### 第一步：登录 Wrangler

推荐使用 Cloudflare OAuth 登录：

```bash
bunx wrangler login
bunx wrangler whoami
```

如果部署机器不能打开浏览器，也可以在当前终端临时设置 `CLOUDFLARE_API_TOKEN`，并按 Cloudflare 权限要求设置 `CLOUDFLARE_ACCOUNT_ID`。不要把 token 写入 README、`.env`、Wrangler 配置或 Git；完成后应清除环境变量。

PowerShell 示例：

```powershell
$env:CLOUDFLARE_API_TOKEN = "<只在当前终端有效的 token>"
$env:CLOUDFLARE_ACCOUNT_ID = "<你的 Cloudflare Account ID>"
bunx wrangler whoami
```

### 第二步：在 Dashboard 创建 D1

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com/)。
2. 进入 **Workers & Pages**，打开 **D1** 或 **D1 SQL databases**。
3. 创建数据库，建议名称使用 `lumen-notes-db`。
4. 打开数据库详情页，复制数据库 ID，暂时保存在本机密码管理器或当前终端变量中；不要提交到仓库。

D1 数据库名称可以不同，但执行远程迁移时必须通过 `LUMEN_D1_DATABASE_NAME` 告诉脚本实际名称。

### 第三步：在 Dashboard 创建 KV namespace

1. 在 Cloudflare Dashboard 进入 **Workers & Pages → KV**。
2. 创建一个 KV namespace，建议名称使用 `lumen-notes-shares`。
3. 记录它用于选择资源即可；本项目不会把 namespace ID 写入 `wrangler.jsonc`。

KV 只用于保存公开分享快照，不要把 D1 数据库或其他私密数据写入这个 namespace。

### 第四步：创建或准备 Worker

如果目标 Worker 尚不存在，可以在 **Workers & Pages** 中创建一个 Worker，名称建议使用：

```text
lumen-notes
```

如果 Worker 已经存在，直接使用现有 Worker。仓库中的 `wrangler.jsonc` 也使用这个名称：

```jsonc
{
  "name": "lumen-notes",
  "main": "./dist/worker/index.js",
  "assets": {
    "directory": "./dist/client",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]
  }
}
```

### 第五步：在 Dashboard 绑定 D1 和 KV

在目标 Worker 页面打开 **Settings → Bindings**，按下面的名称添加绑定：

| 绑定类型 | Variable name | 选择的资源 |
| --- | --- | --- |
| D1 database | `DB` | 第二步创建的 D1 |
| KV namespace | `SHARE_KV` | 第三步创建的 KV |

操作顺序：

1. 点击 **Add binding**。
2. 选择 **D1 database**，变量名填写 `DB`，选择目标数据库并保存。
3. 再次点击 **Add binding**。
4. 选择 **KV namespace**，变量名填写 `SHARE_KV`，选择目标 namespace 并保存。
5. 按 Dashboard 提示点击 **Deploy**。

`ASSETS` 由 `wrangler.jsonc` 的静态资源配置提供。配置中的 `keep_bindings` 要求 Wrangler 在新版本中继承 Dashboard 已有的 D1、KV、变量和 Secret；其中只包含绑定类型，不包含任何资源 ID或 Secret 值。不要把生产 D1/KV ID 补写回配置文件。Worker 源码中使用的绑定名必须保持为 `DB`、`SHARE_KV` 和 `ASSETS`，否则 API 或前端资源会无法工作。

Cloudflare 官方绑定说明：[D1 Dashboard 绑定](https://developers.cloudflare.com/d1/best-practices/remote-development/)、[KV Dashboard 绑定](https://developers.cloudflare.com/kv/concepts/kv-namespaces/)。

### 第六步：配置生产认证 Secrets

在目标 Worker 的 **Settings → Variables & Secrets** 中添加以下两个生产 Secret：

```text
LUMEN_USERNAME
LUMEN_PASSWORD
```

用户名必须符合 3–32 位字母、数字、下划线和短横线的规则；密码必须为 12–128 位。请直接在 Cloudflare Dashboard 的 Secret 输入框填写真实值，不要把值写入仓库、`wrangler.jsonc`、README 或公开的构建变量中。保存后继续下面的迁移和部署步骤。

### 第七步：应用远程 D1 迁移

`db:migrate:remote` 不读取生产 `wrangler.jsonc` 中的 D1 ID，而是根据本机环境变量生成一次性的 `.wrangler.remote.jsonc`。该文件已加入 `.gitignore`，只用于迁移命令。

PowerShell：

```powershell
$env:LUMEN_D1_DATABASE_ID = "<第二步复制的 D1 database ID>"
$env:LUMEN_D1_DATABASE_NAME = "lumen-notes-db"
bun run db:migrate:remote
Remove-Item Env:LUMEN_D1_DATABASE_ID
Remove-Item Env:LUMEN_D1_DATABASE_NAME
```

macOS/Linux：

```bash
export LUMEN_D1_DATABASE_ID="<第二步复制的 D1 database ID>"
export LUMEN_D1_DATABASE_NAME="lumen-notes-db"
bun run db:migrate:remote
unset LUMEN_D1_DATABASE_ID LUMEN_D1_DATABASE_NAME
```

如果数据库名称就是默认的 `lumen-notes-db`，可以省略 `LUMEN_D1_DATABASE_NAME`。迁移命令会显示待执行迁移并要求确认；确认前检查目标数据库确实是生产 D1。

迁移完成后，可在 D1 控制台检查：

```sql
SELECT name
FROM sqlite_master
WHERE type IN ('table', 'view')
ORDER BY name;
```

应该能看到 `users`、`sessions`、`notebooks`、`notes`、`shares`、`notes_fts` 等对象。

### 第八步：本地构建和 dry-run

提交或部署前执行完整检查：

```bash
bun run typecheck
bun test
bun run build
bunx wrangler deploy --dry-run
```

Bun 构建会生成：

- `dist/client/index.html`、哈希后的 JavaScript、CSS 和 favicon。
- `dist/worker/index.js` 以及外部 sourcemap。

`dist/` 已被忽略，不要提交构建产物。`wrangler deploy --dry-run` 只用于检查 Worker bundle 和 Assets，不会将版本发布到线上。

### 第九步：部署

通过项目脚本部署：

```bash
bun run deploy
```

它会依次执行：

1. `bun run build`，使用 Bun bundler 构建前端和 Worker。
2. `wrangler deploy`，上传 `dist/worker` 的 Worker 入口和 `dist/client` 的静态资源。

部署后，打开 Wrangler 输出的 `workers.dev` 地址，或打开绑定到 Worker 的自定义域名。

### 关于 Dashboard 绑定和 Wrangler 提示

本项目故意采用 Dashboard 管理 D1/KV，但当前 Wrangler 版本可能检测远程 Dashboard 设置和本地配置之间的差异。部署时请遵守以下规则：

- 不要把 `DB`、`SHARE_KV` 的 ID 回写到生产 `wrangler.jsonc`。
- `wrangler.jsonc` 已配置 `keep_vars` 和 `keep_bindings`，用于保留 Dashboard 中的变量、D1 和 KV 绑定；如果当前版本已经丢失绑定，先在 Dashboard 重新添加一次，后续 Git 部署会继承它们。
- 如果 Wrangler 提示要把远程绑定同步到本地配置，先停止并检查提示内容；不要提交包含账号级 ID 的配置文件。
- 如果提示可能删除或覆盖已有的 Dashboard 绑定，不要继续部署；回到 Worker 的 **Settings → Bindings** 检查 `DB` 和 `SHARE_KV` 是否存在。
- 部署完成后再次打开 Bindings 页面，确认两个绑定仍然存在，并使用实际页面做 API 验证。

Cloudflare 建议把 Wrangler 配置作为配置事实来源；本项目因为公开仓库的安全边界，明确选择把 D1/KV 资源绑定放在 Dashboard。升级 Wrangler 后应特别复核上述提示和绑定状态。

## 部署后的验收流程

建议按照下面顺序做一次完整验收：

1. 在 Worker Secrets 配置 `LUMEN_USERNAME` 和 `LUMEN_PASSWORD`。
2. 首次访问站点，确认进入登录页。
3. 使用这两个值登录；首次成功登录会自动创建 D1 身份、收件箱和欢迎笔记。
4. 新建笔记，输入 Markdown 内容并等待自动保存状态变为“已保存”。
5. 刷新页面，确认笔记正文和标题仍然存在。
6. 在搜索框输入标题或正文中的词，确认搜索结果正确。
7. 按 `Ctrl + /`，确认命令菜单打开；按 `Esc` 关闭。
8. 输入 `# 一级标题`、`## 二级标题` 和 `### 三级标题`，确认右下角大纲出现并可跳转。
9. 在中文输入法下输入标题，确认不会出现额外的首字母。
10. 点击分享，生成链接并在无登录状态下打开 `/share/:token`。
11. 修改原笔记，确认公开分享页仍显示创建快照时的旧内容。
12. 在笔记的分享记录中撤销链接，确认公开链接立即失效。
13. 在 Cloudflare Dashboard 查看 Worker 日志，确认没有绑定缺失或运行时异常。

## API 速查

所有私有 API 使用 HttpOnly、SameSite=Lax 的 `lumen_session` Cookie。分享读取接口是公开接口，但仍会先访问 D1 校验分享记录。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/bootstrap` | 检查 Worker Secrets 是否已配置 |
| `POST` | `/api/setup` | 已停用；认证由 Worker Secrets 管理 |
| `POST` | `/api/auth/login` | 用户名密码登录 |
| `POST` | `/api/auth/logout` | 注销当前会话 |
| `GET` | `/api/me` | 获取当前登录用户 |
| `GET` | `/api/notes` | 按视图、搜索词或笔记本查询笔记 |
| `POST` | `/api/notes` | 新建笔记 |
| `GET` | `/api/notes/:id` | 获取完整笔记 |
| `PATCH` | `/api/notes/:id` | 按版本更新笔记 |
| `DELETE` | `/api/notes/:id` | 永久删除已在回收站的笔记 |
| `GET` | `/api/notebooks` | 获取笔记本 |
| `POST` | `/api/notebooks` | 新建笔记本 |
| `PATCH` | `/api/notebooks/:id` | 修改笔记本 |
| `DELETE` | `/api/notebooks/:id` | 删除笔记本并将笔记移入收件箱 |
| `POST` | `/api/notes/:id/shares` | 创建 7 天只读快照 |
| `GET` | `/api/notes/:id/shares` | 获取当前笔记的分享记录 |
| `DELETE` | `/api/shares/:id` | 立即撤销分享 |
| `GET` | `/api/shares/:token` | 读取公开分享快照 |

### 常见错误状态

- `401 UNAUTHENTICATED`：缺少或失效的登录会话。
- `404 NOTE_NOT_FOUND`：笔记不属于当前用户或不存在。
- `409 VERSION_CONFLICT`：更新时携带的 `version` 不是最新版本。
- `410 SHARE_REVOKED`：分享已被撤销。
- `410 SHARE_EXPIRED`：分享已过期或 KV 中的快照已不可用。

## 可用脚本

| 命令 | 用途 |
| --- | --- |
| `bun install` | 按 `bun.lock` 安装依赖 |
| `bun run dev` | Bun watch + 本地 Wrangler + 本地 D1/KV |
| `bun run build:client` | 只构建前端 HTML、TSX、CSS 和静态资源 |
| `bun run build:worker` | 只构建 Worker bundle |
| `bun run build` | 完整 Bun 构建 |
| `bun run typecheck` | TypeScript `--noEmit` 类型检查 |
| `bun test` | 运行全部单元测试和 Worker 集成测试 |
| `bun run preview` | 预览已经构建的本地 Worker 和 Assets |
| `bun run db:migrate:local` | 应用本地 D1 迁移 |
| `bun run db:migrate:remote` | 使用本机临时配置应用远程 D1 迁移 |
| `bun run deploy` | 完整 Bun 构建后部署到 Cloudflare |

前端和 Worker 的固定构建命令分别是：

```bash
bun build ./app/index.html \
  --outdir ./dist/client \
  --target browser \
  --format esm \
  --splitting \
  --production \
  --sourcemap external

bun build ./worker/index.ts \
  --outdir ./dist/worker \
  --target browser \
  --format esm \
  --production \
  --sourcemap external
```

PowerShell 可以直接使用项目脚本；如果手动复制多行 Bun 命令，请将行尾 `\` 改为 PowerShell 的反引号，或写成一行。

## 安全与配置注意事项

- 不要提交 D1 database ID、KV namespace ID、Cloudflare API token、密码或真实分享 token。
- 不要提交 `.wrangler/`、`.wrangler.local.jsonc`、`.wrangler.remote.jsonc`、`.dev.vars*`、`dist/` 或 `node_modules/`。
- `wrangler.jsonc` 不保存生产 D1/KV 的资源 ID；它通过 `keep_bindings` 继承 Dashboard 中已经配置的绑定。
- 生产迁移前确认 `LUMEN_D1_DATABASE_ID` 指向正确数据库；迁移命令不可替代备份和变更评审。
- 不要在 Worker 中使用 Bun 专属 API；Cloudflare 生产运行时只提供 Web/Workers API。
- 分享链接是公开只读链接，拿到 token 的人可以在 7 天内读取快照；不要分享包含敏感信息的笔记。
- 修改数据库结构时先新增迁移文件，不要直接改写已经应用到生产的历史迁移。

## 相关文档

- [Bun Bundler](https://bun.sh/docs/bundler)
- [Cloudflare Workers 配置](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Cloudflare Workers 部署](https://developers.cloudflare.com/workers/wrangler/commands/workers/)
- [Cloudflare D1 迁移](https://developers.cloudflare.com/d1/wrangler-commands/)
- [Cloudflare D1 Dashboard 绑定](https://developers.cloudflare.com/d1/best-practices/remote-development/)
- [Cloudflare KV namespace 和绑定](https://developers.cloudflare.com/kv/concepts/kv-namespaces/)
