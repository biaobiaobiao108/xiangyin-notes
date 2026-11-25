import assert from "node:assert/strict";
import { resolve } from "node:path";
import { loadPlaywright, startApp } from "./browser-support.mjs";

const { chromium } = await loadPlaywright();
const app = await startApp({ clientRoot: resolve(process.argv[2] ?? "dist/client") });
const browser = await chromium.launch();

const TITLE_SELECTOR = '[aria-label="笔记标题"]';
const EDITOR_SELECTOR = '[aria-label="笔记正文"][contenteditable="true"]';
const MEMO_SELECTOR = '[contenteditable="true"][aria-label="新建随记"]';

function attachErrorGuard(page, errors) {
  page.on("pageerror", (error) => errors.push(error));
  return page;
}

async function loginThroughUi(page, { waitForEditor = true } = {}) {
  await page.goto(`${app.url}/app`);
  await page.waitForURL(/\/login/);
  await page.getByLabel("用户名").fill(app.username);
  await page.getByLabel("密码", { exact: true }).fill(app.password);
  await page.getByRole("button", { name: "进入笔记" }).click();
  await page.waitForURL(/\/app/);
  if (waitForEditor) {
    await page.getByRole("complementary", { name: "主导航" }).waitFor();
    await page.locator(TITLE_SELECTOR).waitFor();
  }
}

const pageErrors = [];
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  serviceWorkers: "block",
  reducedMotion: "reduce",
});
let mobileContext = null;
let stage = "初始化";
const page = attachErrorGuard(await context.newPage(), pageErrors);

