// 飞书/Lark 群机器人通知：热线索(有意向/询价/投诉回复)实时推送 + 每 6 小时简报。
// 用「自定义机器人」webhook（LARK_WEBHOOK_URL）。可选签名校验（LARK_WEBHOOK_SECRET）。
// 未配置 webhook 时所有发送静默跳过，可安全先部署后填地址。
import type { Env } from "./index";

export function larkConfigured(env: Env): boolean {
  return !!(env.LARK_WEBHOOK_URL && /^https?:\/\//.test(env.LARK_WEBHOOK_URL));
}

// Lark 自定义机器人签名：key = `${timestamp}\n${secret}`，对空串做 HmacSHA256，再 base64
async function larkSign(secret: string, timestamp: number): Promise<string> {
  const stringToSign = `${timestamp}\n${secret}`;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(stringToSign),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new Uint8Array(0));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

export async function larkSend(env: Env, message: any): Promise<{ ok: boolean; error?: string }> {
  if (!larkConfigured(env)) return { ok: false, error: "未配置 LARK_WEBHOOK_URL" };
  let body = message;
  if (env.LARK_WEBHOOK_SECRET) {
    const ts = Math.floor(Date.now() / 1000);
    body = { ...message, timestamp: String(ts), sign: await larkSign(env.LARK_WEBHOOK_SECRET, ts) };
  }
  try {
    const res = await fetch(env.LARK_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data: any = await res.json().catch(() => ({}));
    if (data.code === 0 || data.StatusCode === 0 || data.code === undefined && res.ok) return { ok: true };
    return { ok: false, error: data.msg || data.message || JSON.stringify(data).slice(0, 200) };
  } catch (e: any) {
    return { ok: false, error: e.message || String(e) };
  }
}

const REPLY_LABEL: Record<string, string> = {
  interested: "🔥 有意向", inquiry: "💬 询价", complaint: "⚠️ 投诉",
  not_interested: "无兴趣", other: "其他",
};

// 单条热回复卡片（标题含 TEJOY，兼容“自定义关键词”安全设置）
export function replyCard(r: { company?: string; from?: string; category?: string; summary?: string; snippet?: string; appUrl?: string }) {
  const elements: any[] = [
    { tag: "div", fields: [
      { is_short: true, text: { tag: "lark_md", content: `**公司**\n${r.company || "(未知)"}` } },
      { is_short: true, text: { tag: "lark_md", content: `**来自**\n${r.from || "-"}` } },
    ] },
  ];
  if (r.summary) elements.push({ tag: "div", text: { tag: "lark_md", content: `**AI 摘要**\n${r.summary}` } });
  if (r.snippet) elements.push({ tag: "div", text: { tag: "lark_md", content: `>${r.snippet.replace(/\n+/g, " ").slice(0, 160)}` } });
  if (r.appUrl) elements.push({ tag: "action", actions: [{ tag: "button", text: { tag: "plain_text", content: "打开后台处理" }, url: r.appUrl, type: "primary" }] });
  return {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true },
      header: {
        template: r.category === "complaint" ? "red" : "green",
        title: { tag: "plain_text", content: `TEJOY 新回复 · ${REPLY_LABEL[r.category || "other"] || r.category}` },
      },
      elements,
    },
  };
}

// 冲刺1a：点击热线索卡片（客户点了开发信里的链接，强意向，趁热跟进）
export function clickCard(d: { company?: string; to?: string; appUrl?: string }) {
  const elements: any[] = [
    { tag: "div", text: { tag: "lark_md", content: `**${d.company || d.to || "某线索"}** 刚点击了你的开发信里的链接 🔥\n这是强意向信号，趁热跟进转化率最高。` } },
  ];
  if (d.to) elements.push({ tag: "div", text: { tag: "lark_md", content: `收件邮箱：${d.to}` } });
  if (d.appUrl) elements.push({ tag: "action", actions: [{ tag: "button", text: { tag: "plain_text", content: "打开后台跟进" }, url: d.appUrl, type: "primary" }] });
  return {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true },
      header: { template: "orange", title: { tag: "plain_text", content: "TEJOY 🔥 有人点击了开发信" } },
      elements,
    },
  };
}

// Landing 落地页新询盘卡片。用户提交的字段一律 plain_text（防 lark_md 注入/破卡）。
export function inboundCard(d: { company?: string; email?: string; country?: string; whereSell?: string; volume?: string; appUrl?: string }) {
  const elements: any[] = [
    { tag: "div", fields: [
      { is_short: true, text: { tag: "plain_text", content: `公司: ${d.company || "-"}` } },
      { is_short: true, text: { tag: "plain_text", content: `邮箱: ${d.email || "-"}` } },
    ] },
    { tag: "div", text: { tag: "plain_text", content: `国家: ${d.country || "-"}\n在哪卖: ${d.whereSell || "-"}\n月走量: ${d.volume || "-"}` } },
  ];
  if (d.appUrl) elements.push({ tag: "action", actions: [{ tag: "button", text: { tag: "plain_text", content: "打开后台跟进" }, url: d.appUrl, type: "primary" }] });
  return {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true },
      header: { template: "orange", title: { tag: "plain_text", content: "TEJOY 落地页新询盘 📥" } },
      elements,
    },
  };
}

// 6 小时简报卡片
// ⭐ 两档制：原「高分客户」清单已删。理由 —— 自动通道时代，一家 85 分出现在简报里，
//    意思是**机器已经把信发给它了**，Joe 看了没有任何动作可做 = 噪音。
//    简报该报的是"机器干了什么"+"有没有需要你的事"。
export function digestCard(d: { inserted: number; analyzed: number; replies: number; autoApproved?: number; autoSent?: number; needYou?: number; appUrl?: string }) {
  const elements: any[] = [
    { tag: "div", text: { tag: "lark_md", content: `新找到 **${d.inserted}** 家 · 已分析 **${d.analyzed}** 家 · 新回复 **${d.replies}** 封` } },
    { tag: "hr" },
    { tag: "div", text: { tag: "lark_md", content:
      `**机器这轮干了什么**\n• 自动批准 **${d.autoApproved ?? 0}** 家\n• 自动发信 **${d.autoSent ?? 0}** 封` +
      (d.needYou ? `\n\n**需要你**：翻牌堆还有 **${d.needYou}** 家待复核` : "") } },
  ];
  if (d.appUrl) elements.push({ tag: "action", actions: [{ tag: "button", text: { tag: "plain_text", content: "打开后台" }, url: d.appUrl, type: "primary" }] });
  return {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true },
      header: { template: "blue", title: { tag: "plain_text", content: "TEJOY 获客 · 6 小时简报" } },
      elements,
    },
  };
}

// 测试卡片
export function testCard(appUrl?: string) {
  return {
    msg_type: "interactive",
    card: {
      header: { template: "turquoise", title: { tag: "plain_text", content: "TEJOY 飞书通知 · 测试成功 ✅" } },
      elements: [
        { tag: "div", text: { tag: "lark_md", content: "如果你在群里看到这张卡片，说明获客系统已能推送到本群。\n今后有**热回复**会实时推，每 6 小时来一条**简报**。" } },
        ...(appUrl ? [{ tag: "action", actions: [{ tag: "button", text: { tag: "plain_text", content: "打开后台" }, url: appUrl, type: "primary" }] }] : []),
      ],
    },
  };
}
