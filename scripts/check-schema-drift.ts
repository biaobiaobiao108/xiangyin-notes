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
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { constants, Database } from "bun:sqlite";
import {
  CURRENT_SCHEMA_VERSION,
  SEARCH_INDEX_REBUILD_KEY,
  createExpectedSchemaDatabase,
  databasePathFromEnv,
  openDatabase,
} from "../server/db";
import { snapshotSchema } from "../server/schema-snapshot";

const existingPath = process.argv[2]?.trim() || databasePathFromEnv(Bun.env);

if (!existsSync(existingPath)) {
  console.log(`[db:check] 数据库文件不存在（${existingPath}），全新环境无需检测 schema 漂移。`);
  process.exit(0);
}

async function isWalDatabaseWithoutSidecars(path: string) {
  if (hasWalSidecars(path)) return false;
  const file = await open(path, "r");
  try {
    const header = new Uint8Array(20);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    // SQLite database header bytes 18 and 19 are both 2 for WAL mode.
    return bytesRead === header.length && header[18] === 2 && header[19] === 2;
  } finally {
    await file.close();
  }
}

function hasWalSidecars(path: string) {
  return existsSync(`${path}-wal`) || existsSync(`${path}-shm`);
}

const useImmutableReadOnly = await isWalDatabaseWithoutSidecars(existingPath);
// A cleanly closed WAL database has all committed pages in the main file. Bun's
// readonly open cannot create the missing -shm file, while immutable mode can
// inspect that main file without creating or changing any database sidecars.
const existingFilename = useImmutableReadOnly
  ? `${pathToFileURL(resolve(existingPath)).href}?immutable=1`
  : existingPath;
// Explicitly enable URI parsing: SQLite builds differ in their default URI setting.
const existing = new Database(
  existingFilename,
  useImmutableReadOnly
    ? constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI
    : constants.SQLITE_OPEN_READONLY,
);
if (useImmutableReadOnly && hasWalSidecars(existingPath)) {
  existing.close();
  console.error(
    "[db:check] 检查期间 WAL 辅助文件已出现；immutable 只读视图不会读取新 WAL。请先停止服务，再重新检查。",
  );
  process.exit(1);
}
const existingVersion = Number(
  (existing.query("PRAGMA user_version").get() as { user_version: number } | null)?.user_version ??
    0,
);
const versionUnsupported =
  !Number.isInteger(existingVersion) ||
  existingVersion < 1 ||
  existingVersion > CURRENT_SCHEMA_VERSION;
const target = versionUnsupported
  ? await openDatabase(":memory:")
  : await createExpectedSchemaDatabase(existingVersion);

