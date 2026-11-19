import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function loadPlaywright() {
  const bin = Bun.spawnSync([process.execPath, "pm", "bin", "-g"]);
  assert.equal(bin.exitCode, 0, bin.stderr.toString());
  const modulePath =
    process.env.PLAYWRIGHT_MODULE ??
    resolve(bin.stdout.toString().trim(), "../install/global/node_modules/playwright/index.mjs");
  return import(pathToFileURL(modulePath).href);
}

export async function startApp({ dataRoot, clientRoot = resolve("dist/client") } = {}) {
  const temporaryData = !dataRoot;
  dataRoot ??= await mkdtemp(join(tmpdir(), "xiangyin-browser-"));
  const reservation = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const port = reservation.port;
  reservation.stop();
  const url = new URL("http://127.0.0.1:" + port);
  const username = "browser-check";
  const password = crypto.randomUUID();
  const child = Bun.spawn([process.execPath, "dist/server/index.js"], {
    env: {
      ...process.env,
      HOST: url.hostname,
      PORT: String(port),
      PUBLIC_URL: url.origin,
      NODE_ENV: "production",
      DATABASE_PATH: join(dataRoot, "xiangying-notes.sqlite"),
      ASSETS_PATH: join(dataRoot, "attachments"),
      CLIENT_ROOT: clientRoot,
      XIANGYING_USERNAME: username,
      XIANGYING_PASSWORD: password,
      XIANGYING_API_TOKEN: "",
      XIANGYING_MCP_TOKEN: "",
      COOKIE_SECURE: "false",
      TRUST_PROXY: "false",
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  async function close() {
    if (child.exitCode === null) {
      const forceStop = setTimeout(() => child.kill("SIGKILL"), 6_000);
      child.kill("SIGTERM");
      try {
        await child.exited;
      } finally {
        clearTimeout(forceStop);
      }
    }
    if (temporaryData)
      await rm(dataRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  }
  try {
    for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt++) {
      if (
        await fetch(new URL("/api/health", url)).then(
          (r) => r.ok,
          () => false,
        )
      )
        return { url: url.origin, username, password, close };
      await Bun.sleep(100);
    }
    throw new Error("测试服务未能启动");
  } catch (error) {
    await close();
    throw error;
  }
}

export async function login(app, page) {
  await page.goto(app.url + "/login");
  await page.getByLabel("用户名").fill(app.username);
  await page.getByLabel("密码", { exact: true }).fill(app.password);
  await page.getByRole("button", { name: "进入笔记" }).click();
  await page.getByRole("button", { name: "在收件箱中新建笔记", exact: true }).first().waitFor();
}
