// 抓取客户官网正文：首页 + 最多几个相关子页（about/contact/products/services）
const UA = "Mozilla/5.0 (compatible; TejoyBot/0.1; +https://tejoy.com)";
// ⭐ 首页给足时间，子页保持紧。
// 抽样 20 家 NMEA 线索实测：8s 超时把**真·船舶电子经销商**挡在门外——
//   dinnteco.com 7.6s（卡在 8s 线上，时好时坏）、naocontrol.com 10.5s、
//   wema-marine.se 12.4s（跳到 frigus.se，多一跳）。用 curl 两种 UA 探都是 200，
//   站好好的，是我们自己超时。这解释了"第 1 遍 85 分、第 2 遍抓不到"——它们就卡在线上，抓不抓得到看运气。
// 首页决定这条线索的生死（ok=false 直接进抓失败分支），值得多等；
// 子页只是补充证据，抓不到就算了，保持 8s 免得一条线索拖垮整轮 cron。
// 预算：最坏 18 + 3×8 = 42s 挂钟（旧值 32s），子请求数不变。
const HOME_TIMEOUT_MS = 18000;
const PAGE_TIMEOUT_MS = 8000;
const MAX_TEXT = 8000; // 交给 LLM 的正文上限（字符）

export interface Channels {
  linkedin?: string; facebook?: string; instagram?: string; youtube?: string;
  whatsapp?: string; telegram?: string; phone?: string;
}

export interface ScrapeResult {
  ok: boolean;
  text: string;
  pages: string[];
  emails: string[]; // 从页面提取到的联系邮箱（已排序，最相关在前）
  channels: Channels; // 抓到的社媒/IM/电话渠道（快赢①）
  error?: string;
}

export async function scrapeSite(website: string): Promise<ScrapeResult> {
  const base = normalize(website);
  if (!base) return { ok: false, text: "", pages: [], emails: [], channels: {}, error: "无有效网址" };

  const visited: string[] = [];
  const emailSet = new Set<string>();
  const channels: Channels = {};
  let combined = "";

  const home = await fetchPage(base, HOME_TIMEOUT_MS);   // 首页决定生死，给足时间（见文件头注释）
  if (!home) return { ok: false, text: "", pages: [], emails: [], channels: {}, error: "首页抓取失败" };
  visited.push(base);
  combined += `# ${base}\n${htmlToText(home)}\n\n`;
  extractEmails(home, base).forEach((e) => emailSet.add(e));
  mergeChannels(channels, extractChannels(home));

  // 从首页链接里挑相关子页（contact 页优先，邮箱多半在那）
  const candidates = pickInternalLinks(home, base);
  for (const url of candidates.slice(0, 3)) {
    const html = await fetchPage(url);
    if (!html) continue;
    visited.push(url);
    combined += `# ${url}\n${htmlToText(html)}\n\n`;
    extractEmails(html, url).forEach((e) => emailSet.add(e));
    mergeChannels(channels, extractChannels(html));
    if (combined.length > MAX_TEXT && emailSet.size > 0) break;
  }

  return { ok: true, text: combined.slice(0, MAX_TEXT), pages: visited, emails: rankEmails([...emailSet], base), channels };
}

