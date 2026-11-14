import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { snapshotSchema } from "./schema-snapshot";
import { rebuildNoteShortSearchIndex } from "./note-search";
import { searchContains, searchableTextFromMarkdown, searchSnippet } from "./search-text";

const DEFAULT_DATABASE_PATH = "./data/xiangying-notes.sqlite";
const DEFAULT_SCHEMA_PATH = "./database/schema.sql";
const BASELINE_SCHEMA_VERSION = 1;

export const CURRENT_SCHEMA_VERSION = 6;
export const SEARCH_INDEX_REBUILD_KEY = "search-index-rebuild-required";

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

const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  {
    sourceVersion: 1,
    targetVersion: 2,
    migrate: (database) =>
      database.exec(
        "ALTER TABLE users ADD COLUMN password_iterations INTEGER NOT NULL DEFAULT 100000",
      ),
  },
  {
    sourceVersion: 2,
    targetVersion: 3,
    migrate: (database) =>
      database.exec(`
        CREATE TABLE memos (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          content_markdown TEXT NOT NULL,
          search_text TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE memo_tags (
          memo_id TEXT NOT NULL REFERENCES memos(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          tag_normalized TEXT NOT NULL,
          tag TEXT NOT NULL,
          position INTEGER NOT NULL,
          PRIMARY KEY(memo_id, tag_normalized)
        );

        CREATE VIRTUAL TABLE memos_fts USING fts5(
          search_text,
          content='memos',
          content_rowid='rowid',
          tokenize = 'trigram'
        );

        CREATE INDEX idx_memos_user_created
          ON memos(user_id, created_at DESC, id DESC);

        CREATE INDEX idx_memo_tags_tag_user
          ON memo_tags(tag_normalized, user_id, memo_id);

        CREATE INDEX idx_memo_tags_user_memo
          ON memo_tags(user_id, memo_id);

        CREATE TRIGGER memos_ai AFTER INSERT ON memos BEGIN
          INSERT INTO memos_fts(rowid, search_text)
          VALUES (new.rowid, new.search_text);
        END;

        CREATE TRIGGER memos_ad AFTER DELETE ON memos BEGIN
          INSERT INTO memos_fts(memos_fts, rowid, search_text)
          VALUES ('delete', old.rowid, old.search_text);
        END;

        CREATE TRIGGER memos_au AFTER UPDATE OF search_text ON memos
        WHEN old.search_text IS NOT new.search_text
        BEGIN
          INSERT INTO memos_fts(memos_fts, rowid, search_text)
          VALUES ('delete', old.rowid, old.search_text);
          INSERT INTO memos_fts(rowid, search_text)
          VALUES (new.rowid, new.search_text);
        END;
      `),
  },
  {
    sourceVersion: 3,
    targetVersion: 4,
    migrate: (database) =>
      database.exec(`
        DROP INDEX IF EXISTS idx_note_links_source;
        DROP INDEX IF EXISTS idx_note_links_target;
      `),
  },
  {
    sourceVersion: 4,
    targetVersion: 5,
    migrate: (database) =>
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_memo_tags_user_tag
          ON memo_tags(user_id, tag_normalized, tag);
      `),
  },
  {
    sourceVersion: 5,
    targetVersion: 6,
    migrate: (database) => database.exec("ALTER TABLE image_assets ADD COLUMN orphaned_at INTEGER"),
  },
];

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
      INSERT INTO notes_short_fts(notes_short_fts) VALUES('optimize');
      INSERT INTO memos_fts(memos_fts) VALUES('optimize');
    `);
  } catch (error) {
    console.warn("[db] FTS optimize failed; continuing space reclaim", error);
  }
  database.exec("PRAGMA incremental_vacuum;");
  checkpointDatabase(database);
}

export function checkpointDatabase(database: SqliteDatabase) {
  database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
}

function searchIndexRebuildPending(database: SqliteDatabase) {
  return Boolean(
    database
      .query("SELECT 1 FROM app_metadata WHERE key = ? AND value = '1'")
      .get(SEARCH_INDEX_REBUILD_KEY),
  );
}

