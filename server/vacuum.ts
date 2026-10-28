import { databasePathFromEnv, openDatabase, reclaimDatabaseSpace } from "./db";

export async function runVacuum(targetPath = databasePathFromEnv(Bun.env)) {
  console.log(`[db:vacuum] 正在连接数据库：${targetPath}`);
  const database = await openDatabase(targetPath);
  try {
    console.log("[db:vacuum] 正在优化全文索引并回收空间……");
    const startTime = performance.now();
    reclaimDatabaseSpace(database);
    const elapsed = (performance.now() - startTime).toFixed(1);
    console.log(`[db:vacuum] 整理完成，耗时 ${elapsed}ms。`);
  } finally {
    database.close();
  }
}

if (import.meta.main) {
  const targetPath = process.argv[2]?.trim();
  await runVacuum(targetPath);
}
