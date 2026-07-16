// P3 发信：解析 AI 开发信 → 加退订/地址页脚 → 调 Resend → 状态回写 D1 → 每日限量
import type { Env } from "./index";
import { writeFollowup, writeWarmFollowup } from "./openrouter";
import { getProfile } from "./service";

const RESEND_URL = "https://api.resend.com/emails";

// ---- 通用 settings 读写 ----
export async function getSetting(env: Env, key: string, def = ""): Promise<string> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? def;
}
export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).bind(key, value).run();
}

export interface SendOutcome {
  ok: boolean;
  id: number;
  error?: string;
  skipped?: string;
}

// M3 合规红线：这些状态的线索绝不发信（退订/黑名单/退信/已忽略/已成交）。发送入口硬校验（第一道）。
// won（已成交）纳入压制：成交客户不再自动冷发/跟进。
const SUPPRESSED_STATUSES = new Set(["unsubscribed", "blacklisted", "bounced", "ignored", "won"]);

// M3 终极闸：持久压制名单（suppressed_emails 表），不依赖可变 status，堵"两跳洗白"+同邮箱重导入复发。
export async function addSuppressedEmail(env: Env, email: string | null | undefined, reason: string): Promise<void> {
  const e = (email || "").toLowerCase().trim();
  if (!e) return;
  try {
    await env.DB.prepare("INSERT OR IGNORE INTO suppressed_emails (email, reason) VALUES (?, ?)").bind(e, reason).run();
  } catch (err) { console.error("addSuppressedEmail:", err); } // 记压制失败不阻断主流程
}
export async function isEmailSuppressed(env: Env, email: string | null | undefined): Promise<boolean> {
  const e = (email || "").toLowerCase().trim();
  if (!e) return false;
  try {
    const row = await env.DB.prepare("SELECT 1 AS x FROM suppressed_emails WHERE email = ?").bind(e).first();
    return !!row;
  } catch (err) { console.error("isEmailSuppressed:", err); return false; } // 迁移未就绪时退回 status 闸兜底
}

// 把 "Subject: xxx\n\n正文" 拆成 {subject, body}
function parseEmail(recommended: string): { subject: string; body: string } {
  const text = (recommended || "").trim();
  const m = text.match(/^subject:\s*(.+)$/im);
  if (m) {
    const subject = m[1].trim();
    const body = text.slice(text.indexOf(m[0]) + m[0].length).replace(/^\s+/, "");
    return { subject, body };
  }
  return { subject: "Hello from TEJOY", body: text };
}

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
}

function bodyToHtml(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px">${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function hostOf(u: string): string {
  try { return new URL(u).host.replace(/^www\./, ""); } catch { return u.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""); }
}

