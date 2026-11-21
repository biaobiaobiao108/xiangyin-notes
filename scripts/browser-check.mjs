import assert from "node:assert/strict";
import { cp, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadPlaywright, login, startApp } from "./browser-support.mjs";

const { chromium, webkit } = await loadPlaywright();
const editorSelector = '[contenteditable="true"][aria-label="笔记正文"]';
const memoSelector = '[contenteditable="true"][aria-label="新建随记"]';
const titleSelector = '[aria-label="笔记标题"]';

function checkPage(page, errors) {
  page.on("pageerror", (error) => errors.push(error));
  return page;
}

async function createNote(api, baseUrl, data) {
  const response = await api.post(baseUrl + "/api/notes", { data });
  assert.ok(response.ok(), await response.text());
  return (await response.json()).note;
}

async function readNote(api, baseUrl, id) {
  const response = await api.get(baseUrl + "/api/notes/" + id);
  assert.ok(response.ok(), await response.text());
  return (await response.json()).note;
}

async function openNote(page, baseUrl, note) {
  await page.goto(baseUrl + "/app?note=" + note.id);
  await page.waitForFunction(
    ({ selector, title }) => document.querySelector(selector)?.value === title,
    { selector: titleSelector, title: note.title },
  );
  await page.locator(editorSelector).waitFor();
}

async function placeCaretAtEnd(editor) {
  await editor.evaluate((element) => {
    element.focus();
    const selection = element.ownerDocument.getSelection();
    const lastBlock = element.lastElementChild ?? element;
    selection.collapse(lastBlock, lastBlock.childNodes.length);
  });
}

async function checkEditing(browser, app, errors) {
  const context = await browser.newContext({ serviceWorkers: "block" });
  try {
    const page = checkPage(await context.newPage(), errors);
    await login(app, page);
    const markdown = "# 原始格式\n\n* 列表第一项 __粗体__\n* 列表第二项\n";
    const untouched = await createNote(context.request, app.url, {
      title: "打开时保留 Markdown 格式",
      contentMarkdown: markdown,
    });
    await openNote(page, app.url, untouched);
    const passiveEditor = page.locator(editorSelector);
    await passiveEditor.locator("li").last().click();
    await passiveEditor.press("ArrowDown");
    await page.waitForTimeout(1200);
    const afterOpen = await readNote(context.request, app.url, untouched.id);
    assert.equal(afterOpen.version, untouched.version);
    assert.equal(afterOpen.contentMarkdown, markdown);
    console.log("通过 · 打开笔记和移动光标保持原始 Markdown 与版本");

    const existing = await createNote(context.request, app.url, {
      title: "已有测试笔记",
      contentMarkdown: "原正文保持原样",
    });
    await openNote(page, app.url, existing);
    const other = checkPage(await context.newPage(), errors);
    await openNote(other, app.url, existing);

    // Hold creation long enough to observe the guard on the previous editor.
    const createPath = app.url + "/api/notes";
    let finishCreation;
    const holdCreation = new Promise((resolve) => {
      finishCreation = resolve;
    });
    await page.route(createPath, async (route) => {
      if (route.request().method() === "POST") await holdCreation;
      await route.continue();
    });
    const created = page.waitForResponse(
      (response) => response.url() === createPath && response.request().method() === "POST",
    );
    try {
      await page.getByRole("button", { name: "在收件箱中新建笔记", exact: true }).first().click();
      await page.locator(editorSelector).waitFor({ state: "hidden" });
    } finally {
      finishCreation();
    }
    const creation = await created;
    assert.ok(creation.ok(), await creation.text());
    const fresh = (await creation.json()).note;
    const editor = page.locator(editorSelector);
    await editor.fill("第一段写在新笔记");
    await page.locator(titleSelector).fill("新笔记浏览器回归");
    await placeCaretAtEnd(editor);
    await page.keyboard.insertText("，切换前最后输入");
    const updated = page.waitForResponse(
      (response) =>
        response.url().startsWith(app.url + "/api/notes/" + fresh.id) &&
        response.request().method() === "PATCH" &&
        response.request().postDataJSON()?.contentMarkdown?.includes("切换前最后输入"),
    );
    await page.getByRole("button", { name: /已有测试笔记.*原正文保持原样/ }).click();
    assert.equal((await updated).status(), 200);
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.textContent === "原正文保持原样",
      editorSelector,
    );
    assert.equal(
      (await readNote(context.request, app.url, existing.id)).contentMarkdown,
      "原正文保持原样",
    );
    assert.match(
      (await readNote(context.request, app.url, fresh.id)).contentMarkdown,
      /第一段写在新笔记，切换前最后输入/,
    );
    await other.getByText("新笔记浏览器回归", { exact: true }).waitFor();
    console.log("通过 · 新建后输入、立即切换、跨标签页列表刷新");

    await openNote(page, app.url, existing);
    const conflictPath = app.url + "/api/notes/" + existing.id;
    let remoteWrite;
    await page.route(
      (url) => url.origin + url.pathname === conflictPath,
      async (route) => {
        if (route.request().method() === "PATCH") {
          remoteWrite ??= context.request.patch(conflictPath, {
            data: {
              version: route.request().postDataJSON().version,
              contentMarkdown: "另一端已保存的正文",
            },
          });
          await remoteWrite;
        }
        await route.continue();
      },
    );
    const conflict = page.waitForResponse(
      (response) =>
        response.url().startsWith(conflictPath) && response.request().method() === "PATCH",
    );
    await editor.fill("当前浏览器未提交的正文");
    const rejected = await conflict;
    assert.ok(remoteWrite, "保存请求应等待另一端的写入");
    const savedRemotely = await remoteWrite;
    assert.equal(savedRemotely.status(), 200, await savedRemotely.text());
    assert.equal(rejected.status(), 409, await rejected.text());
    await page.getByRole("button", { name: "重新载入最新版本" }).waitFor();
    assert.equal(await editor.innerText(), "当前浏览器未提交的正文");
    assert.equal(
      (await readNote(context.request, app.url, existing.id)).contentMarkdown,
      "另一端已保存的正文",
    );
    console.log("通过 · 真实 409 冲突保留双方正文");
  } finally {
    await context.close();
  }
}

