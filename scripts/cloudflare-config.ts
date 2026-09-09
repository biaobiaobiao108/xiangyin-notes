export const localConfigPath = "./.wrangler.local.jsonc";
export const remoteConfigPath = "./.wrangler.remote.jsonc";

const baseConfig = {
  $schema: "./node_modules/wrangler/config-schema.json",
  main: "./dist/worker/index.js",
  compatibility_date: "2026-09-09",
  assets: {
    directory: "./dist/client",
    binding: "ASSETS",
    not_found_handling: "single-page-application",
    run_worker_first: ["/api/*"],
  },
};

export async function writeLocalConfig() {
  await Bun.write(localConfigPath, JSON.stringify({
    ...baseConfig,
    name: "lumen-notes-local",
    d1_databases: [{ binding: "DB", database_name: "lumen-notes-db", database_id: "local-lumen-notes", migrations_dir: "./migrations" }],
    kv_namespaces: [{ binding: "SHARE_KV", id: "local-lumen-notes" }],
  }, null, 2));
}

export async function writeRemoteMigrationConfig() {
  const databaseId = process.env.LUMEN_D1_DATABASE_ID?.trim();
  if (!databaseId) {
    throw new Error("远程迁移需要本机环境变量 LUMEN_D1_DATABASE_ID；它不会写入仓库。请从 Cloudflare Dashboard 的 D1 数据库详情中复制 ID 后重试。");
  }
  await Bun.write(remoteConfigPath, JSON.stringify({
    ...baseConfig,
    name: "lumen-notes-migration",
    d1_databases: [{ binding: "DB", database_name: process.env.LUMEN_D1_DATABASE_NAME?.trim() || "lumen-notes-db", database_id: databaseId, migrations_dir: "./migrations" }],
  }, null, 2));
}
