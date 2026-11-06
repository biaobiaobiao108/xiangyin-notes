import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { snapshotSchema } from "./schema-snapshot";
import { syncNoteTags } from "./core";
import { syncNoteLinks } from "./note-links";
import { extractMarkdownTasks } from "../shared/tasks";
import { extractTags, normalizeTag } from "../shared/tags";
import { rebuildNoteShortSearchIndex, syncNoteShortSearchTerms } from "./note-search";
import { searchContains, searchableTextFromMarkdown, searchSnippet } from "./search-text";

const DEFAULT_DATABASE_PATH = "./data/xiangying-notes.sqlite";
const DEFAULT_SCHEMA_PATH = "./database/schema.sql";
const BASELINE_SCHEMA_VERSION = 1;

// Increment this when adding the next entry to SCHEMA_MIGRATIONS.
export const CURRENT_SCHEMA_VERSION = 17;
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
  {
    sourceVersion: 7,
    targetVersion: 8,
    migrate: (database) => {
      database.exec(`
        CREATE TABLE kanban_cards (
          note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK (status IN ('inbox', 'doing', 'done', 'archived')),
          sort_order REAL NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX idx_kanban_cards_user_status
          ON kanban_cards(user_id, status, sort_order);
      `);
    },
  },
  {
    sourceVersion: 8,
    targetVersion: 9,
    migrate: (database) => {
      database.exec(`
        DROP INDEX idx_note_short_terms_user_term;
        CREATE INDEX idx_note_short_terms_user_term
          ON note_short_terms(user_id, term COLLATE NOCASE, note_id);
      `);
    },
  },
  {
    sourceVersion: 9,
    targetVersion: 10,
    migrate: (database) => {
      database.exec(`
        CREATE VIRTUAL TABLE notes_short_fts USING fts5(
          terms, content='', contentless_delete=1, detail=none, tokenize='ascii'
        );
        CREATE TABLE notes_short_overflow (
          note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE TRIGGER notes_short_fts_delete AFTER DELETE ON notes BEGIN
          DELETE FROM notes_short_fts WHERE rowid = old.rowid;
        END;
      `);
      const notes = database
        .query("SELECT id, user_id, title, content_markdown FROM notes ORDER BY rowid")
        .iterate() as IterableIterator<{
        id: string;
        user_id: string;
        title: string;
        content_markdown: string;
      }>;
      for (const note of notes)
        syncNoteShortSearchTerms(
          database,
          note.user_id,
          note.id,
          note.title,
          note.content_markdown,
          true,
        );
      database.exec("DROP TABLE note_short_terms;");
    },
  },
  {
    sourceVersion: 10,
    targetVersion: 11,
    migrate: (database) => {
      database.exec("DELETE FROM notes_short_fts; DELETE FROM notes_short_overflow;");
      const notes = database
        .query("SELECT id, user_id, title, content_markdown FROM notes ORDER BY rowid")
        .iterate() as IterableIterator<{
        id: string;
        user_id: string;
        title: string;
        content_markdown: string;
      }>;
      for (const note of notes)
        syncNoteShortSearchTerms(
          database,
          note.user_id,
          note.id,
          note.title,
          note.content_markdown,
        );
    },
  },
  {
    sourceVersion: 11,
    targetVersion: 12,
    migrate: (database) => {
      database.exec(`
        CREATE INDEX idx_notes_short_overflow_user
          ON notes_short_overflow(user_id, note_id);
      `);
    },
  },
  {
    sourceVersion: 12,
    targetVersion: 13,
    migrate: (database) => {
      database.exec(`
        CREATE TABLE app_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
      // The short-search row format is bounded more tightly now. Rebuild once
      // so existing databases reclaim the oversized token rows.
      database
        .query("INSERT INTO app_metadata (key, value) VALUES (?, ?)")
        .run(SEARCH_INDEX_REBUILD_KEY, "1");
    },
  },
  {
    sourceVersion: 13,
    targetVersion: 14,
    migrate: (database) => {
      database.exec(`
        DROP TRIGGER notes_short_fts_delete;
        DROP TABLE notes_short_overflow;
        DROP TABLE notes_short_fts;
      `);
    },
  },
  {
    sourceVersion: 14,
    targetVersion: 15,
    migrate: (database) => {
      database.exec("DROP INDEX idx_notes_user_deleted_title;");
    },
  },
  {
    sourceVersion: 15,
    targetVersion: 16,
    migrate: (database) => {
      database.exec(`
        CREATE VIRTUAL TABLE notes_short_fts USING fts5(
          terms, content='', contentless_delete=1, detail=none, tokenize='ascii'
        );
        CREATE TABLE notes_short_overflow (
          note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX idx_notes_short_overflow_user
          ON notes_short_overflow(user_id, note_id);
        CREATE TRIGGER notes_short_fts_delete AFTER DELETE ON notes BEGIN
          DELETE FROM notes_short_fts WHERE rowid = old.rowid;
        END;
        DROP TRIGGER notes_au;
        CREATE TRIGGER notes_au AFTER UPDATE OF title, content_markdown ON notes
        WHEN old.title IS NOT new.title OR old.content_markdown IS NOT new.content_markdown
        BEGIN
          INSERT INTO notes_fts(notes_fts, rowid, title, content_markdown) VALUES('delete', old.rowid, old.title, old.content_markdown);
          INSERT INTO notes_fts(rowid, title, content_markdown) VALUES (new.rowid, new.title, new.content_markdown);
        END;
      `);
      rebuildNoteShortSearchIndex(database);
      if (!notesFtsIntegrityValid(database)) {
        database.exec("INSERT INTO notes_fts(notes_fts) VALUES('rebuild');");
      }
      database.query("DELETE FROM app_metadata WHERE key = ?").run(SEARCH_INDEX_REBUILD_KEY);
    },
  },
  {
    sourceVersion: 16,
    targetVersion: 17,
    migrate: (database) => {
      database.exec("ALTER TABLE notes ADD COLUMN search_text TEXT;");
      const notes = database
        .query("SELECT id, content_markdown FROM notes ORDER BY rowid")
        .all() as Array<{ id: string; content_markdown: string }>;
      const updateSearchText = database.query("UPDATE notes SET search_text = ? WHERE id = ?");
      for (const note of notes)
        updateSearchText.run(searchableTextFromMarkdown(note.content_markdown), note.id);

      database.exec(`
        DROP TRIGGER notes_ai;
        DROP TRIGGER notes_ad;
        DROP TRIGGER notes_au;
        DROP TABLE notes_fts;
        CREATE VIRTUAL TABLE notes_fts USING fts5(
          title,
          search_text,
          content='notes',
          content_rowid='rowid',
          tokenize = 'trigram'
        );
        CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
          INSERT INTO notes_fts(rowid, title, search_text)
          VALUES (new.rowid, new.title, COALESCE(new.search_text, new.content_markdown));
        END;
        CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
          INSERT INTO notes_fts(notes_fts, rowid, title, search_text)
          VALUES ('delete', old.rowid, old.title, COALESCE(old.search_text, old.content_markdown));
        END;
        CREATE TRIGGER notes_au AFTER UPDATE OF title, search_text ON notes
        WHEN old.title IS NOT new.title OR old.search_text IS NOT new.search_text
        BEGIN
          INSERT INTO notes_fts(notes_fts, rowid, title, search_text)
          VALUES ('delete', old.rowid, old.title, COALESCE(old.search_text, old.content_markdown));
          INSERT INTO notes_fts(rowid, title, search_text)
          VALUES (new.rowid, new.title, COALESCE(new.search_text, new.content_markdown));
        END;
      `);
      rebuildNoteShortSearchIndex(database, true);
      database.exec("INSERT INTO notes_fts(notes_fts) VALUES('rebuild');");
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
      INSERT INTO notes_short_fts(notes_short_fts) VALUES('optimize');
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

function notesFtsIntegrityValid(database: SqliteDatabase) {
  try {
    database.exec("INSERT INTO notes_fts(notes_fts, rank) VALUES('integrity-check', 1);");
    return true;
  } catch {
    return false;
  }
}

function rebuildSearchIndexes(database: SqliteDatabase) {
  database
    .transaction(() => {
      const missingSearchText = database
        .query("SELECT id, content_markdown FROM notes WHERE search_text IS NULL ORDER BY rowid")
        .iterate() as IterableIterator<{ id: string; content_markdown: string }>;
      const updateSearchText = database.query("UPDATE notes SET search_text = ? WHERE id = ?");
      for (const note of missingSearchText)
        updateSearchText.run(searchableTextFromMarkdown(note.content_markdown), note.id);
      database.exec("INSERT INTO notes_fts(notes_fts) VALUES('rebuild');");
      rebuildNoteShortSearchIndex(database, true);
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
