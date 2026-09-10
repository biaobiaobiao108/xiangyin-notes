const serverEnvironment: Record<string, string> = {
  ...Bun.env,
  LUMEN_USERNAME: "dev",
  LUMEN_PASSWORD: "lumen-dev-password-1234",
  LUMEN_DEV_AUTO_LOGIN: "true",
  NODE_ENV: "development",
  DATABASE_PATH: Bun.env.DEV_DATABASE_PATH?.trim() || "./data/lumen-notes-dev.sqlite",
  COOKIE_SECURE: "false",
};

const processes = [
  Bun.spawn(["bun", "run", "dev:client"], { stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bun", "--hot", "server/index.ts"], { env: serverEnvironment, stdout: "inherit", stderr: "inherit" }),
];

let shuttingDown = false;
const terminate = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of processes) child.kill();
};

process.on("SIGINT", terminate);
process.on("SIGTERM", terminate);
await Promise.race(processes.map((process) => process.exited));
terminate();

export {};
