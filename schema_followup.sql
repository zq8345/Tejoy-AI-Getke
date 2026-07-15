-- 迁移：邮件区分 初次(initial) / 跟进(followup)，用于无回复自动跟进
ALTER TABLE emails ADD COLUMN kind TEXT DEFAULT 'initial';
CREATE INDEX IF NOT EXISTS idx_emails_kind ON emails(kind);
