# 象映笔记 · 全量代码审查报告

- 审查日期：2026-09-30
- 审查方式：4 个并行子代理分域只读审查（后端/数据、前端/UI、测试/工程化、MCP 工具设计）
- **修复状态：P0 4/4、P1 23/23 已修复并提交**（2026-09-30 当日完成），验证 `typecheck` ✅ / `test` 278 pass ✅ / `build` ✅；下文第六节之后追加「第七节 未修复项与原因」
- 覆盖范围：`server/`（含 `routes/`）、`shared/`、`migrations/`、`app/`（47 个文件）、`tests/`（27 个文件）、`scripts/`、`Dockerfile`、`.github/`、`package.json`、`README.md`
- 基线验证：`bun run typecheck` ✅ / `bun test` ✅（273 pass，0 fail，1747 expect，5.21s）/ `bun run build` ✅（1.27s）

---

## 一、总体结论

1. 项目工程质量高于平均水平：类型检查、测试、构建三项全绿，测试隔离干净（全用 `:memory:` 或 tmpdir 随机库，未污染 `data/` 真实数据库），仓库无敏感文件泄漏。
2. **没有导致系统不可用的 P0**，但存在 **2 个静默数据丢失风险**（附件孤儿清理大小写敏感、Docker 场景下 `DATABASE_PATH` 覆盖数据卷），建议按 P0 处置。
3. 服务端安全基线扎实：全量参数化 SQL、逐接口 `user_id` 归属校验、版本乐观锁、路径穿越防护、上传魔数白名单、分享令牌哈希存储、登录限流均无缺口。
4. 前端对 AGENTS.md 硬性规范的落实度很高，尤其「Escape 不被 `defaultPrevented` 阻断」「IME `isComposing`/`keyCode 229` 保护」这两个已知坑处理完整；缺口集中在滚动容器与 Safari 兼容。
5. 主要技术债：`server/core.ts`（33KB）职责混杂、`server/mcp.ts`（62KB）单函数 500 行、常量与工具函数多处重复拷贝。
6. MCP 层设计成熟（20 个工具全部 `.strict()`、`empty_trash` 用 `z.literal(true)` 闸门、冲突回传 current 全文），但**护栏强度与破坏性倒挂**：`delete_notebook` 不可逆且级联，却没有 `empty_trash` 那样的确认闸门。

---

## 二、P0 / 高危（建议立即修）

| # | 分类 | 文件:行 | 问题 | 影响 | 建议 |
|---|---|---|---|---|---|
| 1 | MCP 护栏 | `server/mcp.ts:432-440`<br>`server/routes/notebooks.ts:126-144` | `delete_notebook` 不可逆 + 级联影响 N 篇笔记，却无 `confirm` 闸门；而同样不可逆的 `empty_trash` 有 `z.literal(true)`。**护栏强度与破坏性倒挂** | agent 误调一次即删掉整个笔记本 | 加 `confirm: z.literal(true)`，或加 `expectedNoteCount`，服务端比对不符即拒 |
| 2 | 数据丢失 | `server/routes/assets.ts:143-153`（尤 150）<br>对照 `server/core.ts:859,874` | 孤儿附件清理用 `instr(n.content_markdown, '/api/assets/' \|\| a.id)`，SQLite `instr` **大小写敏感**；而引用解析正则（`giu`）与 `noteAssetIds()->toLowerCase()` 都接受大写 UUID | 正文写 `/api/assets/<大写UUID>` 时校验放行、挂载成功，但清理 SQL 匹配不到 → 24h 后附件行 + 磁盘文件被判孤儿删除，**笔记图片永久 404** | 改为 `instr(lower(...), '/api/assets/' \|\| lower(a.id))`，或改以 `a.note_id IS NULL` 判定 |
| 3 | Docker 数据丢失 | `.env.example:10` vs `Dockerfile:24` | `.env.example` 的 `DATABASE_PATH=./data/xiangying-notes.sqlite` 是生效值，镜像里应为 `/data/...`。用户按 README 复制 `.env` 后 `--env-file` 会覆盖镜像 ENV，数据库与附件落到容器 `/app/data`，**不在 volume 中，容器重建即丢** | 生产部署静默丢数据 | 注释掉该行或改为 `/data/xiangying-notes.sqlite`，README 明确「容器内不要覆盖」 |
| 4 | 会话安全 | `server/core.ts:227-232`<br>`server/routes/auth.ts:163-166`<br>`server/index.ts:67` | `COOKIE_SECURE` 默认 `false`，`isSecureRequest` 仅按 `request.url` 判断；Nginx/Caddy 终止 TLS 时永远是 `http://` → Set-Cookie **不带 Secure**，HSTS 也不下发 | 默认部署路径上会话保护降级 | `TRUST_PROXY=true` 时按 `X-Forwarded-Proto` 判定；README 要求 HTTPS 场景显式设 `COOKIE_SECURE=true` |

