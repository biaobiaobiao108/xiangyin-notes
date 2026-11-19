import assert from "node:assert/strict";
import { resolve } from "node:path";
import { loadPlaywright, startApp } from "./browser-support.mjs";

const { chromium } = await loadPlaywright();
const app = await startApp({ clientRoot: resolve(process.argv[2] ?? "dist/client") });
const browser = await chromium.launch();
const editor = '[aria-label="笔记正文"][contenteditable="true"]';

function fixture(targetBytes) {
  const section = (index) =>
    [
      "## 随访记录 " + index,
      "",
      "记录中文段落、**加粗**、[资料链接](https://example.com)和行内代码 \`query\`。",
      "",
      "会前整理要点并补上资料出处，方便下次打开笔记时接着写。".repeat(9),
      "",
      "- [ ] 复查内容",
      "- 补充其余上下文",
      "",
      ...(index % 6 === 0
        ? [
            "| 主题 | 状态 |",
            "| --- | --- |",
            "| 整理过程 | 待更新 |",
            "",
            "```text",
            "status=pending",
            "```",
            "",
          ]
        : []),
    ].join("\n") + "\n";
  const blocks = [];
  let bytes = 0;
  while (bytes < targetBytes) {
    const block = section(blocks.length + 1);
    blocks.push(block);
    bytes += Buffer.byteLength(block);
  }
  return { text: blocks.join(""), bytes, lastHeading: "随访记录 " + blocks.length };
}

function median(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return Math.round(sorted[Math.floor(sorted.length / 2)]);
}

const context = await browser.newContext({ serviceWorkers: "block", reducedMotion: "reduce" });
try {
  const login = await context.request.post(app.url + "/api/auth/login", {
    data: { username: app.username, password: app.password },
  });
  assert.ok(login.ok(), await login.text());
  const storageState = await context.storageState();
  for (const targetBytes of [50_000, 250_000]) {
    const data = fixture(targetBytes);
    const create = await context.request.post(app.url + "/api/notes", {
      data: { title: "长文基准 " + data.bytes, contentMarkdown: data.text },
    });
    assert.ok(create.ok(), await create.text());
    const { note } = await create.json();
    const samples = [];
    for (let run = 0; run < 3; run++) {
      const cold = await browser.newContext({
        storageState,
        serviceWorkers: "block",
        reducedMotion: "reduce",
      });
      let stage = "打开正文";
      try {
        const page = await cold.newPage();
        await page.goto(app.url + "/app?note=" + note.id, { waitUntil: "commit" });
        await page.waitForFunction(
          ({ selector, heading }) =>
            Array.from(document.querySelectorAll(selector + " h2")).at(-1)?.textContent === heading,
          { selector: editor, heading: data.lastHeading },
        );
        const ready = await page.evaluate(() => ({
          openMs: performance.now(),
          bytes: performance
            .getEntriesByType("resource")
            .filter((entry) => /\.(?:js|css)$/.test(new URL(entry.name).pathname))
            .reduce((total, entry) => total + entry.encodedBodySize, 0),
        }));

        stage = "大纲定位";
        await page.getByRole("button", { name: "打开笔记大纲" }).click();
        const item = page.getByRole("button", { name: data.lastHeading, exact: true });
        await item.waitFor();
        await item.evaluate((button, headingText) => {
          window.outlineStart = 0;
          button.addEventListener(
            "click",
            () => {
              window.outlineStart = performance.now();
            },
            { once: true },
          );
          window.benchHeading = [...document.querySelectorAll('[aria-label="笔记正文"] h2')].find(
            (heading) => heading.textContent === headingText,
          );
        }, data.lastHeading);
        await item.click();
        const jump = await page.waitForFunction(() => {
          const bounds = window.benchHeading.getBoundingClientRect();
          const shell = window.benchHeading.closest(".editor-scroll")?.getBoundingClientRect();
          return (
            window.outlineStart &&
            bounds.top >= (shell?.top ?? 0) &&
            bounds.bottom <= (shell?.bottom ?? innerHeight) &&
            performance.now() - window.outlineStart
          );
        });
        const jumpMs = await jump.jsonValue();

        stage = "输入并验证保存";
        await page.locator(editor).evaluate((element, marker) => {
          window.inputSamples = [];
          const paragraph = element.querySelector("p");
          const selection = window.getSelection();
          element.focus();
          selection.collapse(paragraph.firstChild, 0);
          element.addEventListener(
            "beforeinput",
            (event) => {
              if (event.data !== marker) return;
              const start = performance.now();
              requestAnimationFrame(() => window.inputSamples.push(performance.now() - start));
            },
            { once: true, capture: true },
          );
        }, "测");
        await page.keyboard.insertText("测");
        const paintFrame = await page.waitForFunction(() => window.inputSamples[0]);
        assert.match(await page.locator(editor).locator("p").first().textContent(), /^测/u);
        const patch = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/api/notes/" + note.id &&
            response.request().method() === "PATCH" &&
            response.request().postDataJSON()?.contentMarkdown?.includes("测记录中文段落"),
        );
        assert.equal((await patch).status(), 200);
        const fetched = await context.request.get(app.url + "/api/notes/" + note.id);
        const saved = (await fetched.json()).note;
        assert.match(saved.contentMarkdown, /测记录中文段落/u);
        const reset = await context.request.patch(app.url + "/api/notes/" + note.id, {
          data: { version: saved.version, contentMarkdown: data.text },
        });
        assert.ok(reset.ok(), await reset.text());
        samples.push({ ...ready, jumpMs, inputMs: await paintFrame.jsonValue() });
      } catch (error) {
        throw new Error(`${data.bytes} 字节，第 ${run + 1} 次，${stage}失败`, { cause: error });
      } finally {
        await cold.close();
      }
    }
    console.log(
      JSON.stringify({
        fixtureBytes: data.bytes,
        runs: samples.length,
        medianOpenMs: median(samples.map((sample) => sample.openMs)),
        medianOutlineMs: median(samples.map((sample) => sample.jumpMs)),
        medianInputToFrameMs: median(samples.map((sample) => sample.inputMs)),
        medianColdJsCssBytes: median(samples.map((sample) => sample.bytes)),
      }),
    );
  }
} finally {
  await browser.close();
  await app.close();
}
