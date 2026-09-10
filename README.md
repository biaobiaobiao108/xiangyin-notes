# Lumen Notes

Lumen Notes 是一款运行在本地 Bun 服务上的单用户 Markdown 笔记软件。前端使用 React、TypeScript 和 Tiptap，使用 Bun bundler 构建；后端使用原生 `Bun.serve`，数据保存到 Bun 原生 `bun:sqlite` 数据库。

它保留了原有的三栏笔记界面、沉浸式 Markdown 编辑器、命令菜单、字数统计、悬浮大纲、笔记本、搜索、回收站和只读分享功能。分享快照保存于 SQLite，固定 7 天后失效。

## 技术栈

- 运行时：最新版 Bun
- 前端：React、React Router、TypeScript、Tiptap、Lucide
- 构建：Bun bundler，HTML 入口，ESM，代码分割，生产压缩
- 后端：原生 `Bun.serve`、Fetch API、Web Crypto
- 数据库：Bun `bun:sqlite`、SQLite WAL、FTS5
- 容器：多阶段 `oven/bun:alpine` 镜像
- 镜像仓库：GitHub Container Registry（GHCR）
- CI：GitHub Actions

Bun 官方文档：[HTTP Server](https://bun.sh/docs/runtime/http/server)、[SQLite](https://bun.sh/docs/runtime/sqlite)、[Docker](https://bun.sh/guides/ecosystem/docker)。

## 功能

- 单用户环境变量登录
- 首次成功登录时自动创建用户、收件箱和欢迎笔记
- Markdown 所见即所得编辑
- 段落、H1-H3、粗体、斜体、删除线、行内代码、列表、任务列表、引用、代码块、链接和分隔线
- 编辑后自动保存，并使用版本号防止多标签页覆盖
- Inbox、All Notes、Favorites、Shared、Trash 和自定义笔记本
- SQLite FTS5 搜索
- `Ctrl + /` 打开命令菜单
- 命令菜单支持 `新建 <笔记本名> <标题>`
- 右下角字数/字符数统计胶囊
- 右下角悬浮大纲，支持 H1-H3 跳转和当前标题高亮
- 生成 7 天有效的只读分享快照
- 分享快照不受原笔记后续修改影响
- 撤销分享后立即失效
- 响应式三栏界面，支持平板和手机抽屉布局
- 浏览器标签页 favicon

## 目录结构

```text
app/                       React 前端源码和样式
server/index.ts            Bun HTTP Server、API 和静态资源服务
server/db.ts               SQLite 打开、迁移和数据库初始化
shared/types.ts            前后端共享类型
migrations/                SQLite 迁移文件
scripts/dev.ts             前端 watch + Bun 热更新服务器
scripts/migrate.ts         手动执行 SQLite 迁移
tests/                     Bun 单元测试和 API 集成测试
Dockerfile                 多阶段 Bun Alpine 镜像
.dockerignore              Docker 构建上下文排除规则
.github/workflows/ci.yml   每次 push 的 CI
.github/workflows/docker.yml  Git tag 镜像发布
```

## 环境要求

- Bun 最新稳定版
- Git
- Docker 20.10+（仅 Docker 部署需要）
- GitHub Actions 使用的 Ubuntu runner 自带 Docker

检查 Bun：

```bash
bun --version
bun --revision
```

Windows PowerShell、macOS 和 Linux 都使用同一套 Bun 命令，不需要 npm、yarn 或 pnpm。

## 配置环境变量

复制示例配置：

```bash
cp .env.example .env
```

PowerShell：

```powershell
Copy-Item .env.example .env
```

编辑 `.env`：

```dotenv
LUMEN_USERNAME=lumen
LUMEN_PASSWORD=请替换为至少12位的本地密码
DATABASE_PATH=./data/lumen-notes.sqlite
HOST=0.0.0.0
PORT=3000
COOKIE_SECURE=false
```

变量说明：

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `LUMEN_USERNAME` | 是 | 3–32 位字母、数字、下划线或短横线 |
| `LUMEN_PASSWORD` | 是 | 12–128 个字符 |
| `DATABASE_PATH` | 否 | SQLite 文件路径，默认 `./data/lumen-notes.sqlite` |
| `HOST` | 否 | 服务监听地址，默认 `0.0.0.0` |
| `PORT` | 否 | 服务端口，默认 `3000` |
| `COOKIE_SECURE` | 否 | HTTPS 反向代理部署时设为 `true` |

`.env` 只用于本机或容器启动，已经被 Git 忽略。不要把真实用户名、密码或 SQLite 文件提交到仓库。

## 本地开发

安装依赖：

```bash
bun install
```

执行数据库迁移。服务器启动时不会自动修改数据库，首次启动前必须显式执行：

```bash
bun run db:migrate
```

启动开发服务器：

```bash
bun run dev
```

开发模式会同时运行：

1. `bun build ./app/index.html ... --watch`，监听前端 TSX、CSS 和资源。
2. `bun --hot server/index.ts`，监听 Bun Server 和 SQLite API 代码。

访问：

```text
http://127.0.0.1:3000/app
```

首次使用 `.env` 中的用户名和密码登录。若数据库为空，成功登录会自动初始化唯一用户、收件箱和欢迎笔记。

按 `Ctrl + C` 可以停止开发服务器。

## 生产构建和启动

完整构建：

```bash
bun run build
```

前端构建命令：

```bash
bun build ./app/index.html \
  --outdir ./dist/client \
  --target browser \
  --format esm \
  --splitting \
  --production \
  --minify
```

后端构建命令：

```bash
bun build ./server/index.ts \
  ./server/migrate.ts \
  --outdir ./dist/server \
  --target bun \
  --format esm \
  --production \
  --minify
```

启动已构建产物：

```bash
bun run start
```

等价于：

```bash
bun dist/server/index.js
```

生产服务默认监听 `0.0.0.0:3000`，直接打开：

```text
http://127.0.0.1:3000/app
```

健康检查：

```bash
curl http://127.0.0.1:3000/api/health
```

预期返回：

```json
{"status":"ok","database":"ok"}
```

## SQLite 迁移

迁移器会在数据库中创建 `schema_migrations` 表，然后按文件名顺序执行尚未应用的 SQL 文件。每个迁移只会成功执行一次。迁移只通过 `bun run db:migrate` 或容器中的迁移命令显式执行，服务器启动不会自动迁移。

当前迁移：

- `0001_initial.sql`：用户、会话、笔记本、笔记、分享和 FTS5 表。
- `0002_sqlite_share_snapshots.sql`：分享快照标题和 Markdown 字段。

手动执行：

```bash
bun run db:migrate
```

如果数据库尚未迁移，服务仍可以启动，但依赖数据表的 API 不可用；请先执行迁移，再启动或重启服务。迁移失败时命令会返回错误，不会继续运行。

数据库文件默认位于：

```text
data/lumen-notes.sqlite
```

SQLite WAL 可能同时产生 `-wal` 和 `-shm` 文件，它们也已被 Git 忽略。不要在服务器运行时直接复制主数据库文件作为备份；备份前先停止容器或使用 SQLite 支持的备份方式。

## Docker 部署

### 1. 准备配置

在仓库根目录创建 `.env`：

```dotenv
LUMEN_USERNAME=lumen
LUMEN_PASSWORD=请替换为至少12位的生产密码
COOKIE_SECURE=false
```

Docker 会覆盖以下默认值，不需要写入 `.env`：

```text
HOST=0.0.0.0
PORT=3000
DATABASE_PATH=/data/lumen-notes.sqlite
```

如果前面有 HTTPS 反向代理并且浏览器通过 HTTPS 访问，将 `COOKIE_SECURE` 改为 `true`。

### 2. 构建镜像

```bash
docker build --pull -t lumen-notes:local .
```

`--pull` 会检查最新的 `oven/bun:alpine` 基础镜像。Dockerfile 使用多阶段构建，最终镜像只包含 Bun Alpine、前端产物、服务端产物和迁移文件，不包含源代码、开发依赖、测试和密钥。

### 3. 启动容器

```bash
docker volume create lumen-notes-data

# 首次部署或新增数据库迁移时，显式初始化/升级 SQLite 结构
docker run --rm \
  --env-file .env \
  -v lumen-notes-data:/data \
  lumen-notes:local \
  bun dist/server/migrate.js

docker run -d \
  --name lumen-notes \
  --restart unless-stopped \
  -p 3000:3000 \
  --env-file .env \
  -v lumen-notes-data:/data \
  lumen-notes:local
```

打开：

```text
http://127.0.0.1:3000/app
```

检查容器和服务：

```bash
docker ps
docker logs --tail=100 lumen-notes
curl http://127.0.0.1:3000/api/health
```

### 4. 升级镜像

先构建新镜像，停止旧容器，在同一个 volume 上显式执行迁移，再启动新容器：

```bash
docker build --pull -t lumen-notes:local .
docker stop lumen-notes
docker rm lumen-notes
docker run --rm \
  --env-file .env \
  -v lumen-notes-data:/data \
  lumen-notes:local \
  bun dist/server/migrate.js
docker run -d \
  --name lumen-notes \
  --restart unless-stopped \
  -p 3000:3000 \
  --env-file .env \
  -v lumen-notes-data:/data \
  lumen-notes:local
```

SQLite 文件在 volume 中，容器替换不会删除笔记。

### 5. 备份和回滚

停止容器后备份 SQLite 文件：

```bash
docker stop lumen-notes
docker cp lumen-notes:/data/lumen-notes.sqlite ./lumen-notes-backup.sqlite
docker start lumen-notes
```

回滚时使用之前的固定镜像 tag，并保持同一个 `lumen-notes-data` volume：

```bash
docker stop lumen-notes
docker rm lumen-notes
docker run -d \
  --name lumen-notes \
  --restart unless-stopped \
  -p 3000:3000 \
  --env-file .env \
  -v lumen-notes-data:/data \
  ghcr.io/biaobiaobiao108/lumen-notes:1.0.0
```

不要把数据库文件复制回 Git，也不要把生产 `.env` 放进镜像构建上下文。

## GHCR 镜像发布

Docker workflow 位于 `.github/workflows/docker.yml`，只在 push Git tag 时触发。

仓库需要允许 Actions 使用 `GITHUB_TOKEN` 写入 Packages。workflow 使用：

```text
ghcr.io/${{ github.repository }}
```

创建并推送正式版本：

```bash
git tag v1.0.0
git push origin v1.0.0
```

正式 SemVer tag 会生成：

```text
v1.0.0
1.0.0
1.0
1
latest
```

非正式 tag，例如 `beta` 或 `nightly`，只生成对应 tag，不覆盖 `latest`。

拉取并运行 GHCR 镜像：

```bash
docker pull ghcr.io/biaobiaobiao108/lumen-notes:latest
docker volume create lumen-notes-data
docker run -d \
  --name lumen-notes \
  --restart unless-stopped \
  -p 3000:3000 \
  --env-file .env \
  -v lumen-notes-data:/data \
  ghcr.io/biaobiaobiao108/lumen-notes:latest
```

如果 GHCR package 是私有的，先登录：

```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
```

## GitHub Actions

### CI

`.github/workflows/ci.yml` 在每次 push 和 Pull Request 触发，执行：

```text
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
Docker build（不推送）
```

CI 会从干净仓库检查前端、Bun Server、SQLite 测试和 Dockerfile。

### Docker 发布

`.github/workflows/docker.yml` 在任意 Git tag push 时触发，登录 GHCR，生成版本标签，并推送精简镜像。镜像构建使用 Buildx GitHub Actions cache，不需要配置 Docker Hub 账号或额外密码。

## API 速查

所有私有 API 使用 HttpOnly、SameSite=Lax 的 `lumen_session` Cookie。分享读取接口不需要登录。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | 健康检查 |
| `GET` | `/api/bootstrap` | 检查环境变量认证是否已配置 |
| `POST` | `/api/setup` | 已停用，认证由环境变量管理 |
| `POST` | `/api/auth/login` | 用户名密码登录 |
| `POST` | `/api/auth/logout` | 注销会话 |
| `GET` | `/api/me` | 当前用户 |
| `GET` | `/api/notes` | 查询笔记、搜索和筛选 |
| `POST` | `/api/notes` | 新建笔记 |
| `GET` | `/api/notes/:id` | 获取完整笔记 |
| `PATCH` | `/api/notes/:id` | 携带 `version` 更新笔记 |
| `DELETE` | `/api/notes/:id` | 永久删除回收站笔记 |
| `GET` | `/api/notebooks` | 获取笔记本 |
| `POST` | `/api/notebooks` | 新建笔记本 |
| `PATCH` | `/api/notebooks/:id` | 更新笔记本 |
| `DELETE` | `/api/notebooks/:id` | 删除笔记本并移动笔记到收件箱 |
| `POST` | `/api/notes/:id/shares` | 创建 7 天快照 |
| `GET` | `/api/notes/:id/shares` | 获取分享记录 |
| `DELETE` | `/api/shares/:id` | 撤销分享 |
| `GET` | `/api/shares/:token` | 读取公开快照 |

常见状态：

- `401 UNAUTHENTICATED`：缺少或失效的会话。
- `409 VERSION_CONFLICT`：笔记版本不是最新版本。
- `410 SHARE_REVOKED`：分享已撤销。
- `410 SHARE_EXPIRED`：分享已过期。
- `503 AUTH_NOT_CONFIGURED`：缺少有效的登录环境变量。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `bun install` | 按 `bun.lock` 安装依赖 |
| `bun run dev` | 前端 watch + Bun 热更新服务 |
| `bun run build:client` | 构建浏览器前端 |
| `bun run build:server` | 构建 Bun Server |
| `bun run build` | 完整构建 |
| `bun run start` | 启动构建后的服务 |
| `bun run preview` | 启动构建后的服务 |
| `bun run db:migrate` | 显式执行 SQLite 迁移；服务器不会自动执行 |
| `bun run typecheck` | TypeScript 类型检查 |
| `bun test` | 运行测试 |

## 安全注意事项

- 不要提交 `.env`、密码、SQLite 文件、会话 Cookie 或分享 token。
- 不要把登录凭据写入 Dockerfile、镜像层、GitHub workflow 或构建参数。
- Docker volume 是应用数据的实际存储位置，部署前要规划备份。
- 分享链接是公开只读链接，拿到 token 的人可以在 7 天内读取快照。
- 生产环境建议在反向代理层启用 HTTPS，并设置 `COOKIE_SECURE=true`。
- 不要在服务端日志记录请求正文、密码或 Cookie。
- 修改数据库结构时新增迁移文件，不要删除已经应用的迁移。

## 完整验收

提交前执行：

```bash
bun run typecheck
bun test
bun run build
docker build --pull -t lumen-notes:check .
```

运行后检查：

1. `/api/health` 返回正常。
2. 使用环境变量登录，首次登录自动初始化数据。
3. 新建、编辑、搜索和删除笔记。
4. 创建笔记本并在指定笔记本中新建命名笔记。
5. 使用 `Ctrl + /` 打开命令菜单。
6. 编辑器右下角统计和大纲功能正常。
7. 创建分享并在未登录状态打开分享页。
8. 修改原笔记后，分享快照保持不变。
9. 撤销分享后链接立即失效。
10. 重启容器后笔记仍然存在。
11. 浏览器刷新 `/app`、`/login` 和 `/share/:token` 不返回 404。
