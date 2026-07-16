// P5 自动找客户：关键词 → 搜索 API → 提取公司官网 → 去重入库
import type { Env } from "./index";

// 默认关键词池（E2：转向 经销/分销/集成/安装 渠道 + 配件×批发，避开亚马逊铺货红海）
export const DEFAULT_KEYWORDS = [
  // 渠道型 × Starlink
  "Starlink dealer",
  "Starlink distributor",
  "Starlink wholesale supplier",
  "Starlink reseller",
  "Starlink authorized reseller",
  "Starlink installer",
  "satellite internet integrator",
  // 垂直集成/安装
  "marine satellite internet installer",
  "marine electronics dealer",
  "RV satellite internet installer",
  "off-grid internet installer",
  "off-grid solar installer",
  "WISP wireless internet provider",
  "wireless ISP Starlink",
  "remote connectivity provider",
  // 相邻品类 分销/批发
  "satellite communication equipment distributor",
  "marine electronics wholesaler",
  "RV parts wholesale distributor",
  // 配件意图 × 批发/经销
  "Starlink mount dealer",
  "Starlink mount wholesale",
  "Starlink cable wholesale",
  "Starlink enclosure wholesale",
];

// E2：每条搜索追加的排除串（滤掉中国铺货平台）。
// ⚠️ 实测：Serper/Google 的 `-site:*.cn`/`-site:.cn`（TLD 级 -site）会把结果清零（Google 语法怪癖），故不用；
// 中文站/.cn 改由结果侧 domain.endsWith('.cn') 兜底过滤（见 runDiscovery）。词级 -term 实测正常生效。
export const EXCLUDE_QUERY = "-alibaba -aliexpress -made-in-china -dhgate -temu";

interface SearchResult { title: string; url: string; }

// 支持的目标国家（gl 代码）→ 中文名，用于 UI
// 优先级参考 Starlink 全球用户调研：美国独大 → 英语非洲(增速最猛) → 新兴亚太
export const COUNTRIES: Record<string, string> = {
  us: "美国", ca: "加拿大", au: "澳大利亚", gb: "英国", ie: "爱尔兰", nz: "新西兰",
  // 英语非洲（Starlink 增长最快，官方语言英语，先用英语开发信即可）
  ng: "尼日利亚", ke: "肯尼亚", zw: "津巴布韦", za: "南非",
  // 新兴亚太
  vn: "越南", id: "印尼", lk: "斯里兰卡", sg: "新加坡", ph: "菲律宾",
  // 南美（整合调研：绝对增长第三大区域）
  br: "巴西", ar: "阿根廷", cl: "智利", co: "哥伦比亚", pe: "秘鲁", mx: "墨西哥",
  // 其它成熟市场
  de: "德国", fr: "法国", nl: "荷兰", es: "西班牙", it: "意大利", ae: "阿联酋",
};

// E2 默认搜索国家（优先星链放量、竞争较轻、非中国市场 22 国）。
// VN/LK/SG/ZW/AE 保留在 COUNTRIES 里可选，但不进默认。
export const DEFAULT_COUNTRIES = [
  "us", "ca", "au", "nz", "gb", "ie", "de", "fr", "es", "it", "nl",
  "br", "mx", "cl", "co", "pe", "ar", "za", "ng", "ke", "ph", "id",
];

