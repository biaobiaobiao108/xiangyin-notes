PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS notebooks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#d96245',
  is_system INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_notebooks_user_order ON notebooks(user_id, sort_order, name);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE RESTRICT,
  title TEXT NOT NULL DEFAULT '未命名笔记',
  content_markdown TEXT NOT NULL DEFAULT '',
  is_favorite INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notes_user_deleted_updated ON notes(user_id, deleted_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_user_notebook_deleted_updated ON notes(user_id, notebook_id, deleted_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_user_deleted_title ON notes(user_id, deleted_at, title);

CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  snapshot_title TEXT NOT NULL DEFAULT '',
  snapshot_content_markdown TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_shares_note ON shares(note_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shares_expiry ON shares(expires_at);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  note_id UNINDEXED,
  title,
  content,
  tokenize = 'trigram'
);

CREATE TABLE IF NOT EXISTS image_assets (
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

CREATE INDEX IF NOT EXISTS idx_image_assets_note_order ON image_assets(note_id, document_order, created_at);
CREATE INDEX IF NOT EXISTS idx_image_assets_user ON image_assets(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_image_assets_note_thumbnail ON image_assets(note_id) WHERE note_id IS NOT NULL AND document_order = 0;

CREATE TABLE IF NOT EXISTS note_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  target_title TEXT NOT NULL,
  target_note_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_note_links_source ON note_links(user_id, source_note_id);
CREATE INDEX IF NOT EXISTS idx_note_links_target ON note_links(user_id, target_note_id);
CREATE INDEX IF NOT EXISTS idx_note_links_target_title ON note_links(user_id, target_title);

CREATE TABLE IF NOT EXISTS note_tags (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tag_normalized TEXT NOT NULL,
  tag TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY(note_id, tag_normalized)
);

CREATE INDEX IF NOT EXISTS idx_note_tags_tag_user ON note_tags(tag_normalized, user_id, note_id);
