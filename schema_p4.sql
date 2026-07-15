-- P4 回复处理：给 replies 表补字段（SQLite 支持 ADD COLUMN；已存在会报错，忽略即可）
ALTER TABLE replies ADD COLUMN from_email TEXT;
ALTER TABLE replies ADD COLUMN subject TEXT;
ALTER TABLE replies ADD COLUMN summary TEXT;
ALTER TABLE replies ADD COLUMN message_id TEXT;
-- 防重复：同一封邮件只入库一次
CREATE UNIQUE INDEX IF NOT EXISTS idx_replies_msgid ON replies(message_id);
