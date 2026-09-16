ALTER TABLE sync_mutations ADD COLUMN request_hash TEXT NOT NULL DEFAULT '';

DELETE FROM sync_changes
WHERE sequence NOT IN (
  SELECT MAX(sequence)
  FROM sync_changes
  GROUP BY user_id, entity_type, entity_id
);

UPDATE sync_changes SET payload_json = NULL;
