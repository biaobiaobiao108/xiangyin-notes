# AGENTS.md

## 项目定位

象映笔记是一个使用 Bun + TypeScript + React 构建的本地全栈 Markdown 笔记软件。前端由 Bun bundler 打包，后端使用原生 `Bun.serve`，数据使用 `bun:sqlite` 保存；分享链接实时读取笔记，SQLite 只保存分享令牌元数据。

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

本项目本地开发不需要执行 Docker 构建测试，Docker 构建由 CI 流程负责。

```text
bun run typecheck
bun test
bun run build
```

## 提交规范

- 功能使用 `feat:`，bug 修复使用 `fix:`，文档使用 `docs:`，测试使用 `test:`，构建/工具链使用 `chore:`，CI 使用 `ci:`。
- 提交标题使用中文，简洁说明目的，例如：`fix: 修复中文输入法标题首字母泄漏`。
- 一个提交只表达一个完整意图，不把无关重构、格式化和临时调试混入功能提交。
- 未经用户要求不要执行 `git reset --hard`、`git checkout --`、强制推送或删除远程分支。

## 前端实现要求

- 使用 `bun build` 构建 `app/index.html`，使用 React + TypeScript；不要重新引入 Vite。
- Safari 优先：前端以 macOS 当前稳定版 Safari 为首要适配目标。
- 持久化内容以 Markdown 为准；只用于显示的大纲、统计或标题 ID 不写入数据库。
- 保持暖白画布、白色表面、石墨文字，以复古松柏军绿为主强调色、辅以沉敛朱砂印章点睛的视觉系统。
- 优先使用语义化 HTML、可见焦点状态和 ARIA 属性；核心操作不要依赖浏览器原生菜单。

### 视觉与组件设计规范 (The Literary Editorial Design System)

- **核心色彩与风格基调**：
  - 秉持文人笔记的内敛、克制与纯净质感。保持暖白画布（`--canvas`）、白色表面（`--surface`）、石墨文字（`--ink`）与复古松柏军绿（`--accent`）的核心视觉系统；
  - 导航菜单与笔记本条目（无论折叠还是展开）选中统一使用白色表面（`--surface`）搭配轻阴影浮起与石墨深字；朱砂（`--h1-color`）仅用于正文 H1 或明确的错误/危险语义，不用于收藏和普通选中状态。
- **去死灰硬边框与通透线框体系**：
  - 彻底废除全站纯灰生硬的实线分割（严禁使用 `#dce1dc`、`#edf0ed` 等高对比度死灰线条，杜绝机械表格切割感）；
  - 统一采用半透明淡墨微线（`--line` 与 `--border-soft`，基于浅色 `rgba(32, 38, 33, 0.08)` / 深色 `rgba(255, 255, 255, 0.09)`），依靠留白与柔和底色层级（`--canvas` 与 `--surface`）自然划分信息。
- **微阴影阶梯与圆角层级**：
  - 建立渐进式的多层微阴影阶梯：`--shadow-2xs`（卡片基底）、`--shadow-xs`（微浮起/选中条目）、`--shadow-sm`（小浮层）、`--shadow-md`（悬停上浮）、`--shadow-float`（弹窗/全局指令），如薄纸自然轻落，杜绝粗黑重阴影；
  - 规范圆角体系：微圆角 `--radius-sm: 9px`（晶片/按钮/内嵌块）、中圆角 `--radius-md: 13px`（手记行/卡片/输入框）、大圆角 `--radius-lg: 20px`（弹窗/外层容器）。
- **笔记列表栏（呼吸感浮动手记行）**：
  - 列表项彻底摒弃整屏左右通栏贯通的硬顶线，采用留有边距的**卡片式浮动手记行**（`width: calc(100% - 16px); margin: 3px 8px; border-radius: var(--radius-md)`），项与项之间留有呼吸感；
  - 选中态废除横向渐变，统一使用纯净温润的松柏柔底（`var(--accent-soft)`）与微边框微浮起；时间、字数与计数徽标一律采用等宽数字（`tabular-nums font-mono`）克制排版。