function buildHtml(body: string, unsubUrl: string, company: string, address: string, website: string): string {
  const siteLine = website
    ? `Website: <a href="${esc(website)}" style="color:#6a6a6a">${esc(hostOf(website))}</a><br>`
    : "";
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#222;line-height:1.6;max-width:600px">
${bodyToHtml(body)}
<hr style="border:none;border-top:1px solid #e2e2e2;margin:26px 0 12px">
<div style="font-size:12px;color:#8a8a8a;line-height:1.5">
${esc(company)}${address ? " · " + esc(address) : ""}<br>
${siteLine}If you'd prefer not to receive these emails, <a href="${unsubUrl}" style="color:#8a8a8a">unsubscribe here</a>.
</div>
</div>`;
}

function buildText(body: string, unsubUrl: string, company: string, address: string, website: string): string {
  return `${body}\n\n---\n${company}${address ? " · " + address : ""}${website ? "\nWebsite: " + website : ""}\nUnsubscribe: ${unsubUrl}`;
}

// 今日已发送数量（UTC 日期）
async function sentToday(env: Env): Promise<number> {
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM emails WHERE status='sent' AND date(sent_at)=date('now')"
  ).first<{ n: number }>();
  return r?.n ?? 0;
}

/** 今天**自动**发出去几封（供 auto_send_daily_limit 用；与全局 daily_send_limit 是"与"的关系） */
export async function autoSentToday(env: Env): Promise<number> {
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM emails WHERE status='sent' AND auto_sent=1 AND date(sent_at)=date('now')"
  ).first<{ n: number }>();
  return r?.n ?? 0;
}

// ⭐ 熔断器：自动发送的前提条件，不是附加功能。
// 实证：40 封手动 → 12 退订（30%）。手动时这个问题每天发生一次；自动之后 7×24 发生。
// 按 15/天自动发就是每天 ~4-5 个退订，Resend 会标记账号、收件方开始把 hello@tejoy.net 判垃圾。
export const BREAKER_WINDOW = 30;      // 窗口：最近 30 封**自动发出的初次开发信**
export const BREAKER_THRESHOLD = 0.15; // 退订占比 ≥15% 即熔断

export interface BreakerStatus {
  window: number;        // 窗口内实际有几封（<30 说明样本不足）
  unsubs: number;
  rate: number;          // 0~1
  enoughSample: boolean;
  shouldTrip: boolean;
}

/**
 * 只统计**自动发出的初次开发信**：
 *  · 手动发的不算 —— Joe 手动挑着发的那批退订率高低，跟"自动发送该不该停"是两回事
 *  · 跟进信不算 —— 窗口口径是初次触达
 * 退订判定用 **suppressed_emails(reason='unsubscribe')** 为主 + leads.status 兜底：
 *  按 M3 的原则，压制名单是持久记录、不依赖可变的 status（防"两跳洗白"后统计失真）。
 *
 * ⭐ 窗口从 `auto_send_resumed_at`（Joe 上次手动重开的时刻）之后算起 —— 这条不加的话熔断**不可恢复**：
 *    熔断后自动发送停了 → 窗口再也不进新数据 → 永远卡在那个 30% →
 *    Joe 一重开，下一轮 cron 立刻拿同一批老数据再熔断一次，一封新信都发不出去。
 *    重开＝Joe 说"我查过了、改过了"，那就该拿**改之后的新数据**重新判，而不是拿旧账再判他一次。
 *    这不是"自动恢复"（总工明确禁止的那个）：没有 Joe 手动点，永远不会重开。
 */
export async function getBreakerStatus(env: Env): Promise<BreakerStatus> {
  const since = await getSetting(env, "auto_send_resumed_at", "");
  const row = await env.DB.prepare(
    `WITH w AS (
       SELECT e.lead_id FROM emails e
       WHERE e.auto_sent=1 AND e.kind='initial' AND e.status='sent' AND e.sent_at IS NOT NULL
         AND (? = '' OR e.sent_at > ?)
       ORDER BY e.sent_at DESC LIMIT ?
     )
     SELECT COUNT(*) AS n,
            SUM(CASE WHEN l.status='unsubscribed'
                       OR lower(COALESCE(l.email,'')) IN (SELECT email FROM suppressed_emails WHERE reason='unsubscribe')
                     THEN 1 ELSE 0 END) AS u
     FROM w JOIN leads l ON l.id = w.lead_id`
  ).bind(since, since, BREAKER_WINDOW).first<{ n: number; u: number }>();
  const window = row?.n ?? 0;
  const unsubs = row?.u ?? 0;
  const enoughSample = window >= BREAKER_WINDOW;
  const rate = window > 0 ? unsubs / window : 0;
  // ⚠️ 样本不足**不熔断**：这跟数据看板 n<50 只显示计数、不显示率是同一条原则，别在这儿破例。
  //    5 封里 2 封退订说明不了任何事，据此停掉自动发送只会变成随机噪声开关。
  return { window, unsubs, rate, enoughSample, shouldTrip: enoughSample && rate >= BREAKER_THRESHOLD };
}

// 发信核心：落 queued 记录 → 调 Resend → 回写 email 状态。不改 lead 状态（调用方决定）。
async function deliverEmail(env: Env, lead: any, subject: string, body: string, kind: "initial" | "followup" | "confirmation", autoSent = false): Promise<SendOutcome> {
  // M3 终极闸：持久压制名单命中即 skip（不依赖 status，两跳洗白/重导入也拦得住）
  if (await isEmailSuppressed(env, lead.email)) {
    return { ok: false, id: lead.id, skipped: "邮箱在压制名单，不发送" };
  }
  // S2 幂等：初次开发信只发一次——已有 initial 邮件(已发/排队中)则跳过，防并发/重叠导致同一 lead 重复发信
  if (kind === "initial") {
    const dup = await env.DB.prepare(
      "SELECT id FROM emails WHERE lead_id=? AND kind='initial' AND status IN ('sent','queued') LIMIT 1"
    ).bind(lead.id).first();
    if (dup) return { ok: false, id: lead.id, skipped: "已发过初次开发信（幂等跳过）" };
  }
  const senderEmail = env.SENDER_EMAIL || "hello@tejoy.net";
  const senderName = env.SENDER_NAME || "Tejoy";
  const appUrl = (env.APP_URL || "http://localhost:8787").replace(/\/+$/, "");
  const company = await getSetting(env, "company_name", "TEJOY");
  const address = await getSetting(env, "company_address", "");
  const website = await getSetting(env, "company_website", env.SITE_URL || "https://tejoy.com");

  const token = crypto.randomUUID();
  const unsubUrl = `${appUrl}/u/${token}`;

  const ins = await env.DB.prepare(
    "INSERT INTO emails (lead_id, subject, body, status, kind, unsubscribe_token, auto_sent, created_at) VALUES (?, ?, ?, 'queued', ?, ?, ?, datetime('now'))"
  ).bind(lead.id, subject, body, kind, token, autoSent ? 1 : 0).run();
  const emailId = ins.meta.last_row_id;

  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: `${senderName} <${senderEmail}>`,
        to: [lead.email],
        subject,
        html: buildHtml(body, unsubUrl, company, address, website),
        text: buildText(body, unsubUrl, company, address, website),
        reply_to: senderEmail,
        headers: {
          "List-Unsubscribe": `<${unsubUrl}>, <mailto:${senderEmail}?subject=unsubscribe>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      await env.DB.prepare("UPDATE emails SET status='failed' WHERE id=?").bind(emailId).run();
      return { ok: false, id: lead.id, error: `Resend ${res.status}: ${t.slice(0, 200)}` };
    }
    const data: any = await res.json();
    await env.DB.prepare(
      "UPDATE emails SET status='sent', provider_id=?, sent_at=datetime('now') WHERE id=?"
    ).bind(data?.id ?? null, emailId).run();
    return { ok: true, id: lead.id };
  } catch (e: any) {
    await env.DB.prepare("UPDATE emails SET status='failed' WHERE id=?").bind(emailId).run();
    return { ok: false, id: lead.id, error: e.message || String(e) };
  }
}

