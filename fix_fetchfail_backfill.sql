-- ⚠️ 存量修复：把「因抓不到官网而被误判成低分」的线索放回去重新分析。
-- ⚠️ 我（开发窗）只写不跑。请总工在部署时执行，且**必须先跑第 0 步预览、肉眼确认名单**再往下。
--
-- 前置条件（顺序不能反）：
--   1) 先部署带「抓站失败 ≠ 不合格」修复的版本，并先跑 schema_fetchfail.sql（加 fetch_fail_count 列）
--   2) 再跑本文件 —— 否则重置成 new 之后，旧打分器会把它们再埋一次
--
-- 背景：analyzeLead 以前不看 scrapeSite 的 ok，抓不到时把空文本喂给 scoreLead，
-- H3 必判"看不出在卖/装硬件" → ≤30，永久钉死。已知受害者含 cayelectronics.vg（BVI 船舶电子）、
-- 12volt.com.au（房车/船舶 12V 电源）、flarespace.com（房车改装件）、ccrvtechandsolar.com、
-- off-gridrv.com —— 全是核心目标客户。
--
-- 【范围说明·重要】本文件**只动**"分析理由里明写抓不到官网、且分数 ≤30"的线索。
--   · **不碰**那 199 条「approved 但没有分析记录」—— 那是另一回事，归你的归位 SQL 管。
--     （我第一版误把它们扫进来了，已修正：这里全程用 reason 命中来锁定范围，不用"没有分析行"来反推。）
--   · **不碰** M3 终态（unsubscribed / blacklisted / bounced），也不碰 sent / replied / queued
--     —— 那些已有发信或人工行为，重置回 new 会让它们重新进入分析甚至发送漏斗。
--   · **默认不碰 ignored**（见第 4 步，可选、默认注释掉）：那是人工按过的决定。
--     但请注意：如果当初是用「一键忽略低分」批量按的，那批人正是被假分数骗的，
--     要不要一起捞回来由你定。

-- ========== 第 0 步：预览（只读。先跑这个，肉眼确认名单再往下）==========
-- 数量应在 15 上下。差太多就先停下来，别往下跑。
SELECT l.id, l.company_name, l.website, l.status, a.match_score, substr(a.reason, 1, 60) AS reason前60字
FROM leads l JOIN lead_analysis a ON a.lead_id = l.id
WHERE (
        a.reason LIKE '%无法抓取%' OR a.reason LIKE '%未能抓取%' OR a.reason LIKE '%抓取失败%'
     OR a.reason LIKE '%无法访问%' OR a.reason LIKE '%官网内容无法%' OR a.reason LIKE '%打不开%'
      )
  AND COALESCE(a.match_score, 0) <= 30
  AND l.status IN ('new', 'analyzed', 'pending', 'approved')
  AND l.website IS NOT NULL AND l.website != ''   -- 没网址的放回去也只会再失败 3 次
ORDER BY l.id;

-- ========== 第 1 步：先把状态放回 new（必须在删 analysis 之前）==========
-- 顺序原因：范围是靠 a.reason 命中来锁的，删掉 lead_analysis 就再也认不出是哪批了。
UPDATE leads
SET status = 'new', fetch_fail_count = 0, updated_at = datetime('now')
WHERE id IN (
  SELECT l.id FROM leads l JOIN lead_analysis a ON a.lead_id = l.id
  WHERE (
          a.reason LIKE '%无法抓取%' OR a.reason LIKE '%未能抓取%' OR a.reason LIKE '%抓取失败%'
       OR a.reason LIKE '%无法访问%' OR a.reason LIKE '%官网内容无法%' OR a.reason LIKE '%打不开%'
        )
    AND COALESCE(a.match_score, 0) <= 30
    AND l.status IN ('new', 'analyzed', 'pending', 'approved')
    AND l.website IS NOT NULL AND l.website != ''
);

-- ========== 第 2 步：删掉这些"基于空页面"的结论 ==========
-- 它们不是判断，是噪声：模型根本没看到官网内容。
-- 此刻这批的 status 已全是 'new'（第 1 步刚置的），用它把范围收死。
DELETE FROM lead_analysis
WHERE lead_id IN (
  SELECT l.id FROM leads l JOIN lead_analysis a ON a.lead_id = l.id
  WHERE (
          a.reason LIKE '%无法抓取%' OR a.reason LIKE '%未能抓取%' OR a.reason LIKE '%抓取失败%'
       OR a.reason LIKE '%无法访问%' OR a.reason LIKE '%官网内容无法%' OR a.reason LIKE '%打不开%'
        )
    AND COALESCE(a.match_score, 0) <= 30
    AND l.status = 'new'
    AND l.website IS NOT NULL AND l.website != ''
);

-- ========== 第 3 步：核对 ==========
-- 应该 = 第 0 步预览出来的条数。它们现在是 new + 无分析行 → cron 会用修好的流水线重走一遍。
SELECT COUNT(*) AS 已放回待分析
FROM leads WHERE status = 'new' AND fetch_fail_count = 0
  AND id NOT IN (SELECT lead_id FROM lead_analysis);

-- ========== 第 4 步（可选，默认注释掉）：连 ignored 一起捞 ==========
-- 只有你确认"当初那批 ignored 是被假分数骗着按的"再放开。它会覆盖人工决定，所以默认不跑。
-- UPDATE leads SET status='new', fetch_fail_count=0, updated_at=datetime('now')
-- WHERE id IN (
--   SELECT l.id FROM leads l JOIN lead_analysis a ON a.lead_id = l.id
--   WHERE (a.reason LIKE '%无法抓取%' OR a.reason LIKE '%未能抓取%' OR a.reason LIKE '%抓取失败%'
--       OR a.reason LIKE '%无法访问%' OR a.reason LIKE '%官网内容无法%' OR a.reason LIKE '%打不开%')
--     AND COALESCE(a.match_score,0) <= 30 AND l.status='ignored'
--     AND l.website IS NOT NULL AND l.website != ''
-- );
-- DELETE FROM lead_analysis WHERE lead_id IN (SELECT id FROM leads WHERE status='new' AND fetch_fail_count=0);