try {
  // 1. 登录并进入工作区
  stage = "1. 登录并进入工作区";
  await loginThroughUi(page);

  // 2. 新建笔记、中文输入法组合编辑与自动保存
  stage = "2. 新建笔记与中文输入法保存";
  const createPromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/notes" && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "在收件箱中新建笔记" }).click();
  const createResponse = await createPromise;
  assert.equal(createResponse.status(), 201);
  const created = (await createResponse.json()).note;

  const titleField = page.locator(TITLE_SELECTOR);
  await titleField.fill("E2E 端到端测试笔记");
  const editor = page.locator(EDITOR_SELECTOR);
  await editor.click();
  await editor.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    element.dispatchEvent(
      new CompositionEvent("compositionupdate", { bubbles: true, data: "zhongwen" }),
    );
    element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中文" }));
  });
  const savePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/notes/${created.id}` &&
      response.request().method() === "PATCH" &&
      response.status() === 200 &&
      (response.request().postDataJSON()?.contentMarkdown ?? "").includes("输入法保存验证"),
  );
  await page.keyboard.insertText("输入法保存验证 #端到端");
  await savePromise;

  stage = "2b. 刷新页面验证持久化";
  await page.goto(`${app.url}/app?note=${created.id}`);
  await page.waitForFunction(
    ({ selector, expected }) => document.querySelector(selector)?.value === expected,
    { selector: TITLE_SELECTOR, expected: "E2E 端到端测试笔记" },
  );
  await page.waitForFunction(
    ({ selector }) => document.querySelector(selector)?.textContent?.includes("输入法保存验证"),
    { selector: EDITOR_SELECTOR },
  );

  // 3. 离线断网状态感知与联网恢复自动同步
  stage = "3. 离线断网草稿保护与恢复同步";
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await page.locator(".toast--offline").waitFor();
  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" 离线草稿内容");
  await page.getByRole("button", { name: "重试保存" }).waitFor();

  const recoverySave = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/notes/${created.id}` &&
      response.request().method() === "PATCH" &&
      response.status() === 200,
  );
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  assert.equal((await recoverySave).status(), 200);
  await page.locator(".toast--offline").waitFor({ state: "detached" });

  // 4. 版本冲突检测与确认重新载入
  stage = "4. 版本冲突检测与确认重载";
  const latestResp = await context.request.get(`${app.url}/api/notes/${created.id}`);
  assert.equal(latestResp.status(), 200);
  const latestNote = (await latestResp.json()).note;

  await editor.click();
  const conflictSave = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/notes/${created.id}` &&
      response.request().method() === "PATCH" &&
      response.status() === 409,
  );
  await page.keyboard.insertText(" 本地冲突内容");
  const remoteUpdate = await context.request.patch(`${app.url}/api/notes/${created.id}`, {
    data: {
      version: latestNote.version,
      contentMarkdown: "远端已更新的正文内容",
    },
  });
  assert.equal(remoteUpdate.status(), 200);
  assert.equal((await conflictSave).status(), 409);

  await page.getByRole("button", { name: "重新载入最新版本" }).click();
  const reloadNoteResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/notes/${created.id}` &&
      response.request().method() === "GET" &&
      response.status() === 200,
  );
  await page.getByRole("button", { name: "重新载入", exact: true }).click();
  assert.equal((await reloadNoteResponse).status(), 200);
  await page.waitForFunction(
    ({ selector }) =>
      document.querySelector(selector)?.textContent?.includes("远端已更新的正文内容"),
    { selector: EDITOR_SELECTOR },
  );

  // 5. 全局搜索定位
  stage = "5. 全局搜索定位";
  const searchInput = page.locator('aside.sidebar input[aria-label="全局搜索笔记或标签"]');
  await searchInput.fill("远端已更新的正文内容");
  await searchInput.press("Enter");
  await page.locator(".note-row", { hasText: "E2E 端到端测试笔记" }).waitFor();
  await page.getByRole("button", { name: "清空搜索" }).click();

  // 6. 随记发布与标签筛选
  stage = "6. 随记发布与标签筛选";
  await page.getByRole("button", { name: "随记" }).click();
  const memoComposer = page.locator(MEMO_SELECTOR);
  await memoComposer.waitFor();
  await memoComposer.click();
  await page.keyboard.insertText("随记验证条目 #随记测试");
  const memoCreate = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/memos" && response.request().method() === "POST",
  );
  await page.keyboard.press("ControlOrMeta+Enter");
  assert.equal((await memoCreate).status(), 201);
  await page.getByText("随记验证条目").waitFor();
  await page.locator('.memo-tag-section [data-tag="随记测试"]').click();
  await page.getByText("随记验证条目").waitFor();

  // 7. 看板新建卡片与跨列拖拽
  stage = "7. 看板新建卡片与跨列拖拽";
  await page.getByRole("button", { name: "看板" }).click();
  await page.getByRole("region", { name: "看板视图" }).waitFor();
  const kanbanCreate = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/notes" && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "在收集箱新建笔记" }).click();
  const kanbanCreateResponse = await kanbanCreate;
  assert.equal(kanbanCreateResponse.status(), 201);
  const kanbanNoteId = (await kanbanCreateResponse.json()).note.id;

  const sourceCard = page.locator(`[data-kanban-note-id="${kanbanNoteId}"]`);
  const doingColumn = page.locator('[data-kanban-status="doing"]');
  await sourceCard.waitFor();
  const moveCard = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/kanban/cards/${kanbanNoteId}` &&
      response.request().method() === "PATCH",
  );
  await sourceCard.dragTo(doingColumn);
  assert.equal((await moveCard).status(), 200);
  await doingColumn.locator(`[data-kanban-note-id="${kanbanNoteId}"]`).waitFor();

  // 8. 斜杠命令插入任务、任务面板勾选与编辑器联动
  stage = "8. 斜杠命令与任务面板联动";
  await page.locator('aside.sidebar button:has-text("全部笔记")').click();
  const taskNoteCreate = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/notes" && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "在收件箱中新建笔记" }).click();
  const taskNoteCreateResponse = await taskNoteCreate;
  assert.equal(taskNoteCreateResponse.status(), 201);
  const taskNoteId = (await taskNoteCreateResponse.json()).note.id;

  await titleField.fill("E2E 任务测试笔记");
  await editor.click();
  await page.keyboard.type("/todo");
  await page.locator('.slash-command-menu [role="option"]:has-text("任务清单")').waitFor();
  const taskNoteSave = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/notes/${taskNoteId}` &&
      response.request().method() === "PATCH" &&
      response.status() === 200 &&
      (response.request().postDataJSON()?.contentMarkdown ?? "").includes("E2E 任务联动验证"),
  );
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("E2E 任务联动验证");
  await taskNoteSave;

  const tasksLoad = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/tasks" && response.request().method() === "GET",
  );
  await page.locator('aside.sidebar button:has-text("任务")').click();
  assert.equal((await tasksLoad).status(), 200);
  const taskCompleteSave = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/tasks/toggle" &&
      response.request().method() === "POST" &&
      response.status() === 200,
  );
  await page.getByRole("checkbox", { name: "标记为已完成：E2E 任务联动验证" }).click();
  await taskCompleteSave;
  const doneTasksLoad = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/tasks" && response.request().method() === "GET",
  );
  await page.getByRole("button", { name: "筛选任务状态" }).click();
  await page.locator('#tasks-status-filter-menu [role="menuitemradio"]:has-text("已完成")').click();
  assert.equal((await doneTasksLoad).status(), 200);
  await page.getByRole("checkbox", { name: "标记为未完成：E2E 任务联动验证" }).waitFor();
  await page
    .getByRole("button", { name: "打开笔记 E2E 任务测试笔记 并定位任务：E2E 任务联动验证" })
    .click();
  await page.waitForFunction(
    ({ selector, expected }) => document.querySelector(selector)?.value === expected,
    { selector: TITLE_SELECTOR, expected: "E2E 任务测试笔记" },
  );
  assert.equal(await editor.locator('input[type="checkbox"]').first().isChecked(), true);

  // 9. 卡片网格视图与双栏分屏对照
  stage = "9. 卡片视图与双栏分屏";
  await page.locator('aside.sidebar button:has-text("全部笔记")').click();
  await page.locator(`.note-list-panel [data-note-id="${taskNoteId}"] .note-row`).click();
  await page.keyboard.press("Alt+v");
  await page.locator(".app-shell.layout-cards .note-card-grid-panel").waitFor();
  await page.locator(`.note-card[data-note-id="${taskNoteId}"]`).click();
  await page.getByRole("button", { name: "分屏显示" }).click();
  await page.locator('[aria-labelledby="split-note-dialog-title"]').waitFor();
  await page
    .locator(
      '[aria-labelledby="split-note-dialog-title"] [role="option"]:has-text("E2E 端到端测试笔记")',
    )
    .click();
  await page.waitForFunction(
    () => document.querySelectorAll('[aria-label="笔记编辑器"]').length === 2,
  );
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll('[aria-label="笔记正文"][contenteditable="true"]')).some(
      (el) => el.textContent?.includes("远端已更新的正文内容"),
    ),
  );
  await page.keyboard.press("Escape");
  await page.locator(".app-shell.layout-cards .note-card-grid-panel").waitFor();
  await page.locator(`.note-card[data-note-id="${taskNoteId}"]`).focus();
  await page.keyboard.press("Alt+v");
  await page.locator(".note-list-panel").waitFor();

  // 10. 移入回收站与立即恢复
  stage = "10. 移入回收站与恢复";
  await page.locator(`.note-list-panel [data-note-id="${taskNoteId}"] .note-row`).click();
  await page.waitForFunction(
    ({ selector, expected }) => document.querySelector(selector)?.value === expected,
    { selector: TITLE_SELECTOR, expected: "E2E 任务测试笔记" },
  );
  const trashSave = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/notes/${taskNoteId}` &&
      response.request().method() === "PATCH" &&
      response.status() === 200,
  );
  await page.getByRole("button", { name: "移入回收站" }).click();
  await trashSave;
  await page.locator('aside.sidebar button:has-text("回收站")').click();
  await page.locator(`.note-list-panel [data-note-id="${taskNoteId}"] .note-row`).click();
  await page.locator(".trashed-banner").waitFor();
  const restoreSave = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/notes/${taskNoteId}` &&
      response.request().method() === "PATCH" &&
      response.status() === 200,
  );
  await page.getByRole("button", { name: "立即恢复" }).click();
  await restoreSave;
  await page.locator(".trashed-banner").waitFor({ state: "detached" });

  // 11. 移动端视口导航、编辑与浏览器返回栈
  stage = "11. 移动端视口导航与返回栈";
  mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    serviceWorkers: "block",
    reducedMotion: "reduce",
  });
  const mobilePage = attachErrorGuard(await mobileContext.newPage(), pageErrors);
  await loginThroughUi(mobilePage, { waitForEditor: false });
  await mobilePage.locator("#mobile-notebooks-title").waitFor();
  await mobilePage.locator('nav[aria-label="笔记分类"] button:has-text("全部笔记")').click();
  await mobilePage.locator('.app-shell[data-mobile-page="list"]').waitFor();
  await mobilePage.locator('.note-row:has-text("E2E 端到端测试笔记")').first().click();
  await mobilePage.locator('.app-shell[data-mobile-page="editor"]').waitFor();
  await mobilePage.waitForFunction(
    ({ selector, expected }) => document.querySelector(selector)?.value === expected,
    { selector: TITLE_SELECTOR, expected: "E2E 端到端测试笔记" },
  );
  await mobilePage.locator("button.mobile-editor-back").click();
  await mobilePage.locator('.app-shell[data-mobile-page="list"]').waitFor();
  await mobilePage.goBack();
  await mobilePage.locator('.app-shell[data-mobile-page="home"]').waitFor();
  await mobilePage.locator("#mobile-notebooks-title").waitFor();

  assert.equal(pageErrors.length, 0, `Uncaught page errors: ${pageErrors.map(String).join("; ")}`);
  console.log("Browser E2E passed (11 scenarios, 0 page errors).");
} catch (error) {
  const titleVal = await page
    .locator(TITLE_SELECTOR)
    .inputValue()
    .catch(() => "<missing>");
  const editorText = await page
    .locator(EDITOR_SELECTOR)
    .innerText()
    .catch(() => "<missing>");
  throw new Error(
    `E2E 阶段「${stage}」失败 (url=${page.url()}, title=${JSON.stringify(titleVal)}, editor=${JSON.stringify(editorText.slice(0, 120))})`,
    { cause: error },
  );
} finally {
  if (mobileContext) await mobileContext.close();
  await context.close();
  await browser.close();
  await app.close();
}
