// 分析流水线：抓官网 → 打分 → 写信 → 写库
import type { Env } from "./index";
import { scrapeSite } from "./scrape";
import { scoreLead, writeEmail } from "./openrouter";
import { categorizeCustomerType } from "./taxonomy";
import { inferCountryFromWebsite, COUNTRIES } from "./discover";

export const DEFAULT_PROFILE =
  `TEJOY 是星链 Starlink 配件的供应商/批发商(自有货源),寻找需要"进货/代发/上架销售/随安装打包"星链配件的 B2B 买家。优先毛利好、靠关系与本地化、能走量复购的渠道;刻意避开亚马逊上同质低价铺货的红海。\n\n` +
  `【最高价值目标(按优先级)】\n` +
  `1) 垂直行业经销商 / 系统集成商 / 安装商 —— 船舶电子、房车/越野改装、离网太阳能、WISP 无线宽带运营商、应急/救灾通信、农业/矿业/油田通信、偏远网络服务商;把配件随安装或方案打包卖,价格不透明、毛利好、几乎无价格战,是最优质买家。\n` +
  `2) 区域分销商 / 批发商 / 零售连锁 —— 美/加/澳/新/欧/拉美 的卫星通信、网络、船舶、房车、户外配件分销与批发商;走量、复购稳,处在 TEJOY 的天然下游。\n\n` +
  `【次要目标(会买,低成本可得才做)】\n` +
  `- 非中国的亚马逊/marketplace 卖家(美/欧/澳/加 本土 FBA)与独立站卖家;仅在免费/低成本可得时纳入,不作主力。\n\n` +
  `【打分要点】\n` +
  `- 高分:明显在做经销/分销/批发/安装集成/方案打包,有实体经营(店面/服务区域/产品目录/项目案例),经营 卫星·网络·船舶·房车·户外·离网 品类,提到 dealer/distributor/wholesale/installer/integrator/reseller,本地化、有品牌、非中国主体。\n` +
  `- 加分:能规模化复购与走量;靠关系与服务而非纯比价;位于星链正放量、竞争较轻的地区。\n` +
  `- 降分/谨慎:疑似中国铺货型卖家(中文站、.cn 或中国公司主体、大量同质超低价铺货)→ 一律显著降权(价格战压毛利);纯内容/攻略/评测/博客站(非经营实体);与联网/户外/卫星完全无关的行业;已是大型成熟"自有品牌配件制造/大牌"更像竞品 → 低分。`;

export async function getProfile(env: Env): Promise<string> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'customer_profile'").first<{ value: string }>();
  return row?.value?.trim() ? row.value : DEFAULT_PROFILE;
}

export interface AnalyzeOutcome {
  ok: boolean;
  id: number;
  score?: number;
  error?: string;
}

// 分析单条线索：写入 lead_analysis，并把 leads.status 推进到 analyzed
export async function analyzeLead(env: Env, lead: any): Promise<AnalyzeOutcome> {
  const profile = await getProfile(env);
  try {
    const scraped = await scrapeSite(lead.website || "");
    const siteText = scraped.text;

    // 若线索无邮箱，用抓取到的最佳邮箱补上
    if (!lead.email && scraped.emails.length) {
      lead.email = scraped.emails[0];
      await env.DB.prepare("UPDATE leads SET email=?, updated_at=datetime('now') WHERE id=? AND (email IS NULL OR email='')")
        .bind(lead.email, lead.id).run();
    }

    // 快赢①：抓到的社媒/IM/电话渠道存 leads.channels（有才写，抓不到不覆盖已有）
    if (scraped.channels && Object.keys(scraped.channels).length) {
      await env.DB.prepare("UPDATE leads SET channels=?, updated_at=datetime('now') WHERE id=?")
        .bind(JSON.stringify(scraped.channels), lead.id).run();
    }

    const score = await scoreLead(env, profile, lead.company_name || "", siteText);
    const email = await writeEmail(env, profile, lead.company_name || "", siteText, score);
    const category = categorizeCustomerType(score.customer_type);

    await env.DB.prepare(
      `INSERT INTO lead_analysis (lead_id, customer_type, customer_category, match_score, needed_products, reason, recommended_email, model, analyzed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(lead_id) DO UPDATE SET
         customer_type=excluded.customer_type, customer_category=excluded.customer_category,
         match_score=excluded.match_score,
         needed_products=excluded.needed_products, reason=excluded.reason,
         recommended_email=excluded.recommended_email, model=excluded.model,
         analyzed_at=excluded.analyzed_at`
    ).bind(
      lead.id, score.customer_type, category, score.match_score, score.needed_products,
      score.reason, email, `${env.SCORE_MODEL || "deepseek/deepseek-chat"} + ${env.EMAIL_MODEL || "qwen/qwen3.7-max"}`
    ).run();

    // 已分析且未被人工处理过的，推进到 analyzed（仍属「待审核」分组）
    await env.DB.prepare(
      "UPDATE leads SET status='analyzed', updated_at=datetime('now') WHERE id=? AND status='new'"
    ).bind(lead.id).run();

    // 回填国家：仅当 country 为空时补，绝不覆盖已有（SQL 守卫保证幂等）。
    // ① ccTLD 可靠回填为主；② .com 等通用后缀推不出时，用 AI 保守判国 score.country_code 兜。
    // 两级都必须在 COUNTRIES 白名单内（白名单键是小写，故比对时转小写），非法一律忽略；不清楚保持 NULL、不猜、不默认美国。
    // ⭐批④：**存库一律大写**。这里以前写小写（注释还写着"归一小写"），正是看板出现"两个美国"(US 55 / us 25) 的源头——
    //    因为发现入库写的是大写、列表筛选用 UPPER(l.country)=? 所以筛选没露馅，只有看板 GROUP BY 露了。
    //    比对用小写键、落库用大写，两边各司其职。
    try {
      const ccTld = inferCountryFromWebsite(lead.website || "").toLowerCase();
      let cc = COUNTRIES[ccTld] ? ccTld : "";
      if (!cc && score.country_code && COUNTRIES[String(score.country_code).toLowerCase()]) cc = String(score.country_code).toLowerCase();
      if (cc) {
        await env.DB.prepare(
          "UPDATE leads SET country=?, updated_at=datetime('now') WHERE id=? AND (country IS NULL OR country='')"
        ).bind(cc.toUpperCase(), lead.id).run();
      }
    } catch { /* 国家回填为尽力而为，失败不影响分析结果 */ }

    return { ok: true, id: lead.id, score: score.match_score };
  } catch (e: any) {
    return { ok: false, id: lead.id, error: e.message || String(e) };
  }
}