// 遗留数据国家推断：按官网 ccTLD 后缀映射（最佳努力）。
// 通用后缀（.com/.net/.org 等）+ 被当"通用短域名"卖的伪 ccTLD（.co/.io/.ai/.me/.tv/.cc，
//   如 .co=哥伦比亚但大量美国公司在用）一律不当国家信号 → 返回 ""（保持 NULL，不猜、不默认美国）。
// 只保留明确 ccTLD：多级更稳（.com.au/.co.nz/.com.br/.com.co/.co.uk/.co.za）+ 真国别单级（.us/.ca/.mx/.nz/.au/.ng/.ke/.cl/.pe/.ar 等）。
//   （.us 是真 ccTLD，非美企基本不用；命中率低但命中即可靠，不违"绝不瞎猜"。）
// 按后缀长度降序匹配（下方 .sort 保证），使 .co.za/.co.ke 等长后缀先于短后缀命中，避免误判。
const CCTLD_MAP: [string, string][] = ([
  [".com.au", "AU"], [".net.au", "AU"], [".org.au", "AU"], [".au", "AU"],
  [".co.nz", "NZ"], [".net.nz", "NZ"], [".nz", "NZ"],
  [".co.uk", "GB"], [".org.uk", "GB"], [".uk", "GB"],
  [".com.br", "BR"], [".br", "BR"],
  [".com.mx", "MX"], [".mx", "MX"],
  [".com.ar", "AR"], [".ar", "AR"],
  [".cl", "CL"], [".com.co", "CO"], [".com.pe", "PE"], [".pe", "PE"],
  [".ca", "CA"], [".us", "US"],
  [".co.za", "ZA"], [".za", "ZA"],
  [".com.ng", "NG"], [".ng", "NG"], [".co.ke", "KE"], [".ke", "KE"], [".co.zw", "ZW"], [".zw", "ZW"],
  [".com.vn", "VN"], [".vn", "VN"], [".co.id", "ID"], [".id", "ID"], [".lk", "LK"],
  [".com.sg", "SG"], [".sg", "SG"], [".com.ph", "PH"], [".ph", "PH"],
  [".de", "DE"], [".fr", "FR"], [".nl", "NL"], [".es", "ES"], [".it", "IT"], [".ae", "AE"],
] as [string, string][]).sort((a, b) => b[0].length - a[0].length);
export function inferCountryFromWebsite(website: string): string {
  let host = "";
  try { host = new URL(website).hostname.toLowerCase(); }
  catch { host = (website || "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""); }
  host = host.replace(/^www\./, "");
  if (!host) return "";
  for (const [suffix, cc] of CCTLD_MAP) {   // 已按后缀长度降序：最特异的先匹配
    if (host.endsWith(suffix)) return cc;
  }
  return ""; // 通用后缀无法判定 → 保持 NULL（不猜、不默认美国）
}

// 搜索提供商（可插拔）：默认 Serper（Google 搜索 API，便宜，有免费额度）
// gl = 国家定向（如 us/au/ca）
export async function searchCompanies(env: Env, query: string, num = 10, gl = "us"): Promise<SearchResult[]> {
  const provider = (env.SEARCH_PROVIDER || "serper").toLowerCase();
  if (provider === "serper") return searchSerper(env, query, num, gl);
  throw new Error(`未知搜索提供商: ${provider}（目前支持 serper）`);
}

async function searchSerper(env: Env, query: string, num: number, gl: string): Promise<SearchResult[]> {
  if (!env.SEARCH_API_KEY) throw new Error("缺少 SEARCH_API_KEY（去 serper.dev 生成，免费额度即可）");
  const q = `${query} ${EXCLUDE_QUERY}`.trim(); // E2：追加排除串，滤中国铺货平台/中文站
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": env.SEARCH_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ q, num, gl }),
  });
  if (!res.ok) throw new Error(`Serper ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const data: any = await res.json();
  return (data.organic || [])
    .map((o: any) => ({ title: o.title || "", url: o.link || "" }))
    .filter((r: SearchResult) => r.url);
}

// 找客户配置：目标国家 + 每关键词每国家取几条
export async function getSearchConfig(env: Env): Promise<{ countries: string[]; perKeyword: number }> {
  // search_countries = 面板"已勾选"国家（saveSearchCfg 写入）→ cron 用它，勾掉的不跑
  const cRow = await env.DB.prepare("SELECT value FROM settings WHERE key='search_countries'").first<{ value: string }>();
  let countries = (cRow?.value || DEFAULT_COUNTRIES.join(",")).split(",").map((s) => s.trim()).filter((c) => COUNTRIES[c]);
  // P0-a：面板"从清单移除"的国家也不跑——若设了 country_list，则 effective ⊆ country_list
  const clRaw = (await getS(env, "country_list", "")).trim();
  if (clRaw) {
    const listSet = new Set(clRaw.split(",").map((s) => s.trim()).filter((c) => COUNTRIES[c]));
    const inter = countries.filter((c) => listSet.has(c));
    if (inter.length) countries = inter;
  }
  const pRow = await env.DB.prepare("SELECT value FROM settings WHERE key='search_per_keyword'").first<{ value: string }>();
  const perKeyword = Math.min(Math.max(Number(pRow?.value) || 8, 1), 100);   // #45 放开到 100，尊重滑块
  return { countries: countries.length ? countries : DEFAULT_COUNTRIES.slice(), perKeyword };
}

function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
}

// 过滤平台/目录/社媒/比价/大ISP/招聘/媒体等非目标公司域名
const JUNK_DOMAINS = [
  // 平台/社媒
  "google.", "facebook.", "youtube.", "yelp.", "reddit.", "amazon.", "ebay.",
  "wikipedia.", "linkedin.", "instagram.", "twitter.", "x.com", "tiktok.",
  "pinterest.", "starlink.com", "spacex.com", "maps.google", "bbb.org",
  "quora.", "medium.com", "apple.com", "play.google", "wa.me", "t.me",
  "fandom.", "craigslist.",
  // 招聘站
  "indeed.", "glassdoor.", "ziprecruiter.", "simplyhired.", "monster.", "snagajob.",
  // 比价/评测/聚合站（非采购方）
  "broadbandsearch.", "highspeedinternet.", "satelliteinternet.", "broadbandnow.",
  "whistleout.", "allconnect.", "comparitech.", "cnet.", "pcmag.", "tomsguide.",
  "reviews.org", "broadbandmap.", "techradar.", "forbes.", "usnews.",
  // 大 ISP / 卫星 ISP（非目标客户/竞争对手）
  "spectrum.", "earthlink.", "xfinity.", "verizon.", "att.com", "t-mobile.",
  "viasat.", "hughesnet.", "centurylink.", "frontier.com",
  // 媒体/市场/大牌零售/文档/论坛
  "yachtworld.", "boattrader.", "boats.com", "tripadvisor.",
  "bestbuy.", "westmarine.", "readme.io", "inmyarea.", "irv2.",
  "roadslesstraveled.", "walmart.", "homedepot.", "target.com",
  // E2：中国铺货平台/批发站（避开价格战红海；-site:*.cn 之外的结果侧兜底）
  "alibaba.", "aliexpress.", "made-in-china.", "dhgate.", "temu.", "1688.com", "globalsources.",
];
function isJunkDomain(d: string): boolean {
  return !d || JUNK_DOMAINS.some((j) => d.includes(j));
}

function cleanTitle(t: string): string {
  return (t || "").split(/\s*[|–—]\s*|\s+-\s+/)[0].trim().slice(0, 120) || "(unknown)";
}

// M1 公司名：优先用域名主标签推公司名（比搜索标题碎片可靠：域名一定是这家公司的站）。
// betamarineusa.com → "Betamarineusa"；foo-bar.co.uk → "Foo Bar"。返回 "" 时调用方回落 cleanTitle。
function companyFromDomain(domain: string): string {
  const host = (domain || "").replace(/^www\./, "").toLowerCase();
  if (!host) return "";
  const parts = host.split(".").filter(Boolean);
  if (parts.length < 2) return "";
  // 主标签 = TLD 前一段；若命中 co/com/net/org/gov/edu/ac（如 .com.au/.co.uk）再往前取一段
  let label = parts[parts.length - 2];
  if (parts.length >= 3 && ["co", "com", "net", "org", "gov", "edu", "ac"].includes(label)) label = parts[parts.length - 3];
  label = label.replace(/[-_]+/g, " ").trim();
  if (!label) return "";
  return label.split(" ").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ").slice(0, 80);
}

// 快赢②：识别"文章/攻略/资讯页"而非真实经营的公司/买家，入库前过滤掉最明显的噪音。
// 保守起见：URL 路径出现博客/攻略段，或标题呈明显文章句式，才判为内容页。
const ARTICLE_URL_RE = /\/(blog|blogs|guide|guides|article|articles|news|wiki|resources?|how-?to|tutorials?|tips|diy|learn|magazine|stories|faq|glossary)(\/|$|\?)|\/20\d\d\//i;
// 标题句式：how to / guide / tutorial / step-by-step / DIY / tips / best…20xx / listicle 等 → 内容页
const ARTICLE_TITLE_RE = /^(what is|why |when to|where to|top \d+|best \d+|\d+ best|the \d+ )|\bhow[\s-]?to\b|step[\s-]?by[\s-]?step|\bguide\b|\btutorial\b|\bdiy\b|\btips\b|\bvs\.?\b|\bexplained\b|\breview:|\bcheat sheet\b|\bchecklist\b|\bbest\b.{0,25}\b20\d\d\b/i;
export function isLikelyArticle(title: string, url: string): boolean {
  const u = (url || "").toLowerCase();
  if (ARTICLE_URL_RE.test(u)) return true;
  if (ARTICLE_TITLE_RE.test((title || "").trim())) return true;
  return false;
}

export interface DiscoverResult {
  keywords: number;
  searched: number;
  inserted: number;
  skipped: number;
  contentSkipped: number; // 快赢②：被判为文章/攻略页而过滤掉的数量
  errors: string[];
  budgetStopped?: boolean;    // P0-c：本轮因触及今日 Serper 预算上限而提前停
  serperUsedToday?: number;   // P0-c：今日累计 Serper 搜索次数
  serperBudget?: number;      // P0-c：今日 Serper 预算上限
}

// 主流程：对每个关键词 × 每个目标国家搜索 → 提取公司域名 → 去重 → 入库(status=new)
export async function runDiscovery(env: Env, opts: { keywords?: string[]; perKeyword?: number; countries?: string[]; maxCombos?: number } = {}): Promise<DiscoverResult> {
  const keywords = opts.keywords?.length ? opts.keywords : await getKeywords(env);
  const cfg = await getSearchConfig(env);
  const perKeyword = Math.min(Math.max(opts.perKeyword || cfg.perKeyword, 1), 100);   // #45 放开到 100，尊重滑块
  const countries = opts.countries?.length ? opts.countries : cfg.countries;

  // 展平所有 keyword×country 组合（每组合 = 1 次 Serper 搜索）
  let combos: { kw: string; gl: string }[] = [];
  for (const kw of keywords) for (const gl of countries) combos.push({ kw, gl });

  // P0-b 轮转窗口：cron 传 maxCombos 时，只跑一小批，用 discovery_cursor 环绕，下轮接着跑（别每轮全量 572）
  if (opts.maxCombos && opts.maxCombos < combos.length) {
    const totalC = combos.length;
    let cursor = Number(await getS(env, "discovery_cursor", "0")) || 0;
    cursor = ((cursor % totalC) + totalC) % totalC;
    const window: { kw: string; gl: string }[] = [];
    for (let i = 0; i < opts.maxCombos; i++) window.push(combos[(cursor + i) % totalC]);
    await setS(env, "discovery_cursor", String((cursor + opts.maxCombos) % totalC));
    combos = window;
  }

  // P0-c Serper 积分：今日计数 + 硬预算上限（到顶自动停，别再失控烧免费额度）。注意用 isFinite 判定，允许预算=0（完全暂停）
  const braw = Number(await getS(env, "serper_daily_budget", "200"));
  const budget = Math.max(0, Number.isFinite(braw) ? braw : 200);
  const usedKey = `serper_used_${new Date().toISOString().slice(0, 10)}`;
  let usedToday = Number(await getS(env, usedKey, "0")) || 0;

  let inserted = 0, skipped = 0, searched = 0, contentSkipped = 0, budgetStopped = false;
  const errors: string[] = [];
  const seenThisRun = new Set<string>();

  for (const { kw, gl } of combos) {
    if (usedToday >= budget) { budgetStopped = true; break; }   // 触及今日预算 → 停
    let results: SearchResult[];
    try {
      results = await searchCompanies(env, kw, perKeyword, gl);
      searched++; usedToday++;
      await setS(env, usedKey, String(usedToday));   // 每搜一次即记账，进程中断也不丢
    } catch (e: any) {
      errors.push(`${kw}/${gl}: ${e.message}`);
      continue;
    }
    for (const r of results) {
      const domain = domainOf(r.url);
      if (isJunkDomain(domain) || seenThisRun.has(domain)) { skipped++; continue; }
      // E2：结果侧兜底滤中国站（.cn / .com.cn），以防 -site:*.cn 未完全生效
      if (domain.endsWith(".cn")) { skipped++; continue; }
      // 快赢②：明显的文章/攻略/资讯页不入库（非真实买家）
      if (isLikelyArticle(r.title, r.url)) { contentSkipped++; continue; }
      seenThisRun.add(domain);
      const website = "https://" + domain;
      const dup = await env.DB.prepare(
        "SELECT id FROM leads WHERE website=? OR website=? LIMIT 1"
      ).bind(website, "https://www." + domain).first();
      if (dup) { skipped++; continue; }
      const company = companyFromDomain(domain) || cleanTitle(r.title);   // M1 域名推名优先，回落标题
      const country = inferCountryFromWebsite(website) || gl.toUpperCase(); // M2 ccTLD 推真实所在国优先，gl 仅兜底；统一大写
      await env.DB.prepare(
        "INSERT INTO leads (company_name, website, country, source, keyword, status) VALUES (?, ?, ?, 'search', ?, 'new')"
      ).bind(company, website, country, kw).run();
      inserted++;
    }
  }
  return { keywords: keywords.length, searched, inserted, skipped, contentSkipped, errors: errors.slice(0, 10), budgetStopped, serperUsedToday: usedToday, serperBudget: budget };
}

// P0-c：读今日 Serper 用量 + 预算（供后台展示）
export async function getSerperUsage(env: Env): Promise<{ usedToday: number; budget: number }> {
  const usedKey = `serper_used_${new Date().toISOString().slice(0, 10)}`;
  const usedToday = Number(await getS(env, usedKey, "0")) || 0;
  const braw = Number(await getS(env, "serper_daily_budget", "200"));
  const budget = Math.max(0, Number.isFinite(braw) ? braw : 200);
  return { usedToday, budget };
}

// ===== 免费目录发现源（批B）：零 Serper 搜索费，抓公开会员目录入库，走现有去重+分析管道 =====
export interface DirectoryResult {
  affcode?: string; fetched: number; inserted: number; skipped: number; noSite: number; social: number; errors: string[];
}
// NMEA 会员目录：Learn More(slug+listingID) 与 Visit Site(官网) 相邻成对；一条正则配对抽取
const NMEA_LISTING_RE = /\/Directory-Listing\/([^"]+?)-(\d+)"[^>]*>\s*Learn More\s*<\/a>\s*<\/span>\s*<span class="ListingResults_Level3_VISITSITE">\s*\|\s*<a href="([^"]+)"/g;
const NMEA_AFFCODES = ["Dealer", "International"];   // Manufacturer(多为厂商非买家)默认不抓

// 抓 NMEA 船舶电子经销商目录的**单个 affcode**（前端逐个调、间隔 10s 遵守 Crawl-delay），入库 source='nmea'
export async function runNmeaDiscovery(env: Env, affcode: string): Promise<DirectoryResult> {
  const aff = NMEA_AFFCODES.includes(affcode) ? affcode : "Dealer";
  const out: DirectoryResult = { affcode: aff, fetched: 0, inserted: 0, skipped: 0, noSite: 0, social: 0, errors: [] };
  let html = "";
  try {
    const res = await fetch(`https://web.nmea.org/directory/results/results.aspx?affcode=${encodeURIComponent(aff)}&ysort=true`, {
      headers: { "user-agent": "TejoyBot/1.0 (+https://tejoy.com; contact hello@tejoy.net)" },
    });
    if (!res.ok) { out.errors.push(`HTTP ${res.status}`); return out; }
    html = await res.text();
  } catch (e: any) { out.errors.push(String(e?.message || e)); return out; }

  const seen = new Set<string>();
  NMEA_LISTING_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NMEA_LISTING_RE.exec(html))) {
    out.fetched++;
    const rawName = m[1].replace(/-/g, " ").replace(/\s+/g, " ").trim();
    const href = (m[3] || "").trim();
    if (/^https?:\/\/NA\/?$/i.test(href)) { out.noSite++; continue; }                 // 占位无站
    const low = href.toLowerCase();
    if (low.includes("facebook.com") || low.includes("instagram.com")) { out.social++; continue; }  // 社媒不当官网
    const domain = domainOf(href);
    if (!domain || isJunkDomain(domain) || seen.has(domain)) { out.skipped++; continue; }
    seen.add(domain);
    const website = href.startsWith("http") ? href.replace(/\/+$/, "") : "https://" + domain;
    const dup = await env.DB.prepare("SELECT id FROM leads WHERE website=? OR website=? LIMIT 1").bind(website, "https://www." + domain).first();
    if (dup) { out.skipped++; continue; }
    const company = rawName || companyFromDomain(domain) || "(unknown)";
    const country = inferCountryFromWebsite(website) || null;   // ccTLD 能推则填，否则留空由 AI 分析回填
    await env.DB.prepare("INSERT INTO leads (company_name, website, country, source, status) VALUES (?, ?, ?, 'nmea', 'new')").bind(company, website, country).run();
    out.inserted++;
  }
  return out;
}

