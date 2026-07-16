// 阶段三.4 退信/投诉 webhook：接 Resend 事件 → 匹配线索 → 硬退信标 bounced、投诉标 blacklisted，停止再发。
// 该端点必须公开（Resend 调用），用 Svix 签名校验来源。
import type { Env } from "./index";
import { larkConfigured, larkSend, clickCard } from "./notify";
import { addSuppressedEmail } from "./send";

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
function bytesToBase64(u: Uint8Array): string {
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s);
}

// 常量时间字符串比较（避免时序侧信道）。长度不同直接 false（HMAC 摘要长度固定，不泄露有效信息）。
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// 允许的时间戳漂移（防重放）：±5 分钟
const SVIX_TOLERANCE_SEC = 300;

// Svix 签名校验（Resend webhook 用 Svix）。M4：
// ① 未配置密钥 fail-closed（return false，绝不放行未签名请求）；
// ② 校验 svix-timestamp 在 ±5 分钟内（防重放）；③ 签名比对用常量时间。
export async function verifyResendSignature(env: Env, req: Request, rawBody: string): Promise<boolean> {
  const secret = env.RESEND_WEBHOOK_SECRET;
  if (!secret) return false; // fail-closed：没配密钥就不接受任何 webhook
  const id = req.headers.get("svix-id");
  const ts = req.headers.get("svix-timestamp");
  const sigHeader = req.headers.get("svix-signature");
  if (!id || !ts || !sigHeader) return false;

  // 防重放：时间戳必须是数字且在容忍窗口内
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;
  if (Math.abs(Date.now() / 1000 - tsNum) > SVIX_TOLERANCE_SEC) return false;

  try {
    const secretBytes = base64ToBytes(secret.replace(/^whsec_/, ""));
    const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signed = `${id}.${ts}.${rawBody}`;
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed));
    const expected = bytesToBase64(new Uint8Array(sig));
    // svix-signature 形如 "v1,<sig> v1,<sig2>"，任一匹配即通过（常量时间比对）
    return sigHeader.split(" ").some((p) => {
      const v = p.split(",")[1];
      return !!v && timingSafeEqual(v, expected);
    });
  } catch {
    return false;
  }
}

/** 点击分类：退订链接 / 真实链接 / 判不出来（见 email.clicked 分支的长注释） */
type ClickKind = "unsub" | "real" | "unknown";

/**
 * 判断这次 clicked 点的是不是退订链接。
 * **精确判定优先**：按 provider_id 取这封信自己的 unsubscribe_token，link 含该 token 才算退订 ——
 * 不靠 URL 正则猜（正则会把客户官网上任何含 /u/ 的路径误判成退订）。
 * 兜底：token 取不到（老数据/provider_id 对不上）时，才认 /u/<token> 的路径形态。
 */
async function classifyClick(env: Env, emailId: string | null, link: string): Promise<ClickKind> {
  if (!link) return "unknown";
  if (emailId) {
    const row = await env.DB.prepare("SELECT unsubscribe_token FROM emails WHERE provider_id=? LIMIT 1")
      .bind(emailId).first<{ unsubscribe_token: string | null }>();
    const tok = (row?.unsubscribe_token || "").trim();
    if (tok) return link.includes(tok) ? "unsub" : "real";   // 拿到 token → 判定是确定的，不再猜
  }
  return /\/u\/[A-Za-z0-9_\-]{6,}/.test(link) ? "unsub" : "real";
}

