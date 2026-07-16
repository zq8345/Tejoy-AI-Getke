-- 批⑥A 全量重扫 · 存量重置 —— **这是兜底/文档，正常路径不用它**。
--
-- ⚠️ 正常路径：后台「找客户」页 →「🔄 重扫全部」按钮。它做的就是下面这些事，
--    外加一个前端自驱循环把 428 家在 1-2 小时内跑完（Joe 的要求："428 条当天跑完"）。
--
-- 这个文件留着有两个用处：
--   1) **说明按钮到底动了什么数据** —— 按钮背后是破坏性操作，得有个地方白纸黑字写清楚
--   2) 万一按钮那条路挂了，可以手工 arm，然后让 cron 的日常分析循环慢慢啃（要 9 天，仅应急）
--
-- ⚠️ 跑之前：`auto_send_enabled` 必须是 0。重置会把 approved 打回 new，自动发送开着的话
--    它们重扫过程中重新拿到 ≥60 就会被立刻发出去 —— 那正是"按刚被宣布作废的旧标准发信"。
--    （按钮那条路有代码闸挡着：/api/rescan/start 在 auto_send_enabled=1 时直接 409。）

-- ========== 第 0 步：自检（只读）==========
SELECT
  (SELECT value FROM settings WHERE key='auto_send_enabled')            AS 自动发送开关_必须是0,
  (SELECT COUNT(*) FROM leads)                                          AS 线索总数,
  (SELECT COUNT(*) FROM leads WHERE status IN ('new','analyzed','approved','queued','pending')) AS 重置组,
  (SELECT COUNT(*) FROM leads WHERE status NOT IN ('new','analyzed','approved','queued','pending')) AS 只刷新组;
-- 2026-07-16 读到的生产数：开关=0，总数=433，重置组=389，只刷新组=44

-- ========== 第 1 步：打重扫开始时间戳（**必须在重置之前**）==========
-- 重扫靠 `analyzed_at < rescan_started_at` 判断"谁还没扫"。
-- 时间戳晚于重置的话，两者之间被扫过的线索会被判成"已扫"而漏掉。
INSERT INTO settings (key, value) VALUES ('rescan_started_at', datetime('now'))
  ON CONFLICT(key) DO UPDATE SET value = datetime('now');
DELETE FROM settings WHERE key = 'rescan_done_at';   -- 完成标记留着会让重扫直接 return

-- ========== 第 2 步：重置组 → 打回 new，清掉旧结论 ==========
-- 范围只有这 5 个状态。**sent/replied/won/ignored/unsubscribed/blacklisted/bounced 一个字节都不碰** ——
-- 它们由重扫用 scoreOnly 模式只刷新 analysis：status 不动、不重写已发出的草稿、不触发任何发信。
DELETE FROM lead_analysis
 WHERE lead_id IN (SELECT id FROM leads WHERE status IN ('new','analyzed','approved','queued','pending'));

-- fetch_fail_count 清零：首页超时已从 8s 提到 18s，上次因超时被判"抓不到"的这次很可能抓得到，
--   给它们干净的 3 次重试额度。
-- human_approved 清零：status 被打回 new = 批准**已被撤销**。留着 1 会有两个问题：
--   · 翻牌堆 UI 会显示「已人工放行」并**禁用**「手动发这家」→ Joe 反而按不了
--   · 那次放行是基于**旧证据**做的判断，而旧证据正是这次要作废的东西
--   （2026-07-16 查生产：human_approved=1 目前 0 条，这条是防御性的。）
UPDATE leads
   SET status = 'new', fetch_fail_count = 0, human_approved = 0, updated_at = datetime('now')
 WHERE status IN ('new','analyzed','approved','queued','pending');

-- ========== 第 3 步：核对 ==========
SELECT
  (SELECT value FROM settings WHERE key='rescan_started_at')                      AS 重扫开始时间,
  (SELECT COUNT(*) FROM leads WHERE status='new')                                  AS 待重扫_应约389,
  (SELECT COUNT(*) FROM leads l LEFT JOIN lead_analysis a ON a.lead_id=l.id
     WHERE a.lead_id IS NULL OR a.analyzed_at < (SELECT value FROM settings WHERE key='rescan_started_at'))
                                                                                   AS 重扫看到的待办_应约433,
  (SELECT COUNT(*) FROM leads WHERE status IN ('sent','replied','won','ignored','unsubscribed','blacklisted','bounced'))
                                                                                   AS 只刷新组_状态未动_应约44;

-- ========== 进度 / 叫停 ==========
-- 看进度： GET /api/rescan/status   （或直接查下面这条）
--   SELECT COUNT(*) FROM leads l LEFT JOIN lead_analysis a ON a.lead_id=l.id
--    WHERE a.lead_id IS NULL OR a.analyzed_at < (SELECT value FROM settings WHERE key='rescan_started_at');
-- 叫停：  DELETE FROM settings WHERE key='rescan_started_at';   （前端循环下一批就会拿到 409 停下）
