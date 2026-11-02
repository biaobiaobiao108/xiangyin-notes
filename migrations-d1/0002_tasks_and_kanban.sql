-- Tasks, kanban, app metadata, and query index optimizations.
CREATE TABLE IF NOT EXISTS note_tasks (
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

CREATE TABLE IF NOT EXISTS note_task_counts (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  done INTEGER NOT NULL CHECK (done IN (0, 1)),
  task_count INTEGER NOT NULL CHECK (task_count > 0),
  PRIMARY KEY (user_id, notebook_id, done)
);

CREATE INDEX IF NOT EXISTS idx_note_tasks_user_recent
  ON note_tasks(user_id, sort_created_at, note_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_note_tasks_user_done_recent
  ON note_tasks(user_id, done, sort_created_at, note_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_note_tasks_notebook_recent
  ON note_tasks(user_id, notebook_id, sort_created_at, note_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_note_tasks_notebook_done_recent
  ON note_tasks(user_id, notebook_id, done, sort_created_at, note_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_note_task_counts_user_done
  ON note_task_counts(user_id, done, notebook_id);

CREATE TABLE IF NOT EXISTS kanban_cards (
  note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('inbox', 'doing', 'done', 'archived')),
  sort_order REAL NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_kanban_cards_user_status
  ON kanban_cards(user_id, status, sort_order);

CREATE TABLE IF NOT EXISTS app_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS note_asset_references (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES image_assets(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_order INTEGER,
  PRIMARY KEY (note_id, asset_id)
);

CREATE INDEX IF NOT EXISTS idx_note_asset_references_asset
  ON note_asset_references(asset_id);

CREATE INDEX IF NOT EXISTS idx_notes_user_deleted_updated_id
  ON notes(user_id, deleted_at, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_notes_user_notebook_deleted_updated_id
  ON notes(user_id, notebook_id, deleted_at, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_notes_user_trash_updated
  ON notes(user_id, updated_at DESC, id DESC)
  WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notes_user_favorites_updated
  ON notes(user_id, updated_at DESC, id DESC)
  WHERE deleted_at IS NULL AND is_favorite = 1;
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_note_links_source_note ON note_links(source_note_id, user_id);
CREATE INDEX IF NOT EXISTS idx_note_links_target_note ON note_links(target_note_id, user_id)
  WHERE target_note_id IS NOT NULL;

DROP INDEX IF EXISTS idx_notes_user_deleted_updated;
DROP INDEX IF EXISTS idx_notes_user_notebook_deleted_updated;
DROP INDEX IF EXISTS idx_note_links_target_title;
DROP INDEX IF EXISTS idx_notes_user_deleted_title;
DROP TABLE IF EXISTS note_short_terms;
