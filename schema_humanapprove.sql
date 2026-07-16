-- 翻牌堆 human override：Joe 亲手对单条 <60 的线索按下「手动发这家」时的标记。
--
-- 为什么需要它：两档制下机器只发 ≥60。但机器**误杀一个真客户 = 损失一单、不可见、无兜底**
-- （cayelectronics.vg 船舶电子 / 12volt.com.au 房车电源 / flarespace.com 房车改装 都被埋过）。
-- 所以 <60 里 Joe 认出来的真客户，必须有一条路能发出去。
--
-- ⚠️ 这是**唯一能让 <60 的信发出去的口子**，安全约束（实测必须证明）：
--   1) 只能由「翻牌堆里对单条按下按钮」这一个端点写入 —— 没有任何批量入口、没有任何自动路径能置 1
--   2) approveGateReason 在 human_approved=1 时**只豁免分数线**，邮箱仍然必须有
--   3) 幂等 / 压制名单 / 每日上限 / 原子取批 **一个都不豁免**
--   4) 自动批准（cron）**绝不看这个字段** —— 它只收 ≥auto_approve_min 的，
--      human_approved 的线索由 Joe 按钮当场置 approved，不经过 cron
--
-- ⚠️ ALTER TABLE ADD COLUMN 在 SQLite 不支持 IF NOT EXISTS，**重复执行会报 duplicate column name**。
--    只跑一次；报这个错说明已经加过了，可安全忽略。
ALTER TABLE leads ADD COLUMN human_approved INTEGER NOT NULL DEFAULT 0;

-- sendApprovedBatch 的取数条件变成 (a.match_score>=60 OR l.human_approved=1)，给它建索引
CREATE INDEX IF NOT EXISTS idx_leads_human_approved ON leads(human_approved, status);

-- ---- 触达工作台（D）----
-- bench_queued：Joe 在翻牌堆里把一条 <60 但有社媒渠道的线索「转工作台」。
--   工作台的默认队列是「≥60 且 无邮箱 且 channels 非空」；这个标记是让 <60 的也能进队列的**唯一**入口，
--   同样只由单条端点写入。工作台里**没有任何自动发送** —— 全是 Joe 的手，所以它不像 human_approved 那样敏感。
ALTER TABLE leads ADD COLUMN bench_queued INTEGER NOT NULL DEFAULT 0;

-- bench_contacted_at / bench_channel：工作台里按「已联系」记录的渠道与时间。
-- ⚠️ 这两个必须落库（不能只存在 UI 里）：机器的跟进逻辑要认识它们 ——
--    最关键的是"以后补到邮箱时，别再给一个已经在 WhatsApp 联系过的人发首封开发信"。
ALTER TABLE leads ADD COLUMN bench_contacted_at TEXT;
ALTER TABLE leads ADD COLUMN bench_channel TEXT;
CREATE INDEX IF NOT EXISTS idx_leads_bench ON leads(bench_queued, bench_contacted_at);