// rvwithtito RV 离网/太阳能安装商名单：URL + 黑名单单一真源（端点与 cron 自动刷新共用，避免两处漂移）
export const RVWITHTITO_URL = "https://rvwithtito.com/rv-solar-installers/";
export const RVWITHTITO_BLACKLIST = [
  "rvwithtito", "google", "facebook", "instagram", "surecart", "mailerlite", "youtube", "twitter", "amazon",
  "wp.com", "gravatar", "w.org", "gmpg.org", "w3.org", "schema.org", "googleapis", "gstatic", "jquery",
  "bootstrapcdn", "cloudflare", "wordpress.org",   // 滤 WP <head> 样板域
];

// 队列⑦：免费目录源「每周自动刷新」——零 Serper。cron 每 6h 调一次，内部判 >7 天才真跑。
// 遵守 robots：affcode 之间 + rvwithtito 之前各停 10s（Crawl-delay 10）、礼貌 UA（在各抓取函数里）。
// 抓到的新公司走现有去重 + 分析管道（cron 的 analyze 步骤会自动按 H3 打分）。
export async function runDirectoryRefresh(env: Env, opts: { force?: boolean } = {}): Promise<{
  ran: boolean; reason?: string; inserted: number; detail: Record<string, number>;
}> {
  const detail: Record<string, number> = {};
  if (!opts.force && (await getS(env, "directory_autorefresh_enabled", "1")) !== "1") {
    return { ran: false, reason: "autorefresh disabled", inserted: 0, detail };
  }
  const last = (await getS(env, "directory_last_refresh", "")).trim();
  if (!opts.force && last) {
    const ts = Date.parse(last);
    if (Number.isFinite(ts) && Date.now() - ts < 7 * 24 * 3600 * 1000) {
      return { ran: false, reason: `last refresh ${last}, <7d`, inserted: 0, detail };
    }
  }
  let inserted = 0;
  for (let i = 0; i < NMEA_AFFCODES.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 10000));   // Crawl-delay 10
    const r = await runNmeaDiscovery(env, NMEA_AFFCODES[i]);
    detail[`nmea:${NMEA_AFFCODES[i]}`] = r.inserted;
    inserted += r.inserted;
  }
  await new Promise((r) => setTimeout(r, 10000));                // 换站也停 10s
  const rv = await runLinkHarvest(env, RVWITHTITO_URL, "rvwithtito", RVWITHTITO_BLACKLIST);
  detail["rvwithtito"] = rv.inserted;
  inserted += rv.inserted;
  await setS(env, "directory_last_refresh", new Date().toISOString());
  return { ran: true, inserted, detail };
}

