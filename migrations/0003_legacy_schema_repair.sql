-- The baseline was updated after early installations had already recorded it.
-- Add the backlinks snippet only when an older database still lacks the column.
-- @if-column-missing note_links.snippet
ALTER TABLE note_links ADD COLUMN snippet TEXT NOT NULL DEFAULT '';
-- @endif

CREATE TABLE IF NOT EXISTS rate_limits (
  action TEXT NOT NULL,
  key TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  window_started_at INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(action, key)
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_action_expiry ON rate_limits(action, blocked_until, window_started_at);
