/**
 * 对比一个已有数据库与「当前迁移产物」的 schema，找出漂移。
 *
 * 用法：bun run db:check [数据库路径]
 * 省略路径时使用 DATABASE_PATH，与服务端一致（本机默认 ./data/xiangying-notes.sqlite）。
 *
 * 存在漂移时以退出码 1 结束，便于升级前后当作检查步骤使用。
 * 背景：0001_baseline.sql 曾被就地修改过（新增 note_links.snippet 与 rate_limits），
 * 已应用旧基线文件的数据库不会自动获得这些结构，只能靠新增迁移补齐——本脚本就是用来发现它们的。
 */
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { applyMigrations, databasePathFromEnv, openDatabase } from "../server/db";
import { snapshotSchema } from "./schema-snapshot";

const existingPath = process.argv[2]?.trim() || databasePathFromEnv(Bun.env);

const targetPath = join(tmpdir(), `xiangying-schema-target-${crypto.randomUUID()}.sqlite`);
const target = await openDatabase(targetPath);
await applyMigrations(target);

const existing = new Database(existingPath, { readonly: true });
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

console.log(`已有库 ${existingPath}：${existingObjects.size} 个对象；当前迁移产物：${targetObjects.size} 个对象`);
console.log("缺失对象（迁移产物有、已有库没有）:", missing.length ? missing.join(", ") : "无");
console.log("多余对象（已有库有、迁移产物没有）:", extra.length ? extra.join(", ") : "无");
console.log("定义不一致:", different.length ? different.join(", ") : "无");
console.log("列级差异:", columnDiffs.length ? `\n  - ${columnDiffs.join("\n  - ")}` : "无");
console.log(drifted ? "\n发现漂移：请新增迁移补齐后再升级。" : "\n结构与当前迁移一致。");

existing.close();
target.close();
await Promise.all([
  rm(targetPath, { force: true }),
  rm(`${targetPath}-wal`, { force: true }),
  rm(`${targetPath}-shm`, { force: true }),
]);

process.exitCode = drifted ? 1 : 0;
