# 象映笔记

> 把零散的想法，安静地放在一个属于自己的地方。

象映笔记是一款面向个人使用的本地优先 Markdown 笔记应用。它有清晰的三栏界面、轻量的编辑体验和完整的笔记整理能力，适合记录灵感、工作资料、复盘、清单以及任何值得留下的内容。

你可以把它部署在自己的电脑或服务器上。笔记保存在自己的 SQLite 数据库中，不依赖第三方云笔记服务；即使暂时断网，也可以继续记录，网络恢复后自动同步。

## 适合怎样的你

- 想要一个简洁、专注、不被复杂功能打扰的笔记空间。
- 希望笔记数据掌握在自己手里，可以自己部署和备份。
- 习惯 Markdown，但又希望拥有所见即所得的编辑体验。
- 需要在电脑、平板和手机上都能顺手使用。
- 偶尔需要把一篇笔记分享给别人，但不想开放整个笔记库。

象映笔记目前是单用户应用，登录账号通过部署时的环境变量配置，不提供公开注册和多人协作账号体系。

## 核心功能

### 写下来：专注的 Markdown 编辑器

- 支持标题、粗体、斜体、删除线、行内代码、列表、任务列表、引用、代码块、链接和分隔线。
- 编辑内容会自动保存，不需要频繁寻找“保存”按钮。
- 中文输入法场景经过专门处理，减少输入法组合文字被误识别的问题。
- 编辑器底部提供字数和字符数统计，适合写作、复盘和整理长文。
- 可以切换沉浸模式，把注意力留给当前正在写的内容。

### 理清楚：让笔记有自己的位置

- 收件箱：先放进来，再慢慢整理。
- 全部笔记：查看完整笔记库。
- 收藏：把经常使用或需要重点关注的笔记放在一起。
- 自定义笔记本：按项目、主题、阶段或任何你喜欢的方式分类。
- 回收站：误删的笔记可以恢复，也可以确认后永久删除。
- 已分享：集中查看已经生成过分享链接的笔记。

### 找回来：搜索和命令菜单

- 全局搜索笔记标题和正文，支持中文搜索。
- 在当前笔记中查找并高亮匹配内容，可以用 `F3` / `Shift + F3` 在匹配项之间移动。
- 按 `Ctrl + /` 或 `Ctrl + K`（macOS 使用 `⌘`）打开命令菜单。
- 命令菜单可以完成新建、搜索、收藏、分享、回收站、侧栏和沉浸模式等操作。
- 支持使用 `新建 <笔记本名> <标题>` 快速创建指定笔记本中的笔记，例如：

  ```text
  新建 项目资料 周五复盘
  ```

### 看清结构：悬浮大纲

正文中包含 H1-H3 标题时，编辑器右下角会显示悬浮大纲。点击标题即可跳转，滚动正文时当前所在标题会自动高亮。

### 分享出去：只读快照

- 为笔记生成一个公开只读链接。
- 分享内容是创建时的固定快照，原笔记后续修改不会影响已经发出的内容。
- 每个分享链接固定有效 7 天。
- 可以随时撤销尚未过期的分享链接。

分享链接适合发送会议纪要、阶段总结、项目说明或临时资料。请注意：任何拿到链接的人都可以在有效期内阅读对应快照。

### 断网也能写：离线优先

在支持 PWA 的浏览器中，应用可以安装为独立应用窗口。断网时仍然可以查看、搜索、新建、编辑、收藏、移动和回收笔记；恢复联网后，修改会自动同步。

如果同一篇笔记在不同地方发生修改，应用会保留本地内容，并提供服务器版本、本地版本和合并入口，避免内容被静默覆盖。

## 快捷键

| 快捷键 | 用途 |
| --- | --- |
| `Ctrl + /` 或 `Ctrl + K` | 打开命令菜单 |
| `Ctrl + F` | 打开命令菜单，并尝试使用当前选中的文字作为搜索内容 |
| `Ctrl + S` | 立即保存当前笔记 |
| `Ctrl + \\` | 收起或展开侧栏 |
| `Ctrl + Shift + F` | 进入或退出沉浸模式 |
| `F3` | 查找下一处匹配 |
| `Shift + F3` | 查找上一处匹配 |
| `Esc` | 关闭当前弹窗、清除查找，或退出沉浸模式 |

