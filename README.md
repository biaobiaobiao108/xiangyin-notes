# 象映笔记

> 把零散的想法，安静地放在一个属于自己的地方。

象映笔记是一款面向个人使用的本地优先 Markdown 笔记应用。它有清晰的三栏界面、轻量的编辑体验和完整的笔记整理能力，适合记录灵感、工作资料、复盘、清单以及任何值得留下的内容。

你可以把它部署在自己的电脑或服务器上。笔记保存在自己的 SQLite 数据库中，不依赖第三方云笔记服务。

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
- 支持通过按钮、剪贴板粘贴或拖拽上传 JPEG、PNG、WebP、GIF 图片；点击图片后可拖拽右下角按比例调整大小。

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

### 织网络：双向链接与反向链接

- 在正文中输入 `[[` 或全角 `【【` 唤起自动联想，快速链接到已有笔记或直接新建关联笔记。
- 支持别名语法，例如 `[[2026年度计划|年度计划]]`，在保持目标准确的同时让文句通顺自然。
- 编辑器底部提供反向链接面板，清晰呈现哪些笔记引用了当前内容；同时自动检测“未链接提及”（Unlinked Mentions），可一键转化为正式双向链接。
- 重命名笔记标题时，系统会自动级联更新所有引用该笔记的双向链接，避免产生失效死链。

### 建索引：标签与灵活筛选

- 在正文中任意位置输入 `#标签名`（如 `#工作`、`#项目复盘`），系统自动提取并建立标签索引。
- 侧栏提供直观的标签分类视图，支持点击快速筛选，命令菜单与搜索栏也支持通过 `#标签` 精准定位内容。

### 随身行：实时多端同步

- 电脑端、平板和手机端同时登录时，后端通过轻量高效的 WebSocket 实时推送变更事件。
- 在任一设备新建、重命名或归档笔记，其他已打开的客户端均会静默平滑刷新，保持视图始终同步。

### 留底稿：标准 ZIP 归档导出

- 支持一键将整个笔记库导出为标准 ZIP 压缩包。
- 压缩包内完整包含所有纯净的 Markdown 笔记文件及原始图片附件，方便脱机备份、离线归档或自由迁移。

### 分享出去：只读快照

- 为笔记生成一个公开只读链接。
- 分享内容是创建时的固定快照，原笔记后续修改不会影响已经发出的内容。
- 每个分享链接固定有效 7 天。
- 可以随时撤销尚未过期的分享链接。

分享链接适合发送会议纪要、阶段总结、项目说明或临时资料。请注意：任何拿到链接的人都可以在有效期内阅读对应快照。

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
# 如果要使用快捷指令导入，再设置一个随机 Token
XIANGYING_API_TOKEN=请替换为随机的API Token
DATABASE_PATH=./data/xiangying-notes.sqlite
ASSETS_PATH=./data/attachments
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
XIANGYING_API_TOKEN=请替换为随机的API Token
PUBLIC_URL=https://notes.example.com
TRUST_PROXY=true
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

容器中的数据库位于 `/data/xiangying-notes.sqlite`，图片附件位于 `/data/attachments`，数据卷不会因为容器更新而消失。生产环境建议在反向代理后使用 HTTPS，并将 `COOKIE_SECURE` 设置为 `true`。

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

## 快捷指令 API 导入

配置 `XIANGYING_API_TOKEN` 后，可以通过公网反向代理后的域名调用：

```text
POST https://notes.example.com/api/import
Authorization: Bearer <XIANGYING_API_TOKEN>
Content-Type: text/markdown
```

请求正文可以直接是 Markdown：

```markdown
# 今日记录

这是从 iPhone 或 Mac 快捷指令导入的内容。
```

也可以发送 JSON：

```json
{"contentMarkdown":"# 今日记录\n\n这是导入的内容。"}
```

快捷指令中的“获取 URL 内容”建议设置为：方法 `POST`，请求头包含 `Authorization` 和 `Content-Type: text/markdown`，请求体选择快捷指令输入。`text/plain` 也会按 Markdown 正文处理。