// 发送单条初次开发信（要求 lead 已 approved 且有 analysis.recommended_email）
export async function sendLead(env: Env, lead: any, autoSent = false): Promise<SendOutcome> {
  if (!env.RESEND_API_KEY) return { ok: false, id: lead.id, error: "缺少 RESEND_API_KEY（.dev.vars / wrangler secret）" };
  if (!lead.email) return { ok: false, id: lead.id, skipped: "无邮箱" };
  if (SUPPRESSED_STATUSES.has(lead.status)) return { ok: false, id: lead.id, skipped: `压制名单(${lead.status})，不发送` };

  const analysis = await env.DB.prepare(
    "SELECT recommended_email FROM lead_analysis WHERE lead_id = ?"
  ).bind(lead.id).first<{ recommended_email: string }>();
  if (!analysis?.recommended_email) return { ok: false, id: lead.id, skipped: "无 AI 开发信（先分析）" };

  const { subject, body } = parseEmail(analysis.recommended_email);
  const out = await deliverEmail(env, lead, subject, body, "initial", autoSent);
  if (out.ok) {
    await env.DB.prepare("UPDATE leads SET status='sent', updated_at=datetime('now') WHERE id=?").bind(lead.id).run();
  }
  return out;
}

// 发送单条跟进信（第二次触达，lead 保持 sent 状态）。warm=true 用「趁热跟进」暖变体（engaged 点击线索）。
export async function sendFollowup(env: Env, lead: any, warm = false): Promise<SendOutcome> {
  if (!env.RESEND_API_KEY) return { ok: false, id: lead.id, error: "缺少 RESEND_API_KEY" };
  if (!lead.email) return { ok: false, id: lead.id, skipped: "无邮箱" };
  if (SUPPRESSED_STATUSES.has(lead.status)) return { ok: false, id: lead.id, skipped: `压制名单(${lead.status})，不发送` };

  const analysis = await env.DB.prepare(
    "SELECT recommended_email FROM lead_analysis WHERE lead_id = ?"
  ).bind(lead.id).first<{ recommended_email: string }>();
  const original = analysis?.recommended_email || "";

  let subject: string, body: string;
  try {
    const raw = warm
      ? await writeWarmFollowup(env, lead.company_name || "", await getProfile(env), original)
      : await writeFollowup(env, lead.company_name || "", original);
    ({ subject, body } = parseEmail(raw));
  } catch (e: any) {
    return { ok: false, id: lead.id, error: "写跟进信失败: " + (e.message || String(e)) };
  }
  // 跟进信主题接原信更自然
  if (!/^re:/i.test(subject)) {
    const os = parseEmail(original).subject;
    if (os && os !== "Hello from TEJOY") subject = "Re: " + os;
  }
  return await deliverEmail(env, lead, subject, body, "followup");
}