- **出版物阅读排版与正文呼吸感**：
  - 正文排版严格遵循出版物黄金阅读行高（黄金阅读行高 `1.74`，字符间距 `0.012em`），段落间距舒展透气（`margin-block: 0 0.88em`）；
  - 标题输入区与正文之间保持充分的呼吸过渡（`margin-bottom: 20px`），输入状态严禁添加生硬外框或抖动；
  - 引用块（Blockquote）统一采用复古松柏单立引线（`border-left: 3px solid var(--accent)`）搭配松柏温润微底（`background: var(--accent-soft)`），呈现现代出版物的手记层次。
- **通透磨砂顶栏与轻盈毛玻璃弹窗**：
  - 列表顶栏与编辑器顶栏高度统一规范（`62px`），注入半透明微磨砂底色（`backdrop-filter: blur(14px)`）与极细淡线底边，页面滚动穿透柔和轻盈；
  - 弹窗遮罩升级为现代背景景深虚化（`backdrop-filter: blur(8px)`），弹窗外框圆角采用 `18-20px` 并搭配 `--shadow-float`；搜索框采用饱满微圆角与松柏聚焦环，选项行胶囊化。
- **微晶片与微胶囊交互**：
  - 标签统一采用轻盈圆角微晶片胶囊（`padding: 1px 7px; border-radius: 999px; background: var(--accent-soft)`）；
  - 排序按钮、状态徽标与行内操作一律采用无边框轻量微晶片，默认半透明或极浅微底，悬停时平滑响应轻浅底色或极细淡线，禁止粗大生硬的大色块。
- **Safari 优先与防阴影割裂规范 (Safari Anti-Fragmented-Shadows)**：
  - 卡片多栏与瀑布流布局下严禁随意滥用全局 `transform`，以防 Safari 产生分片阴影（fragmented shadow）渲染异常；
  - 优先使用现代 `@supports (display: grid-lanes)` 的 `scale: 1.015` 与微投影平滑响应悬浮。
- **顶栏状态与稳定性**：
  - 编辑器顶栏的保存、上传、冲突、错误等动态状态只显示固定尺寸图标；文字仅通过 `aria-label`、`title` 提供，不得因状态文字改变顶栏尺寸或挤压其他控件；
  - 弹性或网格子项正确设置 `min-width: 0`；顶栏图标按钮保持固定触控尺寸且不可被 flex 压缩；标题、长字符串和状态变化不得造成横向溢出、重叠或跳变。
- **可访问性与局部滚动**：
  - 优先使用原生语义控件，所有图标按钮有可读名称，保留可见 `:focus-visible`；所有局部滚动容器必须使用 `FloatingScrollbar` 组件并隐藏原生滚动条。

### 键盘交互与 Escape 快捷键规范

- 内核机制规避：富文本编辑器内核 ProseMirror 在正文中按 Escape（`keyCode === 27`）默认会调用 `event.preventDefault()`。全局或外层监听器处理 Escape 时，**绝不得因 `event.defaultPrevented === true` 阻断退出逻辑**，否则会导致正文中按 Escape 失效。
- 逐层退出优先级：全局 Escape 遵循从局部到全局、严谨可预测的逐层退出响应顺序：
  1. 模态弹窗（`<dialog>`）与子级浮层（双链补全、搜索高亮清除、下拉菜单）优先内部关闭，并调用 `event.stopPropagation()` 防止穿透；
  2. 沉浸编辑模式（`focusMode`）：第一优先级退出沉浸模式（无论光标在标题还是正文）；
  3. 笔记大纲（`outlineOpen`）：关闭大纲面板；
  4. 卡片视图单篇编辑（`isCardEditing`）：退出单篇编辑返回卡片网格；
  5. 列表多选（`hasSelection`）：取消多选选中。
- 输入法保护：中文输入法候选态（`event.isComposing` 或 `keyCode === 229`）按 Escape 仅取消当前拼音候选，不得触发任何全局退出逻辑。


### 动画与动效规范 (Motion Design & Fluid Interactions)