---

## 三、P1（明确缺陷 / 规范违背）

### 3.1 前端（5 条）

| # | 分类 | 文件:行 | 问题 | 建议 |
|---|---|---|---|---|
| 5 | Escape 规范 | `app/editor.tsx:1138-1157`<br>`app/workspace/use-workspace-shortcuts.ts:49-83` | 同一次 Escape 触发**两层退出**：两个 handler 都挂 window，全局层先执行且未 `stopImmediatePropagation()`，编辑器层又不检查 `defaultPrevented` → 沉浸模式下按 Esc 会同时退出沉浸 + 清除搜索高亮 | 全局层命中后补 `stopImmediatePropagation()`（参照 `panels.tsx:252-254`） |
| 6 | Escape 规范 | `app/editor.tsx:1147-1152` | 「搜索高亮清除」未落在优先级 1（AGENTS.md 规定为第 1 层），实际优先级低于 focusMode/outline | 改捕获阶段监听，或让全局层感知「有活跃搜索」并让位 |
| 7 | 可访问性 / 规范 | `app/workspace/panels.tsx:26`<br>`app/styles.css:293-294` | `.collapsed-notebook-list` 是局部滚动容器、加了 `floating-scrollbar-target`（CSS 已隐藏原生滚动条），但**没有配 `FloatingScrollbar`** → 可滚动但无滚动条。这是「所有局部滚动容器必须用 FloatingScrollbar」的唯一漏网处 | 补 `<FloatingScrollbar placement="left" />` 或去掉该 class |
| 8 | 性能 | `app/workspace.tsx:1262` + `:519` | `contentOnlyChange` 优化被抵消：`onNoteChange` 对纯正文变更刻意不 `setSelectedNote`，但 `renderedNote` 优先取已被替换的 `selectedRef.current` → 每次防抖同步都让 `memo(NoteEditor)` 拿到新引用而**全量重渲染** | `renderedNote` 以 `selectedNote` state 为准，仅 id 变化/显式 reload 时回退 ref |
| 9 | 性能 | `app/editor/table-scrollbars.tsx:73-75` | `MutationObserver` 以 `{childList:true, subtree:true}` 观察**整篇编辑器文档**，`syncTargets()` 同步执行未 rAF 节流 → 每次回车/粘贴/插入都对全文 `querySelectorAll(".tableWrapper")` | rAF 合并 + 无表格时短路 |
| 10 | Safari 兼容 | `app/workspace/dialogs.tsx:60`<br>`app/editor/backlinks-panel.tsx:148` | 依赖 `<dialog closedby="any">`，早期 Safari 稳定版不支持，点击遮罩关闭失效；同时又有手写 `handleBackdropClick`，逻辑重复 | 去掉 `closedby`，只保留手写兜底 |

### 3.2 后端（3 条）

| # | 分类 | 文件:行 | 问题 | 建议 |
|---|---|---|---|---|
| 11 | 健壮性 | `server/core.ts:234-240`（238 抛错）<br>`server/index.ts:107` | `PUBLIC_URL` 非法时 `new URL()` 抛异常，而 `getPublicOrigin` 在每个非 GET 请求的 CSRF 校验里被调用 → 配置错误时**所有写接口一律 500** 且信息不明显 | 启动阶段解析一次，失败明确报错或降级 |
| 12 | 并发 | `server/routes/notes.ts:292-310` | `wiki-notes/ensure` 先查后建且不在事务内，并发请求会创建两条同名笔记（`notes` 无 `(user_id, title_normalized)` 唯一约束） | 加唯一索引 + `INSERT ... ON CONFLICT`，或事务内二次校验 |
| 13 | 版本锁 | `server/routes/notebooks.ts:132-139` | 删除笔记本时 `UPDATE notes SET version = version + 1` 绕过 `updateNote`，客户端 version 立即失效，下次保存必 409 | 经实时通道推送 `resource:"notes"` 让客户端刷新 |

