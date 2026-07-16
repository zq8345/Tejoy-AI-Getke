-- 批⑧ Bug2：回复匹配 —— 存下我们**发出去那封信的 Message-ID**，用来精确认领回复。
--
-- 为什么需要：旧匹配只有一句 `WHERE lower(email) = ?`（发件邮箱严格等于线索邮箱）。
-- B2B 里这是结构性漏的：我们发给公司通用箱（sales@/info@/contact@），**真人用自己的地址回**。
-- 今天的实证：发给 sales@datalake.ph，Michael 用 michael@datalake.ph 回 → 匹配不上 →
-- 状态不推进、飞书不推 → **Joe 完全不知道第一个真客户回信了**（他是自己在邮箱里肉眼看见的）。
-- Joe 库里 185 个邮箱绝大多数是通用箱 → 照这样下去大部分真实回复都会变成孤儿。
--
-- 回信的 In-Reply-To / References 头指向我们原信的 Message-ID → 对上就是**确定匹配**，
-- 与发件地址无关（哪怕用一个从没见过的地址回也认得出）。
--
-- ⚠️ ALTER TABLE ADD COLUMN 在 SQLite 不支持 IF NOT EXISTS，**重复执行会报 duplicate column name**。
--    只跑一次；报这个错说明已经加过了，可安全忽略。
ALTER TABLE emails ADD COLUMN message_id TEXT;

-- 每收到一封回复都要按 In-Reply-To 查一次，加索引
CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(message_id);

-- ---- 孤儿回复的人工关联（Bug2 第三条：匹配不上的必须可见、可手工挂）----
-- 不新加表：孤儿就是 replies 里 lead_id IS NULL 的行，后台「已回复」页顶部会把它们列出来。
-- 这里只加一个索引，让那个查询别随 replies 增长变慢。
CREATE INDEX IF NOT EXISTS idx_replies_orphan ON replies(lead_id, received_at);
