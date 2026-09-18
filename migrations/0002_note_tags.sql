CREATE TABLE IF NOT EXISTS note_tags (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tag_normalized TEXT NOT NULL,
  tag TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY(note_id, tag_normalized)
);

CREATE INDEX IF NOT EXISTS idx_note_tags_tag_user ON note_tags(tag_normalized, user_id, note_id);