// 详情弹窗「趁热跟进」半自动发送：用户审过（可能已编辑）的暖跟进全文 → 直接发 followup。
// 不重新生成、不改 lead 状态；走 deliverEmail（isEmailSuppressed 终极闸在其内）+ 同一道 SUPPRESSED_STATUSES 硬校验。
export async function sendWarmFollowupNow(env: Env, lead: any, fullText: string): Promise<SendOutcome> {
  if (!env.RESEND_API_KEY) return { ok: false, id: lead.id, error: "缺少 RESEND_API_KEY" };
  if (!lead.email) return { ok: false, id: lead.id, skipped: "无邮箱" };
  if (SUPPRESSED_STATUSES.has(lead.status)) return { ok: false, id: lead.id, skipped: `压制名单(${lead.status})，不发送` };
  const { subject, body } = parseEmail(fullText || "");
  if (!body.trim()) return { ok: false, id: lead.id, error: "跟进信内容为空" };
  return await deliverEmail(env, lead, subject, body, "followup");
}

// 批量跟进：对"已发但 N 天无回复"的线索发跟进信（需开关开启，遵守每日上限与最多跟进次数）
// ids 传入时只跟进这些选中的（仍受全部闸门：followup_enabled 开关 + status='sent' + 有邮箱 +
// 累计跟进 <= followup_max + 冷却天数未到不发 + 每日上限 + deliverEmail 幂等 + 压制名单）。
// engaged(点过链接)的会自动用「趁热」暖变体——所以「跟进选中」和「趁热跟进选中」共用这一条路径。
export async function sendFollowupBatch(env: Env, requested: number, ids?: number[]): Promise<{ processed: number; sent: number; results: SendOutcome[]; disabled?: boolean; capReached?: boolean; dailyLimit: number; sentToday: number }> {
  if ((await getSetting(env, "followup_enabled", "0")) !== "1") {
    return { processed: 0, sent: 0, results: [], disabled: true, dailyLimit: 0, sentToday: 0 };
  }
  const delayDays = Math.max(1, Number(await getSetting(env, "followup_delay_days", "4")) || 4);
  const engagedDelayDays = Math.max(1, Number(await getSetting(env, "engaged_follow_up_delay_days", "2")) || 2);
  const maxFollowups = Math.max(1, Number(await getSetting(env, "followup_max", "1")) || 1);
  const dailyLimit = Number(await getSetting(env, "daily_send_limit", "15")) || 15;
  const already = await sentToday(env);
  const take = Math.min(requested, Math.max(0, dailyLimit - already));
  if (take <= 0) return { processed: 0, sent: 0, results: [], capReached: true, dailyLimit, sentToday: already };

  // 两档跟进：
  //  · engaged（曾点击=有意向）→ 更短的 engagedDelayDays、从 last_engaged_at 起算、用「趁热」暖变体；
  //  · 非 engaged → 原 delayDays、从 last_sent 起算、用常规跟进。
  // 都要 status=sent、有邮箱、累计已发 <= maxFollowups。已回复/退订/黑名单/退信 因 status 非 sent 已自动排除。engaged 优先（趁热）。
  // 批③C：传了 ids 就只在同一条 WHERE 上再加 id IN (...) —— 开关/冷却/次数/上限/幂等/压制全部照旧，只是范围收窄到选中项
  const idList = Array.isArray(ids) ? ids.filter((n) => Number.isFinite(n)) : [];
  const idFilter = idList.length ? ` AND l.id IN (${idList.map(() => "?").join(",")})` : "";
  const sql =
    `SELECT l.*, COUNT(e.id) AS sent_count, MAX(e.sent_at) AS last_sent,
            MAX(CASE WHEN e.clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS has_click
       FROM leads l JOIN emails e ON e.lead_id = l.id AND e.status='sent'
      WHERE l.status='sent' AND l.email IS NOT NULL AND l.email != ''${idFilter}
      GROUP BY l.id
     HAVING sent_count <= ?
        AND (
          (has_click = 1 AND l.last_engaged_at IS NOT NULL AND l.last_engaged_at <= datetime('now', ?))
          OR
          (has_click = 0 AND MAX(e.sent_at) <= datetime('now', ?))
        )
      ORDER BY has_click DESC, last_sent ASC
      LIMIT ?`;
  const rows = await env.DB.prepare(sql)
    .bind(...idList, maxFollowups, `-${engagedDelayDays} days`, `-${delayDays} days`, take).all();
  const leads = rows.results as any[];

  const results: SendOutcome[] = [];
  for (const lead of leads) results.push(await sendFollowup(env, lead, !!lead.has_click));   // engaged（有点击）→ 暖变体
  const sent = results.filter((r) => r.ok).length;
  return { processed: results.length, sent, results, dailyLimit, sentToday: already + sent, capReached: already + sent >= dailyLimit };
}

