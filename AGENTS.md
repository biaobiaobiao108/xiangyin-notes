# AGENTS.md

## 项目定位

象映笔记是一个使用 Bun + TypeScript + React 构建的本地全栈 Markdown 笔记软件。前端由 Bun bundler 打包，后端使用原生 `Bun.serve`，数据使用 `bun:sqlite` 保存，分享快照也保存在 SQLite 中。

## 基本原则

- 信息足够后立即行动，不做无意义调查。
- 不确定时明确说明，不编造运行结果、部署状态或测试结果。
- 优先复用现有代码和实现模式，不增加没有必要的依赖、配置或新文件。
- JavaScript / TypeScript 项目统一使用 Bun；不要用 npm、yarn 或 pnpm 替代项目脚本。
- 修改前先检查工作区状态，保留用户已有的未提交修改，不覆盖无关工作。
- 不要把密码、真实分享 token、`.env`、SQLite 数据库或其他敏感信息写入仓库。

## 运行时与配置边界

- 生产运行时是 Bun Server，不再使用 Cloudflare Worker、D1、KV、Hono 或 Wrangler。
- 服务端使用标准 `Request` / `Response` 和 `Bun.serve`，不得依赖其他运行时专属 API。
- SQLite 默认路径为 `./data/xiangying-notes.sqlite`，Docker 中为 `/data/xiangying-notes.sqlite`，通过 volume 持久化。
- 登录凭据只通过运行时环境变量 `XIANGYING_USERNAME` 和 `XIANGYING_PASSWORD` 注入，不写入代码、镜像或日志。
- `COOKIE_SECURE` 仅在 HTTPS 反向代理场景设为 `true`；本地 HTTP 默认使用 `false`。

## 开发、功能和 Bug 修复流程

每次新增一个功能，或者修复一个 bug，都执行一次 `git commit`。提交前至少运行：

```text
bun run typecheck
bun test
bun run build
docker build --pull -t xiangying-notes:check .
```

## 提交规范

- 功能使用 `feat:`，bug 修复使用 `fix:`，文档使用 `docs:`，测试使用 `test:`，构建/工具链使用 `chore:`，CI 使用 `ci:`。
- 提交标题使用中文，简洁说明目的，例如：`fix: 修复中文输入法标题首字母泄漏`。
- 一个提交只表达一个完整意图，不把无关重构、格式化和临时调试混入功能提交。
- 未经用户要求不要执行 `git reset --hard`、`git checkout --`、强制推送或删除远程分支。

## 前端实现要求

- 使用 `bun build` 构建 `app/index.html`，使用 React + TypeScript；不要重新引入 Vite。
- 持久化内容以 Markdown 为准；只用于显示的大纲、统计或标题 ID 不写入数据库。
- 保持暖白画布、白色表面、石墨文字和朱砂橙色强调色的视觉系统。
- 优先使用语义化 HTML、可见焦点状态和 ARIA 属性；核心操作不要依赖浏览器原生菜单。
- 动画只使用 `transform` 和 `opacity`，并支持 `prefers-reduced-motion`。
- 编辑器涉及中文输入法时必须考虑 `compositionstart`、`compositionend`、`compositioncancel`、`event.isComposing` 和 Chromium/Windows 常见的 `keyCode === 229`。
- 修改布局后检查桌面、平板和窄屏手机，不要让浮层遮挡编辑内容或产生横向溢出。

## 内存与性能要求

- 编辑器正文由 Tiptap 内部状态维护；不要在每次输入时把完整 Markdown 复制到多个 React state、历史快照或缓存。每篇笔记的保存队列只保留一份最新草稿，保存成功后立即释放。
- Tiptap 扩展、编辑器配置和重型模块应稳定化或按需加载；切换、重新载入和卸载时清理定时器、动画帧、DOM 引用与编辑器实例，避免 detached DOM。
- 统计、预览等处理应尽量单次遍历并限制中间字符串、数组的大小；服务端列表逐行处理正文，只返回摘要，预览生成有界，避免一次性保留多篇完整正文。
- 保持现有列表数量上限和交互语义，不以自动丢弃未保存草稿、长期客户端缓存或多编辑器驻留换取内存下降；新增缓存必须有明确上限和释放条件。
- 优化须用长正文、多篇笔记和频繁切换场景验证内存峰值、活动编辑器数量及 detached DOM，并运行类型检查、测试和构建。

## 后端与数据要求

- SQLite 查询一律使用 prepared statements，不拼接用户输入。
- 空数据库首次启动时允许自动执行当前迁移完成基础初始化；已有数据库启动不得自动执行后续迁移。新增迁移只能通过 `bun run db:migrate` 或明确的容器迁移命令执行，迁移按文件名顺序执行并通过 `schema_migrations` 保证幂等；不要修改已经应用的历史迁移。
- 涉及笔记正文的创建、更新、删除必须在 SQLite transaction 中同步更新 `notes_fts`。
- 更新笔记必须携带并校验 `version`，版本冲突返回 `409 VERSION_CONFLICT`。
- 私有 API 必须校验当前会话和资源归属。
- 分享公开读取只使用 SQLite 中保存的不可变快照；验证撤销状态和过期时间后再返回，固定有效期 7 天。
- 生产错误返回统一错误 JSON，详细堆栈只写服务端日志。

## Docker 与 CI 要求

- 最终镜像基于最新 `oven/bun:alpine`，使用多阶段构建和非 root `bun` 用户。
- 最终镜像只包含 `dist/client`、`dist/server` 和 `migrations`，不包含源码、测试、开发依赖、`.env` 或 SQLite 数据。
- `.github/workflows/ci.yml` 在 push 时执行类型检查、测试、Bun 构建和 Docker 构建。
- `.github/workflows/docker.yml` 只在 Git tag 推送时发布支持 `linux/amd64` 和 `linux/arm64` 的 GHCR 多架构镜像，并在镜像推送成功后创建同名 GitHub Release；只有正式 SemVer tag 更新 `latest` 镜像标签。

## 结束任务前检查

- 修改文件符合任务范围。
- 没有敏感信息、`dist/`、`data/`、`.wrangler/`、`.env` 或临时配置进入提交。
- 新增功能或 bug 修复已经执行 `git commit`，并在最终回复中报告真实提交号。
