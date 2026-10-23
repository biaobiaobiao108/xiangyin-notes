import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { snapshotSchema } from "./schema-snapshot";

const DEFAULT_DATABASE_PATH = "./data/xiangying-notes.sqlite";
const DEFAULT_SCHEMA_PATH = "./database/schema.sql";
const BASELINE_SCHEMA_VERSION = 1;

// Increment this when adding the next entry to SCHEMA_MIGRATIONS.
export const CURRENT_SCHEMA_VERSION = 1;

type TableCountRow = {
  count: number;
};

export type SqliteDatabase = Database;

export type SchemaMigration = {
  sourceVersion: number;
  targetVersion: number;
  migrate: (database: SqliteDatabase) => void;
};

export type DatabaseInitializationOptions = {
  schemaPath?: string;
  migrations?: readonly SchemaMigration[];
  currentSchemaVersion?: number;
};

// After deployment, add each new transition here and increment
// CURRENT_SCHEMA_VERSION; never rewrite an already deployed transition.
const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [];

export function databasePathFromEnv(env: Record<string, string | undefined> = Bun.env) {
  return env.DATABASE_PATH?.trim() || DEFAULT_DATABASE_PATH;
}

function readSchemaVersion(database: SqliteDatabase) {
  const row = database.query("PRAGMA user_version").get() as
    { user_version: number } | null | undefined;
  return Number(row?.user_version ?? 0);
}

function isEmptyDatabase(database: SqliteDatabase) {
  const row = database
    .query(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type IN ('table', 'view', 'index', 'trigger') AND name NOT GLOB 'sqlite_*'",
    )
    .get() as TableCountRow | null | undefined;
  return Number(row?.count ?? 0) === 0;
}

function schemaVersionError(version: number, currentVersion: number) {
  return new Error(
    `SQLite schema version ${version} is unsupported; this application supports versions ${BASELINE_SCHEMA_VERSION} through ${currentVersion}.`,
  );
}

function schemaDifference(actual: SqliteDatabase, expected: SqliteDatabase) {
  const actualObjects = snapshotSchema(actual);
  const expectedObjects = snapshotSchema(expected);
  const missing = [...expectedObjects.keys()].filter((key) => !actualObjects.has(key));
  const extra = [...actualObjects.keys()].filter((key) => !expectedObjects.has(key));
  const different = [...expectedObjects.keys()].filter(
    (key) => actualObjects.has(key) && actualObjects.get(key) !== expectedObjects.get(key),
  );
  return { missing, extra, different };
}

function assertSchemaMatches(actual: SqliteDatabase, expected: SqliteDatabase, version: number) {
  const { missing, extra, different } = schemaDifference(actual, expected);
  if (missing.length || extra.length || different.length) {
    const details = [
      missing.length ? `缺失 [${missing.join(", ")}]` : "",
      extra.length ? `多余 [${extra.join(", ")}]` : "",
      different.length ? `定义不一致 [${different.join(", ")}]` : "",
    ]
      .filter(Boolean)
      .join("；");
    throw new Error(
      `SQLite schema version ${version} has drift: ${details}. Database was left unchanged.`,
    );
  }
}

export function reclaimDatabaseSpace(database: SqliteDatabase) {
  try {
    database.exec(`
      INSERT INTO notes_fts(notes_fts) VALUES('optimize');
      PRAGMA incremental_vacuum;
      PRAGMA wal_checkpoint(TRUNCATE);
    `);
  } catch {
    database.exec(`
      PRAGMA incremental_vacuum;
      PRAGMA wal_checkpoint(TRUNCATE);
    `);
  }
}

export function applyMigrations(
  database: SqliteDatabase,
  migrations: readonly SchemaMigration[] = SCHEMA_MIGRATIONS,
  currentSchemaVersion = CURRENT_SCHEMA_VERSION,
) {
  let version = readSchemaVersion(database);
  if (version > currentSchemaVersion || version < BASELINE_SCHEMA_VERSION) {
    throw schemaVersionError(version, currentSchemaVersion);
  }

  while (version < currentSchemaVersion) {
    const migration = migrations.find((candidate) => candidate.sourceVersion === version);
    if (!migration || migration.targetVersion !== version + 1) {
      throw new Error(`SQLite schema migration ${version} -> ${version + 1} is not registered.`);
    }

    const apply = database.transaction(() => {
      const currentVersion = readSchemaVersion(database);
      if (currentVersion === migration.targetVersion) return;
      if (currentVersion !== migration.sourceVersion)
        throw schemaVersionError(currentVersion, currentSchemaVersion);
      migration.migrate(database);
      database.exec(`PRAGMA user_version = ${migration.targetVersion};`);
    });
    apply.immediate();
    version = readSchemaVersion(database);
  }

  if (version !== currentSchemaVersion) throw schemaVersionError(version, currentSchemaVersion);
}