async function checkMemos(browser, app, errors) {
  const context = await browser.newContext({
    serviceWorkers: "block",
    viewport: { width: 1440, height: 900 },
  });
  try {
    const memoPage = checkPage(await context.newPage(), errors);
    await login(app, memoPage);
    const openMemos = () => memoPage.getByRole("button", { name: "随记", exact: true }).click();
    await openMemos();
    const memo = memoPage.locator(memoSelector);
    await memo.fill("应可恢复并重试的随记");
    await memoPage.reload();
    await openMemos();
    await memo.getByText("应可恢复并重试的随记", { exact: true }).waitFor();
    await memoPage.getByText("已恢复未提交的随记草稿", { exact: true }).waitFor();

    const memoPath = app.url + "/api/memos";
    const failSave = (route) =>
      route.request().method() === "POST" ? route.abort() : route.continue();
    await memoPage.route(memoPath, failSave);
    await memo.click();
    await memoPage.getByRole("searchbox", { name: "搜索随记" }).click();
    await memoPage
      .getByRole("alert")
      .getByText(/随记未保存，草稿仍可编辑/)
      .waitFor();
    assert.equal(await memo.innerText(), "应可恢复并重试的随记");
    await memoPage.unroute(memoPath, failSave);
    await memo.click({ button: "right" });
    await memoPage.getByText("保存随记", { exact: true }).click();
    await memoPage.getByText("随记已保存", { exact: true }).waitFor();
    await memoPage.waitForFunction(
      (selector) => !document.querySelector(selector)?.textContent.trim(),
      memoSelector,
    );
    await memoPage.getByText("应可恢复并重试的随记", { exact: true }).waitFor();
    const card = memoPage.locator(".memo-card").filter({ hasText: "应可恢复并重试的随记" });
    const typography = (paragraph) =>
      paragraph.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          width: Math.round(element.getBoundingClientRect().width),
          size: style.fontSize,
          leading: style.lineHeight,
        };
      });
    const preview = card.locator(".note-prose p").first();
    const previewLayout = await typography(preview);
    await preview.dblclick();
    const edit = memoPage.locator('[contenteditable="true"][aria-label="编辑随记"]');
    assert.deepEqual(await typography(edit.locator("p").first()), previewLayout);
    await edit.fill("修改后的随记已经保存");
    await edit.press("Control+Enter");
    await edit.waitFor({ state: "hidden" });
    await memoPage.getByText("随记已保存", { exact: true }).waitFor();
    await memoPage
      .locator(".memo-card-content .note-prose")
      .getByText("修改后的随记已经保存", { exact: true })
      .waitFor();
    console.log("通过 · 随记刷新恢复、失焦失败保留草稿、菜单重试、编辑与预览排版一致");

    // The server commits the creation, but the client never receives its response.
    const retryDraft = "服务端已写入但浏览器未收到响应";
    const day = memoPage.locator(".memo-mini-day:not(.is-outside)").first();
    await day.click();
    await memo.fill(retryDraft);
    // Reopening the editor strips the trailing empty paragraph from its rendered document.
    await placeCaretAtEnd(memo);
    await memo.press("Enter");
    let originalSubmission;
    const loseResponse = async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      originalSubmission = route.request().postDataJSON();
      try {
        const response = await route.fetch();
        assert.equal(response.status(), 201);
      } finally {
        await route.abort();
      }
    };
    await memoPage.route(memoPath, loseResponse);
    await memo.press("Control+Enter");
    await memoPage
      .getByRole("alert")
      .getByText(/随记未保存，草稿仍可编辑/)
      .waitFor();
    await memoPage.unroute(memoPath, loseResponse);
    assert.equal(typeof originalSubmission?.createdAt, "number");
    assert.equal(originalSubmission.contentMarkdown, retryDraft + "\n\n");
    await memoPage.reload();
    await openMemos();
    await memo.getByText(retryDraft, { exact: true }).waitFor();
    const retried = memoPage.waitForResponse(
      (response) => response.url() === memoPath && response.request().method() === "POST",
    );
    await memo.press("Control+Enter");
    const replay = await retried;
    assert.equal(replay.status(), 200);
    assert.deepEqual(replay.request().postDataJSON(), originalSubmission);
    await memoPage.getByText("随记已保存", { exact: true }).waitFor();
    const { memos } = await (await context.request.get(memoPath)).json();
    assert.equal(memos.filter((item) => item.contentMarkdown.trimEnd() === retryDraft).length, 1);
    console.log("通过 · 随记响应丢失后刷新重试保留 ID 与创建时间");

    for (const [panel, region] of [
      ["任务", "任务"],
      ["看板", "看板视图"],
    ]) {
      await memoPage.getByRole("button", { name: panel, exact: true }).click();
      await memoPage
        .getByRole("region", { name: region, exact: true })
        .getByRole("button")
        .first()
        .waitFor();
    }
    console.log("通过 · 按需加载任务与看板");
  } finally {
    await context.close();
  }
}