### 3.3 工程化（4 条）

| # | 分类 | 文件:行 | 问题 | 建议 |
|---|---|---|---|---|
| 14 | 依赖声明 | `package.json:19-35`<br>`app/editor/*.ts`、`app/editor/markdown-config.ts:2` | `@tiptap/pm`、`marked` 被直接 import 但未写入 `dependencies`，仅靠传递解析（pm 是 peer、marked 是 `@tiptap/markdown` 的依赖） | 显式加入 `@tiptap/pm@^3.31.3`、`marked@^17.0.1` |
| 15 | 仓库卫生 | `.gitignore` | `.workbuddy/` 未被忽略（`git status` 唯一未跟踪项），随时可能被 `git add .` 误提交 | `.gitignore` 增加 `.workbuddy/` |
| 16 | 提交规范 | `git log`（fix 43 / feat 7 / style 3 / perf 3 / chore 2 / docs 1 / ci 1） | 出现 `style:`（3 条）、`perf:`（3 条），不在 AGENTS.md 允许的 `feat/fix/docs/test/chore/ci` 内 | 归入 `chore:`/`fix:` |
| 17 | 提交规范 | `tests/` | 近 100 条提交中 `test:` 前缀为 **0**，测试改动混在 `fix:` 提交里，违背 AGENTS.md 约定 | 测试改动单独用 `test:` 提交 |

### 3.4 MCP 工具设计（11 条）

| # | 分类 | 文件:行 | 问题 | 建议 |
|---|---|---|---|---|
| 18 | agent 友好度 | `server/routes/notebooks.ts:138-143`<br>`server/mcp.ts:439` | 路由算出 `movedCount` 却只回 `{ok:true}` → agent 无法告知用户多少篇笔记被搬走 | 路由返回 `movedCount`，MCP 透传 |
| 19 | 一致性 | `server/routes/notebooks.ts:135` | 级联 `version+1` 让 agent 手上所有 version 失效，返回里无任何提示，后续操作一律 409 只能靠报错反推 | 返回 `versionsInvalidated: true` 或 `affectedNoteIds` |
| 20 | **schema 语义** | `server/mcp.ts:576` / `705` / `835` | **同一个 `tags` 字段三种语义**：`create_note` 追加、`set_tags` **整体替换**、`batch_update_notes` 追加。选错工具 = 静默清空其余标签（标签写在正文里，是真实内容修改） | 改名为 `addTags`/`removeTags`/`replaceTags` |
| 21 | 能力缺口 | `server/mcp.ts:467-485` / `456-461` / `349` | **回收站里找不到东西**：`list_trash` 无 `query`/`tag`/`notebookId`，`search_notes` 无 `view=trash`，`get_note` 按 title 查硬编码 `deleted_at IS NULL` → 用户说「恢复上周删的会议记录」时 agent 只能翻页枚举，按标题查会误判不存在而**重复创建** | `list_trash` 增 `query`；`search_notes` 增 `includeDeleted`；`get_note` title 路径增 `includeDeleted` |
| 22 | 往返浪费 | `server/mcp.ts:673/687/701/806/816` | 五个写工具描述都写「先用 `get_note` 获取最新 version」，但 `get_note` 无 `includeContent` 开关 → 为一个 bit 的收藏状态下载 8,000 字正文。而 `search_notes`/`list_trash` 返回**本来就带 version**（`core.ts:800-814`），描述里没说 | `get_note` 加 `includeContent`；描述改为「用 `search_notes`/`list_trash` 拿 version 即可」 |
| 23 | 一致性 | `server/mcp.ts:124-127` | 只有 `updatedAt` 补了 ISO，`createdAt`/`deletedAt` 仍是裸 Unix 秒，同一条笔记两种时间格式 | 补 `createdAtISO` / `deletedAtISO` |
| 24 | 一致性 | `server/mcp.ts:643` vs `771` | 同名 `occurrence`：replace 用非重叠匹配、insert 用 `overlapping:true` → 同段文字在两边 `matchCount` 不一致 | 统一为非重叠，或在 description 写明 |
| 25 | 错误码 | `server/mcp.ts:360/651/779` | 一个「歧义」概念三套码（`AMBIGUOUS_TITLE`/`_TEXT_MATCH`/`_ANCHOR`）+ 四套「找不到」，agent 要背 7 套分支 | 收敛为 `AMBIGUOUS_MATCH` + `NOT_FOUND` + `target` 字段，旧码保留别名一版 |
| 26 | agent 友好度 | `server/mcp.ts:867` | `batch_update_notes` 部分失败也整体 `isError:true` → agent 整批重试，48 次冗余写入 + 48 次无谓 version 递增 | `isError` 仅在 `failedCount === results.length` 时置位，否则返回 `partial: true` |
| 27 | 重复实现 | `server/mcp.ts:344-368`<br>vs `server/core.ts:715/735` | `noteByTitle` 是第二套搜索实现（裸 SQL `LIKE` + NFKC），绕开 core 的 `parseSearchTerms`/`buildFtsQuery`，标题规则一改就漂移 | 标题解析抽到 core，MCP 层不碰 SQL |
| 28 | agent 友好度 | `server/mcp.ts:362` | `AMBIGUOUS_TITLE` 候选只有 `{id, title, notebookName}`，**没有 version** → 消歧后还得再调一次 `get_note` | 候选补 `version` |

