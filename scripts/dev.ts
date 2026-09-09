import { localConfigPath, writeLocalConfig } from "./cloudflare-config";

await writeLocalConfig();

const processes = [
  Bun.spawn(["bun", "build", "./app/index.html", "--outdir", "./dist/client", "--target", "browser", "--format", "esm", "--splitting", "--watch"], { stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bun", "build", "./worker/index.ts", "--outdir", "./dist/worker", "--target", "browser", "--format", "esm", "--watch"], { stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["wrangler", "dev", "--local", "--config", localConfigPath], { stdout: "inherit", stderr: "inherit" }),
];

const terminate = () => { for (const child of processes) child.kill(); };
process.on("SIGINT", terminate);
process.on("SIGTERM", terminate);
await Promise.race(processes.map((process) => process.exited));
terminate();

export {};
