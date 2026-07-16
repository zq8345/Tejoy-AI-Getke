-- 自动批准 + 自动发送 + 熔断器：给 emails 标记"这封是自动发的"。
--
-- 为什么必须区分手动/自动：
--   1) 自动发送有独立的每日上限（auto_send_daily_limit=15），不复用手动的 daily_send_limit=50 ——
--      要算"今天自动发了几封"就必须能把自动的挑出来
--   2) 熔断器的窗口是"最近 30 封**自动发出的初次开发信**"。手动发的不能算进来：
--      Joe 手动挑着发的那批，退订率高低跟"自动发送该不该停"是两回事。
--
-- ⚠️ ALTER TABLE ADD COLUMN 在 SQLite 不支持 IF NOT EXISTS，**重复执行会报 duplicate column name**。
--    只跑一次；报这个错说明已经加过了，可安全忽略。
ALTER TABLE emails ADD COLUMN auto_sent INTEGER NOT NULL DEFAULT 0;

-- 熔断器每轮 cron 都查一次"最近 30 封自动初次信"，加索引免得随 emails 增长变慢。
CREATE INDEX IF NOT EXISTS idx_emails_auto_window ON emails(auto_sent, kind, status, sent_at);
