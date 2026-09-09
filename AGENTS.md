# AGENTS.md

## 项目定位

Lumen Notes 是一个使用 Bun + TypeScript + React 构建、部署到 Cloudflare Workers 的 Markdown 笔记软件。D1 保存结构化数据和搜索索引，KV 保存 7 天有效的只读分享快照。

## 基本原则

- 信息足够后立即行动，不做无意义的调查。
- 不确定时明确说明，不编造运行结果、部署状态或测试结果。
- 优先复用现有代码和实现模式，不增加没有必要的依赖、配置或文件。
- JavaScript / TypeScript 项目统一使用 Bun；不要用 npm、yarn 或 pnpm 替代项目脚本。
- 修改前先检查工作区状态，保留用户已有的未提交修改，不覆盖无关工作。
- 不要把 D1 ID、KV ID、Cloudflare token、密码、真实分享 token 或其他敏感信息写入仓库。

## Cloudflare 配置边界

- 生产 D1 和 KV 必须在 Cloudflare Dashboard 中配置和绑定。
- 不要为了方便把生产 `database_id` 写入 `wrangler.jsonc`。
- Worker 运行时绑定名必须保持为 `DB`、`SHARE_KV` 和 `ASSETS`。
- 本地开发和远程 D1 迁移可以使用脚本生成的 `.wrangler.local.jsonc` 与 `.wrangler.remote.jsonc`；这两个文件必须保持被 `.gitignore` 忽略。
- Worker 代码必须兼容 Cloudflare `workerd`，不能依赖 Bun runtime 专属 API。

## 开发、功能和 Bug 修复流程

每次新增一个功能，或者修复一个 bug，都执行一次 git 提交。

## 提交规范

- 功能使用 `feat:`，bug 修复使用 `fix:`，文档使用 `docs:`，测试使用 `test:`，构建/工具链使用 `chore:`。
- 提交标题使用中文，简洁说明目的，例如：`fix: 修复中文输入法标题首字母泄漏`。
- 一个提交只表达一个完整意图，不把无关重构、格式化和临时调试混入功能提交。
- 未经用户要求不要执行 `git reset --hard`、`git checkout --`、强制推送或删除远程分支。
- 不要修改或删除已经应用到生产环境的历史 D1 迁移；数据库结构变更应新增迁移文件。

## 前端实现要求

- 使用 Bun bundler 构建 `app/index.html` 和 `worker/index.ts`。
- 持久化内容以 Markdown 为准；不要把只用于显示的大纲、统计或标题 ID 写入后端。
- 保持现有暖白画布、白色表面、石墨文字和朱砂橙强调色的视觉系统。
- 优先使用语义化 HTML、可见焦点状态和 ARIA 属性；核心操作不要依赖浏览器原生菜单。
- 动画只使用 `transform` 和 `opacity`，并支持 `prefers-reduced-motion`。
- 编辑器涉及中文输入法时必须考虑 `compositionstart`、`compositionend`、`compositioncancel`、`event.isComposing` 和 Chromium/Windows 常见的 `keyCode === 229`。
- 修改布局后要检查桌面、平板和窄屏手机，不要让浮层遮挡编辑内容或产生横向溢出。

## 后端与数据要求

- D1 SQL 一律使用 prepared statement，不拼接用户输入。
- 涉及笔记正文的创建、更新操作必须同步更新 `notes_fts`。
- 更新笔记必须携带并校验 `version`，版本冲突返回 `409`。
- 私有 API 必须校验当前用户和资源归属。
- 分享公开读取必须先查 D1 校验撤销和过期，再读取 KV 快照。
- 分享快照固定 7 天，不因原笔记后续修改而变化。

## 结束任务前检查

结束前至少确认：

- 修改文件符合任务范围。
- `bun run typecheck` 通过。
- `bun test` 通过。
- 对前端或 Worker 改动执行 `bun run build` 并通过。
- 没有敏感信息、`dist/`、`.wrangler/` 或临时文件进入提交。
- 新增功能或 bug 修复已经执行 `git commit`，并在最终回复中报告真实提交号。