// 批量发送已批准线索：按分数从高到低，遵守每日上限
// ids 传入时只发这些选中的（仍受下面全部闸门约束：status='approved' + match_score>=60 + 每日上限 +
// 原子取批 + deliverEmail 幂等 + isEmailSuppressed 压制名单）——"发送选中"复用同一条路径，绝不另开绕过口。
// autoSent=true：这一批算"自动发送"（标记进 emails.auto_sent，供每日上限与熔断器窗口统计）。
// ⭐ 每日上限怎么不打架（总工点名要说明的那条）：
//   · `daily_send_limit`（生产=50）是**全局总闸**：下面的 sentToday() 数的是**今天所有 status='sent' 的信**
//     （手动 + 自动 + 跟进 + 落地确认信，一个不落），room = 50 - already。
//     所以只要自动发送**也走这个函数**（总工的硬要求），手动+自动+跟进加起来**在结构上就不可能突破 50**——
//     不需要为自动单独扣减，共享计数本身就是闸。
//   · `auto_send_daily_limit`（默认 15）是**自动这条路自己的额外上限**，由调用方（cron）先算好
//     autoRoom = 15 - 今天已自动发的，再把 requested 传进来。两个上限是**与**的关系，取更紧的那个生效。
//   · 结果：自动 ≤15/天，且 全部 ≤50/天。自动跑在 cron 里会先占额度，手动还剩 ≥35 —— 这是有意的：
//     自动的东西要跑得慢、出事损失小一格。
export async function sendApprovedBatch(env: Env, requested: number, ids?: number[], autoSent = false): Promise<{ processed: number; sent: number; results: SendOutcome[]; capReached?: boolean; dailyLimit: number; sentToday: number }> {
  const dailyLimit = Number(await getSetting(env, "daily_send_limit", "15")) || 15;
  const already = await sentToday(env);
  const room = Math.max(0, dailyLimit - already);
  const take = Math.min(requested, room);

  if (take <= 0) {
    return { processed: 0, sent: 0, results: [], capReached: true, dailyLimit, sentToday: already };
  }

  // S3 发送分数硬下限：只取 match_score >= 60 的（NULL/<60 即使被误批准也永不发，兜底防"一点群发就发垃圾"）
  // A2：传了 ids 就在同一条 WHERE 上再加 id IN (...) —— 门槛/上限/排序全部照旧，只是范围收窄到选中项
  const idList = Array.isArray(ids) ? ids.filter((n) => Number.isFinite(n)) : [];
  const base =
    `SELECT l.*, a.match_score FROM leads l JOIN lead_analysis a ON a.lead_id=l.id
     WHERE l.status='approved' AND a.match_score >= 60`;
  const tail = ` ORDER BY a.match_score DESC, l.id ASC LIMIT ?`;
  const rows = idList.length
    ? await env.DB.prepare(`${base} AND l.id IN (${idList.map(() => "?").join(",")})${tail}`).bind(...idList, take).all()
    : await env.DB.prepare(`${base}${tail}`).bind(take).all();
  const leads = rows.results as any[];

  const results: SendOutcome[] = [];
  for (const lead of leads) {
    // S2 原子取批：approved→queued，仅当当前仍是 approved（并发下只有一方 changes===1 能取到，杜绝同一 lead 被两次群发/自动+手动重叠取走）
    const claim = await env.DB.prepare(
      "UPDATE leads SET status='queued', updated_at=datetime('now') WHERE id=? AND status='approved'"
    ).bind(lead.id).run();
    if (claim.meta.changes !== 1) { results.push({ ok: false, id: lead.id, skipped: "并发已被取走" }); continue; }
    const out = await sendLead(env, { ...lead, status: "queued" }, autoSent);   // sendLead 成功时置 sent
    if (!out.ok) {
      // 未成功发送 → 退回 approved（保持与原语义一致：非成功线索留在待发送池，可重试）
      await env.DB.prepare("UPDATE leads SET status='approved' WHERE id=? AND status='queued'").bind(lead.id).run();
    }
    results.push(out);
  }
  const sent = results.filter((r) => r.ok).length;
  return { processed: results.length, sent, results, dailyLimit, sentToday: already + sent, capReached: already + sent >= dailyLimit };
}

