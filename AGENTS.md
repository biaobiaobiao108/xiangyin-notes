# AGENTS.md

## 项目

象映笔记是 Bun + TypeScript + React 的本地 Markdown 笔记软件：前端由 Bun 打包，服务端使用 `Bun.serve`，数据保存在 `bun:sqlite`。

## 通用要求

- 使用中文沟通；信息足够后直接行动，不编造检查或运行结果。
- 优先沿用现有实现，避免无必要的依赖、抽象和文件。
- JavaScript / TypeScript 使用 Bun，不用 npm、yarn 或 pnpm。
- 修改前检查 Git 状态，保留用户已有改动；不要把凭据、`.env`、数据库或用户数据写入仓库。
- 未经用户要求，不执行硬重置、强制推送或删除远程分支。

## 开发与提交

- 新功能或 bug 修复完成后提交；标题使用中文，并按 `feat:`、`fix:`、`docs:`、`test:`、`chore:` 或 `ci:` 分类。
- 代码修改提交前先运行 `bun run format`，再运行以下检查：

  ```text
  bun run format
  bun run typecheck
  bun test
  bun run build
  ```

- `bun run format` 会直接改写脚本覆盖的文件；提交前检查格式化产生的 diff，确认没有无关改动。

- 本地不需要构建 Docker 镜像；由 CI 负责。

## 运行与部署

- 生产后端使用标准 `Request` / `Response` 和 `Bun.serve`；不要引入 Cloudflare Worker、D1、KV、Hono 或 Wrangler。
- 数据库默认位于 `./data/xiangying-notes.sqlite`，Docker 中为 `/data/xiangying-notes.sqlite`，通过 volume 持久化。
- 登录凭据只通过运行时环境变量 `XIANGYING_USERNAME`、`XIANGYING_PASSWORD` 注入，不写入代码、镜像或日志。
- 仅在 HTTPS 反向代理场景设置 `COOKIE_SECURE=true`；本地 HTTP 使用 `false`。
- 保持现有多阶段 Bun 镜像、CI 检查和 amd64/arm64 发布流程；最终镜像不包含源码、测试、开发依赖、凭据或数据库文件。

## 前端约束

- 使用 React + TypeScript 和 `bun build`；不要引入 Vite。以 Safari 为首要适配目标，并延续现有暖白、石墨、松柏绿与朱砂点缀的视觉风格。
- Markdown 是笔记内容的持久化来源；仅供展示的大纲、统计和标题 ID 不写入数据库。
- 优先语义化 HTML 和 ARIA；图标按钮提供 `aria-label`。全站不绘制 `outline`，不使用 HTML `title` 或悬停提示；局部滚动使用 `FloatingScrollbar`。
- 遵循现有组件和 Hook 的职责边界；不要为了拆文件而拆分。动效只使用 `transform` / `opacity`，并尊重 `prefers-reduced-motion`。
- Tiptap 内部维护编辑中的正文，避免每次输入都把整篇 Markdown 复制到多个 React state；处理长正文时限制中间数据并及时清理资源。
- Escape 按局部到全局退出：弹窗/子浮层 → 沉浸模式 → 大纲 → 卡片单篇编辑 → 多选。ProseMirror 的 `defaultPrevented` 不得阻断退出；输入法组合态（`isComposing` 或 `keyCode === 229`）不得触发全局退出。

## 后端与数据

- SQLite 查询使用 prepared statements，不拼接用户输入；私有 API 校验会话和资源归属，更新笔记校验 `version`，冲突返回 `409 VERSION_CONFLICT`。
- `database/schema.sql` 是当前基线，以 `PRAGMA user_version` 标记版本。空库启动时初始化；已有库只执行已登记、连续且逐步事务化的迁移。遇到未知版本、缺失迁移、迁移失败或 schema 漂移时停止启动，不猜测修复。正式发布后不改基线和历史迁移，只新增迁移。
- `bun run db:migrate` 执行同一升级流程；`bun run db:check` 只读检查 schema，发现漂移时以非零状态退出。
- `notes_fts` 使用外部内容表并由触发器同步；不要额外复制正文。保持 `auto_vacuum=INCREMENTAL`；已有库启用时按 SQLite 要求执行 `VACUUM`。删除操作依赖空闲页复用，不在请求中强制截断数据库。
- 生产错误返回统一 JSON；详细堆栈只写服务端日志。

## 收尾检查

- 确认改动范围正确，提交中不包含 `dist/`、`data/`、`.env`、`.wrangler/` 或临时文件。
