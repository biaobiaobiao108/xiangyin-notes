import { networkInterfaces } from "node:os";

const port = Number.parseInt(Bun.env.PORT ?? "3000", 10) || 3000;
const isPrivateIpv4 = (address: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address);
const lanAddresses = Object.values(networkInterfaces())
  .flatMap((addresses) => addresses ?? [])
  .filter((address) => address.family === "IPv4" && !address.internal && isPrivateIpv4(address.address))
  .map((address) => address.address);

console.log(`[dev] 本机访问：http://localhost:${port}`);
if (lanAddresses.length > 0) {
  console.log(`[dev] 局域网访问：${lanAddresses.map((address) => `http://${address}:${port}`).join("  ")}`);
  console.log("[dev] iPhone 需连接同一 Wi-Fi；若仍无法访问，请允许 Bun 通过 Windows 专用网络防火墙，并检查路由器是否开启客户端隔离。");
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
  COOKIE_SECURE: "false",
  CLIENT_ROOT: "./dist/dev-client",
  HOST: "0.0.0.0",
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