---

## 四、P2（改进建议，按域归类）

**后端 / 数据层**
- `assets.ts:210-217`：`Bun.write` + `rename` 成功但 DB INSERT 抛错时文件已落盘且无 DB 行，孤儿清理只扫 DB → 无主文件永不回收（catch 中 `unlink`）
- `assets.ts:65`：`Content-Length` 取 DB `byte_size` 而非 `file.size`，文件被外部改动会截断/挂起
- `notes.ts:507`：客户端可任意指定笔记 `id`（未校验 UUID 格式），越权不可行但可制造 500
- `notes.ts:183/688/699`：`BATCH_VERSION_CONFLICT`、`MENTION_STALE` 与 AGENTS.md 要求的 `409 VERSION_CONFLICT` 不一致
- `notes.ts:501/733`：`validText` 对类型错误（如 `title: 123`）也返回 `413 NOTE_TOO_LARGE`，语义误导
- `core.ts:145-147`：标题/正文按 **UTF-16 码元**计数（emoji 计 2），与「字符」直觉不一致；`NOTE_BODY_MAX_BYTES=4.5MB` 实际永不触发
- `notes.ts:455-479`：`offset` 无上限且 `includeTotal` 默认开启，每次列表都跑带 JOIN 的 `COUNT(*)`；标签对账逐条 SELECT 有 N+1
- `db.ts:49-53`：已有库 `auto_vacuum != 2` 时每次启动静默 `VACUUM;`（大库可能数十秒）
- `db.ts:62-64`：已有库静默跳过迁移符合规范，但缺少「schema 落后」告警，后续新增 `0002_*.sql` 会让旧库运行期崩溃
- `core.ts:227`、`index.ts:97-108`：`readJson` 不校验 `Content-Type`；Origin 与 `Sec-Fetch-Site` 双缺失时放行（当前靠 `SameSite=Lax` 兜住）
- `core.ts:234-240` + `shares.ts:95`：未配 `PUBLIC_URL` 时用 Host 头拼分享 URL

**代码质量 / 重复**
- `core.ts`（33KB）职责混杂：密码学 + 限流 + 400 行 `formatPreview` + FTS 构造 + SQL 映射 + 资产同步 → 建议拆 `preview.ts`/`crypto.ts`/`rate-limit.ts`/`notes-sql.ts`
- `mcp.ts:374-872`：`createNoteMcpServer` 单函数约 500 行
- 常量重复且**值不一致**：`routes/auth.ts:36-41` 与 `core.ts:108-128`；`routes/assets.ts:23-24` 与 `core.ts:127-128` 取值不同（3600 vs 60）
- `routes/export.ts:5` 复制了 `core.ts:859` 的 `ASSET_REFERENCE_PATTERN`；`note-links.ts:18-20` 复制了 `core.ts:141` 的 `all()`
- `scripts/migrate.ts` 与 `server/migrate.ts` 内容完全一致（仅 import 路径不同）
- 死代码：`core.ts:111` `PASSWORD_ITERATIONS` 未使用（实际硬编码在 :176）；`zip.ts:208-313` `createZip`/`crc32` 全仓无引用
- `routes/notes.ts:270-779`：`handleNotesRoute` 约 500 行 if 链

