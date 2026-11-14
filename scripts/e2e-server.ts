import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const runtimeRoot = join(tmpdir(), "xiangying-notes-playwright");
const port = process.env.E2E_PORT || "3107";

await rm(runtimeRoot, { recursive: true, force: true });
await mkdir(runtimeRoot, { recursive: true });

const server = Bun.spawn(["bun", "dist/server/index.js"], {
  cwd: projectRoot,
  env: {
    ...process.env,
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: port,
    DATABASE_PATH: join(runtimeRoot, "e2e.sqlite"),
    ASSETS_PATH: join(runtimeRoot, "assets"),
    CLIENT_ROOT: join(projectRoot, "dist", "client"),
    XIANGYING_USERNAME: "e2e-owner",
    XIANGYING_PASSWORD: "e2e-password",
    COOKIE_SECURE: "false",
  },
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
});

let stopping = false;
const stop = (signal: NodeJS.Signals) => {
  if (stopping) return;
  stopping = true;
  server.kill(signal);
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

const exitCode = await server.exited;
await rm(runtimeRoot, { recursive: true, force: true });
process.exit(exitCode);