// 通用「网页链接采集」免费源：抓一个页面正文里的外链域名，黑名单第三方域后入库（rvwithtito 等 RV 安装商名单用）
export async function runLinkHarvest(env: Env, url: string, source: string, blacklist: string[]): Promise<DirectoryResult> {
  const out: DirectoryResult = { fetched: 0, inserted: 0, skipped: 0, noSite: 0, social: 0, errors: [] };
  let html = "";
  try {
    const res = await fetch(url, { headers: { "user-agent": "TejoyBot/1.0 (+https://tejoy.com; contact hello@tejoy.net)" } });
    if (!res.ok) { out.errors.push(`HTTP ${res.status}`); return out; }
    html = await res.text();
  } catch (e: any) { out.errors.push(String(e?.message || e)); return out; }
  const seen = new Set<string>();
  const bl = blacklist.map((b) => b.toLowerCase());
  const re = /href="(https?:\/\/[^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    out.fetched++;
    const href = m[1].trim(); const low = href.toLowerCase();
    if (low.includes("facebook.com") || low.includes("instagram.com")) { out.social++; continue; }
    const domain = domainOf(href);
    if (!domain || isJunkDomain(domain) || bl.some((b) => domain.includes(b)) || seen.has(domain)) { out.skipped++; continue; }
    seen.add(domain);
    const website = "https://" + domain;
    const dup = await env.DB.prepare("SELECT id FROM leads WHERE website=? OR website=? LIMIT 1").bind(website, "https://www." + domain).first();
    if (dup) { out.skipped++; continue; }
    await env.DB.prepare("INSERT INTO leads (company_name, website, country, source, status) VALUES (?, ?, ?, ?, 'new')").bind(companyFromDomain(domain) || "(unknown)", website, inferCountryFromWebsite(website) || null, source).run();
    out.inserted++;
  }
  return out;
}

