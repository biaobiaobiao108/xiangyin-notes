DELETE FROM sync_changes
WHERE sequence IN (
  SELECT sequence FROM (
    SELECT sequence, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY sequence DESC) AS row_number
    FROM sync_changes
  ) WHERE row_number > 100
);
