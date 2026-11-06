PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE notebooks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#d96245',
  icon TEXT NOT NULL DEFAULT 'folder',
  is_system INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, name)
);

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE RESTRICT,
  title TEXT NOT NULL DEFAULT '未命名笔记',
  title_normalized TEXT NOT NULL DEFAULT '',
  content_markdown TEXT NOT NULL DEFAULT '',
  is_favorite INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
, search_text TEXT);

CREATE TABLE image_assets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note_id TEXT REFERENCES notes(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  document_order INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE note_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  target_title TEXT NOT NULL,
  target_title_normalized TEXT NOT NULL DEFAULT '',
  target_note_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
  snippet TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE note_tags (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tag_normalized TEXT NOT NULL,
  tag TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY(note_id, tag_normalized)
);

CREATE TABLE rate_limits (
  action TEXT NOT NULL,
  key TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  window_started_at INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(action, key)
);

CREATE TABLE note_tasks (
          note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE RESTRICT,
          ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
          depth INTEGER NOT NULL CHECK (depth >= 0),
          text TEXT NOT NULL,
          done INTEGER NOT NULL CHECK (done IN (0, 1)),
          sort_created_at INTEGER NOT NULL,
          PRIMARY KEY (note_id, ordinal)
        );

CREATE TABLE note_task_counts (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
          done INTEGER NOT NULL CHECK (done IN (0, 1)),
          task_count INTEGER NOT NULL CHECK (task_count > 0),
          PRIMARY KEY (user_id, notebook_id, done)
        );

CREATE TABLE kanban_cards (
          note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK (status IN ('inbox', 'doing', 'done', 'archived')),
          sort_order REAL NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

CREATE TABLE app_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

CREATE VIRTUAL TABLE notes_short_fts USING fts5(
          terms, content='', contentless_delete=1, detail=none, tokenize='ascii'
        );

CREATE TABLE notes_short_overflow (
          note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
        );

CREATE VIRTUAL TABLE notes_fts USING fts5(
          title,
          search_text,
          content='notes',
          content_rowid='rowid',
          tokenize = 'trigram'
        );

CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

CREATE INDEX idx_notebooks_user_order ON notebooks(user_id, sort_order, name);

CREATE INDEX idx_notes_notebook_deleted ON notes(notebook_id, deleted_at);

CREATE INDEX idx_notes_user_deleted_created ON notes(user_id, deleted_at, created_at DESC, id DESC);

CREATE INDEX idx_notes_user_deleted_title_nocase ON notes(user_id, deleted_at, title COLLATE NOCASE, id);

CREATE INDEX idx_notes_user_deleted_title_normalized ON notes(user_id, deleted_at, title_normalized, updated_at DESC, id);

CREATE INDEX idx_image_assets_note_order ON image_assets(note_id, document_order, created_at);

CREATE INDEX idx_image_assets_user ON image_assets(user_id, created_at DESC);

CREATE UNIQUE INDEX idx_image_assets_note_thumbnail ON image_assets(note_id) WHERE note_id IS NOT NULL AND document_order = 0;

CREATE INDEX idx_note_links_source ON note_links(user_id, source_note_id);

CREATE INDEX idx_note_links_target ON note_links(user_id, target_note_id);

CREATE INDEX idx_note_links_target_title_normalized ON note_links(user_id, target_title_normalized);

CREATE INDEX idx_note_tags_tag_user ON note_tags(tag_normalized, user_id, note_id);

CREATE INDEX idx_rate_limits_action_expiry ON rate_limits(action, blocked_until, window_started_at);

CREATE INDEX idx_note_tasks_user_recent
          ON note_tasks(user_id, sort_created_at, note_id, ordinal);

CREATE INDEX idx_note_tasks_user_done_recent
          ON note_tasks(user_id, done, sort_created_at, note_id, ordinal);

CREATE INDEX idx_note_tasks_notebook_recent
          ON note_tasks(user_id, notebook_id, sort_created_at, note_id, ordinal);

CREATE INDEX idx_note_tasks_notebook_done_recent
          ON note_tasks(user_id, notebook_id, done, sort_created_at, note_id, ordinal);

CREATE INDEX idx_note_task_counts_user_done
          ON note_task_counts(user_id, done, notebook_id);

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

CREATE INDEX idx_kanban_cards_user_status
          ON kanban_cards(user_id, status, sort_order);

CREATE INDEX idx_notes_short_overflow_user
          ON notes_short_overflow(user_id, note_id);

CREATE TRIGGER notes_short_fts_delete AFTER DELETE ON notes BEGIN
          DELETE FROM notes_short_fts WHERE rowid = old.rowid;
        END;

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

PRAGMA user_version = 1;
