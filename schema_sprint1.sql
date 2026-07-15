-- 冲刺1a：开信/点击追踪 + 参与度排序。重复执行时"已存在"报错可忽略。
ALTER TABLE emails ADD COLUMN opened_at   TEXT;                 -- 首次打开时间
ALTER TABLE emails ADD COLUMN open_count  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE emails ADD COLUMN clicked_at  TEXT;                 -- 首次点击时间
ALTER TABLE emails ADD COLUMN click_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leads  ADD COLUMN last_engaged_at TEXT;             -- 最近一次参与(打开/点击)时间，冗余便于排序
CREATE INDEX IF NOT EXISTS idx_leads_last_engaged ON leads(last_engaged_at);