function createSchemaAtVersion(
  schemaSql: string,
  version: number,
  migrations: readonly SchemaMigration[],
  currentSchemaVersion: number,
) {
  const expected = new Database(":memory:");
  try {
    expected.exec(schemaSql);
    if (readSchemaVersion(expected) !== BASELINE_SCHEMA_VERSION) {
      throw new Error(
        `database/schema.sql must set PRAGMA user_version = ${BASELINE_SCHEMA_VERSION}.`,
      );
    }
    if (version > currentSchemaVersion) throw schemaVersionError(version, currentSchemaVersion);
    applyMigrations(expected, migrations, version);
    return expected;
  } catch (error) {
    expected.close();
    throw error;
  }
}

export async function initializeDatabase(
  database: SqliteDatabase,
  options: DatabaseInitializationOptions = {},
) {
  const schemaPath = options.schemaPath ?? DEFAULT_SCHEMA_PATH;
  const migrations = options.migrations ?? SCHEMA_MIGRATIONS;
  const currentSchemaVersion = options.currentSchemaVersion ?? CURRENT_SCHEMA_VERSION;
  const schemaFile = Bun.file(schemaPath);
  if (!(await schemaFile.exists()))
    throw new Error(`SQLite schema baseline not found: ${schemaPath}`);
  const schemaSql = await schemaFile.text();

  let version = readSchemaVersion(database);
  if (version > currentSchemaVersion) throw schemaVersionError(version, currentSchemaVersion);

  if (isEmptyDatabase(database) && version === 0) {
    const expectedBaseline = createSchemaAtVersion(
      schemaSql,
      BASELINE_SCHEMA_VERSION,
      migrations,
      currentSchemaVersion,
    );
    try {
      const initialize = database.transaction(() => {
        if (!isEmptyDatabase(database)) return;
        if (readSchemaVersion(database) !== 0)
          throw schemaVersionError(readSchemaVersion(database), currentSchemaVersion);
        database.exec(schemaSql);
        assertSchemaMatches(database, expectedBaseline, BASELINE_SCHEMA_VERSION);
      });
      initialize.immediate();
      version = readSchemaVersion(database);
    } finally {
      expectedBaseline.close();
    }
  } else if (version === 0) {
    throw schemaVersionError(version, currentSchemaVersion);
  }

  if (version < BASELINE_SCHEMA_VERSION || version > currentSchemaVersion) {
    throw schemaVersionError(version, currentSchemaVersion);
  }

  const expectedAtStoredVersion = createSchemaAtVersion(
    schemaSql,
    version,
    migrations,
    currentSchemaVersion,
  );
  try {
    assertSchemaMatches(database, expectedAtStoredVersion, version);
  } finally {
    expectedAtStoredVersion.close();
  }

  applyMigrations(database, migrations, currentSchemaVersion);

  const expectedCurrentSchema = createSchemaAtVersion(
    schemaSql,
    currentSchemaVersion,
    migrations,
    currentSchemaVersion,
  );
  try {
    assertSchemaMatches(database, expectedCurrentSchema, currentSchemaVersion);
  } finally {
    expectedCurrentSchema.close();
  }
}

export async function openDatabase(
  databasePath = databasePathFromEnv(),
  options: DatabaseInitializationOptions = {},
) {
  const resolvedPath = databasePath === ":memory:" ? databasePath : resolve(databasePath);
  if (resolvedPath !== ":memory:") await mkdir(dirname(resolvedPath), { recursive: true });

  const database = new Database(resolvedPath, { create: true });
  try {
    database.exec("PRAGMA busy_timeout = 5000;");
    database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA synchronous = NORMAL;
      PRAGMA cache_size = -20000;
      PRAGMA temp_store = MEMORY;
    `);
    await initializeDatabase(database, options);

    const autoVacuumRow = database.query("PRAGMA auto_vacuum;").get() as
      { auto_vacuum: number } | null | undefined;
    if (Number(autoVacuumRow?.auto_vacuum ?? 0) !== 2) {
      if (resolvedPath !== ":memory:")
        console.warn("[db] 正在启用 auto_vacuum=INCREMENTAL，首次整理可能需要一些时间");
      database.exec("PRAGMA auto_vacuum = INCREMENTAL;");
      database.exec("VACUUM;");
    }
    database.exec("PRAGMA journal_mode = WAL;");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