**前端**
- `use-virtual-note-list.ts:164-169`：`rowStyle(top)` 每次返回新对象 → `NoteListRow` 的 memo 失效，列表重渲染会重渲全部可见行
- `use-virtual-note-list.ts:52-56`：`heightsRef`/`rowRefCallbacksRef` 只在 scope 变化时清空，删除笔记后测量值长期滞留
- `dialogs.tsx:93-98` + `share.tsx:42,45`：复制反馈的 `setTimeout` 未清理，卸载后悬挂定时器对已卸载组件 setState
- `command-menu.tsx:274-312`：effect 依赖含未 memo 的 `execute` → 每次渲染重挂 keydown 监听
- `editor.tsx:222-224,249-274,294-299`：多处「渲染阶段直接写 ref」，并发渲染/StrictMode 下非幂等
- `editor.tsx:39`：编辑器跨层 import `./workspace/panels`，边界不清
- `relativeDate` 三处重复实现（`editor.tsx:1435`、`backlinks-panel.tsx:8`、`workspace/helpers.ts:121`）；`NOTE_TAG_DISPLAY_LIMIT` 两处定义
- `styles.css:2714-2742`：`prefers-reduced-motion` 的 `animation: none` 清单漏了 `.slash-command-menu`、`.wiki-link-suggestion-dropdown`、`.card-editor-in`
- `workspace.tsx:1271`：`aria-hidden="true"` 的 `<button>` 遮罩，键盘用户无法关闭移动抽屉
- `editor/image-node.tsx:87-98`：图片缩放手柄的 Escape 未做 `isComposing`/`keyCode 229` 保护（其余 12 处都做了）
- `floating-scrollbar.tsx:95-96`：未传 `contentRef` 时挂 `characterData` 的 MutationObserver，文本每次更新都触发度量

**工程化 / 测试**
- `scripts/preview.ts` 未被任何脚本引用，`preview` 实际指向 `start`（死文件）
- `Dockerfile:1`：未固定 `oven/bun:alpine` 版本/digest，构建不可复现
- `.dockerignore` 未排除 `docs/`、`electron/`、`scratch/`、`.workbuddy/`、其它 `*.md`
- `.github/workflows/docker.yml:8-11`：`tags: "**"` 任意 tag 都触发 GHCR 发布 → 收窄为 `v*.*.*`
- `tsconfig.json`：`strict: true` 已开，但未开 `noUncheckedIndexedAccess`、`noUnusedLocals/Parameters`、`exactOptionalPropertyTypes`
- `tests/card-view.test.ts:130-156`：直接断言 CSS 字面量（阴影 rgba、grid-template-columns），任何视觉微调都会红 → 改断言语义契约
- `tests/ime-markdown-safe.test.ts:37,48`：用 `Bun.sleep(40)` 做时序断言，CI 慢机器有 flake 风险
- 覆盖缺口：`scripts/`（build-client 的 sw 预缓存替换、migrate）无测试

**MCP**
- `mcp.ts:492-493`：`if (confirm !== true)` 分支不可达（`z.literal(true)` 已在 schema 层拦掉），测试也未覆盖该错误码 → 改成 `z.boolean()` 让业务错误码真正生效（对 agent 更友好）
- `mcp.ts:192-202` vs `core.ts:312-712`：摘要截断两套实现（core 按 180 字、MCP `previewAtLength` 再截一次），边界行为可能不一致
- `mcp.ts:22` vs `core.ts:120`：`NOTE_CONTENT_MAX_LENGTH` 在 mcp.ts 重新定义了一份，core 改了 MCP 不跟随
- `mcp.ts:592`：`update_note` 描述只引导了 replace/append，没说「标签用 `set_tags`、收藏用 `toggle_favorite`」，而其 schema 硬拒这两个字段
- `mcp.ts:528`：`get_notes_batch` 的 `limit` 默认 20 但 `noteIds` 允许 50 → 传 50 个 ID 只回 20 篇，默认应改为 `min(length, 50)`
- `mcp.ts:1073`：`scopes: ["notes:read","notes:write"]` 是装饰性的，单静态 token 全权，无只读档位
- 命名：`delete_note` 名不副实（实为软删除）→ 建议 `trash_note` 保留别名；`empty_trash` 名字读不出永久性
- `mcp.ts:749` vs `617`：`insert_into_note.anchor` 上限 2,000 字 vs `replace_in_note.oldText` 上限 1,000,000 字，同为片段查找差 500 倍
- `mcp.ts:357`：`matches.length !== 1 || (...)` 第二个子句逻辑冗余（疑似）
- 测试缺口：`DUPLICATE_NOTE_ID`、`OCCURRENCE_NOT_FOUND`、`list_trash` cursor 分页、`UNAUTHENTICATED`、`CONFIRMATION_REQUIRED`、`NOTE_TOO_LARGE` 的 MCP 改写分支

