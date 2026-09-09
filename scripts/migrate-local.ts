import { localConfigPath, writeLocalConfig } from "./cloudflare-config";

await writeLocalConfig();
const migration = Bun.spawn(["bunx", "wrangler", "d1", "migrations", "apply", "DB", "--local", "--config", localConfigPath], { stdout: "inherit", stderr: "inherit" });
process.exitCode = await migration.exited;
