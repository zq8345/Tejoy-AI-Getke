// 分析流水线：抓官网 → 打分 → 写信 → 写库
import type { Env } from "./index";
import { scrapeSite, type ScrapeResult } from "./scrape";
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
  /** 官网抓不到（**不是**模型失败）。调用方应「跳过这条、继续下一条」，绝不能拿它当"分析失败"去 break 整轮。 */
  fetchFailed?: boolean;
  /** 抓失败已达上限，已归档成 analyzed（match_score 仍为 NULL） */
  giveUp?: boolean;
  fetchFailCount?: number;
}

// ⭐「抓站失败 ≠ 不合格」
// 以前 analyzeLead 不看 scrapeSite 返回的 ok，官网抓不到时照样把空文本喂给 scoreLead，
// H3 必判"官网看不出在卖/装硬件" → ≤30 → **永久钉死，且与"真不合格"在分数上无法区分**。
// 生产已因此埋掉 15 家核心目标客户（cayelectronics.vg 船舶电子 / 12volt.com.au 房车电源 /
// flarespace.com 房车改装 / ccrvtechandsolar.com / off-gridrv.com …）。
// 现在的规则：抓不到 → **不调 LLM**（给空页面打分毫无意义，白烧额度）、**不写 match_score**、
// **不推进 status**（留 new 等下轮重试）；连续失败达 FETCH_FAIL_MAX → 归档成 analyzed 但
// match_score 保持 **NULL**，靠 approveGateReason 的"未打分不能批准"兜住 →
// 它落在「待审批」显示未打分，**可见、可人工处理**，而不是埋在低分堆里冒充"不合格"。
export const FETCH_FAIL_MAX = 3;
export const FETCH_FAIL_TYPE = "官网抓不到·无法判断";
// 抓到了但正文少到没法判（JS-only 空壳、"请开启 JavaScript"页等）等价于没抓到——
// 送给 LLM 同样只会得到"看不出在卖什么"→≤30 永久钉死。门槛压得很低，只拦真空壳。
const MIN_USABLE_TEXT = 200;