---

## 五、AGENTS.md 规范符合度核对（前端）

| 规范 | 结论 | 依据 |
|---|---|---|
| bun build + React + TS，无 Vite | ✅ 已落实 | `package.json:9` |
| Safari 优先 | ⚠️ 部分 | `-webkit-backdrop-filter` 兜底 ✅、`@supports (display: grid-lanes)` ✅；`closedby="any"` ❌ |
| Markdown 为准，大纲/统计不入库 | ✅ | `outlineItems` 仅为 state，`editor-metrics.ts:189-194` 的 id 不提交 |
| 视觉系统（暖白/军绿/朱砂） | ✅ | `styles.css:115-126`、`.note-prose h1` 用 `--h1-color` |
| 去死灰硬边框 / 半透明淡墨微线 | ✅ | `--line`、`--border-soft`，`.note-row` 用 `border: transparent` |
| 微阴影阶梯 + 圆角 9/13/20px | ✅ | `styles.css:115-117` 逐值一致 |
| 卡片式浮动手记行（`calc(100% - 16px)`） | ✅ | `styles.css:425-431` |
| 出版物排版（行高 1.74 / 字距 0.012em / 段距 0.88em） | ✅ | `styles.css:580,602` |
| 顶栏 62px + `blur(14px)` | ✅ | `styles.css:300,308-309,486-487` |
| 弹窗遮罩 `blur(8px)` + 圆角 18-20px | ✅ | `styles.css:997-998,1444-1445` |
| 瀑布流内禁全局 transform，用 `scale: 1.015` | ✅ | `styles.css:2357-2385` |
| 顶栏状态只显示固定尺寸图标 | ✅ | `editor.tsx:1332-1341` |
| `min-width: 0`，图标按钮不被压缩 | ✅ | `styles.css:146,422,436,482`；`.icon-button` 固定 36×36 |
| **所有局部滚动容器用 `FloatingScrollbar`** | ❌ 未落实 | `panels.tsx:26` 唯一漏网（其余 11 处正确） |
| **Escape 不被 `defaultPrevented` 阻断** | ✅ | 6 处 handler 均无 `defaultPrevented` 早退 |
| Escape 5 层优先级 | ⚠️ 部分 | 2-5 层 ✅；第 1 层搜索高亮清除缺位 + 双层穿透 |
| IME 保护（`isComposing` / `keyCode 229`） | ✅ | 12 处已做，仅 `image-node.tsx:88` 缺 |
| 动效时长阶梯 + `--motion-ease-out` | ✅ | `styles.css:118-126` |
| 弹窗 `dialog-in` / `toast-in-top` / `outlineFadeIn` | ✅ | `styles.css:1011,1478,2614` |
| `:active` 微缩放 0.94~0.992 | ✅ | `styles.css:216,221,225,438,383` |
| 只动画 transform/opacity，禁 transition grid-template-columns | ✅ | 全部静态声明 |
| `prefers-reduced-motion` 降级 | ⚠️ 部分 | 变量归零 ✅；`animation:none` 清单漏 3 个选择器 |
| 模块化拆分 / `use*.ts` / 无 `utils.ts` | ✅ | 全仓无 `utils.ts`，命名均有职责 |
| 懒加载 | ✅ | `app.tsx:5-8`、`workspace.tsx:27`、`share.tsx:8` |
| 不逐键复制 Markdown | ✅ | `editor.tsx:856-864` 只置 dirty 标记，防抖后才 `getMarkdown()` |
| 保存队列单草稿 + 成功后释放 | ✅ | `use-note-save-queue.ts:126,80-81,88` |
| Tiptap 扩展/配置稳定化 | ✅ | `editor.tsx:479-501,624-808` 均为 `useMemo(…, [])` |
| 卸载清理定时器/动画帧/编辑器 | ⚠️ 部分 | 11 处已清理；`dialogs.tsx:93-98`、`share.tsx:42,45` 漏 |
| 统计/预览单次遍历且有界 | ✅ | `WeakMap<ProseMirrorNode, EditorStats>` 缓存未变更块 |