// Landing 落地页：给主动索取价单的询盘发确认邮件（不含具体价，走 deliverEmail → 压制名单/合规页脚自动生效）
export async function sendInboundConfirmation(env: Env, lead: { id: number; email: string; company_name?: string }): Promise<SendOutcome> {
  if (!env.RESEND_API_KEY) return { ok: false, id: lead.id, error: "缺少 RESEND_API_KEY" };
  if (!lead.email) return { ok: false, id: lead.id, skipped: "无邮箱" };
  const subject = "Your TEJOY wholesale price list request";
  const body =
    "Hi there,\n\n" +
    "Thanks for requesting our wholesale price list for Starlink accessories. We've received your request — our team will email you the catalog and trade pricing shortly.\n\n" +
    "TEJOY is the supply source behind many top-selling Starlink accessory listings — dropship-ready, no minimum-order games, and fast fulfillment for resellers, dealers, and installers worldwide.\n\n" +
    "Talk soon,\nThe TEJOY Team";
  return await deliverEmail(env, lead, subject, body, "confirmation");
}

// 退订：按 token 找到邮件 → 标记 lead unsubscribed
export async function unsubscribeByToken(env: Env, token: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT lead_id FROM emails WHERE unsubscribe_token = ?").bind(token).first<{ lead_id: number }>();
  if (!row) return false;
  await env.DB.prepare("UPDATE leads SET status='unsubscribed', updated_at=datetime('now') WHERE id=?").bind(row.lead_id).run();
  // 记入持久压制名单（合规：退订永久生效，重导入也不再发）
  const lead = await env.DB.prepare("SELECT email FROM leads WHERE id=?").bind(row.lead_id).first<{ email: string }>();
  await addSuppressedEmail(env, lead?.email, "unsubscribe");
  return true;
}
