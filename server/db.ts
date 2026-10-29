import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { snapshotSchema } from "./schema-snapshot";
import { syncNoteTags } from "./core";
import { syncNoteLinks } from "./note-links";
import { extractMarkdownTasks } from "../shared/tasks";
import { extractTags, normalizeTag } from "../shared/tags";

const DEFAULT_DATABASE_PATH = "./data/xiangying-notes.sqlite";
const DEFAULT_SCHEMA_PATH = "./database/schema.sql";
const BASELINE_SCHEMA_VERSION = 1;

// Increment this when adding the next entry to SCHEMA_MIGRATIONS.
export const CURRENT_SCHEMA_VERSION = 7;

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
const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  {
    sourceVersion: 1,
    targetVersion: 2,
    migrate: (database) => {
      database.exec(`
        CREATE TABLE note_tasks (
          note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE RESTRICT,
          ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
          depth INTEGER NOT NULL CHECK (depth >= 0),
          text TEXT NOT NULL,
          done INTEGER NOT NULL CHECK (done IN (0, 1)),
          sort_updated_at INTEGER NOT NULL,
          PRIMARY KEY (note_id, ordinal)
        );
        CREATE TABLE note_task_counts (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
          done INTEGER NOT NULL CHECK (done IN (0, 1)),
          task_count INTEGER NOT NULL CHECK (task_count > 0),
          PRIMARY KEY (user_id, notebook_id, done)
        );
        CREATE INDEX idx_note_tasks_user_recent
          ON note_tasks(user_id, sort_updated_at, note_id, ordinal);
        CREATE INDEX idx_note_tasks_user_done_recent
          ON note_tasks(user_id, done, sort_updated_at, note_id, ordinal);
        CREATE INDEX idx_note_tasks_notebook_recent
          ON note_tasks(user_id, notebook_id, sort_updated_at, note_id, ordinal);
        CREATE INDEX idx_note_tasks_notebook_done_recent
          ON note_tasks(user_id, notebook_id, done, sort_updated_at, note_id, ordinal);
        CREATE INDEX idx_note_task_counts_user_done
          ON note_task_counts(user_id, done, notebook_id);
      `);

      const insertTask = database.query(
        "INSERT INTO note_tasks (note_id, user_id, notebook_id, ordinal, depth, text, done, sort_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const insertTaskCount = database.query(
        "INSERT INTO note_task_counts (user_id, notebook_id, done, task_count) VALUES (?, ?, ?, ?)",
      );
      const taskCounts = new Map<
        string,
        { userId: string; notebookId: string; done: number; count: number }
      >();
      const notes = database
        .query(
          "SELECT id, user_id, notebook_id, content_markdown, updated_at FROM notes WHERE deleted_at IS NULL ORDER BY id",
        )
        .iterate() as IterableIterator<{
        id: string;
        user_id: string;
        notebook_id: string;
        content_markdown: string;
        updated_at: number;
      }>;
      for (const note of notes) {
        for (const task of extractMarkdownTasks(note.content_markdown)) {
          const done = task.completed ? 1 : 0;
          insertTask.run(
            note.id,
            note.user_id,
            note.notebook_id,
            task.ordinal,
            task.depth,
            task.text,
            done,
            -note.updated_at,
          );
          const countKey = `${note.user_id}\0${note.notebook_id}\0${done}`;
          const count = taskCounts.get(countKey);
          if (count) count.count += 1;
          else
            taskCounts.set(countKey, {
              userId: note.user_id,
              notebookId: note.notebook_id,
              done,
              count: 1,
            });
        }
      }
      for (const count of taskCounts.values())
        insertTaskCount.run(count.userId, count.notebookId, count.done, count.count);
    },
  },
  {
    sourceVersion: 2,
    targetVersion: 3,
    migrate: (database) => {
      database.exec(`
        CREATE INDEX idx_notes_user_deleted_updated_id
          ON notes(user_id, deleted_at, updated_at DESC, id DESC);
        CREATE INDEX idx_notes_user_notebook_deleted_updated_id
          ON notes(user_id, notebook_id, deleted_at, updated_at DESC, id DESC);
        CREATE INDEX idx_notes_user_trash_updated
          ON notes(user_id, updated_at DESC, id DESC)
          WHERE deleted_at IS NOT NULL;
        CREATE INDEX idx_notes_user_favorites_updated
          ON notes(user_id, updated_at DESC, id DESC)
          WHERE deleted_at IS NULL AND is_favorite = 1;
        CREATE INDEX idx_sessions_user ON sessions(user_id);
        CREATE INDEX idx_note_links_source_note ON note_links(source_note_id, user_id);
        CREATE INDEX idx_note_links_target_note ON note_links(target_note_id, user_id)
          WHERE target_note_id IS NOT NULL;

        DROP INDEX idx_notes_user_deleted_updated;
        DROP INDEX idx_notes_user_notebook_deleted_updated;
        DROP INDEX idx_note_links_target_title;
      `);
    },
  },
  {
    sourceVersion: 3,
    targetVersion: 4,
    migrate: (database) => {
      database.exec(`
        ALTER TABLE note_tasks RENAME COLUMN sort_updated_at TO sort_created_at;
        UPDATE note_tasks
        SET sort_created_at = -(
          SELECT created_at FROM notes WHERE notes.id = note_tasks.note_id
        );
      `);
    },
  },
  {
    sourceVersion: 4,
    targetVersion: 5,
    migrate: (database) => {
      // Rebuild the derived task index so deployments recover any drift from
      // earlier trash, notebook-move, or permanent-delete paths.
      database.exec("DELETE FROM note_tasks; DELETE FROM note_task_counts;");

      const insertTask = database.query(
        "INSERT INTO note_tasks (note_id, user_id, notebook_id, ordinal, depth, text, done, sort_created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const insertTaskCount = database.query(
        "INSERT INTO note_task_counts (user_id, notebook_id, done, task_count) VALUES (?, ?, ?, ?)",
      );
      const taskCounts = new Map<
        string,
        { userId: string; notebookId: string; done: number; count: number }
      >();
      const notes = database
        .query(
          "SELECT id, user_id, notebook_id, content_markdown, created_at FROM notes WHERE deleted_at IS NULL ORDER BY id",
        )
        .iterate() as IterableIterator<{
        id: string;
        user_id: string;
        notebook_id: string;
        content_markdown: string;
        created_at: number;
      }>;
      for (const note of notes) {
        for (const task of extractMarkdownTasks(note.content_markdown)) {
          const done = task.completed ? 1 : 0;
          insertTask.run(
            note.id,
            note.user_id,
            note.notebook_id,
            task.ordinal,
            task.depth,
            task.text,
            done,
            -note.created_at,
          );
          const countKey = note.user_id + "\0" + note.notebook_id + "\0" + done;
          const count = taskCounts.get(countKey);
          if (count) count.count += 1;
          else
            taskCounts.set(countKey, {
              userId: note.user_id,
              notebookId: note.notebook_id,
              done,
              count: 1,
            });
        }
      }
      for (const count of taskCounts.values())
        insertTaskCount.run(count.userId, count.notebookId, count.done, count.count);
    },
  },
  {
    sourceVersion: 5,
    targetVersion: 6,
    migrate: (database) => {
      // Rebuild tags after the Markdown parser began ignoring code fences inside blockquotes.
      database.exec("DELETE FROM note_tags;");
      const insertTag = database.query(
        "INSERT INTO note_tags (note_id, user_id, tag_normalized, tag, position) VALUES (?, ?, ?, ?, ?)",
      );
      const notes = database
        .query("SELECT id, user_id, content_markdown FROM notes ORDER BY id")
        .iterate() as IterableIterator<{
        id: string;
        user_id: string;
        content_markdown: string;
      }>;

      for (const note of notes) {
        const seen = new Set<string>();
        let position = 0;
        for (const tag of extractTags(note.content_markdown)) {
          const normalized = normalizeTag(tag);
          if (seen.has(normalized)) continue;
          seen.add(normalized);
          insertTag.run(note.id, note.user_id, normalized, tag, position++);
        }
      }
    },
  },
  {
    sourceVersion: 6,
    targetVersion: 7,
    migrate: (database) => {
      // Remove links and tags previously indexed from nested Markdown code blocks.
      const notes = database
        .query("SELECT id, user_id, content_markdown, updated_at FROM notes ORDER BY id")
        .iterate() as IterableIterator<{
        id: string;
        user_id: string;
        content_markdown: string;
        updated_at: number;
      }>;
      for (const note of notes) {
        syncNoteLinks(database, note.user_id, note.id, note.content_markdown, note.updated_at);
        syncNoteTags(database, note.user_id, note.id, note.content_markdown);
      }
    },
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
      database.exec("INSERT INTO notes_fts(notes_fts) VALUES('rebuild');");
    }
    database.exec("PRAGMA journal_mode = WAL;");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