// 本地 settings 读写（避免 discover→send 循环依赖）
async function getS(env: Env, key: string, def = ""): Promise<string> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(key).first<{ value: string }>();
  return row?.value ?? def;
}
async function setS(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key, value).run();
}

// 关键词池：优先 keywords 表，空则用默认；P0-a 尊重面板勾选（active_keywords 非空则只用勾选的）
export async function getKeywords(env: Env): Promise<string[]> {
  const rows = await env.DB.prepare("SELECT keyword FROM keywords ORDER BY weight DESC, id ASC").all();
  const list = (rows.results as any[]).map((r) => r.keyword);
  if (!list.length) return DEFAULT_KEYWORDS;
  const akRaw = (await getS(env, "active_keywords", "")).trim();   // P0-a：面板"取消勾选"的关键词 cron 真的不跑
  if (akRaw) {
    const active = new Set(akRaw.split("\n").map((s) => s.trim()).filter(Boolean));
    const filtered = list.filter((k) => active.has(k));
    if (filtered.length) return filtered;   // 勾选集非空→只用勾选的；全没匹配上则回落全表（防误清空导致 0 词）
  }
  return list;
}

export async function seedDefaultKeywords(env: Env): Promise<void> {
  for (const kw of DEFAULT_KEYWORDS) {
    await env.DB.prepare("INSERT INTO keywords (keyword) VALUES (?) ON CONFLICT(keyword) DO NOTHING").bind(kw).run();
  }
}

