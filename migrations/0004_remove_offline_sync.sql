-- Offline sync is no longer supported; discard its server-side queues and history.
DROP TABLE IF EXISTS sync_mutations;
DROP TABLE IF EXISTS sync_tombstones;
DROP TABLE IF EXISTS sync_changes;
