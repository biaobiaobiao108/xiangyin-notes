import { localConfigPath, writeLocalConfig } from "./cloudflare-config";

await writeLocalConfig();
const preview = Bun.spawn(["bunx", "wrangler", "dev", "--local", "--config", localConfigPath], { stdout: "inherit", stderr: "inherit" });
process.exitCode = await preview.exited;
