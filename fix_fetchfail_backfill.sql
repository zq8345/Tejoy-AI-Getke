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

-- ========== 第 5 步（可选，默认注释掉）：已忽略里那 3 条 95 分的纯攻略文章 ==========
-- 你提到"存量重扫时这类会自动归位"——**这一条我要更正一下**：cron 只捡 status='new'，
-- 它们躺在 ignored 里，永远不会被重扫，95 分会一直挂着。要归位只能像下面这样手动放回去。
--
-- 但我的建议是：**别跑这一步**。理由：
--   · 它们现在已经被正确地忽略了（人当初判断对了，尽管分数在骗人），不会被发信，没有实际危害
--   · 放回 new → H3-v2 把它们压到 ≤30 → 它们落进「待审核」→ Joe 还得再手动忽略一次
--     = 拿"正确地埋着"换"需要重新分诊"，净增工作量
--   · 95 分留在 ignored 里唯一的害处是污染看板的分数分布，那是化妆品级问题
-- 如果你就是想让存量分数干净（比如要拿分布做决策），再放开它。
-- SELECT id, company_name, website, status FROM leads l JOIN lead_analysis a ON a.lead_id=l.id
-- WHERE l.status='ignored' AND a.match_score>=80
--   AND (a.customer_type LIKE '%内容%' OR a.customer_type LIKE '%攻略%' OR a.customer_type LIKE '%博客%'
--     OR a.customer_type LIKE '%媒体%' OR a.customer_category='其他');
-- ↑ 先跑这个看名单。确认全是攻略/内容站、没有误伤真客户，再把下面两句放开：
-- DELETE FROM lead_analysis WHERE lead_id IN (SELECT l.id FROM leads l JOIN lead_analysis a ON a.lead_id=l.id
--   WHERE l.status='ignored' AND a.match_score>=80 AND (a.customer_type LIKE '%内容%' OR a.customer_type LIKE '%攻略%'
--     OR a.customer_type LIKE '%博客%' OR a.customer_type LIKE '%媒体%' OR a.customer_category='其他'));
-- UPDATE leads SET status='new', fetch_fail_count=0, updated_at=datetime('now')
--   WHERE status='ignored' AND id NOT IN (SELECT lead_id FROM lead_analysis);
-- ⚠️ 上面这句 UPDATE 的范围条件是"ignored 且没有分析行"——如果库里本来就有别的 ignored 无分析行的线索，
--    它们也会被一起放回。跑之前先 SELECT 数一下：
--    SELECT COUNT(*) FROM leads WHERE status='ignored' AND id NOT IN (SELECT lead_id FROM lead_analysis);

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
