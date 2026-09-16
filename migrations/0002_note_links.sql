CREATE TABLE IF NOT EXISTS note_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  target_title TEXT NOT NULL,
  target_note_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_note_links_user_source ON note_links(user_id, source_note_id);
CREATE INDEX IF NOT EXISTS idx_note_links_user_target_title ON note_links(user_id, target_title);
CREATE INDEX IF NOT EXISTS idx_note_links_user_target_id ON note_links(user_id, target_note_id);
