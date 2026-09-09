import { remoteConfigPath, writeRemoteMigrationConfig } from "./cloudflare-config";

try {
  await writeRemoteMigrationConfig();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
  process.exit();
}

const migration = Bun.spawn(["bunx", "wrangler", "d1", "migrations", "apply", "DB", "--remote", "--config", remoteConfigPath], { stdout: "inherit", stderr: "inherit" });
process.exitCode = await migration.exited;
