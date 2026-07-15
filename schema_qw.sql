-- 快赢三条迁移：联系渠道 + 轻CRM(下一步提醒)。重复执行时"已存在"报错可忽略。
ALTER TABLE leads ADD COLUMN channels TEXT;           -- 社媒/IM/电话 渠道，JSON: {linkedin,facebook,instagram,youtube,whatsapp,telegram,phone}
ALTER TABLE leads ADD COLUMN next_action TEXT;        -- 下一步动作（人工填，轻CRM）
ALTER TABLE leads ADD COLUMN next_action_date TEXT;   -- 下一步日期 YYYY-MM-DD（到期即"该跟进了"）
CREATE INDEX IF NOT EXISTS idx_leads_next_action_date ON leads(next_action_date);
