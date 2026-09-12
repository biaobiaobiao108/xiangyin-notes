CREATE TABLE IF NOT EXISTS sync_tombstones (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('note', 'notebook')),
  entity_id TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, entity_type, entity_id)
);

INSERT OR IGNORE INTO sync_tombstones (user_id, entity_type, entity_id, deleted_at)
SELECT user_id, entity_type, entity_id, created_at
FROM sync_changes
WHERE operation = 'delete';
