import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

const dataDirectory = mkdtempSync(join(tmpdir(), "xiangying-notes-e2e-"));
process.env.XIANGYING_E2E_DATA_DIRECTORY = dataDirectory;
process.on("exit", () => {
  rmSync(dataDirectory, { recursive: true, force: true });
});

const baseURL = "http://127.0.0.1:4174";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  reporter: "list",
  outputDir: join(dataDirectory, "results"),
  use: {
    baseURL,
    browserName: "webkit",
    headless: true,
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: "bun run start",
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      HOST: "127.0.0.1",
      PORT: "4174",
      DATABASE_PATH: join(dataDirectory, "notes.sqlite"),
      ASSETS_PATH: join(dataDirectory, "attachments"),
      XIANGYING_USERNAME: "e2e-owner",
      XIANGYING_PASSWORD: "e2e-passphrase-for-ci",
      COOKIE_SECURE: "false",
    },
  },
});