**服务端规范**
| 规范 | 结论 |
|---|---|
| 全部 prepared statements | ✅ 未见拼接 |
| 版本乐观锁 409 `VERSION_CONFLICT` | ✅（仅批量/提及用了其它码，见 P2） |
| `notes_fts` 外部内容表 + 触发器 | ✅ `0001_baseline.sql:70-89` |
| `auto_vacuum = INCREMENTAL` | ✅ `db.ts:49-53` |
| freelist 复用，删除不截断 | ✅ |
| 已有库不自动迁移 + `schema_migrations` 幂等 | ✅ `db.ts:62-64,80-91` |
| 私有 API 归属校验 | ✅ 逐条核查无遗漏 |
| 分享令牌哈希存储 + 7 天有效期 + 30 天清理 | ✅ |
| 生产错误统一 JSON，堆栈只进日志 | ✅ `index.ts:238-243` |

---

## 六、建议修复顺序

| 批次 | 内容 | 理由 |
|---|---|---|
| **第 1 批** | P0 #1（delete_notebook 护栏）、#2（附件清理大小写）、#3（Docker DATABASE_PATH）、#4（COOKIE_SECURE） | 全部涉及不可逆损失或安全降级 |
| **第 2 批** | MCP P1 #20（tags 三义性）、#21（回收站检索）、#22（version 不必拉全文）、#18/#19（movedCount / version 失效提示） | 直接决定 agent 会不会误改用户数据、能不能少走往返 |
| **第 3 批** | 前端 P1 #5/#6（Escape 双层）、#7（FloatingScrollbar）、#8（重渲染）、#9（MutationObserver）、#10（Safari） | 用户可感知，且 #7 是规范明文要求 |
| **第 4 批** | 工程化 #14~#17（依赖声明、.gitignore、提交前缀） | 成本低，小时级 |
| **第 5 批** | P2 中「重复实现 / 死代码 / core.ts 拆分」 | 技术债，可排期 |

---

## 七、修复落地情况（2026-09-30）

按主题拆成 12 个提交，全部通过 `bun run typecheck`、`bun test`（278 pass）、`bun run build`：

| 提交 | 覆盖问题 |
|---|---|
| `fix: 修复反向代理会话保护、PUBLIC_URL 容错与非 JSON 请求体` | P0 #4、P1 #11、P2（readJson Content-Type） |
| `fix: 修复孤儿附件清理大小写敏感导致引用中的图片被误删` | P0 #2、P2（Content-Length） |
| `fix: 为已有数据库补充迁移落后提示并减少日志噪音` | P2（db.ts 两项） |
| `fix: 删除笔记本时回传迁移数量并提示版本失效` | P1 #13、#18、#19 的服务端部分 |
| `fix: 修正笔记写入校验、并发创建、分页边界与冲突错误码` | P1 #12、P2（类型校验 / offset / 错误码 / 标签对账 N+1） |
| `feat: 为 MCP 危险操作增加确认护栏并统一错误码与标签语义` | P0 #1、P1 #18–#28 及 MCP 的 P2 主体 |
| `test: 补充 MCP 护栏、回收站检索与标签语义用例` | P2（测试缺口） |
| `chore: 清理重复实现与死代码` | P2（zip / export / auth / note-links / scripts 重复） |
| `chore: 显式声明 @tiptap/pm 与 marked 依赖并修复 preview 脚本` | P1 #14、P2（preview 死文件） |
| `docs: 修正 Docker 数据卷、升级迁移与 MCP 工具说明` | P0 #3、README 不一致 1–5 |
| `ci: 收窄镜像发布触发条件并忽略会话目录` | P1 #15、P2（docker.yml / dockerignore） |
| `fix: 修复前端 Escape 逐层退出、滚动条缺失与编辑器重渲染等问题` | 前端 F1–F15（P1 #5–#10 + 前端 P2 全部） |

