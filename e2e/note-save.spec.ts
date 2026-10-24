import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

async function createAndReloadSavedNote(page: Page, title: string, body: string) {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/app");
  await expect(page).toHaveTitle("象映笔记");
  await expect(page.locator("#root")).not.toBeEmpty();
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await page.getByLabel("用户名").fill("e2e-owner");
  await page.locator('input[name="password"]').fill("e2e-passphrase-for-ci");
  await page.getByRole("button", { name: "进入笔记" }).click();

  const createButtonName =
    (page.viewportSize()?.width ?? 1280) < 600 ? "新建笔记" : "在收件箱中新建笔记";
  const createNoteButton = page.getByRole("button", { name: createButtonName, exact: true });
  await expect(createNoteButton).toBeVisible();
  await createNoteButton.click();

  await page.getByRole("textbox", { name: "笔记标题" }).fill(title);
  const editor = page.locator(".ProseMirror[contenteditable='true']");
  await editor.fill(body);
  await expect(page.getByRole("status", { name: "已保存" })).toBeVisible();

  await page.reload();
  if ((page.viewportSize()?.width ?? 1280) < 600) {
    await page.getByRole("button", { name: /^收件箱/ }).click();
    const savedNote = page.locator(".note-row").filter({ hasText: title });
    await expect(savedNote).toBeVisible();
    await savedNote.click();
  }
  await expect(page.getByRole("textbox", { name: "笔记标题" })).toHaveValue(title);
  await expect(page.locator(".ProseMirror[contenteditable='true']")).toContainText(body);
  const screenshotDirectory = process.env.XIANGYING_E2E_SCREENSHOT_DIR;
  if (screenshotDirectory) {
    await mkdir(screenshotDirectory, { recursive: true });
    await page.screenshot({ path: join(screenshotDirectory, `${title}.png`), fullPage: false });
  }
  expect(pageErrors).toEqual([]);
}

test("logs in, creates a note, and reloads its saved content", async ({ page }) => {
  await createAndReloadSavedNote(page, "浏览器回归笔记-桌面", "WebKit 中的桌面保存回归内容。");
});

test("saves and reloads a note in a narrow WebKit viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await createAndReloadSavedNote(page, "浏览器回归笔记-手机", "WebKit 中的窄屏保存回归内容。");
});
