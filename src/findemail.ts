// 邮箱发现：深挖联系页 + 反混淆；可选 Hunter.io 兜底。给缺邮箱的真实客户补上可发地址。
import type { Env } from "./index";
import { htmlToText } from "./scrape";

const UA = "Mozilla/5.0 (compatible; TejoyBot/0.1; +https://tejoy.com)";
const TIMEOUT = 6000;
// 高命中率联系页路径（含 Shopify /pages/ 结构）；并行抓取，速度≈单页
const PATHS = [
  "", "/contact", "/contact-us", "/contactus",
  "/about", "/about-us", "/pages/contact", "/pages/contact-us",
];

const JUNK = /(example\.|test@|your-?email|name@|email@|sentry\.|wixpress|\.png|\.jpg|\.jpeg|\.gif|\.webp|\.svg|@2x|domain\.com|yourdomain|godaddy|sentry|wordpress\.|w3\.org|schema\.org|@example)/i;

export interface FindResult { email: string | null; source: string; candidates: string[] }

// useHunter：是否允许调用 Hunter 兜底（消耗付费/免费额度）。默认 false，只做免费官网抓取，避免自动花钱。
export async function findLeadEmail(env: Env, website: string, useHunter = false): Promise<FindResult> {
  const base = normalize(website);
  if (!base) return { email: null, source: "no-url", candidates: [] };
  const origin = new URL(base).origin;
  const emails = new Set<string>();

  // 并行抓所有候选联系页（总耗时≈最慢的单页，而非累加）—— 免费，不花额度
  const htmls = await Promise.all(PATHS.map((p) => fetchPage(origin + p)));
  for (const html of htmls) {
    if (html) extractEmailsDeep(html).forEach((e) => emails.add(e));
  }

  const ranked = rank([...emails], origin);
  if (ranked.length) return { email: ranked[0], source: "scrape", candidates: ranked };

  // 兜底：Hunter.io（需 EMAIL_FINDER_API_KEY + 明确 useHunter=true。每次查 1 家=1 积分）
  if (useHunter && env.EMAIL_FINDER_API_KEY) {
    try {
      const h = await hunterDomainSearch(env, new URL(base).hostname.replace(/^www\./, ""));
      if (h.length) return { email: h[0], source: "hunter", candidates: h };
    } catch { /* 忽略兜底失败 */ }
  }
  return { email: null, source: "none", candidates: [] };
}

async function hunterDomainSearch(env: Env, domain: string): Promise<string[]> {
  const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${env.EMAIL_FINDER_API_KEY}&limit=10`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data: any = await res.json();
  const emails: { value: string; conf: number }[] = (data?.data?.emails || [])
    .map((e: any) => ({ value: String(e.value || "").toLowerCase(), conf: Number(e.confidence) || 0 }))
    .filter((e: any) => valid(e.value));
  // 优先高置信度 + 角色/通用邮箱
  emails.sort((a, b) => b.conf - a.conf);
  return emails.map((e) => e.value);
}

function extractEmailsDeep(html: string): string[] {
  const out = new Set<string>();
  // 解码 HTML 实体（常见混淆手段：&#64; = @）
  let h = html
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&commat;/gi, "@").replace(/&period;/gi, ".");
  // mailto: 最可靠
  for (const m of h.matchAll(/mailto:([^"'?>\s]+)/gi)) {
    const e = safeDecode(m[1]).trim().toLowerCase();
    if (valid(e)) out.add(e);
  }
  let text = htmlToText(h);
  // 反混淆：user [at] domain [dot] com / (at) / {at}
  text = text
    .replace(/\s*[\[({]\s*at\s*[\])}]\s*/gi, "@")
    .replace(/\s*[\[({]\s*dot\s*[\])}]\s*/gi, ".");
  // 重建空格分隔的邮箱：user @ domain . com
  text = text.replace(/([a-z0-9._%+\-]+)\s*@\s*([a-z0-9.\-]+)\s*\.\s*([a-z]{2,})/gi, "$1@$2.$3");
  for (const m of text.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi) || []) {
    const e = m.trim().toLowerCase();
    if (valid(e)) out.add(e);
  }
  return [...out];
}

function valid(e: string): boolean {
  if (!e || e.length > 100 || !e.includes("@")) return false;
  if (JUNK.test(e)) return false;
  return /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(e);
}

function rank(emails: string[], origin: string): string[] {
  let domain = "";
  try { domain = new URL(origin).hostname.replace(/^www\./, ""); } catch {}
  const role = ["sales", "info", "contact", "hello", "support", "enquiries", "inquiries", "office", "admin", "orders"];
  const score = (e: string) => {
    let s = 0;
    const [local, host] = e.split("@");
    if (domain && host && host.replace(/^www\./, "").endsWith(domain)) s += 100;
    const i = role.indexOf(local);
    if (i !== -1) s += 50 - i * 2;
    if (/(noreply|no-reply|donotreply|postmaster|abuse|webmaster|privacy|legal)/.test(local)) s -= 100;
    return s;
  };
  return emails.sort((a, b) => score(b) - score(a));
}

function safeDecode(s: string): string { try { return decodeURIComponent(s); } catch { return s; } }

async function fetchPage(url: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT);
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html" }, signal: ctrl.signal, redirect: "follow" });
    clearTimeout(t);
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/html") && !ct.includes("text/")) return null;
    return await res.text();
  } catch { return null; }
}

function normalize(u: string): string {
  const t = (u || "").trim();
  if (!t) return "";
  const withProto = /^https?:\/\//i.test(t) ? t : "https://" + t;
  try { const url = new URL(withProto); return url.origin + url.pathname.replace(/\/+$/, ""); } catch { return ""; }
}
