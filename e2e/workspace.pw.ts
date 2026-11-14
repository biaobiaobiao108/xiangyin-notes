import { expect, test, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("用户名").fill("e2e-owner");
  await page.getByLabel("密码", { exact: true }).fill("e2e-password");
  await page.getByRole("button", { name: "进入笔记" }).click();
  await expect(page).toHaveURL(/\/app/);
  await expect(page.locator(".editor-panel")).toBeVisible();
}

test("login fields have standalone labels and failures move focus to the error", async ({
  page,
}) => {
  await page.goto("/login");
  await expect(page.getByLabel("密码", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "显示密码" })).toBeVisible();

  await page.getByLabel("用户名").fill("e2e-owner");
  await page.getByLabel("密码", { exact: true }).fill("wrong-password");
  await page.getByRole("button", { name: "进入笔记" }).click();

  const error = page.locator(".form-error");
  await expect(error).toContainText("用户名或密码不正确");
  await expect(error).toBeFocused();
  await expect(page.getByLabel("用户名")).toHaveValue("e2e-owner");
  await expect(page.getByLabel("密码", { exact: true })).toHaveValue("wrong-password");
});

test("active note rows keep a visible focus ring in both themes", async ({ page }) => {
  await login(page);
  await page.keyboard.press("Tab");
  const lightShadow = await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
    const row = document.querySelector<HTMLElement>(".note-row.is-active");
    row?.focus();
    return row ? getComputedStyle(row).boxShadow : "";
  });
  expect(lightShadow).toContain("rgb(54, 94, 78)");

  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await page.waitForTimeout(250);
  const darkShadow = await page.evaluate(() => {
    const row = document.querySelector<HTMLElement>(".note-row.is-active");
    row?.focus();
    return row ? getComputedStyle(row).boxShadow : "";
  });
  expect(darkShadow).toContain("rgb(125, 187, 154)");
});

test("new note creation locks the previous editor until the new note is ready", async ({
  page,
}) => {
  await login(page);
  const sidebar = page.getByRole("complementary", { name: "主导航" });
  let releaseRequest: () => void = () => undefined;
  const requestGate = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  await page.route("**/api/notes", async (route) => {
    if (route.request().method() === "POST") await requestGate;
    await route.continue();
  });

  try {
    const createButton = sidebar.getByRole("button", { name: "在收件箱中新建笔记" });
    await createButton.click();
    await expect(page.getByRole("button", { name: "正在新建笔记" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "正在新建笔记" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await expect(page.getByLabel("笔记标题")).toHaveAttribute("readonly", "");
    await expect(page.getByText("正在新建笔记…")).toBeVisible();
  } finally {
    releaseRequest();
  }

  await expect(page.getByLabel("笔记标题")).toHaveValue("未命名笔记");
  await expect(sidebar.getByRole("button", { name: "在收件箱中新建笔记" })).toBeEnabled();
});

test("workspace does not overflow at supported responsive widths", async ({ page }) => {
  await login(page);
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 768, height: 1024 },
    { width: 375, height: 812 },
    { width: 320, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    await page.reload();
    await expect(page.locator(".app-shell")).toBeVisible();
    const overflow = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      body: document.body.scrollWidth - document.body.clientWidth,
    }));
    expect(overflow.document).toBeLessThanOrEqual(0);
    expect(overflow.body).toBeLessThanOrEqual(0);
  }
});