- **风格基调**：保持文人笔记的内敛、克制、轻柔与可预测性。杜绝炫目夸张的花哨动效，以自然呼吸感与微物理手感为导向。
- **动效时长与缓动体系**：
  - 缓动函数统一规范为现代高阶缓动 `--motion-ease-out`（`cubic-bezier(0.16, 1, 0.3, 1)`），杜绝浏览器生硬机械的默认 `ease`；微交互反馈可辅以 `--motion-spring`；
  - 建立明确的时间阶梯：
    - `--motion-micro: 120ms`：触觉按压、小图标微缩放跟手反馈；
    - `--motion-fast: 160ms`：悬停背景、边框高亮、微投影展开；
    - `--motion-content: 180ms`：正文内容、行内格式淡入入场；
    - `--motion-panel: 220ms`：弹窗浮层、侧边抽屉、Toast 通知优雅滑入；
    - `--motion-layout: 280ms`：侧栏折叠/展开、工作区视口大结构切换。
- **弹窗与浮层入场体系**：
  - 全站模态弹窗（`<dialog>`、命令面板、分享面板、笔记本设置、确认弹窗等）统一采用 `dialog-in` 配合 `var(--motion-panel) var(--motion-ease-out)`，起始态带有细腻微位移与微缩放（`translateY(-10px) scale(0.975)`），呈现轻盈浮现质感；
  - 侧边与浮动大纲抽屉（`.editor-floating-outline`）采用 `outlineFadeIn`（`translateX(-10px) scale(0.98)` 到正常），配合半透明毛玻璃柔和展开。
- **系统通知与 Toast**：
  - Toast 与更新通知采用 `toast-in-top`（带有 `scale(0.97)` 微缩放），如浮动轻手记卡片自然滑落悬浮，避免生硬下冲。
- **触觉微手感反馈 (Micro-haptic Feedback)**：
  - 主按钮（`.primary-button`）、次按钮（`.secondary-button`）、图标按钮（`.icon-button`）与列表行（`.note-row`）在 `:active` 点击态下均具备细腻的轻微缩放响应（`scale(0.94)` ~ `scale(0.992)`），模拟原生桌面级物理按压手感。
- **视图与笔记切换一致性**：
  - 三栏列表与卡片网格在目标内容就绪后，由 `transitionToken` 各触发一次 `page-content-in`（淡入上移 6px）；
  - 编辑器切换笔记时播放 `note-fade-in`（淡入上移 4px），初次进入编辑器由 `.editor-document--entering` 保持相同节奏；从编辑器退回卡片网格也保持连贯淡入。
- **属性与性能约束**：
  - 只动画 `transform` 与 `opacity`；绝对避免动画布局、尺寸（width/height）、内边距和网格轨道路径（禁止 transition `grid-template-columns`）；
  - 列表切换只在目标数据成功加载或本地回退渲染后播放一次；后台同步、重复点击和搜索逐字输入不得重复触发。
- **Safari 优先与防分片阴影规范**：
  - 卡片多栏与 CSS 瀑布流布局下严禁随意声明全局 `transform`，以杜绝 Safari 分片阴影（fragmented shadow）渲染异常；优先在支持网格车道的环境下使用 `scale: 1.015`。
- **无障碍降级保障**：
  - 在 `prefers-reduced-motion: reduce` 下，所有 `--motion-*` 时间变量均强制归零，所有弹窗、通知、卡片与正文动画统一应用 `animation: none !important;`，但完整保留页面功能与静态状态提示。

## 前端模块化规范

- 页面容器负责跨区域状态和页面编排；侧栏、列表、编辑器工具区、弹窗等独立 UI 按职责拆分为组件模块。
- 数据请求、保存队列、离线同步、快捷键等副作用逻辑优先抽为 `use*.ts` 或领域模块；纯类型和纯函数放在相邻的 `*.types.ts`、`*.helpers.ts` 文件中。
- 组件通过明确的 props 和回调通信；只有确有必要的共享状态才使用 Context 或全局 store，避免隐式耦合和循环依赖。
- 富文本编辑器的 Tiptap 生命周期、IME 处理和强相关 DOM 同步逻辑可以保留在同一模块，不按行数机械拆分；只读渲染、工具栏和配置可独立拆出。
- 重型编辑器、只读渲染和不常用弹窗优先在真实使用边界懒加载；拆文件本身不等同于性能优化，必须以构建产物或浏览器性能数据验证收益。
- 避免无语义的 `utils.ts` 和为拆分而拆分；新增模块应有单一职责、稳定边界和可独立测试的理由。


