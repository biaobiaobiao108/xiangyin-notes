import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
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

async function checkEditing(browser, app, errors) {
  const context = await browser.newContext({ serviceWorkers: "block" });
  try {
    const page = checkPage(await context.newPage(), errors);
    await login(app, page);
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
    await editor.press("End");
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
  const context = await browser.newContext({ serviceWorkers: "block" });
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

async function checkPwa(engine, app, clientRoot, errors) {
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

    const worker = join(clientRoot, "sw.js");
    const original = await Bun.file(worker).text();
    const updated = original + "\n// browser check " + crypto.randomUUID() + "\n";
    try {
      await Bun.write(worker, updated);
      await Bun.write(worker + ".gz", Bun.gzipSync(updated));
      // Check a real change to the worker served by the production app.
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
      console.log("通过 · " + engine.name() + " 首次安装、更新激活、其他标签页清除提示");
    } finally {
      await Bun.write(worker, original);
      await Bun.write(worker + ".gz", Bun.gzipSync(original));
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
  const app = await startApp({ clientRoot });
  try {
    const browser = await chromium.launch();
    try {
      await checkEditing(browser, app, errors);
      await checkMemos(browser, app, errors);
    } finally {
      await browser.close();
    }
    await checkPwa(chromium, app, clientRoot, errors);
    await checkPwa(webkit, app, clientRoot, errors);
    assert.deepEqual(errors, []);
  } finally {
    await app.close();
  }
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 3 });
}
console.log("浏览器回归全部通过");
