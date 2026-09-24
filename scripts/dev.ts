const serverEnvironment: Record<string, string> = {
  ...Bun.env,
  XIANGYING_USERNAME: Bun.env.XIANGYING_USERNAME?.trim() || "dev",
  XIANGYING_PASSWORD: Bun.env.XIANGYING_PASSWORD?.trim() || "xiangying-dev-password-1234",
  XIANGYING_DEV_AUTO_LOGIN: Bun.env.XIANGYING_DEV_AUTO_LOGIN?.trim() || "true",
  NODE_ENV: "development",
  DATABASE_PATH: Bun.env.DEV_DATABASE_PATH?.trim() || "./data/xiangying-notes-dev.sqlite",
  COOKIE_SECURE: "false",
  CLIENT_ROOT: "./dist/dev-client",
  HOST: "localhost",
};

const processes = [
  Bun.spawn(["bun", "run", "dev:client"], { stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bun", "--hot", "server/index.ts"], { env: serverEnvironment, stdout: "inherit", stderr: "inherit" }),
];

let shutdownPromise: Promise<void> | null = null;
const terminate = () => {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = Promise.all(processes.map(async (child) => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    const forceKillTimer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 1_000);
    try {
      await child.exited;
    } finally {
      clearTimeout(forceKillTimer);
    }
  })).then(() => undefined);
  return shutdownPromise;
};

process.once("SIGINT", () => { void terminate(); });
process.once("SIGTERM", () => { void terminate(); });
await Promise.race(processes.map((process) => process.exited));
await terminate();

export {};
