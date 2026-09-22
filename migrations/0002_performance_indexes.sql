ALTER TABLE notes ADD COLUMN title_normalized TEXT NOT NULL DEFAULT '';
ALTER TABLE note_links ADD COLUMN target_title_normalized TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_notes_notebook_deleted ON notes(notebook_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_notes_user_deleted_created ON notes(user_id, deleted_at, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_notes_user_deleted_title_nocase ON notes(user_id, deleted_at, title COLLATE NOCASE, id);
CREATE INDEX IF NOT EXISTS idx_notes_user_deleted_title_normalized ON notes(user_id, deleted_at, title_normalized, updated_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_note_links_target_title_normalized ON note_links(user_id, target_title_normalized);
