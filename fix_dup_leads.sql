-- ⚠️ 存量重复线索清查。**我只写，你跑。而且第 2 步默认注释掉 —— 先看名单再决定。**
--
-- 2026-07-16 只读查生产发现：433 条有网址的线索里，**40 组**域名主体重复。分两类，性质完全不同：
--
--   🔴 A 类：**同一个站被录了两次**（真重复）—— 协议/www/大小写不同，旧去重的 `website=? OR website=?`
--      原文比对全漏。生产实例：
--        #163 https://2csyachtoutfitters.com   vs  #238 http://www.2CsYachtOutfitters.com
--        #165 https://alliancenav.com          vs  #241 http://www.alliancenav.com
--        # 98 https://concordelectronics.com   vs  #263 http://www.concordelectronics.com
--      ⚠️ **这类会真咬人**：#163/#238 的邮箱是**同一个**（2csyachtoutfitters@gmail.com），
--        #163 已发信、#238 还躺在 new 里 → 重扫后一旦重开自动发送，**同一个地址会收到第二封冷邮件**。
--        （代码侧我已经在 deliverEmail 加了**按邮箱地址**的幂等兜底，所以即使这些脏数据留着也发不出第二封。
--          这个 SQL 是让列表干净，不是安全所必需。）
--
--   🟡 B 类：**同一公司的多个区域站**（不是重复）—— seasucker.com/.eu/.de、spacetek.com.au/.co.nz、
--      datalake.ph/.id。它们是不同的站、可能不同的联系人 → **不该合并，也不该删**。
--      新入库的这类会被 markSibling 打上 notes 提示；存量的用第 3 步补打。

-- ========== 第 1 步：看名单（只读，先跑这个）==========
-- A 类：同一个规范化域名有多行 = 真重复
SELECT
  lower(replace(replace(replace(rtrim(website,'/'),'https://',''),'http://',''),'www.','')) AS host,
  COUNT(*) AS 行数,
  GROUP_CONCAT(id) AS ids,
  GROUP_CONCAT(status) AS statuses,
  GROUP_CONCAT(COALESCE(email,'-')) AS emails
FROM leads
WHERE website IS NOT NULL AND website != ''
GROUP BY host HAVING COUNT(*) > 1
ORDER BY 行数 DESC;

-- ========== 第 2 步（默认注释掉）：A 类合并 —— 删掉"没发过信的那一行" ==========
-- ⚠️ **先跑第 1 步、肉眼看完名单再放开这段。** 删除是不可逆的。
-- 规则：同一个站的多行里，**保留有发信记录/状态更靠后的那行**，删掉纯 new/analyzed 的重复行。
-- 之所以敢删这类：它们是**同一个网站**，不是同一公司的两个站 —— 留着只会让列表和统计变脏。
--
-- DELETE FROM lead_analysis WHERE lead_id IN (
--   SELECT l.id FROM leads l
--    WHERE l.status IN ('new','analyzed')
--      AND NOT EXISTS (SELECT 1 FROM emails e WHERE e.lead_id = l.id)   -- 自己没发过信
--      AND EXISTS (                                                      -- 但同一个站另有一行更"靠后"
--        SELECT 1 FROM leads o
--         WHERE o.id != l.id
--           AND lower(replace(replace(replace(rtrim(o.website,'/'),'https://',''),'http://',''),'www.','')) =
--               lower(replace(replace(replace(rtrim(l.website,'/'),'https://',''),'http://',''),'www.',''))
--           AND (EXISTS (SELECT 1 FROM emails e2 WHERE e2.lead_id = o.id)
--                OR o.status IN ('sent','replied','won','approved','queued','ignored','unsubscribed','blacklisted','bounced'))
--      )
-- );
-- DELETE FROM leads WHERE id IN ( ...同一条 SELECT... );

-- ========== 第 3 步：B 类（跨域名疑似）→ 给存量补打 notes 提示 ==========
-- 不合并、不删，只在 notes 里留一句话，Joe 打开详情页时能看见"隔壁还有一个长得像的"。
-- 新入库的由 markSibling 自动打；这段是补存量。
-- 保守起见只处理**主体长度 ≥ 4** 的（太短的主体撞名概率高）。
--
-- ⚠️ SQLite 没有正则也没有"取域名主体"函数，纯 SQL 写这个会很难看且容易错。
--    建议：跑第 1 步和下面这条只读查询看清楚有哪些，**这几组人工在后台备注里写一句即可**（就 40 组里的一小半）。
SELECT id, company_name, website, status,
       lower(replace(replace(replace(rtrim(website,'/'),'https://',''),'http://',''),'www.','')) AS host
FROM leads
WHERE website IS NOT NULL AND website != ''
  AND (   lower(website) LIKE '%seasucker%'
       OR lower(website) LIKE '%spacetek%'
       OR lower(website) LIKE '%datalake%' )
ORDER BY host;

-- ========== 跑完之后 ==========
-- 代码侧已经修好的（不需要这个 SQL 也生效）：
--   · 入库去重改用规范化域名比对（findLeadByHost）→ **新的**同站重复进不来了
--   · deliverEmail 加了**按邮箱地址**的幂等 → 即使库里有重复行，同一个地址也只会收到一封冷邮件
--   · 新入库的跨域名疑似会自动打 notes（markSibling）
-- 这个 SQL 只解决"存量列表看着脏"，不是安全所必需。