macOS 用户将 `Ctrl` 替换为 `⌘` 即可。正在使用中文输入法组合文字时，命令菜单不会误触发确认操作。

## 开始使用

### 方式一：本机运行

环境要求：

- [Bun](https://bun.sh/) 最新稳定版
- Git（仅用于获取项目代码）

进入项目目录后安装依赖：

```bash
bun install
```

复制配置文件：

macOS / Linux：

```bash
cp .env.example .env
```

Windows PowerShell：

```powershell
Copy-Item .env.example .env
```

编辑 `.env`，至少设置登录用户名和密码：

```dotenv
XIANGYING_USERNAME=xiangying
XIANGYING_PASSWORD=请替换为至少12位的密码
DATABASE_PATH=./data/xiangying-notes.sqlite
HOST=0.0.0.0
PORT=3000
COOKIE_SECURE=false
```

构建并启动：

```bash
bun run build
bun run start
```

打开：

```text
http://127.0.0.1:3000/app
```

数据库为空时，第一次成功登录会自动创建收件箱和一篇欢迎笔记。

### 开发模式

如果你要修改代码并实时查看效果：

```bash
bun run dev
```

开发模式会启动前端监听构建和 Bun 热更新服务，访问地址仍然是：

```text
http://127.0.0.1:3000/app
```

开发脚本会使用本地开发账号自动登录；这是为了方便开发调试，生产环境请使用自己的 `.env` 配置并运行构建产物。

## 方式二：Docker 部署

Docker 部署适合长期运行在家用服务器、NAS 或云主机上。项目已经发布了支持 `linux/amd64` 和 `linux/arm64` 的镜像，直接拉取即可，不需要自己构建镜像，也不需要在主机上安装 Bun。

镜像地址：

```text
ghcr.io/biaobiaobiao108/xiangying-notes
```

先在项目根目录准备 `.env`：

```dotenv
XIANGYING_USERNAME=xiangying
XIANGYING_PASSWORD=请替换为至少12位的生产密码
PUBLIC_URL=https://notes.example.com
COOKIE_SECURE=true
```

拉取已发布镜像并创建数据卷：

```bash
docker pull ghcr.io/biaobiaobiao108/xiangying-notes:latest
docker volume create xiangying-notes-data
```

启动容器：

```bash
docker run -d \
  --name xiangying-notes \
  --restart unless-stopped \
  -p 3000:3000 \
  --env-file .env \
  -v xiangying-notes-data:/data \
  ghcr.io/biaobiaobiao108/xiangying-notes:latest
```

然后访问：

```text
http://127.0.0.1:3000/app
```

容器中的数据库位于 `/data/xiangying-notes.sqlite`，数据卷不会因为容器更新而消失。生产环境建议在反向代理后使用 HTTPS，并将 `COOKIE_SECURE` 设置为 `true`。

如果 GHCR 镜像是私有的，先登录 GitHub Container Registry：

```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
```

### 升级或回滚

升级时拉取新镜像，继续使用原来的数据卷即可：

```bash
docker pull ghcr.io/biaobiaobiao108/xiangying-notes:latest
docker stop xiangying-notes
docker rm xiangying-notes
docker run -d \
  --name xiangying-notes \
  --restart unless-stopped \
  -p 3000:3000 \
  --env-file .env \
  -v xiangying-notes-data:/data \
  ghcr.io/biaobiaobiao108/xiangying-notes:latest
```

如果新版本包含数据库迁移，先执行一次迁移，再启动新容器：

```bash
docker run --rm \
  --env-file .env \
  -v xiangying-notes-data:/data \
  ghcr.io/biaobiaobiao108/xiangying-notes:latest \
  bun dist/server/migrate.js
```

回滚时把 `latest` 替换为需要的版本 tag，并继续使用同一个 `xiangying-notes-data` 数据卷。

## 配置项

| 配置项 | 必需 | 说明 |
| --- | --- | --- |
| `XIANGYING_USERNAME` | 是 | 登录用户名，长度为 3–32 个字符 |
| `XIANGYING_PASSWORD` | 是 | 登录密码，长度为 12–128 个字符 |
| `DATABASE_PATH` | 否 | SQLite 数据库路径，默认 `./data/xiangying-notes.sqlite`；Docker 中默认 `/data/xiangying-notes.sqlite` |
| `HOST` | 否 | 服务监听地址，默认 `0.0.0.0` |
| `PORT` | 否 | 服务端口，默认 `3000` |
| `PUBLIC_URL` | 否 | 分享链接使用的公网根地址，例如 `https://notes.example.com` |
| `COOKIE_SECURE` | 否 | HTTPS 部署时设置为 `true`；本机 HTTP 使用 `false` |

`PUBLIC_URL` 只填写公网根地址，不要在末尾添加 `/app` 或其他路径。`.env`、SQLite 数据库和分享 token 都不应提交到 Git 仓库。

## 数据、隐私与安全

- 象映笔记是单用户应用，账号凭据只通过运行时环境变量注入。
- 服务端笔记保存在 SQLite 中，默认位置为 `data/xiangying-notes.sqlite`；Docker 部署时保存在 `/data` 数据卷。
- 离线副本和待同步操作保存在当前浏览器的 IndexedDB 中。
- 分享链接是公开链接，拿到链接的人可以阅读对应的只读快照，直到链接过期或被撤销。
- 生产部署建议使用 HTTPS，并设置 `COOKIE_SECURE=true`。
- 备份时请同时考虑 SQLite 的 `-wal` 和 `-shm` 文件；应用运行期间不要直接复制正在使用的数据库文件。
- 当前版本不提供多人实时协作、公开注册或多租户隔离能力。

## 数据库迁移

空数据库首次启动时，会自动按顺序执行已有迁移完成初始化。

已经存在的数据库不会在服务启动时自动应用后续新增迁移。升级版本如果包含新的 `migrations/*.sql` 文件，请显式执行：

本机：

```bash
bun run db:migrate
```

Docker：

```bash
docker run --rm \
  --env-file .env \
  -v xiangying-notes-data:/data \
  ghcr.io/biaobiaobiao108/xiangying-notes:latest \
  bun dist/server/migrate.js
```

迁移完成后再启动新版本服务。不要修改已经应用过的历史迁移文件。

## 常见问题

### 我在哪里能找到笔记数据？

本机默认在 `data/xiangying-notes.sqlite`。可以通过 `DATABASE_PATH` 修改。Docker 部署时数据在 `xiangying-notes-data` 卷中。

### 断网后写的内容会丢吗？

正常情况下不会。浏览器会保存本地副本和待同步操作，恢复联网后自动同步。如果出现版本冲突，本地内容会被保留，并在应用中提示处理。

### 分享链接为什么打不开？

请检查链接是否已经超过 7 天、是否被撤销，以及 `PUBLIC_URL` 是否配置成了用户实际访问的公网地址。分享读取本身不要求登录，但创建和管理分享需要登录。

### 如何彻底删除笔记？

先将笔记移入回收站，再在回收站中选择永久删除。清空回收站和永久删除都不可恢复。

### 如何确认服务正常？

访问健康检查地址：

```text
http://127.0.0.1:3000/api/health
```

正常时会返回：

```json
{"status":"ok","database":"ok"}
```

## 开发者信息

项目使用 Bun + TypeScript + React 构建：

- 前端：React、React Router、Tiptap、Lucide
- 服务端：原生 `Bun.serve`、Fetch API、Web Crypto
- 数据库：Bun `bun:sqlite`、SQLite WAL、FTS5
- 构建：Bun bundler，生产环境使用代码分割和压缩

常用命令：

| 命令 | 用途 |
| --- | --- |
| `bun install` | 安装依赖 |
| `bun run dev` | 启动开发服务 |
| `bun run build` | 构建前端和服务端 |
| `bun run start` | 启动构建后的服务 |
| `bun run preview` | 启动构建后的服务 |
| `bun run db:migrate` | 显式执行数据库迁移 |
| `bun run typecheck` | TypeScript 类型检查 |
| `bun test` | 运行测试 |

主要目录：

```text
app/                 React 前端、编辑器和样式
server/              Bun Server、API 和数据库访问
shared/              前后端共享类型
migrations/          SQLite 数据库迁移
tests/               单元测试和 API 集成测试
scripts/              开发、构建和迁移脚本
Dockerfile           多阶段生产镜像
```

## 许可证

当前仓库未声明独立开源许可证。若要公开分发或二次开发，请先根据项目实际发布方式补充许可证说明。