async function checkKanbanMoves(browser, app, errors, status) {
  const context = await browser.newContext({ serviceWorkers: "block" });
  try {
    const page = checkPage(await context.newPage(), errors);
    await login(app, page);
    const notes = [];
    for (const title of ["看板首项", "拖放卡片", "排序参照", "看板末项"]) {
      notes.push(await createNote(context.request, app.url, { title, kanbanStatus: status }));
    }
    const [first, dragged, anchor, last] = notes;
    await page.getByRole("button", { name: "看板", exact: true }).click();
    const cardSelector = `[data-kanban-status="${status}"] [data-kanban-note-id]`;
    const cards = page.locator(cardSelector);
    const card = (note) => cards.filter({ hasText: note.title });
    const cardPath = app.url + "/api/kanban/cards/" + dragged.id;
    const waitForMove = () =>
      page.waitForResponse(
        (response) => response.url() === cardPath && response.request().method() === "PATCH",
      );
    const move = waitForMove();
    await card(dragged).dragTo(card(last), { targetPosition: { x: 24, y: 8 } });
    const moved = await move;
    assert.equal(moved.status(), 200);
    assert.equal(moved.request().postDataJSON().beforeNoteId, last.id);
    assert.equal(moved.request().postDataJSON().sortOrder, undefined);
    await page.waitForFunction(
      ({ selector, order }) =>
        [...document.querySelectorAll(selector)]
          .map((element) => element.getAttribute("data-kanban-note-id"))
          .join() === order,
      { selector: cardSelector, order: [first.id, anchor.id, dragged.id, last.id].join() },
    );

    await page.route(cardPath, async (route) => {
      const trashed = await context.request.patch(app.url + "/api/notes/" + dragged.id, {
        data: { version: dragged.version, deleted: true },
      });
      assert.ok(trashed.ok(), await trashed.text());
      await route.continue();
    });
    const lateMove = waitForMove();
    await card(dragged).dragTo(card(anchor), { targetPosition: { x: 24, y: 8 } });
    assert.equal((await lateMove).status(), 409);
    await page.getByText("卡片或排序位置已变化，正在刷新看板", { exact: true }).waitFor();
    await card(dragged).waitFor({ state: "hidden" });
    await card(anchor).waitFor();
    console.log(
      "通过 · " +
        browser.browserType().name() +
        " 看板同列拖放按参照排序，卡片移入回收站后拒绝迟到的拖放",
    );
  } finally {
    await context.close();
  }
}