每次导入都会在“收件箱”中新建一篇笔记，标题由服务端生成，格式为 `快捷导入 YYYY-MM-DD HH:mm:ss`（上海时间）。接口返回 `201` 和新笔记摘要。建议同时发送唯一的 `Idempotency-Key`；相同 Key 的网络重试会复用第一次创建的笔记，若正文不同则返回 `409`。导入接口按客户端地址限制为每分钟 30 次请求，超过后返回 `429`。

反向代理需要保留 `Authorization`、可选的 `Idempotency-Key` 请求头和请求体，并将请求体大小限制设置为至少 5 MB。应直接使用 HTTPS 公网地址调用，不要把 Token 放到 URL 查询参数中；服务部署在域名根路径，接口路径固定为 `/api/import`。

网页端登录后会通过同源 WebSocket `/api/realtime` 接收当前用户的笔记变更通知。通知只用于触发列表重新校准，笔记正文仍通过普通 API 获取。使用反向代理时，除了 HTTP 请求头，还必须转发 WebSocket 的 `Upgrade` 和 `Connection` 请求头，并将 WebSocket 空闲超时设置得高于服务端 25 秒的心跳周期；如果 WebSocket 暂时不可用，页面重新获得焦点、恢复联网或回到前台时会自动重新连接并校准数据。

Markdown 中允许使用 `https://` 外部图片地址和应用内部附件地址。服务端不会下载或代理外部图片，图片由打开笔记的浏览器直接请求；外部图片可能失效，也可能向第三方泄露访问者的网络信息。

## 配置项

| 配置项 | 必需 | 说明 |
| --- | --- | --- |
| `XIANGYING_USERNAME` | 是 | 登录用户名，长度为 3–32 个字符 |
| `XIANGYING_PASSWORD` | 是 | 登录密码，非空字符串；建议至少使用 12 个字符 |
| `XIANGYING_API_TOKEN` | 否 | 快捷指令导入 API 的 Bearer Token；建议使用 `openssl rand -hex 32` 生成 |
| `DATABASE_PATH` | 否 | SQLite 数据库路径，默认 `./data/xiangying-notes.sqlite`；Docker 中默认 `/data/xiangying-notes.sqlite` |
| `ASSETS_PATH` | 否 | 图片附件目录，未设置时使用数据库所在目录旁的 `attachments`；Docker 中默认 `/data/attachments` |
| `HOST` | 否 | 服务监听地址，默认 `0.0.0.0` |
| `PORT` | 否 | 服务端口，默认 `3000` |
| `PUBLIC_URL` | 否 | 分享链接使用的公网根地址，例如 `https://notes.example.com` |
| `TRUST_PROXY` | 否 | 仅在服务位于可信反向代理后时设为 `true`，用于读取代理写入的客户端 IP 转发头 |
| `COOKIE_SECURE` | 否 | HTTPS 部署时设置为 `true`；本机 HTTP 使用 `false` |

`PUBLIC_URL` 只填写公网根地址，不要在末尾添加 `/app` 或其他路径。不要在服务直接暴露公网时启用 `TRUST_PROXY`；启用后应由可信代理覆盖 `X-Forwarded-For` 或 `X-Real-IP`。`.env`、SQLite 数据库、API Token 和分享 token 都不应提交到 Git 仓库。修改 API Token 后需要重启或重新创建容器。

## 数据、隐私与安全

- 象映笔记是单用户应用，账号凭据只通过运行时环境变量注入。
- 服务端笔记正文和图片元数据保存在 SQLite 中，图片二进制保存在附件目录；默认分别为 `data/xiangying-notes.sqlite` 和 `data/attachments`，Docker 部署时都保存在 `/data` 数据卷。
- 分享链接是公开链接，拿到链接的人可以阅读对应的只读快照，直到链接过期或被撤销。
- 快捷指令 API 只接受 `Authorization: Bearer ...`，不会使用网页 Cookie 认证；API Token 缺失时导入接口处于未配置状态。
- 外部图片仅允许 HTTPS，图片请求由访问者浏览器直接发出，分享页面也会遵循这一规则。
- 生产部署建议使用 HTTPS，并设置 `COOKIE_SECURE=true`。
- 备份时请同时考虑 SQLite 的 `-wal` 和 `-shm` 文件以及整个附件目录；应用运行期间不要直接复制正在使用的数据库文件，建议先停服或使用 SQLite 在线备份方式。
- 当前版本不提供多人实时协作、公开注册或多租户隔离能力；实时同步仅用于同一账号在不同设备之间刷新数据，不会自动合并同时编辑的正文。