export async function handleResendEvent(env: Env, event: any): Promise<{ ok: boolean; action: string; lead?: number | null }> {
  const type = String(event?.type || "");
  const data = event?.data || {};
  const emailId = data.email_id || data.id || null;
  const to = Array.isArray(data.to) ? data.to[0] : (data.to || null);

  // 匹配线索：优先按 Resend email id（我们存的 provider_id），兜底按收件邮箱
  let leadId: number | null = null;
  if (emailId) {
    const row = await env.DB.prepare("SELECT lead_id FROM emails WHERE provider_id=? LIMIT 1").bind(emailId).first<{ lead_id: number }>();
    leadId = row?.lead_id ?? null;
  }
  if (!leadId && to) {
    const row = await env.DB.prepare("SELECT id FROM leads WHERE lower(email)=lower(?) LIMIT 1").bind(to).first<{ id: number }>();
    leadId = row?.id ?? null;
  }

  // 匹配到的收件邮箱（优先 lead.email，兜底 webhook 里的 to），用于写持久压制名单
  let leadEmail: string | null = null;
  if (leadId) {
    const le = await env.DB.prepare("SELECT email FROM leads WHERE id=?").bind(leadId).first<{ email: string }>();
    leadEmail = le?.email ?? null;
  }
  const suppressTarget = leadEmail || (typeof to === "string" ? to : null);

  if (type === "email.bounced") {
    if (emailId) await env.DB.prepare("UPDATE emails SET status='bounced' WHERE provider_id=?").bind(emailId).run();
    if (leadId) await env.DB.prepare("UPDATE leads SET status='bounced', updated_at=datetime('now') WHERE id=?").bind(leadId).run();
    await addSuppressedEmail(env, suppressTarget, "bounced");
    return { ok: true, action: "bounced", lead: leadId };
  }

  if (type === "email.complained") {
    if (leadId) await env.DB.prepare("UPDATE leads SET status='blacklisted', updated_at=datetime('now') WHERE id=?").bind(leadId).run();
    await addSuppressedEmail(env, suppressTarget, "complaint");
    // 投诉是高风险信号，推飞书提醒（标题含 TEJOY 兼容自定义关键词）
    try {
      if (larkConfigured(env)) {
        await larkSend(env, { msg_type: "text", content: { text: `TEJOY ⚠️ 收到垃圾邮件投诉(complaint)：${to || "?"}\n已自动加入黑名单、停止再发。请检查开发信内容/发送频率。` } });
      }
    } catch { /* 通知失败不影响处理 */ }
    return { ok: true, action: "complained", lead: leadId };
  }

  // 冲刺1a：开信追踪。opened 计数噪音大（客户端预取/图片代理）→ 只记录、不推飞书。
  if (type === "email.opened") {
    if (emailId) await env.DB.prepare(
      "UPDATE emails SET open_count = open_count + 1, opened_at = COALESCE(opened_at, datetime('now')) WHERE provider_id = ?"
    ).bind(emailId).run();
    if (leadId) await env.DB.prepare("UPDATE leads SET last_engaged_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").bind(leadId).run();
    return { ok: true, action: "opened", lead: leadId };
  }

  // 冲刺1a：点击追踪。clicked 是强意向信号 → 记录 + 推飞书"趁热跟进"（只 clicked 推，opened 不推）。
  // ⭐「点退订」也是 clicked：每封信底部都有 "unsubscribe here"（send.ts buildHtml/buildText），
  //    Resend 对它同样上报 email.clicked。以前这里不看用户点的是**哪个链接** → 人点退订，
  //    系统转头给 Joe 推"🔥 强意向信号，趁热跟进转化率最高"。
  //    生产实证：14 个"点击"里 12 个是退订，全部落在群发后 20 秒内。
  //    污染的**不止推送** —— clicked_at / last_engaged_at 会一路串下去：
  //      · clicked_at → has_click → 🔥徽章 +「已查看」格 + 看板"已查看→已回复 转化 0%"
  //      · last_engaged_at → sendFollowupBatch 的 engaged 分支用更快的节奏去追刚退订的人
  //    所以退订点击必须在**写库之前**拦掉，而不是只按住飞书。
  if (type === "email.clicked") {
    const kind = await classifyClick(env, emailId, String(data?.click?.link ?? data?.link ?? ""));
    if (kind === "unsub") {
      // 这不是意向，是"别再发了"。什么都不写、不推。
      //（真正的退订处理走 /u/<token> 页面那条独立路径，不依赖这里，所以拦掉不会漏掉退订本身。）
      return { ok: true, action: "clicked_unsubscribe_ignored", lead: leadId };
    }
    if (kind === "unknown") {
      // link 缺失 → 判不出来。只累加 click_count（**write-only 取证计数：全库无任何读取方**），
      // 不写 clicked_at / last_engaged_at、不推飞书。
      //
      // 总工倾向"记 clicked_at 但不推飞书"，我按他自己给的原则往前推了一格。理由：
      // 他的原则是"宁可漏报一个真点击，也不要再给 Joe 推一条假的"—— 而 clicked_at **本身就在给假的**：
      // 它驱动 🔥徽章 +「已查看」格 + 看板转化率。只按住飞书却让 clicked_at 照写，
      // 四个污染口只堵了一个，Joe 照样会在列表里看到假 🔥、在看板上看到假的 0% 转化。
      // 且生产实证 14 个点击里 12 个是退订 → 判不出来时写进去，更可能是造假而不是捡到信号。
      if (emailId) await env.DB.prepare(
        "UPDATE emails SET click_count = click_count + 1 WHERE provider_id = ?"
      ).bind(emailId).run();
      return { ok: true, action: "clicked_unknown_link", lead: leadId };
    }
    if (emailId) await env.DB.prepare(
      "UPDATE emails SET click_count = click_count + 1, clicked_at = COALESCE(clicked_at, datetime('now')) WHERE provider_id = ?"
    ).bind(emailId).run();
    if (leadId) await env.DB.prepare("UPDATE leads SET last_engaged_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").bind(leadId).run();
    try {
      if (larkConfigured(env)) {
        const company = leadEmail || (typeof to === "string" ? to : "") || "(未知)";
        const name = leadId
          ? ((await env.DB.prepare("SELECT company_name FROM leads WHERE id = ?").bind(leadId).first<{ company_name: string }>())?.company_name || company)
          : company;
        await larkSend(env, clickCard({ company: name, to: typeof to === "string" ? to : undefined, appUrl: env.ADMIN_URL || env.APP_URL }));
      }
    } catch { /* 通知失败不影响处理 */ }
    return { ok: true, action: "clicked", lead: leadId };
  }

  // delivered / delivery_delayed 等：暂不处理，直接确认
  return { ok: true, action: "ignored" };
}
