/**
 * 对比一个已有数据库与当前 schema 基线及迁移链，找出漂移。
 *
 * 用法：bun run db:check [数据库路径]
 * 省略路径时使用 DATABASE_PATH，与服务端一致（本机默认 ./data/xiangying-notes.sqlite）。
 *
 * 存在漂移时以退出码 1 结束，便于升级前后当作检查步骤使用。
 * 启动时也会执行同样的结构检查；本命令可在启动前只读检查数据库文件。
 */
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { databasePathFromEnv, openDatabase } from "../server/db";
import { snapshotSchema } from "../server/schema-snapshot";

const existingPath = process.argv[2]?.trim() || databasePathFromEnv(Bun.env);

if (!existsSync(existingPath)) {
  console.log(`[db:check] 数据库文件不存在（${existingPath}），全新环境无需检测 schema 漂移。`);
  process.exit(0);
}

const target = await openDatabase(":memory:");
const existing = new Database(existingPath, { readonly: true });

try {
  const existingObjects = snapshotSchema(existing);
  const targetObjects = snapshotSchema(target);

  const missing: string[] = [];
  const different: string[] = [];
  const extra: string[] = [];
  for (const [key, sql] of targetObjects) {
    const current = existingObjects.get(key);
    if (current === undefined) missing.push(key);
    else if (current !== sql) different.push(key);
  }
  for (const key of existingObjects.keys()) {
    if (!targetObjects.has(key)) extra.push(key);
  }

  const columnDiffs: string[] = [];
  for (const [key] of targetObjects) {
    if (!key.startsWith("table:")) continue;
    const table = key.slice(6);
    const columnsOf = (database: Database) => (database.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
    const targetColumns = columnsOf(target);
    const existingColumns = columnsOf(existing);
    const missingColumns = targetColumns.filter((column) => !existingColumns.includes(column));
    const extraColumns = existingColumns.filter((column) => !targetColumns.includes(column));
    if (missingColumns.length || extraColumns.length) {
      columnDiffs.push(`${table}: 缺列 [${missingColumns.join(", ")}] 多列 [${extraColumns.join(", ")}]`);
    }
  }

  const drifted = missing.length > 0 || different.length > 0 || extra.length > 0 || columnDiffs.length > 0;

  console.log(`已有库 ${existingPath}：${existingObjects.size} 个对象；当前 schema：${targetObjects.size} 个对象`);
  console.log("缺失对象（当前 schema 有、已有库没有）:", missing.length ? missing.join(", ") : "无");
  console.log("多余对象（已有库有、当前 schema 没有）:", extra.length ? extra.join(", ") : "无");
  console.log("定义不一致:", different.length ? different.join(", ") : "无");
  console.log("列级差异:", columnDiffs.length ? `\n  - ${columnDiffs.join("\n  - ")}` : "无");
  console.log(drifted ? "\n发现漂移：请排查后再启动服务。" : "\n结构与当前 schema 一致。");

  process.exitCode = drifted ? 1 : 0;
} finally {
  existing.close();
  target.close();
}
