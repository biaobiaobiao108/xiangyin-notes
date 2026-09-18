-- Upgrade notes_fts to FTS5 trigram tokenizer for CJK substring search
DROP TABLE IF EXISTS notes_fts;

CREATE VIRTUAL TABLE notes_fts USING fts5(
  note_id UNINDEXED,
  title,
  content,
  tokenize = 'trigram'
);

INSERT INTO notes_fts (note_id, title, content)
SELECT id, title, content_markdown
FROM notes;

CREATE INDEX IF NOT EXISTS idx_notes_user_deleted_title ON notes(user_id, deleted_at, title);
