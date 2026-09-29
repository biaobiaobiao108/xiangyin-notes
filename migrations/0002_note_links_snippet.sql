-- 为 note_links 补齐 snippet 列与标题索引。
-- 0001_baseline.sql 已被部分数据库应用过，不能就地修改，因此这里用「重建表」的写法，
-- 无论源表是否已有 snippet 列都可以安全执行（结果一致：统一为空串，反向链接会在读取时重新生成上下文）。
CREATE TABLE IF NOT EXISTS note_links_rebuilt (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  target_title TEXT NOT NULL,
  target_title_normalized TEXT NOT NULL DEFAULT '',
  target_note_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
  snippet TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

INSERT INTO note_links_rebuilt (id, user_id, source_note_id, target_title, target_title_normalized, target_note_id, snippet, created_at)
SELECT id, user_id, source_note_id, target_title, target_title_normalized, target_note_id, '', created_at FROM note_links;

DROP TABLE note_links;

ALTER TABLE note_links_rebuilt RENAME TO note_links;

CREATE INDEX IF NOT EXISTS idx_note_links_source ON note_links(user_id, source_note_id);
CREATE INDEX IF NOT EXISTS idx_note_links_target ON note_links(user_id, target_note_id);
CREATE INDEX IF NOT EXISTS idx_note_links_target_title ON note_links(user_id, target_title);
CREATE INDEX IF NOT EXISTS idx_note_links_target_title_normalized ON note_links(user_id, target_title_normalized);

-- 同一原因：rate_limits 表也是后来才进 baseline 的，旧库没有它，登录与导入限流会直接报 no such table。
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