// 提取社媒/IM/电话渠道（快赢①）：从 <a href>/og:url 等属性里匹配已知平台，取每类第一个"带 handle"的链接。
export function extractChannels(html: string): Channels {
  const ch: Channels = {};
  const set = (k: keyof Channels, v: string) => { if (!ch[k] && v) ch[k] = v; };
  const abs = (href: string): string => {
    if (/^https?:\/\//i.test(href)) return href;
    if (href.startsWith("//")) return "https:" + href;
    return "https://" + href.replace(/^\/+/, "");
  };
  const re = /(?:href|content)\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = m[1].trim();
    const low = href.toLowerCase();
    if (/^(mailto:|javascript:|#|data:)/.test(low)) continue;
    if (low.startsWith("tel:")) { set("phone", href.slice(4).trim()); continue; }
    // 需带 handle/路径段，过滤指向平台首页或分享/插件的无效链接
    if (/(?:^|\/\/|\.)linkedin\.com\/(?:company|in|pub|school)\/[a-z0-9%._\-]+/.test(low)) set("linkedin", abs(href));
    else if (/(?:^|\/\/|\.)(?:facebook\.com|fb\.com)\/[a-z0-9.\-]{2,}/.test(low) && !/(sharer|share\.php|\/plugins\/|\/dialog\/|\/tr\?)/.test(low)) set("facebook", abs(href));
    else if (/(?:^|\/\/|\.)instagram\.com\/[a-z0-9._]{2,}/.test(low) && !/\/(p|reel|explore)\//.test(low)) set("instagram", abs(href));
    else if (/(?:^|\/\/|\.)youtube\.com\/(?:channel|c|user|@)[a-z0-9%._\-]+/.test(low) || /(?:^|\/\/|\.)youtu\.be\/[a-z0-9_\-]+/.test(low)) set("youtube", abs(href));
    else if (/(?:wa\.me\/\+?\d{6,}|api\.whatsapp\.com\/send\?phone=\+?\d{6,}|chat\.whatsapp\.com\/[a-z0-9]+)/.test(low)) set("whatsapp", abs(href));
    else if (/(?:^|\/\/|\.)t\.me\/[a-z0-9_]{3,}/.test(low)) set("telegram", abs(href));
  }
  return ch;
}
function mergeChannels(into: Channels, from: Channels): void {
  for (const k of Object.keys(from) as (keyof Channels)[]) if (!into[k] && from[k]) into[k] = from[k];
}

// 从 HTML 提取邮箱：mailto 链接 + 正文正则，过滤垃圾
const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi;
const JUNK_EMAIL = /(example\.|test@|your-?email|name@|email@|sentry\.|wixpress|\.png|\.jpg|\.jpeg|\.gif|\.webp|\.svg|@sentry|@2x|domain\.com|yourdomain|godaddy|@example)/i;

function extractEmails(html: string, pageUrl: string): string[] {
  const out = new Set<string>();
  // mailto: 链接最可靠
  const mailtoRe = /mailto:([^"'?>\s]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = mailtoRe.exec(html))) {
    const e = decodeURIComponent(m[1]).trim().toLowerCase();
    if (isValidEmail(e)) out.add(e);
  }
  // 正文中的邮箱
  const text = htmlToText(html);
  const matches = text.match(EMAIL_RE) || [];
  for (const raw of matches) {
    const e = raw.trim().toLowerCase();
    if (isValidEmail(e)) out.add(e);
  }
  return [...out];
}

function isValidEmail(e: string): boolean {
  if (!e || e.length > 100 || !e.includes("@")) return false;
  if (JUNK_EMAIL.test(e)) return false;
  if (!/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(e)) return false;
  return true;
}

// 排序：同域优先 > 角色邮箱(sales/info/contact/hello/sales) > 其他
function rankEmails(emails: string[], base: string): string[] {
  let domain = "";
  try { domain = new URL(base).hostname.replace(/^www\./, ""); } catch {}
  const rolePriority = ["sales", "info", "contact", "hello", "support", "enquiries", "inquiries", "office", "admin"];
  const score = (e: string): number => {
    let s = 0;
    const [local, host] = e.split("@");
    if (domain && host && host.replace(/^www\./, "").endsWith(domain)) s += 100; // 同域大加分
    const roleIdx = rolePriority.indexOf(local);
    if (roleIdx !== -1) s += 50 - roleIdx * 2;
    if (/(noreply|no-reply|donotreply|postmaster|abuse|webmaster)/.test(local)) s -= 100; // 系统邮箱降权
    return s;
  };
  return emails.sort((a, b) => score(b) - score(a));
}

async function fetchPage(url: string, timeoutMs: number = PAGE_TIMEOUT_MS): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      headers: { "user-agent": UA, accept: "text/html" },
      signal: ctrl.signal,
      redirect: "follow",
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/html") && !ct.includes("text/")) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function normalize(u: string): string {
  const t = (u || "").trim();
  if (!t) return "";
  const withProto = /^https?:\/\//i.test(t) ? t : "https://" + t;
  try {
    const url = new URL(withProto);
    return url.origin + url.pathname.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

const REL_KEYWORDS = ["about", "contact", "product", "service", "solution", "shop", "starlink"];
// ⭐ 证据页：能证明"它在卖/装实体硬件"的页面。打分闸的唯一判据就是这个，
//    所以这些页必须优先抓 —— 只采 ≤3 个子页时，抓到产品页还是抓到"关于我们"，
//    直接决定这条线索是 85 还是 30。以前按 found 的插入顺序挑 = 闭着眼睛抓。
//
// 分强弱两档（实测教训）：`service` 这种弱词会命中 /service-areas、/terms-of-service，
// 它们不证明在卖硬件，却会靠文档顺序**挤掉 /products/**。所以强证据必须排在弱证据前面。
const EVIDENCE_STRONG = /(starlink|product|dealer|shop|store|catalog|equipment|brand|reseller|distributor)/i;
const EVIDENCE_WEAK = /(install|service|solution)/i;
// 法务/招聘页永远不是证据，先排掉——否则 terms-of-service 会命中上面的 service
const EVIDENCE_JUNK = /(terms|privacy|policy|legal|cookie|career|job|login|cart|checkout|account)/i;
const MAX_SCAN = 60;   // 最多扫这么多个 <a>，够翻出证据页又不至于在大站上空转

function pickInternalLinks(html: string, base: string): string[] {
  const origin = new URL(base).origin;
  const seen = new Set<string>();
  const strong: string[] = []; // 直接指向"卖什么"的页 → 最优先
  const weak: string[] = [];   // 可能相关（安装/服务）→ 次之
  const rest: string[] = [];   // 其它相关页（about/contact 等）→ 补剩余名额
  // 连锚文本一起取：URL 常是 /p/12345 这种看不出内容的，但锚文本写着 "Shop Starlink"。
  // 只看 URL 会把这类证据页整个漏掉。
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  let scanned = 0;
  while ((m = re.exec(html)) && scanned < MAX_SCAN) {
    scanned++;
    const href = m[1].trim();
    const anchor = htmlToText(m[2] || "").slice(0, 120);
    if (!href || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) continue;
    let abs: string;
    try {
      abs = new URL(href, base).href.replace(/\/+$/, "");
    } catch {
      continue;
    }
    if (!abs.startsWith(origin)) continue; // 只抓同站
    if (seen.has(abs)) continue;
    const lower = abs.toLowerCase();
    const hay = lower + " " + anchor.toLowerCase();
    if (EVIDENCE_JUNK.test(hay)) continue;                    // 法务/招聘/购物车：永远不是证据
    const isStrong = EVIDENCE_STRONG.test(hay);
    const isWeak = !isStrong && EVIDENCE_WEAK.test(hay);
    const isRelated = REL_KEYWORDS.some((k) => lower.includes(k));
    if (!isStrong && !isWeak && !isRelated) continue;
    seen.add(abs);
    (isStrong ? strong : isWeak ? weak : rest).push(abs);
    if (strong.length + weak.length + rest.length >= 12) break;
  }
  return [...strong, ...weak, ...rest];   // 强证据排最前；调用方 slice(0,3) 就会先要它们
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}