try {
  const integrityRows = existing.query("PRAGMA quick_check").all() as Array<{
    quick_check: string;
  }>;
  const integrityOk = integrityRows.length === 1 && integrityRows[0]?.quick_check === "ok";
  const foreignKeyViolations = existing.query("PRAGMA foreign_key_check").all() as Array<{
    table: string;
    rowid: number | null;
    parent: string;
    fkid: number;
  }>;
  const existingObjects = snapshotSchema(existing);
  const targetObjects = snapshotSchema(target);
  const migrationPending = !versionUnsupported && existingVersion < CURRENT_SCHEMA_VERSION;
  let searchIndexRebuildPending = false;
  if (
    !migrationPending &&
    existingVersion === CURRENT_SCHEMA_VERSION &&
    existingObjects.has("table:app_metadata")
  ) {
    searchIndexRebuildPending = Boolean(
      existing
        .query("SELECT 1 FROM app_metadata WHERE key = ? AND value = '1'")
        .get(SEARCH_INDEX_REBUILD_KEY),
    );
  }

  const missing: string[] = [];
  const different: string[] = [];
  const extra: string[] = [];
  if (!versionUnsupported) {
    for (const [key, sql] of targetObjects) {
      const current = existingObjects.get(key);
      if (current === undefined) missing.push(key);
      else if (current !== sql) different.push(key);
    }
    for (const key of existingObjects.keys()) {
      if (!targetObjects.has(key)) extra.push(key);
    }
  }

  const columnDiffs: string[] = [];
  if (!versionUnsupported) {
    for (const [key] of targetObjects) {
      if (!key.startsWith("table:")) continue;
      const table = key.slice(6);
      const columnsOf = (database: Database) =>
        (database.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
          (column) => column.name,
        );
      const targetColumns = columnsOf(target);
      const existingColumns = columnsOf(existing);
      const missingColumns = targetColumns.filter((column) => !existingColumns.includes(column));
      const extraColumns = existingColumns.filter((column) => !targetColumns.includes(column));
      if (missingColumns.length || extraColumns.length) {
        columnDiffs.push(
          `${table}: 缺列 [${missingColumns.join(", ")}] 多列 [${extraColumns.join(", ")}]`,
        );
      }
    }
  }

  const walSidecarsAppearedDuringCheck = useImmutableReadOnly && hasWalSidecars(existingPath);
  const drifted =
    versionUnsupported ||
    missing.length > 0 ||
    different.length > 0 ||
    extra.length > 0 ||
    columnDiffs.length > 0 ||
    searchIndexRebuildPending ||
    !integrityOk ||
    foreignKeyViolations.length > 0 ||
    walSidecarsAppearedDuringCheck;

  console.log(
    `已有库 ${existingPath}：${existingObjects.size} 个对象；版本 ${existingVersion} 的 schema：${targetObjects.size} 个对象`,
  );
  if (versionUnsupported)
    console.log(`不支持的 schema 版本：${existingVersion}（支持 1 至 ${CURRENT_SCHEMA_VERSION}）`);
  else if (migrationPending)
    console.log(`待升级：启动服务后将迁移 ${existingVersion} → ${CURRENT_SCHEMA_VERSION}`);
  console.log(
    "缺失对象（当前 schema 有、已有库没有）:",
    missing.length ? missing.join(", ") : "无",
  );
  console.log("多余对象（已有库有、当前 schema 没有）:", extra.length ? extra.join(", ") : "无");
  console.log("定义不一致:", different.length ? different.join(", ") : "无");
  console.log("列级差异:", columnDiffs.length ? `\n  - ${columnDiffs.join("\n  - ")}` : "无");
  console.log(
    "SQLite 完整性:",
    integrityOk
      ? "正常"
      : `异常\n  - ${integrityRows.map((row) => row.quick_check).join("\n  - ")}`,
  );
  console.log(
    "外键检查:",
    foreignKeyViolations.length
      ? `发现 ${foreignKeyViolations.length} 条违规\n  - ${foreignKeyViolations
          .slice(0, 20)
          .map(
            ({ table, rowid, parent, fkid }) => `${table} rowid=${rowid} → ${parent} (fk ${fkid})`,
          )
          .join("\n  - ")}${foreignKeyViolations.length > 20 ? "\n  - 其余违规已省略" : ""}`
      : "正常",
  );
  if (walSidecarsAppearedDuringCheck)
    console.log(
      "WAL 状态:",
      "检查期间辅助文件出现；immutable 视图可能未包含 WAL 内容，请先停止服务后重试。",
    );
  console.log(
    "搜索索引重建:",
    migrationPending
      ? "待迁移后重新检查"
      : searchIndexRebuildPending
        ? "未完成，启动服务后会继续重建"
        : "无待完成标记",
  );
  console.log(
    drifted
      ? "\n发现 schema 漂移、数据库完整性问题或未完成的重建任务：请先备份数据库并排查；不要删除或重建数据卷。"
      : migrationPending
        ? "\n结构与已有版本一致，可启动服务完成迁移。"
        : "\n结构与当前 schema 一致。",
  );

  process.exitCode = drifted ? 1 : 0;
} finally {
  existing.close();
  target.close();
}