function usableSiteText(scraped: ScrapeResult): boolean {
  if (!scraped.ok) return false;
  const body = scraped.text.replace(/^#\s+\S+$/gm, "").trim(); // 去掉 "# {url}" 那几行页头再量
  return body.length >= MIN_USABLE_TEXT;
}

// 抓不到官网：记一次失败；没到上限就留在 new 等下轮重试，到上限则归档但**不判死**。
async function recordFetchFailure(env: Env, lead: any, scraped: ScrapeResult, opts: { rescan?: boolean } = {}): Promise<AnalyzeOutcome> {
  const why = scraped.error || (scraped.ok ? "官网正文过少（疑似 JS 空壳/占位页）" : "官网抓取失败");
  await env.DB.prepare(
    "UPDATE leads SET fetch_fail_count = COALESCE(fetch_fail_count,0)+1, updated_at=datetime('now') WHERE id=?"
  ).bind(lead.id).run();
  const row = await env.DB.prepare("SELECT COALESCE(fetch_fail_count,0) AS n FROM leads WHERE id=?")
    .bind(lead.id).first<{ n: number }>();
  const n = row?.n ?? 1;

  if (n < FETCH_FAIL_MAX) {
    return {
      ok: false, id: lead.id, fetchFailed: true, fetchFailCount: n,
      error: `${why}（第 ${n}/${FETCH_FAIL_MAX} 次，未打分、留 new 等下轮重试）`,
    };
  }

  // 到上限：转 analyzed 让它别再占分析队列，但 match_score 保持 NULL —— 未打分 ≠ 不合格。
  const note = `连续 ${n} 次抓不到官网（${why}）。**未打分**：这不是"不合格"，是根本没看到官网内容。` +
    `需要人工看一眼或补个能打开的网址，再手动重新分析。`;
  // ⚠️ 末尾这个 WHERE 是防误伤：这条线索若**以前抓得到、已有真分数**（例如 Seacoast 抓得到时拿过 75），
  //    那个分数是基于真实官网内容得出的，绝不能被后来的网络抖动抹成 NULL。有真分数就保留，不覆盖。
  //
  // ⭐ 但**全量重扫时这个守卫必须让路**（批⑥A 实测撞出来的，不是设想）：
  //   · 守卫的前提是"已有的分数是可信的，别让网络抖动毁了它"。
  //   · 重扫的前提正相反 —— **所有旧分数都已被宣布作废**（新旧标准的混合物）。
  //     此时若抓不到官网，诚实的记录是「官网抓不到·无法判断」(NULL)，
  //     而不是留着一个**按已被推翻的标准算出来的分数**继续冒充有效判断。
  //   · 而且不让路会死循环：这个 WHERE 挡掉的是**整个 DO UPDATE**，连 analyzed_at 都不更新
  //     → 这条线索永远满足"analyzed_at < 重扫开始时间" → 每班被重取 → **重扫永不完成、
  //       飞书完成信号永不触发**。生产里真有 4 家这种（fetch_fail_count 已经 4 了还挂着旧分数）。
  const guard = opts.rescan ? "" : " WHERE lead_analysis.match_score IS NULL";
  await env.DB.prepare(
    `INSERT INTO lead_analysis (lead_id, customer_type, customer_category, match_score, needed_products, reason, recommended_email, model, analyzed_at)
     VALUES (?, ?, ?, NULL, NULL, ?, NULL, ?, datetime('now'))
     ON CONFLICT(lead_id) DO UPDATE SET
       customer_type=excluded.customer_type, customer_category=excluded.customer_category,
       match_score=NULL, reason=excluded.reason, model=excluded.model, analyzed_at=excluded.analyzed_at${guard}`
  ).bind(lead.id, FETCH_FAIL_TYPE, categorizeCustomerType(FETCH_FAIL_TYPE), note,
         opts.rescan ? "fetch-failed(重扫·抓不到，旧分数已作废)" : "fetch-failed(未调用 LLM)").run();
  await env.DB.prepare(
    "UPDATE leads SET status='analyzed', updated_at=datetime('now') WHERE id=? AND status='new'"
  ).bind(lead.id).run();
  return { ok: false, id: lead.id, fetchFailed: true, giveUp: true, fetchFailCount: n, error: note };
}

/**
 * 批⑦C：打分失败的就地重试（指数退避 1s → 3s）。
 * 只包**模型调用**这一段 —— 官网正文已经在手里了，重试不重抓。
 * 429/5xx/网络抖动这类瞬时错误一次退避基本就过；真挂了（额度尽/密钥失效）也就多花 4 秒确认，
 * 之后照常抛出去让调用方按"模型失败"处理（重扫的停滞检测靠的就是这个信号）。
 */
async function retryScore<T>(fn: () => Promise<T>, leadId: number): Promise<T> {
  const DELAYS = [1000, 3000];
  let last: any;
  for (let i = 0; i <= DELAYS.length; i++) {
    try { return await fn(); }
    catch (e: any) {
      last = e;
      if (i === DELAYS.length) break;
      console.log(`score retry #${leadId}: 第 ${i + 1} 次失败（${String(e.message || e).slice(0, 60)}），${DELAYS[i]}ms 后重试（官网不重抓）`);
      await new Promise((r) => setTimeout(r, DELAYS[i]));
    }
  }
  throw last;
}

/**
 * ⭐ 批⑦A：开发信**在发送那一刻才写**，不在分析时写。
 *
 * 为什么改：Joe 的 OpenRouter 账单 **93% 烧在写信模型上**（Qwen $9.15 vs 打分 $0.67）——
 * 因为 analyzeLead 给**每一家**都写整封信，包括 <60 写完就直接归档的（433 家里约 300 家白写）。
 * 挪到发送时之后：只有真要发的那 ~128 家才写信 → 重扫的 AI 成本从 ~$10 掉到 ~$0.67（只剩打分）。
 *
 * ⚠️ 为什么要重抓一次官网：**抓取正文没存库**（总工定的：存了膨胀不值得）。而信必须引用官网的
 *    具体内容才不像群发。所以这里重抓 —— 抓站不花钱，只花时间，且只对真要发的那批发生。
 *    抓不到时**仍然写**（不阻断）：这条线索既然打到 ≥60，说明分析时官网是读得到的，
 *    此刻抓不到多半是抖动；而 reason 里本来就带着官网证据的引用（H3 要求 buyer_type 必须引证），
 *    信仍然是针对性的，只是不如有全文时丰富。为了一次抖动就不发一个已经决定要发的客户，不划算。
 *
 * 幂等：已有草稿直接返回，不重复烧钱。
 */
export async function ensureDraft(env: Env, lead: any): Promise<{ ok: boolean; draft?: string; error?: string; generated?: boolean }> {
  const a = await env.DB.prepare(
    "SELECT recommended_email, match_score, reason, needed_products, customer_type FROM lead_analysis WHERE lead_id=?"
  ).bind(lead.id).first<any>();
  if (a?.recommended_email) return { ok: true, draft: a.recommended_email };
  if (!a || a.match_score == null) {
    // 未打分 ≠ 低分（多半是官网抓不到）。没有分数就没有"为什么适合"，写出来的只能是空话。
    return { ok: false, error: "还没打分，写不了信（先 AI 分析）" };
  }
  try {
    const profile = await getProfile(env);
    const scraped = await scrapeSite(lead.website || "");
    if (!scraped.ok) console.log(`draft: #${lead.id} 官网此刻抓不到（${scraped.error}），用打分时的证据写`);
    const draft = await writeEmail(env, profile, lead.company_name || "", scraped.text, {
      customer_type: a.customer_type || "", match_score: a.match_score,
      needed_products: a.needed_products || "", reason: a.reason || "", country_code: "",
    }, lead.website);
    await env.DB.prepare("UPDATE lead_analysis SET recommended_email=? WHERE lead_id=?").bind(draft, lead.id).run();
    return { ok: true, draft, generated: true };
  } catch (e: any) {
    // 生成失败**只跳过这一条**，不能让它卡死整批（调用方会把 status 退回 approved 等下批重试）
    return { ok: false, error: `开发信生成失败：${e.message || String(e)}` };
  }
}

/**
 * 分析单条线索：写入 lead_analysis，并把 leads.status 推进到 analyzed。
 *
 * ⚠️ **status 只会从 new → analyzed**（下面那条 UPDATE 带 `AND status='new'`）。
 *    这条性质是全量重扫"只刷新组"能安全复用本函数的**全部依据**：
 *    一条 status='sent' 的线索走完这里，analysis 换新、status 纹丝不动、更不会触发任何发信。
 *
 * opts.scoreOnly：只要新分数+新证据，不重写开发信草稿（见下方 email 那行的注释）。
 */
export async function analyzeLead(env: Env, lead: any, opts: { scoreOnly?: boolean; rescan?: boolean } = {}): Promise<AnalyzeOutcome> {
  const profile = await getProfile(env);
  try {
    const scraped = await scrapeSite(lead.website || "");

    // ⭐ 抓不到官网就到此为止：不调 LLM、不写分、不推进 status（见上方 FETCH_FAIL_MAX 注释）
    if (!usableSiteText(scraped)) return await recordFetchFailure(env, lead, scraped, { rescan: opts.rescan });

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

    // ⭐ 把线索来源喂给打分器：NMEA 目录成员本身就是"我是船舶电子经销/安装商"的硬证据，
    //    比爬虫瞎猜官网可靠。白名单与安全约束见 openrouter.ts 的 sourceEndorsement ——
    //    source='search' 绝不享受背书（攻略文章正是从搜索来的）。
    //    keyword 存的是 NMEA affcode（Dealer/International）；存量老数据为 NULL → 退回泛称。
    //
    // ⭐ 批⑦C：官网已经抓到了 —— 打分失败**就地重试**，别让整条重来。
    //   以前：scoreLead 抛错 → analyzeLead 抛错 → 这条留 new → 下一批**重新抓一遍官网**。
    //   抓站是这条流水线里最慢的一段（首页最多 18s + 子页），为一次模型抖动白抓一遍不划算。
    //   正文就在手里（siteText），重试只花模型那一次的钱和时间。
    //   重试仍失败才留给下一批（下一批会重抓 —— 接受：**不把正文存库**，膨胀不值得，总工定的）。
    const score = await retryScore(() =>
      scoreLead(env, profile, lead.company_name || "", siteText, lead.source, lead.keyword), lead.id);
    // ⭐ 批⑦A：**分析不再写信**（分析 = 抓站 + 打分，到此为止）。
    //   写信的钱 93% 花在了永远发不出去的线索上（<60 写完就归档）。草稿改由 ensureDraft()
    //   在**发送那一刻**懒生成 —— 见本文件上方那段注释。
    //   顺带：`scoreOnly` 这个参数因此退化了 —— 它当初就是为了"重扫只刷新组时别重写草稿"，
    //   而现在**任何分析都不写草稿**，两组行为本来就一样。保留它只为让重扫调用点的语义读得出来，
    //   以及下面 model 字段能标出这条是重扫刷的还是新分析的。
    const category = categorizeCustomerType(score.customer_type);

    // ⚠️ recommended_email 用 `COALESCE(excluded.x, lead_analysis.x)` 保留原值 —— 这里传的是 NULL，
    //    直接 excluded 会把**已发出的那封信**抹掉（详情页「已发出的开发信」就是读它）。
    await env.DB.prepare(
      `INSERT INTO lead_analysis (lead_id, customer_type, customer_category, match_score, needed_products, reason, recommended_email, model, analyzed_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, datetime('now'))
       ON CONFLICT(lead_id) DO UPDATE SET
         customer_type=excluded.customer_type, customer_category=excluded.customer_category,
         match_score=excluded.match_score,
         needed_products=excluded.needed_products, reason=excluded.reason,
         recommended_email=COALESCE(excluded.recommended_email, lead_analysis.recommended_email),
         model=excluded.model,
         analyzed_at=excluded.analyzed_at`
    ).bind(
      lead.id, score.customer_type, category, score.match_score, score.needed_products,
      score.reason,
      opts.scoreOnly
        ? `${env.SCORE_MODEL || "deepseek/deepseek-chat"}（重扫·只刷新分数）`
        : `${env.SCORE_MODEL || "deepseek/deepseek-chat"}（打分；开发信在发送时生成）`
    ).run();

    // 已分析且未被人工处理过的，推进到 analyzed（仍属「待审核」分组）
    await env.DB.prepare(
      "UPDATE leads SET status='analyzed', updated_at=datetime('now') WHERE id=? AND status='new'"
    ).bind(lead.id).run();

    // 抓成功 → 失败计数清零：历史上的偶发抖动不该累加，否则迟早把一个健康站点误推到上限。
    // 加 >0 守卫，避免给每条正常线索都写一次无意义的 UPDATE。
    await env.DB.prepare(
      "UPDATE leads SET fetch_fail_count=0 WHERE id=? AND COALESCE(fetch_fail_count,0)>0"
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