## 存储与空间管理

象映笔记在底层针对 SQLite 数据库与磁盘占用做了针对性优化，保证在长期、高频使用下的轻量与稳定：

- **FTS5 外部内容表（External Content Table）**：全文检索直接映射 `notes` 主表（`content='notes'`），不在索引表中重复存储 Markdown 正文，消除了正文双重冗余；笔记属性（如收藏、笔记本归属等）修改时完全跳过 FTS 索引，大幅降低写 I/O。
- **空闲页自然复用机制（Freelist Page Reuse）**：笔记删除与清空回收站遵循数据库标准的空闲页复用设计。删除记录释放的数据页保存在 SQLite 空闲列表中，供后续新建笔记或修改内容时直接复用，避免频繁向操作系统申请扩容与物理截断所导致的 I/O 抖动和磁盘磨损，兼顾运行性能与磁盘寿命。
- **短词检索防膨胀控制**：单篇笔记最多提取 500 个短词索引（`note_short_terms`），并限制正文前 4,000 字符扫描范围，结合批量参数化插入，防止超长文导致索引行数爆炸。
- **分享快照生命周期管理**：撤销分享时立即将正文快照置空，超过 30 天的失效记录自动从数据库中彻底抹除，避免废弃快照长期占用存储。

## 数据库迁移

空数据库首次启动时，会自动执行 `migrations/0001_baseline.sql` 完成初始化。

当前项目处于正式上线前阶段，数据库结构维护在单个基线文件中。基线变更前创建的本地开发数据库不再兼容这套迁移历史；如需保留其中内容，请先备份，再导出需要的笔记后重建数据库。正式环境投入使用后，新增结构应继续使用新的增量迁移文件，不能再删除已应用的迁移。

已经存在的数据库不会在服务启动时自动应用后续新增迁移。升级版本如果包含新的 `migrations/*.sql` 文件，请显式执行：

本机：

```bash
bun run db:migrate
```

如果使用 `bun run dev` 的默认开发数据库，请在 PowerShell 中指定开发库路径后再执行：

```powershell
$env:DATABASE_PATH = "./data/xiangying-notes-dev.sqlite"
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

本机默认在 `data/xiangying-notes.sqlite`，图片在 `data/attachments`。可以分别通过 `DATABASE_PATH` 和 `ASSETS_PATH` 修改。Docker 部署时两者都在 `xiangying-notes-data` 卷中。

### 断网时可以继续编辑吗？

不可以。应用不提供离线编辑或同步队列；恢复联网后重新打开应用即可继续操作。已保存的笔记正文和附件保存在服务端 SQLite 数据库与附件目录中。

### 分享链接为什么打不开？

请检查链接是否已经超过 7 天、是否被撤销，以及 `PUBLIC_URL` 是否配置成了用户实际访问的公网地址。分享读取本身不要求登录，但创建和管理分享需要登录。

### 为什么删除笔记后，SQLite 文件没有变小？

1. **移入回收站是软删除**：在笔记列表中点击“删除”，只是将笔记移入“回收站”（标记 `deleted_at`），数据仍完整保留在数据库中以便随时恢复。
2. **物理删除采用空闲页复用**：在回收站中选择“彻底删除”或“清空回收站”后，记录已从底层物理删除，释放的数据页进入 SQLite 的空闲列表（Freelist）。当你后续新建或编辑笔记时，SQLite 会优先复用这部分空闲页，而不需要向操作系统扩容文件。这种机制能避免频繁物理截断带来的 I/O 压力与 SSD 写入放大。

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
