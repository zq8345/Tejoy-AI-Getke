-- Landing 落地页：公开表单频率限制表（防滥用，配合 honeypot）。
-- k = "ip:<CF-Connecting-IP>" 或 "email:<lower>"；Cron 清理 >1 天的旧记录，防膨胀。
CREATE TABLE IF NOT EXISTS inbound_throttle (
  k       TEXT PRIMARY KEY,
  last_at TEXT NOT NULL DEFAULT (datetime('now'))
);