export interface KeywordStat { keyword: string; sent: number; replied: number; rate: number; weight: number; }

// 关键词优化引擎：按各关键词真实回复率重算权重，让高回报词被搜得更多、低效词自然降权。
// - sent    = 该 keyword 的 lead 中「有 status='sent' 邮件」的去重数
// - replied = 该 keyword 的 lead 中「status='replied' 或 replies 表有记录」的去重数
// - weight  = 拉普拉斯平滑：先验回复率 P0、伪计数 ALPHA，使 0 数据新词恰好落在默认 1.0（不惩罚），
//             有数据后好词上浮、发多零回的词下沉；clamp 到 [WMIN,WMAX] 避免小样本噪音。
// leads.keyword 可能为 NULL（CSV 导入的没有）——keyword=? 连接自然跳过。全部 SQL 参数化。
export async function recomputeKeywordStats(env: Env): Promise<{ updated: number; stats: KeywordStat[] }> {
  const P0 = 0.05, ALPHA = 10, K = 10, WMIN = 0.2, WMAX = 5;
  const rows = await env.DB.prepare("SELECT id, keyword FROM keywords").all();
  const kws = rows.results as { id: number; keyword: string }[];
  const stats: KeywordStat[] = [];
  let updated = 0;
  for (const { id, keyword } of kws) {
    if (!keyword) continue;
    const sentRow = await env.DB.prepare(
      "SELECT COUNT(DISTINCT l.id) AS n FROM leads l JOIN emails e ON e.lead_id = l.id WHERE l.keyword = ? AND e.status = 'sent'"
    ).bind(keyword).first<{ n: number }>();
    const repRow = await env.DB.prepare(
      "SELECT COUNT(DISTINCT l.id) AS n FROM leads l WHERE l.keyword = ? AND (l.status = 'replied' OR EXISTS (SELECT 1 FROM replies r WHERE r.lead_id = l.id))"
    ).bind(keyword).first<{ n: number }>();
    const sent = sentRow?.n || 0;
    const replied = repRow?.n || 0;
    let weight: number;
    if (sent === 0) {
      weight = 1.0; // 0 数据的新词：保持默认权重，不惩罚
    } else {
      const smoothed = (replied + ALPHA * P0) / (sent + ALPHA);
      weight = Math.max(WMIN, Math.min(WMAX, 1 + (smoothed - P0) * K));
      weight = Math.round(weight * 1000) / 1000;
    }
    await env.DB.prepare(
      "UPDATE keywords SET sent_count = ?, reply_count = ?, weight = ? WHERE id = ?"
    ).bind(sent, replied, weight, id).run();
    updated++;
    stats.push({ keyword, sent, replied, rate: sent > 0 ? replied / sent : 0, weight });
  }
  return { updated, stats };
}