function markSearchIndexesForRebuild(database: SqliteDatabase) {
  database
    .query(
      "INSERT INTO app_metadata (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(SEARCH_INDEX_REBUILD_KEY);
}

function rebuildSearchIndexes(database: SqliteDatabase) {
  database
    .transaction(() => {
      const missingSearchText = database.query(
        "SELECT id, content_markdown FROM notes WHERE search_text IS NULL AND id > ? ORDER BY id LIMIT 100",
      );
      const updateSearchText = database.query("UPDATE notes SET search_text = ? WHERE id = ?");
      let lastId = "";
      while (true) {
        const notes = missingSearchText.all(lastId) as Array<{
          id: string;
          content_markdown: string;
        }>;
        if (!notes.length) break;
        for (const note of notes)
          updateSearchText.run(searchableTextFromMarkdown(note.content_markdown), note.id);
        lastId = notes[notes.length - 1]!.id;
      }
      const missingMemoSearchText = database.query(
        "SELECT id, content_markdown FROM memos WHERE search_text = '' AND id > ? ORDER BY id LIMIT 100",
      );
      const updateMemoSearchText = database.query("UPDATE memos SET search_text = ? WHERE id = ?");
      let lastMemoId = "";
      while (true) {
        const memos = missingMemoSearchText.all(lastMemoId) as Array<{
          id: string;
          content_markdown: string;
        }>;
        if (!memos.length) break;
        for (const memo of memos)
          updateMemoSearchText.run(searchableTextFromMarkdown(memo.content_markdown), memo.id);
        lastMemoId = memos[memos.length - 1]!.id;
      }
      database.exec("INSERT INTO notes_fts(notes_fts) VALUES('rebuild');");
      database.exec("INSERT INTO memos_fts(memos_fts) VALUES('rebuild');");
      rebuildNoteShortSearchIndex(database);
      database.query("DELETE FROM app_metadata WHERE key = ?").run(SEARCH_INDEX_REBUILD_KEY);
    })
    .immediate();
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

export async function createExpectedSchemaDatabase(
  version: number,
  options: DatabaseInitializationOptions = {},
) {
  const schemaPath = options.schemaPath ?? DEFAULT_SCHEMA_PATH;
  const schemaFile = Bun.file(schemaPath);
  if (!(await schemaFile.exists()))
    throw new Error(`SQLite schema baseline not found: ${schemaPath}`);
  return createSchemaAtVersion(
    await schemaFile.text(),
    version,
    options.migrations ?? SCHEMA_MIGRATIONS,
    options.currentSchemaVersion ?? CURRENT_SCHEMA_VERSION,
  );
}

export async function initializeDatabase(
  database: SqliteDatabase,
  options: DatabaseInitializationOptions = {},
) {
  database.function("search_contains", (text: string, term: string) =>
    searchContains(text, term) ? 1 : 0,
  );
  database.function("search_snippet", searchSnippet);
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
    const needsAutoVacuum = Number(autoVacuumRow?.auto_vacuum ?? 0) !== 2;
    const needsSearchRebuild = searchIndexRebuildPending(database);
    if (needsAutoVacuum) {
      if (resolvedPath !== ":memory:")
        console.warn("[db] 正在启用 auto_vacuum=INCREMENTAL，首次整理可能需要一些时间");
      // Persist intent before VACUUM: the write can otherwise leave rowids
      // changed while the process dies before the derived indexes are rebuilt.
      markSearchIndexesForRebuild(database);
      database.exec("PRAGMA auto_vacuum = INCREMENTAL;");
      database.exec("VACUUM;");
    }
    if (needsAutoVacuum || needsSearchRebuild) {
      // Full VACUUM is allowed to renumber rowids for tables without an
      // INTEGER PRIMARY KEY. Rebuild the rowid-keyed index in one transaction
      // and clear the marker only after it is consistent.
      rebuildSearchIndexes(database);
    }
    database.exec("PRAGMA journal_mode = WAL;");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