### 行为变更（需要知晓）

1. `delete_notebook` 现在**必须**传 `confirm: true`，否则被 schema 拒绝——现有 agent 调用会报错，需同步更新。
2. 错误码收敛：MCP 侧 `AMBIGUOUS_TITLE` / `AMBIGUOUS_TEXT_MATCH` / `AMBIGUOUS_ANCHOR` → `AMBIGUOUS_MATCH`（带 `target`）；`TEXT_NOT_FOUND` / `ANCHOR_NOT_FOUND` / `OCCURRENCE_NOT_FOUND` → `NOT_FOUND`（带 `target`）。REST 侧 `BATCH_VERSION_CONFLICT` → `VERSION_CONFLICT`。
3. `insert_into_note` 的匹配改为**非重叠**计数，与 `replace_in_note` 一致（此前 `overlapping: true`）。
4. `get_notes_batch` 省略 `limit` 时改为取 `min(noteIds.length, 50)`，不再默认只回 20 篇。
5. `batch_update_notes` 部分失败不再整体标记 `isError`，改为 `partial: true` + 逐条结果。
6. `empty_trash` 的 `confirm` 由 `z.literal(true)` 改为 `z.boolean()`，业务错误码 `CONFIRMATION_REQUIRED` 现在真正可达。
7. `set_tags` 新增可选 `mode`（默认 `replace` 保持不变），`add` / `remove` 提供安全路径。
8. 前端 `relativeDate` 内部复用共享实现，个别语言环境下的措辞可能有细微变化（测试已覆盖常见分支）。

### 未修复项与原因

| 项 | 原因 |
|---|---|
| `server/core.ts`（33KB）、`server/mcp.ts` 的 500 行注册函数、`routes/notes.ts` 的 500 行 if 链拆分 | 属于架构重构而非缺陷修复，改动面大且需要专门的回归验证，建议单独一次重构提交 |
| `delete_note` 改名 `trash_note` | 破坏性改名，且工具数会膨胀；已改为在 description 中明确"只移入回收站、可恢复" |
| MCP `scopes` 只读档位 | 需要新增只读 token 配置（新功能），不是修复 |
| `invalidCookieMutationOrigin` 在 Origin 与 Sec-Fetch-Site 双缺失时收紧 | 会破坏无 Origin 的非浏览器客户端；当前由 `SameSite=Lax` 兜底 |
| `includeTotal` 默认关闭、标签对账缓存 TTL | 需先确认前端对 `total` 的依赖，避免影响列表显示 |
| Docker 镜像固定 tag/digest | AGENTS.md 明确要求基于最新 `oven/bun:alpine` |
| tsconfig 追加 `noUncheckedIndexedAccess` 等 | 改动面很大，需分批推进并逐个修类型 |
| `tests/card-view.test.ts` 的 CSS 字面量断言 | 是视觉基线，需先与前端确定语义契约再改 |
| `scripts/`（build-client、migrate）测试覆盖 | 属于新测试，可排期 |
| `previewAtLength` 与 `formatPreview` 的重复截断 | 边界行为一致，收益低于改动风险 |
| `replace_in_note.oldText` 与 `insert_into_note.anchor` 上限不一致 | 有意为之：oldText 可能需要匹配长片段，保留差异 |

---

## 八、值得肯定的地方

- **测试隔离做得干净**：27 个测试文件全部用 `:memory:` 或 tmpdir 随机库，附件目录随机且 `afterEach` 递归删除，运行前后 `data/` 无变化——这是很多项目做不到的。
- **Escape 的两个已知深坑处理完整**：ProseMirror `keyCode 27` 的 `defaultPrevented` 阻断、中文输入法 `isComposing`/`keyCode 229` 保护，在 12 处 handler 里都落实了。
- **内存主线落实良好**：不逐键复制 Markdown、单草稿队列、扩展 `useMemo(…, [])` 稳定化、`WeakMap` 缓存统计块。
- **MCP schema 全部 `.strict()`**，20 个工具无一例外，`empty_trash` 用 `z.literal(true)` 做编译期闸门，`VERSION_CONFLICT` 回传 current 全文支持自愈——设计成熟度高于同类 server。
- **MCP 层没有绕过 version 或所有权校验**：写操作全部收口到 REST 路由，`user_id` 在 SQL 层强制。