async function makeNextClientBuild(clientRoot, nextRoot) {
  await cp(clientRoot, nextRoot, { recursive: true });
  const chunks = new Map();
  for await (const name of new Bun.Glob("chunk-*.js").scan({ cwd: clientRoot, onlyFiles: true })) {
    chunks.set(name, "chunk-" + crypto.randomUUID().slice(0, 8) + ".js");
  }
  const chunkPattern = /chunk-[a-z0-9]{8}\.js/g;
  for (const name of ["index.html", "sw.js", ...chunks.keys()]) {
    let source = (await Bun.file(join(clientRoot, name)).text()).replace(
      chunkPattern,
      (chunk) => chunks.get(chunk) ?? chunk,
    );
    if (name === "sw.js")
      source = source.replace(/xiangying-notes-shell-[a-z0-9]+/, "xiangying-notes-shell-next");
    const path = join(nextRoot, chunks.get(name) ?? name);
    await Bun.write(path, source);
    await Bun.write(path + ".gz", Bun.gzipSync(source));
    if (chunks.has(name)) {
      await rm(join(nextRoot, name));
      await rm(join(nextRoot, name + ".gz"));
    }
  }
  return chunks;
}

async function checkPwa(engine, app, clientRoot, nextRoot, oldChunks, errors) {
  const browser = await engine.launch();
  try {
    const context = await browser.newContext();
    const first = checkPage(await context.newPage(), errors);
    const second = checkPage(await context.newPage(), errors);
    await login(app, first);
    await first.waitForFunction(() => navigator.serviceWorker.controller?.state === "activated");
    const banner = (page) => page.getByText("发现新版本", { exact: true });
    assert.equal(await banner(first).isVisible(), false);
    await second.goto(app.url + "/app");
    await second.getByRole("button", { name: "在收件箱中新建笔记", exact: true }).first().waitFor();
    await second.waitForFunction(() => navigator.serviceWorker.controller?.state === "activated");
    assert.equal(await banner(second).isVisible(), false);

    const previousRoot = clientRoot + "-previous";
    await rename(clientRoot, previousRoot);
    try {
      await rename(nextRoot, clientRoot);
      await first.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
      await Promise.all([banner(first).waitFor(), banner(second).waitFor()]);
      await second.evaluate(() => {
        window.browserCheckTabStayedOpen = true;
      });
      await Promise.all([
        first.waitForEvent("framenavigated", (frame) => frame === first.mainFrame()),
        first.getByRole("button", { name: "更新", exact: true }).click(),
      ]);
      await first
        .getByRole("button", { name: "在收件箱中新建笔记", exact: true })
        .first()
        .waitFor();
      await Promise.all([
        banner(first).waitFor({ state: "hidden" }),
        banner(second).waitFor({ state: "hidden" }),
      ]);
      assert.equal(await second.evaluate(() => window.browserCheckTabStayedOpen), true);
      const lazyChunk = second.waitForResponse((response) =>
        oldChunks.has(new URL(response.url()).pathname.slice(1)),
      );
      await second.getByRole("button", { name: "看板", exact: true }).click();
      await second.getByRole("region", { name: "看板视图", exact: true }).waitFor();
      const oldChunk = await lazyChunk;
      assert.equal(oldChunk.status(), 200);
      assert.equal((await context.request.get(oldChunk.url())).status(), 404);
      console.log("通过 · " + engine.name() + " PWA 更新后旧标签页首次打开看板");
    } finally {
      if (await Bun.file(join(clientRoot, "index.html")).exists())
        await rename(clientRoot, nextRoot);
      await rename(previousRoot, clientRoot);
    }
  } finally {
    await browser.close();
  }
}

const directory = await mkdtemp(join(tmpdir(), "xiangyin-worker-check-"));
const errors = [];
try {
  const clientRoot = join(directory, "client");
  await cp(resolve("dist/client"), clientRoot, { recursive: true });
  const nextRoot = join(directory, "client-next");
  const oldChunks = await makeNextClientBuild(clientRoot, nextRoot);
  const app = await startApp({ clientRoot });
  try {
    const browser = await chromium.launch();
    try {
      await checkEditing(browser, app, errors);
      await checkMemos(browser, app, errors);
      await checkKanbanMoves(browser, app, errors, "doing");
    } finally {
      await browser.close();
    }
    const webkitBrowser = await webkit.launch();
    try {
      await checkKanbanMoves(webkitBrowser, app, errors, "done");
    } finally {
      await webkitBrowser.close();
    }
    await checkPwa(chromium, app, clientRoot, nextRoot, oldChunks, errors);
    await checkPwa(webkit, app, clientRoot, nextRoot, oldChunks, errors);
    assert.deepEqual(errors, []);
  } finally {
    await app.close();
  }
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 3 });
}
console.log("浏览器回归全部通过");
