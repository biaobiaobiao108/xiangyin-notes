# AGENTS.md

## 项目

象映笔记使用 Bun、TypeScript 和 React。前端由 Bun 打包并通过 Cloudflare Workers 静态资产提供；服务端运行在 Workers，数据使用 D1、R2 和 Durable Objects。

## 通用要求

- 使用中文沟通；简单优先，沿用现有架构，避免无必要的依赖、抽象和文件。
- JavaScript / TypeScript 项目使用 Bun，不用 npm、yarn 或 pnpm。
- 修改前检查 Git 状态并保留已有改动；不编造检查结果。
- 不把凭据、`.env`、`.dev.vars`、数据库或用户数据写入仓库。
- 未经要求不执行硬重置、强制推送或删除远程分支。

## 开发与提交

- 新功能和 bug 修复完成后提交；标题使用中文，并按 `feat:`、`fix:`、`docs:`、`test:`、`chore:` 或 `ci:` 分类。
- 代码修改提交前运行：

  ```text
  bun run typecheck
  bun test
  bun run build
  bun run cf:db:migrate:local
  ```

## 运行与部署

- 生产环境使用 Cloudflare Workers；本地通过 `bun run cf:dev` 和 Wrangler 模拟。服务端使用 Web APIs，并依赖 `DB`、`ASSETS_BUCKET`、`REALTIME_HUB`、`ASSETS` 绑定。
- 登录凭据通过 `XIANGYING_USERNAME`、`XIANGYING_PASSWORD` 等运行时 secrets 注入。识别客户端 IP 时优先使用 `CF-Connecting-IP`。
- D1 迁移放在 `migrations-d1/`，使用 `bun run cf:db:migrate:local` 或 `bun run cf:db:migrate:remote`；初始化迁移启用外键。
- CI 在 push 时运行类型检查、测试、构建和本地迁移验证；Cloudflare 部署通过手动 workflow 执行线上迁移和 Wrangler 部署。部署前确认 `wrangler.jsonc` 中的 D1 `database_id` 已配置。

## 前端约束

- 使用 React + TypeScript 和 `bun build`，不要引入 Vite；优先适配 Safari。延续暖白、石墨、松柏绿与朱砂点缀的现有视觉风格。
- Markdown 是笔记内容的持久化来源；展示用的大纲、统计和标题 ID 不写入数据库。
- 使用语义化 HTML 和 ARIA；图标按钮提供 `aria-label`。不绘制焦点 `outline`，不使用 HTML `title` 或悬停提示；局部滚动使用 `FloatingScrollbar`。
- 按职责拆分组件和 Hook，不为拆分而拆分；重型模块仅在真实使用边界懒加载。动效限于 `transform` 和 `opacity`，并尊重 `prefers-reduced-motion`。
- Tiptap 内部维护编辑正文；避免输入时复制整篇 Markdown 到多个 state。保存队列只保留最新草稿，卸载时清理定时器、动画帧和编辑器实例。
- Escape 按局部到全局依次关闭弹窗/浮层、沉浸模式、大纲、卡片编辑和多选；不得因 ProseMirror 的 `defaultPrevented` 阻断退出，输入法组合态不得触发全局退出。

## 后端与数据

- D1 / SQLite 查询使用 prepared statements；批量写入使用 D1 `batch()`。更新笔记校验 `version`，冲突返回 `409 VERSION_CONFLICT`；私有 API 校验会话和资源归属。
- `notes_fts` 使用外部内容表和 trigram，由触发器同步，搜索通过 `notes_fts.rowid = n.rowid` 联查；不复制正文。迁移及删除遵循现有事务和数据约束。
- 生产错误返回统一 JSON；详细堆栈只写服务端日志。

## 收尾检查

确认改动范围正确，提交中不包含 `dist/`、`data/`、`.wrangler/`、`.env`、数据库或临时文件。
