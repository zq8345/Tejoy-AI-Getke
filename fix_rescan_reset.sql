-- ⚠️ 批⑥A 全量重扫 · 存量重置。**我只写，你跑。**
--
-- Joe 原话："现有的428个信息要全部重新分析打分"。原因：这几天标准被重定了
-- （H3-v2 去掉体量闸 / 来源背书 / 首页 18s 超时 / 证据页优先），库里的分数是新旧标准的混合物。
--
-- ============ 跑之前必须先做的两件事 ============
--   1) **auto_send_enabled 必须是 0**（你已经置了）。重置会把 81 家 approved 打回 new，
--      如果自动发送开着，重扫过程中它们重新拿到 ≥60 就会被立刻发出去 —— 那正是"按刚被宣布
--      作废的旧流程发信"。跑第 0 步会帮你确认这一条。
--   2) **先部署带 rescanTick 的版本**。否则重置完没人捡，433 家全躺在 new 里等 6h 主班
--      按 12/班 慢慢啃（要 9 天）。
--
-- ============ 顺序（别跳步）============
--   第 0 步 自检 → 第 1 步 打时间戳 → 第 2 步 重置组 → 第 3 步 核对
--   打时间戳必须在重置**之前**：rescanTick 靠 `analyzed_at < rescan_started_at` 判断"谁还没扫"，
--   时间戳晚于重置的话，重置瞬间到打戳之间被扫过的线索会被判成"已扫"而漏掉。

-- ========== 第 0 步：自检（只读，先跑，两个数都对了再往下）==========
SELECT
  (SELECT value FROM settings WHERE key='auto_send_enabled')            AS 自动发送开关_必须是0,
  (SELECT COUNT(*) FROM leads)                                          AS 线索总数,
  (SELECT COUNT(*) FROM leads WHERE status IN ('new','analyzed','approved','queued','pending')) AS 重置组,
  (SELECT COUNT(*) FROM leads WHERE status NOT IN ('new','analyzed','approved','queued','pending')) AS 只刷新组;
-- 预期（2026-07-16 读到的生产数）：开关=0，总数≈433，重置组≈389，只刷新组≈44

-- ========== 第 1 步：打重扫开始时间戳（必须在重置之前）==========
-- rescanTick 用它判断"谁还没扫"：analysis 缺失 或 analyzed_at < 这个时间 → 需要重扫。
-- 清掉 rescan_done_at：那是完成标记，留着会让 rescanTick 直接 return（幂等保护，重跑时必须清）。
INSERT INTO settings (key, value) VALUES ('rescan_started_at', datetime('now'))
  ON CONFLICT(key) DO UPDATE SET value = datetime('now');
DELETE FROM settings WHERE key = 'rescan_done_at';

-- ========== 第 2 步：重置组 → 打回 new，清掉旧结论 ==========
-- 范围只有这 5 个状态。**sent/replied/won/ignored/unsubscribed/blacklisted/bounced 一个字节都不碰** ——
-- 它们由 rescanTick 用 scoreOnly 模式只刷新 analysis，status 不动、不触发任何发信。
--
-- 2a) 先清 analysis：旧分数是新旧标准的混合物，留着会让"这条扫过没有"判不清
DELETE FROM lead_analysis
 WHERE lead_id IN (SELECT id FROM leads WHERE status IN ('new','analyzed','approved','queued','pending'));

-- 2b) 再打回 new + 清空抓站失败计数（给它们干净的 3 次重试额度 —— 首页超时已从 8s 提到 18s，
--     上次因为超时被判"抓不到"的这次很可能抓得到）
--
-- ⚠️ human_approved 一并归零，理由：这批线索的 status 正在被打回 new = 它们的批准**已经被撤销**了。
--    若留着 human_approved=1 而 status=new，会出两个问题：
--      · 翻牌堆 UI 会显示「已人工放行」并**禁用**「手动发这家」按钮 → Joe 反而按不了
--      · 那次放行是基于**旧证据**做的判断，而旧证据正是这次重扫要作废的东西
--    重扫后若它仍 <60，Joe 在翻牌堆里重新看一眼再决定 —— 这才是重扫的意义。
--    （2026-07-16 查生产：human_approved=1 的目前是 0 条，所以这条实际上是防御性的。）
UPDATE leads
   SET status = 'new',
       fetch_fail_count = 0,
       human_approved = 0,
       updated_at = datetime('now')
 WHERE status IN ('new','analyzed','approved','queued','pending');

-- ========== 第 3 步：核对 ==========
SELECT
  (SELECT value FROM settings WHERE key='rescan_started_at')                      AS 重扫开始时间,
  (SELECT COUNT(*) FROM leads WHERE status='new')                                  AS 待重扫_应约389,
  (SELECT COUNT(*) FROM leads l LEFT JOIN lead_analysis a ON a.lead_id=l.id
     WHERE a.lead_id IS NULL OR a.analyzed_at < (SELECT value FROM settings WHERE key='rescan_started_at'))
                                                                                   AS rescanTick看到的待办_应约433,
  (SELECT COUNT(*) FROM leads WHERE status IN ('sent','replied','won','ignored','unsubscribed','blacklisted','bounced'))
                                                                                   AS 只刷新组_状态未被动_应约44;

-- ========== 跑完之后 ==========
-- 重扫专班（每小时 :30）会自己开始啃，12 条/班 × 24 班 = 288/天 → 433 家约 1.5 天跑完。
-- 主班（每 6h :00）的分析循环也会顺带啃 status='new' 的那批 → 实际更快。
-- 全部扫完 → 自动推飞书「重扫完成：X 家 ≥60、Y 家 <60、Z 家抓不到」，然后你通知 Joe 决定要不要重开自动发送。
--
-- 想中途看进度：
--   SELECT COUNT(*) FROM leads l LEFT JOIN lead_analysis a ON a.lead_id=l.id
--    WHERE a.lead_id IS NULL OR a.analyzed_at < (SELECT value FROM settings WHERE key='rescan_started_at');
--
-- 想紧急叫停：DELETE FROM settings WHERE key='rescan_started_at';   （下一班 :30 立刻 return）