## 内存与性能要求

- 编辑器正文由 Tiptap 内部状态维护；不要在每次输入时把完整 Markdown 复制到多个 React state、历史快照或缓存。每篇笔记的保存队列只保留一份最新草稿，保存成功后立即释放。
- Tiptap 扩展、编辑器配置和重型模块应稳定化或按需加载；切换、重新载入和卸载时清理定时器、动画帧、DOM 引用与编辑器实例，避免 detached DOM。
- 统计、预览等处理应尽量单次遍历并限制中间字符串、数组的大小；服务端列表逐行处理正文，只返回摘要，预览生成有界，避免一次性保留多篇完整正文。
- 保持现有列表数量上限和交互语义，不以自动丢弃未保存草稿、长期客户端缓存或多编辑器驻留换取内存下降；新增缓存必须有明确上限和释放条件。
- 优化须用长正文、多篇笔记和频繁切换场景验证内存峰值、活动编辑器数量及 detached DOM，并运行类型检查、测试和构建。

## 后端与数据要求

- SQLite 查询一律使用 prepared statements，不拼接用户输入。
- 空数据库首次启动时允许自动执行当前迁移完成基础初始化；已有数据库启动不得自动执行后续迁移。新增迁移只能通过 `bun run db:migrate` 或明确的容器迁移命令执行，迁移按文件名顺序执行并通过 `schema_migrations` 保证幂等。正式部署前可以把迁移折叠进 `0001_baseline.sql`；正式部署后不要修改已经应用的历史迁移。
- `notes_fts` 配置为外部内容表（`content='notes', content_rowid='rowid'`），由 SQLite 触发器在正文或标题变更时自动同步维护，搜索联查使用 `notes_fts.rowid = n.rowid`；不额外存储正文副本。
- 数据库打开时必须确保 `PRAGMA auto_vacuum = INCREMENTAL;`，已有数据库如未启用需通过 `VACUUM;` 自动升级。
- 物理删除笔记与清空废纸篓遵循数据库空闲页复用机制（freelist reuse），释放页保留在数据库中供后续写入直接复用，不在删除请求中强行截断，避免 I/O 抖动与磁盘磨损；深度整理工具函数 `reclaimDatabaseSpace` 仅按需维护使用。
- 更新笔记必须携带并校验 `version`，版本冲突返回 `409 VERSION_CONFLICT`。
- 私有 API 必须校验当前会话和资源归属。
- 分享公开读取在验证撤销状态和过期时间后读取笔记当前内容；笔记进入回收站时不可公开读取，固定有效期 7 天。分享记录只保存令牌元数据，不保存正文快照，并定期清理过期 30 天以上的记录。
- 生产错误返回统一错误 JSON，详细堆栈只写服务端日志。

## Docker 与 CI 要求

- 最终镜像基于最新 `oven/bun:alpine`，使用多阶段构建。
- 最终镜像只包含 `dist/client`、`dist/server` 和 `migrations`，不包含源码、测试、开发依赖、`.env` 或 SQLite 数据。
- `.github/workflows/ci.yml` 在 push 时执行类型检查、测试、Bun 构建和 Docker 构建。
- `.github/workflows/docker.yml` 只在 Git tag 推送时发布支持 `linux/amd64` 和 `linux/arm64` 的 GHCR 多架构镜像，并在镜像推送成功后创建同名 GitHub Release；只有正式 SemVer tag 更新 `latest` 镜像标签。

## 结束任务前检查

- 修改文件符合任务范围。
- 没有敏感信息、`dist/`、`data/`、`.wrangler/`、`.env` 或临时配置进入提交。
- 新增功能或 bug 修复已经执行 `git commit`，并在最终回复中报告真实提交号。
