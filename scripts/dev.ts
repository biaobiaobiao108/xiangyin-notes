import { networkInterfaces } from "node:os";

const port = Number.parseInt(Bun.env.PORT ?? "3000", 10) || 3000;
const isPrivateIpv4 = (address: string) =>
  /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address);
const lanAddresses = Object.values(networkInterfaces())
  .flatMap((addresses) => addresses ?? [])
  .filter(
    (address) => address.family === "IPv4" && !address.internal && isPrivateIpv4(address.address),
  )
  .map((address) => address.address);

console.log(`[dev] 本机访问：http://localhost:${port}`);
if (lanAddresses.length > 0) {
  console.log(
    `[dev] 局域网访问：${lanAddresses.map((address) => `http://${address}:${port}`).join("  ")}`,
  );
  console.log(
    "[dev] iPhone 需连接同一 Wi-Fi；若仍无法访问，请允许 Bun 通过 Windows 专用网络防火墙，并检查路由器是否开启客户端隔离。",
  );
} else {
  console.log("[dev] 未检测到私有 IPv4 地址；请用 ipconfig 确认电脑的 Wi-Fi/局域网 IPv4 地址。");
}

const serverEnvironment: Record<string, string> = {
  ...Bun.env,
  XIANGYING_USERNAME: Bun.env.XIANGYING_USERNAME?.trim() || "dev",
  XIANGYING_PASSWORD: Bun.env.XIANGYING_PASSWORD?.trim() || "xiangying-dev-password-1234",
  XIANGYING_DEV_AUTO_LOGIN: Bun.env.XIANGYING_DEV_AUTO_LOGIN?.trim() || "true",
  NODE_ENV: "development",
  DATABASE_PATH: Bun.env.DEV_DATABASE_PATH?.trim() || "./data/xiangying-notes-dev.sqlite",
  ASSETS_PATH: Bun.env.DEV_ASSETS_PATH?.trim() || "./data/attachments-dev",
  COOKIE_SECURE: "false",
  CLIENT_ROOT: "./dist/dev-client",
  HOST: "0.0.0.0",
};

if (lanAddresses.length > 0 && serverEnvironment.XIANGYING_DEV_AUTO_LOGIN === "true") {
  console.warn(
    "[dev] 开发自动登录已开启，且服务监听 0.0.0.0；同一网络内的其他设备可无需密码进入。仅在可信网络中使用。",
  );
}

const processes = [
  Bun.spawn(["bun", "run", "dev:client"], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }),
  Bun.spawn(["bun", "--hot", "server/index.ts"], {
    env: serverEnvironment,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }),
];

let shutdownPromise: Promise<void> | null = null;
let shuttingDown = false;
const terminate = () => {
  shuttingDown = true;
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = Promise.all(
    processes.map(async (child) => {
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
    }),
  ).then(() => undefined);
  return shutdownPromise;
};

process.once("SIGINT", () => {
  shuttingDown = true;
  void terminate();
});
process.once("SIGTERM", () => {
  shuttingDown = true;
  void terminate();
});
const exited = await Promise.race(
  processes.map((proc, index) =>
    proc.exited.then((code) => ({ name: index === 0 ? "dev:client" : "server", code })),
  ),
);
const isExpectedExit =
  shuttingDown || exited.code === 0 || exited.code === 130 || exited.code === 143;
if (!isExpectedExit && exited.code !== null) {
  console.error(`[dev] ${exited.name} 异常退出 (退出码: ${exited.code})`);
}
await terminate();

export {};
