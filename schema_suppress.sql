-- M3 整改：持久压制名单（不依赖可变 status 字段，防"两跳洗白"绕过 + 同邮箱重导入复发）
-- email 一律小写存入；发送前 deliverEmail 硬查此表命中即 skip。
CREATE TABLE IF NOT EXISTS suppressed_emails (
  email      TEXT PRIMARY KEY,   -- 小写邮箱
  reason     TEXT,               -- unsubscribe / bounced / complaint / manual:<status>
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
