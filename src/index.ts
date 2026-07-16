import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { parseCsv, mapRowToLead } from "./csv";
import { analyzeLead, getProfile, DEFAULT_PROFILE } from "./service";
import { writeReplyDraft, writeWarmFollowup, DEFAULT_SELLING_POINTS, translateToChinese, isTrustedDirectorySource } from "./openrouter";
import { scrapeSite } from "./scrape";
import { sendLead, sendApprovedBatch, sendFollowupBatch, sendWarmFollowupNow, unsubscribeByToken, getSetting, setSetting, addSuppressedEmail, isEmailSuppressed, autoSentToday, getBreakerStatus, BREAKER_WINDOW, BREAKER_THRESHOLD } from "./send";
import { runDiscovery, getKeywords, seedDefaultKeywords, getSearchConfig, COUNTRIES, DEFAULT_COUNTRIES, recomputeKeywordStats, inferCountryFromWebsite, getSerperUsage, runNmeaDiscovery, runLinkHarvest, runDirectoryRefresh, RVWITHTITO_URL, RVWITHTITO_BLACKLIST } from "./discover";
import { findLeadEmail } from "./findemail";
import { ingestReplies } from "./replies";
import { categorizeCustomerType, classifyKillReason, KILL_REASONS } from "./taxonomy";
import { larkConfigured, larkSend, digestCard, testCard, inboundCard } from "./notify";
import { catalogHtml } from "./landing";
import { handleResendEvent, verifyResendSignature } from "./webhook";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  OPENROUTER_API_KEY: string;
  SCORE_MODEL: string;
  EMAIL_MODEL: string;
  SITE_URL: string;
  RESEND_API_KEY: string;
  SENDER_EMAIL: string;
  SENDER_NAME: string;
  APP_URL: string;
  ADMIN_HOST: string;   // 团队后台自定义域名（受 Cloudflare Access 保护）
  ADMIN_URL: string;    // 后台完整地址，用于飞书“打开后台”按钮
  SEARCH_PROVIDER: string;
  SEARCH_API_KEY: string;
  EMAIL_FINDER_API_KEY: string;
  ADMIN_USER: string;
  ADMIN_PASSWORD: string;
  LARK_IMAP_HOST: string;
  LARK_IMAP_PORT: string;
  LARK_IMAP_USER: string;
  LARK_IMAP_PASS: string;
  LARK_WEBHOOK_URL: string;      // 飞书群「自定义机器人」webhook（可选，配了才推送）
  LARK_WEBHOOK_SECRET: string;   // 飞书机器人签名密钥（可选，开了签名校验才需要）
  RESEND_WEBHOOK_SECRET: string; // Resend webhook 签名密钥（whsec_...，可选但强烈建议配）
  DEV_BYPASS_AUTH?: string;      // 仅本地 .dev.vars：跳过登录鉴权（生产无此变量）
}

const app = new Hono<{ Bindings: Env }>();

// ---- 登录保护 ----
// - /u/ 退订页：对收件人公开（任何域名都不拦，合规必须）
// - localhost：本地开发免登录
// - 团队域名 admin.tejoy.com：走 Cloudflare Access（每人邮箱验证码登录）。
//   Access 在边缘拦截未登录请求，只有登录后的请求才到 Worker，并带 Cf-Access-Authenticated-User-Email。
// - 其余（workers.dev）：保留 Basic Auth 作为应急/管理入口
app.use("*", async (c, next) => {
  if (c.req.path.startsWith("/u/")) return next();          // 退订页对收件人公开
  if (c.req.path.startsWith("/api/webhooks/")) return next(); // webhook 需公开（自带签名校验）
  if (c.req.path === "/catalog" || c.req.path === "/api/inbound") return next(); // Landing 落地页 + 询盘写端点：公开
  if (c.env.DEV_BYPASS_AUTH === "1") return next(); // 仅本地 .dev.vars，生产无此变量
  const host = (c.req.header("host") || "").split(":")[0].toLowerCase();
  if (host === "localhost" || host === "127.0.0.1") return next();

  if (host === (c.env.ADMIN_HOST || "admin.tejoy.com")) {
    const email = c.req.header("cf-access-authenticated-user-email");
    if (email) return next(); // 已通过 Access 登录
    // 该域名尚未在 Cloudflare Access 启用（否则请求到不了这里）
    return c.text("此后台需通过 Cloudflare Access 登录。若刚绑定域名，请先在 Zero Trust 后台为 admin.tejoy.com 配置 Access 应用。", 403);
  }

  // L1：未配置 ADMIN_PASSWORD 时 fail-closed（拒绝），绝不用占位弱口令放行
  if (!c.env.ADMIN_PASSWORD) {
    return c.text("后台密码未配置（ADMIN_PASSWORD）。请管理员设置 secret 后再访问。", 503);
  }
  return basicAuth({
    username: c.env.ADMIN_USER || "tejoy",
    password: c.env.ADMIN_PASSWORD,
  })(c, next);
});

// ---- 当前登录用户（Access 注入的邮箱；workers.dev/Basic Auth 下为 null）----
app.get("/api/me", (c) => {
  const email = c.req.header("cf-access-authenticated-user-email") || null;
  return c.json({ email, mode: email ? "access" : "basic" });
});

// ---- 后台可见的状态分组 ----
const STATUS_GROUPS: Record<string, string[]> = {
  all: [],
  pending: ["new", "analyzed", "pending"], // 兼容旧调用
  unscored: ["new"],                        // B2 待AI打分（无 match_score）
  review: ["analyzed", "pending"],          // B2 待你审批（已打分待人工批/忽略）
  approved: ["approved", "queued", "sent"], // 兼容旧调用（含已发）
  ready: ["approved", "queued"],            // 左栏「待发送」：已批准未发（排除已发）
  sent: ["sent"],                           // 左栏「已发送」：已发出
  replied: ["replied"],
  won: ["won"],
  ignored: ["ignored"],
  blacklisted: ["blacklisted", "unsubscribed", "bounced"],
};

const ALLOWED_STATUS = new Set([
  "new", "analyzed", "pending", "approved", "queued", "sent",
  "replied", "unsubscribed", "bounced", "ignored", "blacklisted", "won",
  // A3：no_reply 已移除——孤儿状态，全局无任何写入方（仅 2 处纯展示查表且都有兜底）
]);

// 批④ 找客户「积压刹车条」：进货前先看管道里堵了多少。
// 瓶颈往往不是线索不够，是 199 家没打分 / 296 家缺邮箱堵在中间 —— 这时再抓 1300 家只会堵得更死。
async function getBacklog(env: Env): Promise<{ unscored: number; noEmail: number; sendable: number }> {
  const db = env.DB;
  const q = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())?.n || 0;
  return {
    // 没打分：进来了还没过 AI（cron 会慢慢消化，但堆太多就是堵）
    unscored: await q("SELECT COUNT(*) AS n FROM leads WHERE status='new'"),
    // 缺邮箱：打了分但没邮箱 → 发不出去，卡在待审批
    noEmail: await q("SELECT COUNT(*) AS n FROM leads l JOIN lead_analysis a ON a.lead_id=l.id WHERE (l.email IS NULL OR l.email='') AND l.status IN ('analyzed','pending','approved','queued')"),
    // 能发没发：真能发出去却还躺着（与待办事项 sendable 同一口径）
    sendable: await q(
      `SELECT COUNT(*) AS n FROM leads l JOIN lead_analysis a ON a.lead_id=l.id
        WHERE l.status='approved' AND a.match_score >= ${APPROVE_MIN_SCORE}
          AND l.email IS NOT NULL AND l.email!=''
          AND lower(l.email) NOT IN (SELECT email FROM suppressed_emails)`),
  };
}

// A1 待发送准入门槛（单一真源，bulk-status 与单条 status 共用）：
// 置 approved 必须 有邮箱 且 已打分 且 ≥60（与发送端 sendApprovedBatch 的 ≥60 门槛一致）。
// 返回 null=可批准；否则返回拒绝原因。
// 注意：index.ts 是 Worker 入口模块，顶层 export 的非函数值会被运行时当成 handler 校验并报
// "Incorrect type for map entry"（dry-run 查不出、只有真启动才报）→ 这里必须是模块内常量，不能 export。
const APPROVE_MIN_SCORE = 60;
// ⭐ 两档制（Joe 拍板）：**60 是全系统唯一的决策线**。
//   ≥60 有邮箱 → 机器自动发；<60 → 进「翻牌堆」由 Joe 复核。60-69 的人工拍板区**已取消**。
//   道理：机器误发一封信成本低、可见、有熔断器兜底；机器误杀一个真客户损失一单、不可见、无兜底
//   （cayelectronics / 12volt / flarespace / seasucker 都是被埋过的实证）→ 人的火力对准「机器扔掉的堆」。
//   做成设置项不写死常量：门槛是运营参数，Joe 该能自己调（且 index.ts 顶层 export 非函数会让 Worker
//   起不来 —— 上次 `export const APPROVE_MIN_SCORE` 的教训，dry-run 还查不出来）。
const AUTO_APPROVE_MIN_DEFAULT = 60;
async function getAutoApproveMin(env: Env): Promise<number> {
  const v = Number(await getSetting(env, "auto_approve_min", String(AUTO_APPROVE_MIN_DEFAULT)));
  // 不许低于 APPROVE_MIN_SCORE：低了也没用，approveGateReason 那条护栏照样拦，只会造成"设了却不生效"的假象
  return Number.isFinite(v) ? Math.max(APPROVE_MIN_SCORE, Math.min(100, v)) : AUTO_APPROVE_MIN_DEFAULT;
}
/**
 * 「待发送」准入的**单一真源**。bulk-status / :id/status / 自动批准 全部走它。
 *
 * humanApproved：Joe 在翻牌堆里对**单条** <60 线索亲手按过「手动发这家」。
 *   · 只豁免**分数线**这一条 —— 邮箱仍然必须有（没邮箱根本发不了，豁免它没有意义）
 *   · 幂等/压制名单/每日上限/原子取批 全都不在这个函数里，一个也豁免不到
 *   · "未打分"也不豁免：未打分 ≠ 低分，它多半是官网抓不到（见 service.ts FETCH_FAIL_MAX），
 *     那种情况该去补网址重新分析，不是硬发一封基于空白信息写出来的信
 */
function approveGateReason(email: string | null, score: number | null, humanApproved = false): string | null {
  if (!email || !String(email).trim()) return "缺邮箱，不能批准（先补邮箱）";
  if (score == null) return "未打分，不能批准（先 AI 分析）";
  if (score < APPROVE_MIN_SCORE && !humanApproved) return `${score} 分 < ${APPROVE_MIN_SCORE} 分门槛，不能批准`;
  return null;
}

// ---- 统计：按状态计数 ----
app.get("/api/stats", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT status, COUNT(*) AS n FROM leads GROUP BY status"
  ).all();
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const r of rows.results as any[]) {
    byStatus[r.status] = r.n;
    total += r.n;
  }
  // #39 已查看：status=sent 且有点击（与「已发送」互斥，供左栏漏斗把 sent 拆成 已发送/已查看）
  const vr = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM leads l WHERE l.status='sent' AND EXISTS (SELECT 1 FROM emails e WHERE e.lead_id=l.id AND e.clicked_at IS NOT NULL)"
  ).first<{ n: number }>();
  return c.json({ total, byStatus, viewed: vr?.n || 0 });
});

// #47 行动建议引擎（数据看板 + 今日待办共用同一份逻辑）：按规则算出当前最该做的事，按紧急度取前 4 条。
// cta.action 由前端 dashAction() 映射到对应页面/分组/操作。
async function buildActionSuggestions(env: Env): Promise<{
  actions: { text: string; cta: { label: string; action: string } | null }[];
  highNoEmail: number; readyCount: number; reviewCount: number;
}> {
  const db = env.DB;
  const statusRows = await db.prepare("SELECT status, COUNT(*) AS n FROM leads GROUP BY status").all();
  const f: Record<string, number> = {}; let total = 0;
  for (const r of statusRows.results as any[]) { f[r.status] = r.n; total += r.n; }
  const F = (s: string) => f[s] || 0;
  const sentLeads = (await db.prepare("SELECT COUNT(DISTINCT lead_id) AS n FROM emails WHERE status='sent'").first<{ n: number }>())?.n || 0;
  const viewed = (await db.prepare("SELECT COUNT(*) AS n FROM leads l WHERE l.status='sent' AND EXISTS (SELECT 1 FROM emails e WHERE e.lead_id=l.id AND e.clicked_at IS NOT NULL)").first<{ n: number }>())?.n || 0;
  // ⭐ 两档制：≥60 无邮箱 = 触达工作台的队列（机器发不了、只能 Joe 用社媒/电话手动碰）——这是真人工活，留着。
  //    门槛从 80 对齐到 60：80 那条线不对应任何决策，纯装饰。
  const highNoEmail = (await db.prepare(`SELECT COUNT(*) AS n FROM leads l JOIN lead_analysis a ON a.lead_id=l.id WHERE a.match_score>=${APPROVE_MIN_SCORE} AND (l.email IS NULL OR l.email='') AND l.status NOT IN ('blacklisted','unsubscribed','bounced')`).first<{ n: number }>())?.n || 0;
  const replied = F("replied"), bounced = F("bounced"), unsub = F("unsubscribed");
  const readyCount = F("approved") + F("queued");
  const reviewCount = F("analyzed") + F("pending");
  const rate = (x: number) => (sentLeads > 0 ? x / sentLeads : 0);
  // 累计漏斗（同 #43 口径）求最狠掉点
  const wonC = F("won"), replyC = F("replied") + wonC;
  const viewC = Math.min(F("sent"), viewed) + F("replied") + wonC;
  const sentC = sentLeads, approveC = F("approved") + F("queued") + sentC;
  const poolC = Math.max(total - (F("blacklisted") + F("unsubscribed") + F("bounced")), approveC);
  const lv = [{ l: "已入池", n: poolC }, { l: "已批准", n: approveC }, { l: "已发送", n: sentC }, { l: "已查看", n: viewC }, { l: "已回复", n: replyC }, { l: "成交", n: wonC }];
  let worstJump: { from: string; to: string; conv: number } | null = null;
  for (let i = 1; i < lv.length; i++) {
    if (lv[i - 1].n <= 0) continue;
    const conv = Math.min(100, Math.round((lv[i].n / lv[i - 1].n) * 100));
    if (!worstJump || conv < worstJump.conv) worstJump = { from: lv[i - 1].l, to: lv[i].l, conv };
  }
  const bounceRate = rate(bounced), unsubRate = rate(unsub);
  const acts: { text: string; cta: { label: string; action: string } | null; pri: number }[] = [];
  if (replied > 0) acts.push({ pri: 100, text: `${replied} 条回复待跟进`, cta: { label: "去回复箱", action: "replies" } });
  // ⭐ 两档制删掉的三张卡（它们都在喊 Joe 去干机器的活，违反"能批量化的 AI 做"）：
  //  · 「N 家待发送，今天群发」/「≥80 没发开发信」→ ≥60 有邮箱现在**自动发**。没发出去只会是
  //    每日上限（设计如此）或熔断（有自己的横幅+告警卡）——都不需要 Joe 去点群发。
  //  · 「≥70 家高分可批准」→ 自动批准干了。
  // 留下的 highNoEmail：≥60 无邮箱＝机器碰不到，只能 Joe 手动触达 → 真人工活（C/D 的工作台队列）。
  if (reviewCount > 0) acts.push({ pri: 76, text: `${reviewCount} 家已打分待审批`, cta: { label: "去审核", action: "group:review" } });
  if (highNoEmail > 0) acts.push({ pri: 70, text: `${highNoEmail} 家 ≥${APPROVE_MIN_SCORE} 分没邮箱，机器发不了`, cta: { label: "去补邮箱", action: "findmail" } });
  if (bounceRate > 0.03) acts.push({ pri: 60, text: `退信率 ${(bounceRate * 100).toFixed(1)}% 偏高，邮箱质量差，建议收紧补邮箱来源`, cta: { label: "看退信/黑名单", action: "group:blacklisted" } });
  if (unsubRate > 0.05) acts.push({ pri: 50, text: `退订率 ${(unsubRate * 100).toFixed(1)}% 偏高，检查发信频率/相关性`, cta: null });
  if (worstJump && worstJump.conv < 50) acts.push({ pri: 40, text: `『${worstJump.from}→${worstJump.to}』转化仅 ${worstJump.conv}%，建议优化开发信/跟进`, cta: null });
  if (sentLeads >= 10 && replied === 0) acts.push({ pri: 30, text: `已发 ${sentLeads} 封暂无回复，主题待优化或量还小`, cta: null });
  acts.sort((a, b) => b.pri - a.pri);
  const actions = acts.slice(0, 4).map(({ pri, ...rest }) => rest);
  return { actions, highNoEmail, readyCount, reviewCount };
}

// ---- 数据看板：获客漏斗 + 关键指标聚合（走鉴权，非公开）----
// 全部为静态 SQL（无用户输入），天然无注入风险；日期用 SQLite date() 以 UTC 对齐前端。
app.get("/api/dashboard", async (c) => {
  const db = c.env.DB;

  // 1) 漏斗各状态计数
  const statusRows = await db.prepare("SELECT status, COUNT(*) AS n FROM leads GROUP BY status").all();
  const funnel: Record<string, number> = {};
  let total = 0;
  for (const r of statusRows.results as any[]) { funnel[r.status] = r.n; total += r.n; }
  const F = (s: string) => funnel[s] || 0;

  // 2) 发送总量 + 关键率（分母 = 去重后已发送到的线索数，因回复后 lead 状态不再是 sent）
  const emailsSentRow = await db.prepare("SELECT COUNT(*) AS n FROM emails WHERE status='sent'").first<{ n: number }>();
  const sentLeadsRow = await db.prepare("SELECT COUNT(DISTINCT lead_id) AS n FROM emails WHERE status='sent'").first<{ n: number }>();
  const emailsSent = emailsSentRow?.n || 0;
  const sentLeads = sentLeadsRow?.n || 0;
  const replied = F("replied"), bounced = F("bounced"), unsubscribed = F("unsubscribed");
  const rate = (x: number) => (sentLeads > 0 ? x / sentLeads : 0);

  // 3) 国家 / 规范分类 分布
  const byCountry = (await db.prepare(
    // 批④：GROUP BY UPPER(country) —— 存量遗留的小写码(us)与新写的大写(US)合并，别再出"两个美国"（写入口已在各处堵住）
    "SELECT UPPER(country) AS v, COUNT(*) AS n FROM leads WHERE country IS NOT NULL AND country!='' GROUP BY UPPER(country) ORDER BY n DESC"
  ).all()).results;
  const byCategory = (await db.prepare(
    "SELECT customer_category AS v, COUNT(*) AS n FROM lead_analysis WHERE customer_category IS NOT NULL AND customer_category!='' GROUP BY customer_category ORDER BY n DESC"
  ).all()).results;

  // 批④：按「收件箱类型」切片（通用箱 info@/support@ · 销售箱 sales@/team@ · 个人箱）
  // 只给 发送(唯一线索)/退订/互动 三个**计数**；比率交前端在 n>=50 时才算（与主比率同一把样本量锁）。
  const byInbox = (await db.prepare(
    `SELECT CASE
        WHEN lower(substr(l.email,1,instr(l.email,'@')-1)) IN
          ('info','support','contact','hello','admin','office','enquiries','enquiry','inquiry','inquiries','mail','general','reception','service')
          THEN 'generic'
        WHEN lower(substr(l.email,1,instr(l.email,'@')-1)) IN
          ('sales','team','biz','business','partners','partner','wholesale','orders','order','marketing','purchasing','procurement')
          THEN 'sales'
        ELSE 'personal' END AS box,
       COUNT(DISTINCT l.id) AS sent,
       SUM(CASE WHEN l.status='unsubscribed' THEN 1 ELSE 0 END) AS unsub,
       SUM(CASE WHEN l.status IN ('replied','won')
                  OR EXISTS (SELECT 1 FROM emails e2 WHERE e2.lead_id=l.id AND e2.clicked_at IS NOT NULL)
                THEN 1 ELSE 0 END) AS engaged
       FROM leads l
      WHERE l.email IS NOT NULL AND l.email!='' AND instr(l.email,'@')>1
        AND EXISTS (SELECT 1 FROM emails e WHERE e.lead_id=l.id AND e.status='sent')
      GROUP BY box ORDER BY sent DESC`
  ).all()).results;

  // 4) 近 14 天每日发送 / 回复
  const sentDaily = (await db.prepare(
    "SELECT date(sent_at) AS d, COUNT(*) AS n FROM emails WHERE status='sent' AND sent_at IS NOT NULL AND date(sent_at) >= date('now','-13 days') GROUP BY date(sent_at)"
  ).all()).results as any[];
  const repliedDaily = (await db.prepare(
    "SELECT date(received_at) AS d, COUNT(*) AS n FROM replies WHERE received_at IS NOT NULL AND date(received_at) >= date('now','-13 days') GROUP BY date(received_at)"
  ).all()).results as any[];
  const newDaily = (await db.prepare(
    "SELECT date(created_at) AS d, COUNT(*) AS n FROM leads WHERE created_at IS NOT NULL AND date(created_at) >= date('now','-13 days') GROUP BY date(created_at)"
  ).all()).results as any[];
  const sentMap: Record<string, number> = {}; for (const r of sentDaily) sentMap[r.d] = r.n;
  const repMap: Record<string, number> = {}; for (const r of repliedDaily) repMap[r.d] = r.n;
  const newMap: Record<string, number> = {}; for (const r of newDaily) newMap[r.d] = r.n;
  const daily: { date: string; neu: number; sent: number; replied: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    daily.push({ date: d, neu: newMap[d] || 0, sent: sentMap[d] || 0, replied: repMap[d] || 0 });
  }

  // 5) 评分分桶 + 缺邮箱 + 已分析数
  // ⭐ 两档制：原 5 档直方图（b0/b40/b60/b70/b80）删除 —— 前端只读了 b80 一个（其余 4 个是死查询），
  //    而「高分线索(≥80)」这个 KPI 在自动通道下没有意义：它只会随着找到的线索变多而变大，
  //    既不是健康度也不对应任何动作（机器已经把信发出去了）。
  //    换成**翻牌堆待复核**：机器扔掉、Joe 还没看过的家数 —— 这是唯一映射到"还剩多少你的活"的数。
  const buckets = await db.prepare(
    `SELECT
       SUM(CASE WHEN a.match_score >= ${APPROVE_MIN_SCORE} THEN 1 ELSE 0 END) AS bAuto,
       SUM(CASE WHEN a.match_score IS NOT NULL AND a.match_score < ${APPROVE_MIN_SCORE}
                 AND l.status IN ('analyzed','pending') THEN 1 ELSE 0 END) AS bFlipPending
     FROM lead_analysis a JOIN leads l ON l.id = a.lead_id`
  ).first<any>();
  const noEmailRow = await db.prepare("SELECT COUNT(*) AS n FROM leads WHERE email IS NULL OR email=''").first<{ n: number }>();
  const analyzedRow = await db.prepare("SELECT COUNT(*) AS n FROM lead_analysis WHERE match_score IS NOT NULL").first<{ n: number }>();
  const viewedRow = await db.prepare("SELECT COUNT(*) AS n FROM leads l WHERE l.status='sent' AND EXISTS (SELECT 1 FROM emails e WHERE e.lead_id=l.id AND e.clicked_at IS NOT NULL)").first<{ n: number }>();
  const weekRow = await db.prepare("SELECT COUNT(*) AS n FROM leads WHERE created_at >= date('now','-6 days')").first<{ n: number }>();

  // #43 转化漏斗（累计口径：每级=到达该阶段「及以后」的线索数，单调递减，转化%≤100）
  //  - 状态是互斥快照，故按「已达到的最远阶段」累计：won⊂replied阶段之后、replied、已查看(sent+点击)、已发送(唯一线索)、已批准、待分析
  //  - 基数=已入池=总线索排除黑名单/退订/退信（出局线索）
  const outLeads = F("blacklisted") + F("unsubscribed") + F("bounced");
  const wonC = F("won");
  const replyC = F("replied") + wonC;
  const viewC = Math.min(F("sent"), viewedRow?.n || 0) + F("replied") + wonC;
  const sentC = sentLeads;                                    // 唯一已发送线索（去重，含已回复/成交）
  const approveC = F("approved") + F("queued") + sentC;       // 已批准及以后 = 当前待发送 + 已发送及以后
  const poolC = Math.max(total - outLeads, approveC);         // 已入池（顶端基数）；clamp 兜底单调
  const rawLevels = [
    { key: "pool", label: "已入池", n: poolC },
    { key: "approve", label: "已批准", n: approveC },
    { key: "sent", label: "已发送", n: sentC },
    { key: "view", label: "已查看", n: viewC },
    { key: "reply", label: "已回复", n: replyC },
    { key: "won", label: "成交", n: wonC },
  ];
  const funnelLevels = rawLevels.map((lv, i) => {
    const prev = i > 0 ? rawLevels[i - 1].n : 0;
    const conv = i > 0 && prev > 0 ? Math.min(100, Math.round((lv.n / prev) * 100)) : null;
    return { ...lv, conv };
  });

  const sug = await buildActionSuggestions(c.env);   // #47 行动建议（与今日待办共用引擎）

  return c.json({
    total,
    funnel,
    funnelLevels,   // #43 累计口径漏斗（前端直接渲染）
    actions: sug.actions,                                              // #47 行动建议（已按紧急度排序，最多 4 条）
    highNoEmail: sug.highNoEmail,                                      // #47 指标（备用）
    readyCount: sug.readyCount, reviewCount: sug.reviewCount,
    emailsSent,
    sentLeads,
    counts: { replied, bounced, unsubscribed },
    rates: { reply: rate(replied), bounce: rate(bounced), unsub: rate(unsubscribed) },
    byCountry,
    byCategory,
    byInbox,        // 批④：按收件箱类型切片（受 n<50 样本量锁）
    daily,
    scoreBuckets: {
      bAuto: buckets?.bAuto || 0,                 // ≥60：机器的自动通道
      bFlipPending: buckets?.bFlipPending || 0,   // <60 且还没被人工处理 = 翻牌堆待复核
      min: APPROVE_MIN_SCORE,
    },
    noEmailCount: noEmailRow?.n || 0,
    analyzedCount: analyzedRow?.n || 0,
    viewed: viewedRow?.n || 0,     // #40 数据看板：已查看（sent+点击）
    thisWeek: weekRow?.n || 0,     // 本周新增
  });
});

// ---- 线索列表（多维筛选：状态组 / 国家 / 客户类型 / 有无邮箱 / 最低分 / 关键词）----
app.get("/api/leads", async (c) => {
  const group = c.req.query("group") || "all";
  const q = (c.req.query("q") || "").trim();
  const country = (c.req.query("country") || "").trim().toUpperCase();
  const category = (c.req.query("category") || "").trim();
  const hasEmail = (c.req.query("hasEmail") || "").trim();   // "yes" | "no" | ""
  const minScore = Number(c.req.query("minScore") || "");    // 兼容旧参数（≥minScore）
  const scoreMinQ = c.req.query("scoreMin");                 // 区间下界（含），缺省=不过滤
  const scoreMaxQ = c.req.query("scoreMax");                 // 区间上界（不含），缺省=不过滤
  const scoreMin = scoreMinQ != null && scoreMinQ !== "" ? Number(scoreMinQ) : NaN;
  const scoreMax = scoreMaxQ != null && scoreMaxQ !== "" ? Number(scoreMaxQ) : NaN;
  const due = c.req.query("due") === "1";                    // 快赢③：只看"该跟进了"(下一步日期已到/过期)
  const stage = (c.req.query("stage") || "").trim();         // B：按销售漏斗阶段筛（派生，见下映射）
  const hasChannel = (c.req.query("hasChannel") || "").trim().toLowerCase(); // B：按渠道存在筛
  const statuses = STATUS_GROUPS[group] ?? [];

  let sql =
    "SELECT l.id, l.company_name, l.website, l.email, l.country, l.source, l.keyword, l.status, l.created_at, l.channels, " +
    "l.next_action, l.next_action_date, l.last_engaged_at, " +
    "a.match_score AS match_score, a.customer_type AS customer_type, a.customer_category AS customer_category, " +
    // 跟进中派生标志：已发(sent)线索中，存在已发出的 followup 邮件
    "EXISTS (SELECT 1 FROM emails e WHERE e.lead_id = l.id AND e.kind='followup' AND e.status='sent') AS has_followup, " +
    // 参与度（冲刺1a）：是否有邮件被打开/点击
    "EXISTS (SELECT 1 FROM emails e WHERE e.lead_id = l.id AND e.opened_at IS NOT NULL) AS has_open, " +
    "EXISTS (SELECT 1 FROM emails e WHERE e.lead_id = l.id AND e.clicked_at IS NOT NULL) AS has_click, " +
    // 阶段派生：最新一条回复的类别，用于判「洽谈中/已婉拒」
    "(SELECT r.category FROM replies r WHERE r.lead_id = l.id ORDER BY r.id DESC LIMIT 1) AS latest_reply_cat, " +
    // 批③追加2：回复箱并入「已回复」页——每行一个线索 + 最新回复摘要/id（页面数据源仍是 /api/leads，不用 /api/replies）
    "(SELECT r.summary FROM replies r WHERE r.lead_id = l.id ORDER BY r.id DESC LIMIT 1) AS latest_reply_summary, " +
    "(SELECT r.id FROM replies r WHERE r.lead_id = l.id ORDER BY r.id DESC LIMIT 1) AS latest_reply_id " +
    "FROM leads l LEFT JOIN lead_analysis a ON a.lead_id = l.id";
  const where: string[] = [];
  const binds: any[] = [];

  const CLICKED = "EXISTS (SELECT 1 FROM emails e WHERE e.lead_id = l.id AND e.clicked_at IS NOT NULL)";
  if (group === "viewed") {          // #39 已查看 = 已发送(sent) 且有点击
    where.push(`l.status='sent' AND ${CLICKED}`);
  } else if (group === "sent") {     // 已发送 = 已发送(sent) 且无点击（与已查看互斥）
    where.push(`l.status='sent' AND NOT ${CLICKED}`);
  } else if (statuses.length) {
    where.push(`l.status IN (${statuses.map(() => "?").join(",")})`);
    binds.push(...statuses);
  }
  if (q) {
    where.push("(l.company_name LIKE ? OR l.website LIKE ? OR l.email LIKE ? OR l.country LIKE ?)");
    const like = `%${q}%`;
    binds.push(like, like, like, like);
  }
  if (country) { where.push("UPPER(l.country) = ?"); binds.push(country); }
  if (category) { where.push("a.customer_category = ?"); binds.push(category); }
  if (hasEmail === "yes") where.push("(l.email IS NOT NULL AND l.email != '')");
  if (hasEmail === "no") where.push("(l.email IS NULL OR l.email = '')");
  if (Number.isFinite(minScore) && minScore > 0) { where.push("a.match_score >= ?"); binds.push(minScore); }
  // 评分区间筛选（分桶）：scoreMin 含、scoreMax 不含；NULL 分数自然被排除
  if (Number.isFinite(scoreMin)) { where.push("a.match_score >= ?"); binds.push(scoreMin); }
  if (Number.isFinite(scoreMax)) { where.push("a.match_score < ?"); binds.push(scoreMax); }
  // 「未打分」是特殊态，不是区间：分数区间表达不了 IS NULL。
  // 这批人现在有真实来源了——抓站失败归档的「官网抓不到·无法判断」就是 match_score NULL，
  // 它们既不在自动通道也不在翻牌堆，必须能单独捞出来看。
  if ((c.req.query("scored") || "") === "no") where.push("a.match_score IS NULL");
  if (due) where.push("(l.next_action_date IS NOT NULL AND l.next_action_date != '' AND date(l.next_action_date) <= date('now') AND l.status NOT IN ('unsubscribed','blacklisted','bounced','won','ignored'))");
  // B：阶段筛选（与前端 stageOf 派生一致；映射到 SQL）
  const ENGAGED = "EXISTS (SELECT 1 FROM emails e WHERE e.lead_id=l.id AND (e.opened_at IS NOT NULL OR e.clicked_at IS NOT NULL))";
  const LAST_CAT = "(SELECT r.category FROM replies r WHERE r.lead_id=l.id ORDER BY r.id DESC LIMIT 1)";
  const STAGE_SQL: Record<string, string> = {
    // ⭐ 待分析(new) 与 待审核(analyzed/pending) 必须分开：这是阶段列筛选下拉的数据源，
    //   以前一个 'new' 键把三个状态揉在一起 → 用户按「待审核」筛会筛出一堆还没打分的，
    //   跟前端 stageOf 的徽章对不上。key 必须与前端 STAGE_OPTS 一致。
    unscored: "l.status='new'",
    review: "l.status IN ('analyzed','pending')",
    approved: "l.status IN ('approved','queued')",
    sent: `l.status='sent' AND NOT ${ENGAGED}`,
    engaged: `l.status='sent' AND ${ENGAGED}`,
    talking: `l.status='replied' AND COALESCE(${LAST_CAT},'') != 'not_interested'`,
    declined: `l.status='replied' AND ${LAST_CAT} = 'not_interested'`,
    won: "l.status='won'",
    dead: "l.status IN ('blacklisted','unsubscribed','bounced')",
  };
  if (stage && STAGE_SQL[stage]) where.push(`(${STAGE_SQL[stage]})`);
  // B：渠道存在筛选（channels JSON 含该键；键来自白名单，用 json_extract 精确判断）
  const CH_KEYS = new Set(["linkedin", "whatsapp", "facebook", "instagram", "phone", "telegram", "youtube"]);
  if (CH_KEYS.has(hasChannel)) where.push(`json_extract(l.channels, '$.${hasChannel}') IS NOT NULL`);

  if (where.length) sql += " WHERE " + where.join(" AND ");
  // 排序：待跟进→下一步日期升序；最近参与→last_engaged_at 降序(NULL 垫底)；否则 id 倒序
  const sort = c.req.query("sort") || "";
  if (due) sql += " ORDER BY l.next_action_date ASC LIMIT 300";
  else if (sort === "engaged") sql += " ORDER BY (l.last_engaged_at IS NULL), l.last_engaged_at DESC, l.id DESC LIMIT 300";
  else if (sort === "score_asc") sql += " ORDER BY (a.match_score IS NULL), a.match_score ASC, l.id DESC LIMIT 300";
  // A1 默认按价值：有分的按分降序、无分垫底
  else sql += " ORDER BY (a.match_score IS NULL), a.match_score DESC, l.id DESC LIMIT 300";

  const rows = await c.env.DB.prepare(sql).bind(...binds).all();
  return c.json({ leads: rows.results });
});

// ---- 筛选维度可选值（国家 / 规范客户分类），供前端下拉动态生成 ----
// ---- 翻牌堆：<60 被机器扔掉的，按"被杀原因"分组给 Joe 复核 ----
// 为什么值得做这个视图：机器**误杀**一个真客户 = 损失一单、不可见、无兜底。
// Joe 扫组名就能整组略过（"这 30 家全是攻略站" → 跳过），只在可疑的组里下钻。
app.get("/api/leads/flip-pile", async (c) => {
  const rows = (await c.env.DB.prepare(
    `SELECT l.id, l.company_name, l.website, l.email, l.country, l.channels, l.human_approved,
            a.match_score, a.customer_type, a.reason
       FROM leads l JOIN lead_analysis a ON a.lead_id = l.id
      WHERE l.status IN ('analyzed','pending')
        AND a.match_score IS NOT NULL AND a.match_score < ${APPROVE_MIN_SCORE}
      ORDER BY a.match_score DESC, l.id ASC LIMIT 500`
  ).all()).results as any[];

  const groups: Record<string, any[]> = {};
  for (const r of rows) {
    // 分类看 buyer_type 前缀 + reason 正文（老数据没有前缀，见 taxonomy.classifyKillReason 的注释）
    const key = classifyKillReason(`${r.customer_type || ""} ${r.reason || ""}`);
    (groups[key] ||= []).push({
      id: r.id, company_name: r.company_name, website: r.website, email: r.email,
      country: r.country, channels: r.channels, human_approved: r.human_approved,
      match_score: r.match_score, customer_type: r.customer_type,
      // 证据摘要：Joe 要"一行看懂为什么被杀"，长的截断（详情页能看全文）
      evidence: String(r.reason || "").replace(/^【[^】]*】\s*/, "").slice(0, 120),
    });
  }
  // 组内已按分数降序（SQL 的 ORDER BY 带过来），组间按 KILL_REASONS 的固定顺序 —— 位置稳定，Joe 能形成肌肉记忆
  const out = KILL_REASONS.filter((g) => groups[g.key]?.length).map((g) => ({
    key: g.key, label: g.label, hint: g.hint, count: groups[g.key].length, leads: groups[g.key],
  }));
  return c.json({ total: rows.length, groups: out });
});

app.get("/api/leads/facets", async (c) => {
  const countries = await c.env.DB.prepare(
    "SELECT UPPER(country) AS v, COUNT(*) AS n FROM leads WHERE country IS NOT NULL AND country != '' GROUP BY UPPER(country) ORDER BY n DESC"
  ).all();
  const categories = await c.env.DB.prepare(
    "SELECT a.customer_category AS v, COUNT(*) AS n FROM lead_analysis a WHERE a.customer_category IS NOT NULL AND a.customer_category != '' GROUP BY a.customer_category ORDER BY n DESC"
  ).all();
  const noEmail = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM leads WHERE (email IS NULL OR email = '')"
  ).first<{ n: number }>();
  const withEmail = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM leads WHERE (email IS NOT NULL AND email != '')"
  ).first<{ n: number }>();
  const totalRow = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM leads").first<{ n: number }>();
  // 评分分桶计数（边界统一：0-40含0不含40 / 40-70含40不含70 / 70-100含70含100，不重叠不漏）
  // ⭐ 两档制：0-40 / 40-70 / 70-100 老三档已删 —— 40 和 70 这两条线不对应任何决策。
  //    现在只有 60 一条线：≥60 走自动通道、<60 进翻牌堆、未打分是特殊态（多为官网抓不到）。
  const sb = await c.env.DB.prepare(
    `SELECT
       SUM(CASE WHEN match_score >= ${APPROVE_MIN_SCORE} THEN 1 ELSE 0 END) AS bAuto,
       SUM(CASE WHEN match_score IS NOT NULL AND match_score < ${APPROVE_MIN_SCORE} THEN 1 ELSE 0 END) AS bFlip,
       SUM(CASE WHEN match_score IS NULL THEN 1 ELSE 0 END) AS bNone
     FROM lead_analysis`
  ).first<any>();
  return c.json({
    countries: countries.results,
    allCountries: COUNTRIES,            // 全部目标国家，供筛选下拉始终列全
    categories: categories.results,
    noEmailCount: noEmail?.n || 0,
    withEmailCount: withEmail?.n || 0,
    total: totalRow?.n || 0,
    scoreBuckets: { bAuto: sb?.bAuto || 0, bFlip: sb?.bFlip || 0, bNone: sb?.bNone || 0, min: APPROVE_MIN_SCORE },
  });
});

// ---- A3 高分待发：数量 + 批量批准 Top N（≥门槛·已打分·有邮箱·未压制；不自动发信）----
// 未压制 = status∈(analyzed,pending)(已排除各终态) 且 邮箱不在持久压制名单。
// ⭐ 两档制：门槛对齐到 APPROVE_MIN_SCORE(60)，不再私设 70 —— 全系统只有 60 这一条决策线。
//    自动批准开着时这批本来就会被自动收走；这个按钮是自动批准关掉时的手动入口，口径必须一致。
const HIGH_SCORE_READY_WHERE =
  `a.match_score >= ${APPROVE_MIN_SCORE} AND l.status IN ('analyzed','pending') AND l.email IS NOT NULL AND l.email != '' ` +
  "AND lower(l.email) NOT IN (SELECT email FROM suppressed_emails)";
app.get("/api/high-score-ready", async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM leads l JOIN lead_analysis a ON a.lead_id = l.id WHERE ${HIGH_SCORE_READY_WHERE}`
  ).first<{ n: number }>();
  return c.json({ count: row?.n || 0 });
});
// ---- B1 批量改状态（复用 M3b 护栏；逐条 try/catch；越权跳过不整批失败）----
app.post("/api/leads/bulk-status", async (c) => {
  const b = await c.req.json<{ ids?: number[]; status?: string }>().catch(() => ({}));
  const status = b.status;
  if (!status || !ALLOWED_STATUS.has(status)) return c.json({ error: "invalid status" }, 400);
  const ids = Array.isArray(b.ids) ? [...new Set(b.ids.map(Number).filter(Number.isFinite))].slice(0, 500) : [];
  if (!ids.length) return c.json({ error: "no ids" }, 400);
  const PROTECTED = new Set(["unsubscribed", "blacklisted", "bounced"]);
  const PROTECTED_ALLOWED = new Set(["unsubscribed", "blacklisted", "bounced", "ignored"]);
  let updated = 0;
  const skipped: { id: number; reason: string }[] = [];
  for (const id of ids) {
    try {
      const cur = await c.env.DB.prepare(
        "SELECT l.status, l.email, a.match_score FROM leads l LEFT JOIN lead_analysis a ON a.lead_id = l.id WHERE l.id = ?"
      ).bind(id).first<{ status: string; email: string; match_score: number | null }>();
      if (!cur) { skipped.push({ id, reason: "not found" }); continue; }
      // M3b 合规护栏：退订/黑名单/退信 只能在彼此或→ignored，不能复发
      if (PROTECTED.has(cur.status) && !PROTECTED_ALLOWED.has(status)) {
        skipped.push({ id, reason: `「${cur.status}」不可转「${status}」` }); continue;
      }
      // A1 待发送护栏（服务端强制）：置 approved 必须 有邮箱 且 已打分≥60——
      // 防"没打分/缺邮箱/低分"线索再漏进待发送（根因：199条没打分、269条缺邮箱、12条<60）
      const gate = approveGateReason(cur.email, cur.match_score);
      if (status === "approved" && gate) { skipped.push({ id, reason: gate }); continue; }
      await c.env.DB.prepare("UPDATE leads SET status = ?, updated_at = datetime('now') WHERE id = ?").bind(status, id).run();
      if (status === "unsubscribed" || status === "blacklisted" || status === "bounced") {
        await addSuppressedEmail(c.env, cur.email, `bulk:${status}`);
      }
      updated++;
    } catch (e: any) { skipped.push({ id, reason: e.message || String(e) }); }
  }
  return c.json({ updated, skipped });
});
app.post("/api/high-score-ready/approve", async (c) => {
  // 按分从高到低把符合条件的置 approved（上限 500 防误伤海量）；不自动发信——发送仍走「发送已批准」按每日上限。
  const res = await c.env.DB.prepare(
    "UPDATE leads SET status='approved', updated_at=datetime('now') WHERE id IN (" +
    `SELECT l.id FROM leads l JOIN lead_analysis a ON a.lead_id = l.id WHERE ${HIGH_SCORE_READY_WHERE} ORDER BY a.match_score DESC LIMIT 500)`
  ).run();
  return c.json({ approved: res.meta.changes || 0 });
});

// ---- 一次性回填：把已有 lead_analysis 的 customer_type 归一到 customer_category（幂等）----
app.post("/api/admin/recategorize", async (c) => {
  const rows = await c.env.DB.prepare("SELECT lead_id, customer_type FROM lead_analysis").all();
  let updated = 0;
  for (const r of rows.results as any[]) {
    const cat = categorizeCustomerType(r.customer_type);
    await c.env.DB.prepare("UPDATE lead_analysis SET customer_category=? WHERE lead_id=?").bind(cat, r.lead_id).run();
    updated++;
  }
  return c.json({ updated });
});

// ---- 一次性回填：给缺 country 的遗留线索按官网 ccTLD 推断国家（幂等，只动 NULL/空）----
// ⚠️ 这是对遗留数据的最佳努力推断：ccTLD 命中则回填，.com/.net 等通用后缀无法判定 → 保持 NULL（不猜、不默认美国）。
//    新线索入库已带准确 country，不受影响。
app.post("/api/admin/backfill-country", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id, website FROM leads WHERE (country IS NULL OR country='') AND website IS NOT NULL AND website != ''"
  ).all();
  const breakdown: Record<string, number> = {};
  let updated = 0;
  for (const r of rows.results as any[]) {
    const cc = inferCountryFromWebsite(r.website);
    if (!cc) continue;
    await c.env.DB.prepare("UPDATE leads SET country=?, updated_at=datetime('now') WHERE id=?").bind(cc, r.id).run();
    breakdown[cc] = (breakdown[cc] || 0) + 1;
    updated++;
  }
  return c.json({ updated, breakdown });
});

// ---- 一次性：国家字段规整（英文全名/大写码 → 小写 ISO-2 码），幂等 ----
const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  "united states": "us", "philippines": "ph", "canada": "ca", "australia": "au",
  "south africa": "za", "new zealand": "nz", "turkey": "tr", "nigeria": "ng",
  "mexico": "mx", "malta": "mt", "greece": "gr", "british virgin islands": "vg",
};
app.post("/api/admin/normalize-countries", async (c) => {
  // M2 归一化回填（幂等）：① 优先按官网 ccTLD 推真实所在国（纠正 gl 标错，如 Dubai 站被标 FR）；
  //   ② 否则把现有值规整为 **大写 ISO-2 码**（英文全名→码、任意大小写码→大写），统一大小写、消除看板 Top10 同国重复。
  const rows = await c.env.DB.prepare("SELECT id, country, website FROM leads WHERE country IS NOT NULL AND country != ''").all();
  let updated = 0;
  const breakdown: Record<string, number> = {};
  for (const r of rows.results as any[]) {
    const raw = String(r.country).trim();
    let code = inferCountryFromWebsite(r.website || "");   // ccTLD 命中 → 大写两位码；否则 ""
    if (!code) {
      const lower = raw.toLowerCase();
      if (COUNTRY_NAME_TO_CODE[lower]) code = COUNTRY_NAME_TO_CODE[lower].toUpperCase();   // 英文全名 → 大写码
      else if (/^[a-z]{2}$/i.test(raw)) code = raw.toUpperCase();                          // 两位码(任意大小写) → 大写
    }
    if (code && code !== raw) {                                              // 仅在有变化时更新（幂等）
      await c.env.DB.prepare("UPDATE leads SET country=?, updated_at=datetime('now') WHERE id=?").bind(code, r.id).run();
      updated++;
      breakdown[code] = (breakdown[code] || 0) + 1;
    }
  }
  return c.json({ updated, breakdown });
});

// ---- 线索详情（含 AI 分析）----
app.get("/api/leads/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const lead = await c.env.DB.prepare(
    "SELECT l.*, " +
    "EXISTS (SELECT 1 FROM emails e WHERE e.lead_id = l.id AND e.opened_at IS NOT NULL) AS has_open, " +
    "EXISTS (SELECT 1 FROM emails e WHERE e.lead_id = l.id AND e.clicked_at IS NOT NULL) AS has_click, " +
    "EXISTS (SELECT 1 FROM emails e WHERE e.lead_id = l.id AND e.kind='followup' AND e.status='sent') AS has_followup, " +
    "(SELECT r.category FROM replies r WHERE r.lead_id = l.id ORDER BY r.id DESC LIMIT 1) AS latest_reply_cat " +
    "FROM leads l WHERE l.id = ?"
  ).bind(id).first();
  if (!lead) return c.json({ error: "not found" }, 404);
  const analysis = await c.env.DB.prepare("SELECT * FROM lead_analysis WHERE lead_id = ?").bind(id).first();
  return c.json({ lead, analysis });
});

// ---- 改状态（批准 / 忽略 / 黑名单 等）----
app.post("/api/leads/:id/status", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ status?: string }>().catch(() => ({}));
  const status = body.status;
  if (!status || !ALLOWED_STATUS.has(status)) {
    return c.json({ error: "invalid status" }, 400);
  }
  // M3 合规保护：退订/黑名单/退信是合规终态，只能在彼此间或转到 ignored，
  // 禁止转到任何其它状态（含 pending/analyzed 等中间态）—— 堵"两跳洗白"绕过。
  const PROTECTED = new Set(["unsubscribed", "blacklisted", "bounced"]);
  const PROTECTED_ALLOWED_TARGETS = new Set(["unsubscribed", "blacklisted", "bounced", "ignored"]);
  const cur = await c.env.DB.prepare(
    "SELECT l.status, l.email, l.human_approved, a.match_score FROM leads l LEFT JOIN lead_analysis a ON a.lead_id = l.id WHERE l.id = ?"
  ).bind(id).first<{ status: string; email: string; human_approved: number; match_score: number | null }>();
  if (!cur) return c.json({ error: "not found" }, 404);
  if (PROTECTED.has(cur.status) && !PROTECTED_ALLOWED_TARGETS.has(status)) {
    return c.json({ error: `「${cur.status}」是合规终态，只能转到 黑名单/退订/退信/已忽略，不能转到「${status}」（防复发绕过）` }, 409);
  }
  // A1 待发送护栏（服务端强制，与 bulk-status 同一真源）：置 approved 必须 有邮箱 且 已打分≥60。
  // 单条路径认 human_approved（Joe 亲手按过「手动发这家」）→ 只豁免分数线，邮箱仍必须有。
  {
    const gate = approveGateReason(cur.email, cur.match_score, cur.human_approved === 1);
    if (status === "approved" && gate) return c.json({ error: gate }, 409);
  }
  const res = await c.env.DB.prepare(
    "UPDATE leads SET status = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(status, id).run();
  if (!res.meta.changes) return c.json({ error: "not found" }, 404);
  // 手动改成压制态：把该 lead 邮箱写入持久压制名单（终极闸，重导入/两跳也拦得住）
  if (status === "unsubscribed" || status === "blacklisted" || status === "bounced") {
    await addSuppressedEmail(c.env, cur.email, `manual:${status}`);
  }
  return c.json({ ok: true, id, status });
});

// ---- 翻牌堆 human override：「手动发这家」（Joe 亲手对单条 <60 线索按下）----
// ⭐ 这是**唯一能让 <60 的信发出去的口子**。设计约束（对应的实测在 commit message 里）：
//   · 只接受**单条 id**（路径参数）—— 没有 ids[] 数组、没有批量版本、没有任何自动路径调它
//   · 只豁免**分数线**：邮箱仍必须有（approveGateReason 里判），M3 终态照样拦
//   · 幂等/压制名单/每日上限/原子取批 一个都不豁免（那些在 sendApprovedBatch / deliverEmail 里，
//     这个端点根本碰不到它们）
//   · 不发信，只置 approved —— 发送仍走 sendApprovedBatch 那条唯一的发送路径
// 存在的理由：机器误杀一个真客户 = 损失一单、不可见、无兜底。Joe 在翻牌堆里认出来的，得有路发出去。
app.post("/api/leads/:id/human-approve", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
  const cur = await c.env.DB.prepare(
    "SELECT l.status, l.email, a.match_score FROM leads l LEFT JOIN lead_analysis a ON a.lead_id = l.id WHERE l.id = ?"
  ).bind(id).first<{ status: string; email: string; match_score: number | null }>();
  if (!cur) return c.json({ error: "not found" }, 404);
  // M3 合规终态照拦：human override 只越过分数线，不越过合规
  const PROTECTED = new Set(["unsubscribed", "blacklisted", "bounced"]);
  if (PROTECTED.has(cur.status)) {
    return c.json({ error: `「${cur.status}」是合规终态，不能手动发（这条线是合规红线，不是分数线）` }, 409);
  }
  // 走同一条护栏，humanApproved=true 只让它跳过分数线那一项；缺邮箱/未打分照样被拦
  const gate = approveGateReason(cur.email, cur.match_score, true);
  if (gate) return c.json({ error: gate }, 409);
  await c.env.DB.prepare(
    "UPDATE leads SET human_approved=1, status='approved', updated_at=datetime('now') WHERE id=?"
  ).bind(id).run();
  return c.json({ ok: true, id, score: cur.match_score, note: "已加入待发送（人工放行）。发送仍受每日上限/压制名单/幂等约束。" });
});

// ---- 翻牌堆 →「转工作台」：<60 但有社媒渠道的，进 D 的手动触达队列 ----
// 工作台里没有任何自动发送，全是 Joe 的手 → 这个标记不像 human_approved 那样敏感，
// 但同样只接受单条 id、只由这个端点写。
app.post("/api/leads/:id/to-bench", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
  const cur = await c.env.DB.prepare("SELECT status, channels FROM leads WHERE id=?").bind(id)
    .first<{ status: string; channels: string | null }>();
  if (!cur) return c.json({ error: "not found" }, 404);
  if (["unsubscribed", "blacklisted", "bounced"].includes(cur.status)) {
    return c.json({ error: `「${cur.status}」是合规终态，不能再联系（换渠道也不行）` }, 409);
  }
  let n = 0; try { n = Object.keys(JSON.parse(cur.channels || "{}")).length; } catch { /* 坏 JSON 当没渠道 */ }
  if (!n) return c.json({ error: "这家没有任何社媒/电话渠道，碰不到（工作台也没辙）" }, 409);
  await c.env.DB.prepare("UPDATE leads SET bench_queued=1, updated_at=datetime('now') WHERE id=?").bind(id).run();
  return c.json({ ok: true, id });
});

// ---- 快赢③：设置线索"下一步动作 + 日期"（轻CRM）----
app.post("/api/leads/:id/next-action", async (c) => {
  const id = Number(c.req.param("id"));
  const b = await c.req.json<{ next_action?: string; next_action_date?: string }>().catch(() => ({}));
  const action = (b.next_action ?? "").trim().slice(0, 500);
  let date = (b.next_action_date ?? "").trim();
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: "日期格式须为 YYYY-MM-DD" }, 400);
  const res = await c.env.DB.prepare(
    "UPDATE leads SET next_action=?, next_action_date=?, updated_at=datetime('now') WHERE id=?"
  ).bind(action || null, date || null, id).run();
  if (!res.meta.changes) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true, id, next_action: action || null, next_action_date: date || null });
});

// ---- 快赢③：线索时间线（从 leads/lead_analysis/emails/replies 聚合关键事件，按时间排序）----
app.get("/api/leads/:id/timeline", async (c) => {
  const id = Number(c.req.param("id"));
  const lead = await c.env.DB.prepare("SELECT created_at, source, keyword FROM leads WHERE id=?").bind(id).first<any>();
  if (!lead) return c.json({ error: "not found" }, 404);
  const events: { time: string; type: string; label: string }[] = [];
  events.push({ time: lead.created_at, type: "discovered", label: `线索录入${lead.source ? `（来源 ${lead.source}${lead.keyword ? ` · ${lead.keyword}` : ""}）` : ""}` });

  const a = await c.env.DB.prepare("SELECT analyzed_at, match_score FROM lead_analysis WHERE lead_id=?").bind(id).first<any>();
  if (a?.analyzed_at) events.push({ time: a.analyzed_at, type: "analyzed", label: `AI 分析打分 ${a.match_score ?? "—"}` });

  const emails = await c.env.DB.prepare(
    "SELECT kind, status, subject, sent_at, created_at FROM emails WHERE lead_id=? ORDER BY id ASC"
  ).bind(id).all();
  for (const e of emails.results as any[]) {
    const t = e.sent_at || e.created_at;
    const kindLabel = e.kind === "followup" ? "跟进信" : "开发信";
    const stLabel = e.status === "sent" ? "已发送" : e.status === "bounced" ? "退信" : e.status === "failed" ? "发送失败" : "待发";
    events.push({ time: t, type: `email_${e.status}`, label: `${kindLabel}${stLabel}${e.subject ? `：${e.subject}` : ""}` });
  }

  const replies = await c.env.DB.prepare(
    "SELECT category, summary, received_at FROM replies WHERE lead_id=? ORDER BY id ASC"
  ).bind(id).all();
  for (const r of replies.results as any[]) {
    events.push({ time: r.received_at, type: "reply", label: `收到回复（${r.category || "?"}）${r.summary ? `：${r.summary}` : ""}` });
  }

  // 按时间升序；无时间的排最后
  events.sort((x, y) => String(x.time || "").localeCompare(String(y.time || "")));
  return c.json({ events });
});

// ---- 冲刺1a：今日待办作战台（聚合 该跟进 / 未处理热回复 / 今日参与）----
app.get("/api/today", async (c) => {
  const db = c.env.DB;
  // ① 今天该跟进（next_action_date 已到，排除已成交/忽略/压制态）
  const dueFollowups = (await db.prepare(
    "SELECT l.id, l.company_name, l.website, l.next_action, l.next_action_date FROM leads l " +
    "WHERE l.next_action_date IS NOT NULL AND l.next_action_date != '' AND date(l.next_action_date) <= date('now') " +
    "AND l.status NOT IN ('won','ignored','blacklisted','unsubscribed','bounced') ORDER BY l.next_action_date ASC LIMIT 50"
  ).all()).results;
  // ② 未处理热回复（interested/inquiry，且线索未成交/忽略/黑名单）
  const hotReplies = (await db.prepare(
    "SELECT r.id, r.lead_id, r.from_email, r.category, r.summary, r.received_at, l.company_name FROM replies r " +
    "LEFT JOIN leads l ON l.id = r.lead_id WHERE r.category IN ('interested','inquiry') " +
    "AND (l.status IS NULL OR l.status NOT IN ('won','ignored','blacklisted')) ORDER BY r.id DESC LIMIT 50"
  ).all()).results;
  // ③ 今天有参与（打开/点击）的线索
  const engagedToday = (await db.prepare(
    "SELECT l.id, l.company_name, l.website, l.last_engaged_at, " +
    "EXISTS (SELECT 1 FROM emails e WHERE e.lead_id = l.id AND e.clicked_at IS NOT NULL) AS has_click " +
    "FROM leads l WHERE l.last_engaged_at IS NOT NULL AND date(l.last_engaged_at) = date('now') ORDER BY l.last_engaged_at DESC LIMIT 50"
  ).all()).results;
  // ④「新高分线索」查询已删（两档制）：批④-1 早就把前端那个列表删了、没人读它 = 死查询；
  //    而且自动通道时代"新出现一家 85 分"没有动作含义 —— 发生的事就是机器已经把信发出去了。
  const sug = await buildActionSuggestions(c.env);   // #47 今日待办顶部「现在就能推进」复用同一引擎
  // 批④ 待办事项=分诊台：这里只给"每类还剩几件"的真实计数，页面按紧急度排、0 的不显示、只跳转不做动作。
  // ⭐「X 家能发」必须是真能发的口径 = approved 且 有邮箱 且 ≥60分（与 sendApprovedBatch 的取批条件一致）。
  //    旧版直接拿 approved 总数当"待发送"→ 显示 322 而真值 41，是用户最恼火的那个谎。
  const sendable = (await db.prepare(
    `SELECT COUNT(*) AS n FROM leads l JOIN lead_analysis a ON a.lead_id = l.id
      WHERE l.status='approved' AND a.match_score >= ${APPROVE_MIN_SCORE}
        AND l.email IS NOT NULL AND l.email != ''
        AND lower(l.email) NOT IN (SELECT email FROM suppressed_emails)`
  ).first<{ n: number }>())?.n || 0;
  const serper = await getSerperUsage(c.env);
  return c.json({
    dueFollowups, hotReplies, engagedToday, actions: sug.actions,
    sendable,                       // 批④：真能发的家数（approved+有邮箱+≥60+未压制）
    reviewCount: sug.reviewCount,   // 待审批
    serper,                         // ⚠️系统警报：Serper 预算
  });
});

// ---- CSV 导入（去重）----
app.post("/api/leads/import", async (c) => {
  const body = await c.req.json<{ csv?: string; source?: string }>().catch(() => ({}));
  const csv = body.csv || "";
  // ⚠️ source 由请求体控制 → 绝不允许自称可信目录来源（nmea/rvwithtito）。
  //    否则导一份 CSV 写 source=nmea，每条都能白拿 NMEA 强背书 = 打分器的新骗分通道。
  //    可信目录背书只能由我们自己的抓取管道（runNmeaDiscovery / runLinkHarvest）写入。
  const rawSource = String(body.source || "").trim();
  const source = (!rawSource || isTrustedDirectorySource(rawSource)) ? "csv" : rawSource.slice(0, 40);
  if (!csv.trim()) return c.json({ error: "empty csv" }, 400);

  const rows = parseCsv(csv);
  if (rows.length < 2) return c.json({ error: "csv 至少需要表头 + 1 行数据" }, 400);

  const header = rows[0].map((h) => h.trim().toLowerCase());
  let inserted = 0, skipped = 0;
  const errors: string[] = [];

  for (let i = 1; i < rows.length; i++) {
    const lead = mapRowToLead(header, rows[i]);
    if (!lead) { skipped++; continue; }
    if (!lead.company_name && !lead.website && !lead.email) { skipped++; continue; }

    // 去重：邮箱或网站命中已存在则跳过
    let dupSql = "SELECT id FROM leads WHERE ";
    const conds: string[] = [];
    const binds: any[] = [];
    if (lead.email) { conds.push("email = ?"); binds.push(lead.email); }
    if (lead.website) { conds.push("website = ?"); binds.push(lead.website); }
    if (conds.length) {
      const dup = await c.env.DB.prepare(dupSql + conds.join(" OR ") + " LIMIT 1").bind(...binds).first();
      if (dup) { skipped++; continue; }
    }

    try {
      // ⭐批④：CSV 里的两位国家码统一大写落库（英文全名等非两位值原样留给 /api/admin/normalize-countries 规整）
      const csvCC = String(lead.country || "").trim();
      const csvCountry = /^[a-z]{2}$/i.test(csvCC) ? csvCC.toUpperCase() : (csvCC || null);
      await c.env.DB.prepare(
        "INSERT INTO leads (company_name, website, email, country, source, keyword, status) VALUES (?, ?, ?, ?, ?, ?, 'new')"
      ).bind(lead.company_name, lead.website, lead.email, csvCountry, source, lead.keyword).run();
      inserted++;
    } catch (e: any) {
      errors.push(`第 ${i + 1} 行: ${e.message}`);
    }
  }

  return c.json({ inserted, skipped, errors: errors.slice(0, 10) });
});

// ---- AI 分析：单条 ----
app.post("/api/leads/:id/analyze", async (c) => {
  const id = Number(c.req.param("id"));
  const lead = await c.env.DB.prepare("SELECT * FROM leads WHERE id = ?").bind(id).first();
  if (!lead) return c.json({ error: "not found" }, 404);
  const out = await analyzeLead(c.env, lead);
  return c.json(out, out.ok ? 200 : 500);
});

// ---- AI 分析：批量（默认处理 5 条 new 线索）----
app.post("/api/analyze/batch", async (c) => {
  const body = await c.req.json<{ limit?: number; ids?: number[] }>().catch(() => ({}));
  const limit = Math.min(Math.max(Number(body.limit) || 5, 1), 20);
  // A2：传 ids 只处理选中的（仍受原有 status='new' 过滤 + limit 上限）；不传维持原行为
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(Number).filter(Number.isFinite))].slice(0, 500) : [];
  const rows = ids.length
    ? await c.env.DB.prepare(
        `SELECT * FROM leads WHERE status = 'new' AND id IN (${ids.map(() => "?").join(",")}) ORDER BY id ASC LIMIT ?`
      ).bind(...ids, limit).all()
    : await c.env.DB.prepare(
        "SELECT * FROM leads WHERE status = 'new' ORDER BY id ASC LIMIT ?"
      ).bind(limit).all();
  const leads = rows.results as any[];

  const results = [];
  for (const lead of leads) {
    results.push(await analyzeLead(c.env, lead));
    // 便宜模型也别打太猛，逐条串行即可
  }
  const ok = results.filter((r) => r.ok).length;
  return c.json({ processed: results.length, ok, failed: results.length - ok, results });
});

// ---- 客户画像设置 ----
app.get("/api/settings/profile", async (c) => {
  const profile = await getProfile(c.env);
  const row = await c.env.DB.prepare("SELECT value FROM settings WHERE key='customer_profile'").first();
  return c.json({ profile, isDefault: !row });
});
app.post("/api/settings/profile", async (c) => {
  const body = await c.req.json<{ profile?: string }>().catch(() => ({}));
  const profile = (body.profile || "").trim();
  if (!profile) return c.json({ error: "profile 不能为空" }, 400);
  await c.env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('customer_profile', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).bind(profile).run();
  return c.json({ ok: true });
});
// 一次性：把生效画像重置为当前 DEFAULT_PROFILE（经销/电商卖家 ICP），覆盖已有自定义。
app.post("/api/admin/reset-profile", async (c) => {
  await c.env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('customer_profile', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).bind(DEFAULT_PROFILE).run();
  return c.json({ ok: true, length: DEFAULT_PROFILE.length });
});
// E2 一次性：清空关键词池并重灌新版 DEFAULT_KEYWORDS + 默认搜索国家设为 22 国。
// （生产 keywords 表已有旧词，仅改 DEFAULT_KEYWORDS 不生效，故用此端点覆盖。）
app.post("/api/admin/reset-keywords", async (c) => {
  await c.env.DB.prepare("DELETE FROM keywords").run();
  await seedDefaultKeywords(c.env);
  await setSetting(c.env, "search_countries", DEFAULT_COUNTRIES.join(","));
  const kws = await getKeywords(c.env);
  return c.json({ ok: true, keywords: kws.length, countries: DEFAULT_COUNTRIES.length });
});

// ---- 调试：查看抓取效果（内部工具，验证网站抓取用）----
app.get("/api/debug/scrape", async (c) => {
  const url = c.req.query("url") || "";
  if (!url) return c.json({ error: "缺少 url 参数" }, 400);
  const r = await scrapeSite(url);
  return c.json({ ok: r.ok, error: r.error, pages: r.pages, chars: r.text.length, sample: r.text.slice(0, 600) });
});

// ---- P3 发信：单条（要求已批准 approved）----
app.post("/api/leads/:id/send", async (c) => {
  const id = Number(c.req.param("id"));
  const lead = await c.env.DB.prepare("SELECT * FROM leads WHERE id=?").bind(id).first();
  if (!lead) return c.json({ error: "not found" }, 404);
  const out = await sendLead(c.env, lead);
  return c.json(out, out.ok ? 200 : 500);
});

// ---- 详情弹窗：保存（人工编辑过的）推荐开发信 ----
app.post("/api/leads/:id/email", async (c) => {
  const id = Number(c.req.param("id"));
  const b = await c.req.json<{ recommended_email?: string }>().catch(() => ({}));
  const em = (b.recommended_email ?? "").slice(0, 8000);
  const res = await c.env.DB.prepare("UPDATE lead_analysis SET recommended_email=? WHERE lead_id=?").bind(em, id).run();
  return c.json({ ok: !!res.meta.changes });
});

// #44 推荐开发信一键翻译成中文（纯展示；传入文本仅当数据翻译，不改动实际发送的英文原文）
app.post("/api/translate", async (c) => {
  const b = await c.req.json<{ text?: string }>().catch(() => ({}));
  const text = String(b.text ?? "").trim();
  if (!text) return c.json({ error: "空文本" }, 400);
  if (text.length > 8000) return c.json({ error: "文本过长（上限 8000 字）" }, 400);
  try {
    const translation = await translateToChinese(c.env, text);
    return c.json({ translation });
  } catch (e: any) {
    return c.json({ error: String(e?.message || e) }, 500);
  }
});

// ---- 详情弹窗：手动填「联系邮箱」到 leads.email（用户自己在官网找到的；区别于上面存草稿的 :id/email）----
app.post("/api/leads/:id/contact-email", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "无效 id" }, 400);
  const b = await c.req.json<{ email?: string }>().catch(() => ({}));
  const email = String(b.email ?? "").trim();
  if (!email || email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: "邮箱格式不正确" }, 400);
  }
  // 合规红线：退订/退信/黑名单邮箱不能作为发信地址（与发信同一道 isEmailSuppressed 闸）
  if (await isEmailSuppressed(c.env, email)) {
    return c.json({ error: "该邮箱已退订/退信/黑名单，不能作为发信地址" }, 409);
  }
  const res = await c.env.DB.prepare("UPDATE leads SET email=?, updated_at=datetime('now') WHERE id=?").bind(email, id).run();
  if (!res.meta.changes) return c.json({ error: "线索不存在" }, 404);
  return c.json({ ok: true, email });
});

// ---- engaged「趁热跟进」：起草暖跟进（不发送，返回可编辑全文供人工审）----
app.post("/api/leads/:id/warm-followup", async (c) => {
  const id = Number(c.req.param("id"));
  const lead = await c.env.DB.prepare("SELECT * FROM leads WHERE id=?").bind(id).first<any>();
  if (!lead) return c.json({ error: "not found" }, 404);
  const a = await c.env.DB.prepare("SELECT recommended_email FROM lead_analysis WHERE lead_id=?").bind(id).first<{ recommended_email: string }>();
  try {
    const text = await writeWarmFollowup(c.env, lead.company_name || "", await getProfile(c.env), a?.recommended_email || "");
    return c.json({ ok: true, text });
  } catch (e: any) {
    return c.json({ error: "起草失败: " + (e.message || String(e)) }, 500);
  }
});
// ---- engaged「趁热跟进」：发送用户审过（可能已编辑）的暖跟进（走 deliverEmail 压制闸）----
app.post("/api/leads/:id/warm-followup/send", async (c) => {
  const id = Number(c.req.param("id"));
  const lead = await c.env.DB.prepare("SELECT * FROM leads WHERE id=?").bind(id).first<any>();
  if (!lead) return c.json({ error: "not found" }, 404);
  const b = await c.req.json<{ text?: string }>().catch(() => ({}));
  const out = await sendWarmFollowupNow(c.env, lead, b.text || "");
  if (out.skipped) return c.json({ skipped: out.skipped }, 200);
  return c.json(out, out.ok ? 200 : 500);
});

// ---- P3 发信：批量已批准（按分数从高到低 + 每日上限）----
app.post("/api/send/batch", async (c) => {
  const body = await c.req.json<{ limit?: number; ids?: number[] }>().catch(() => ({}));
  const limit = Math.min(Math.max(Number(body.limit) || 10, 1), 50);
  // A2：传 ids 只发选中的（仍走同一条 sendApprovedBatch —— status='approved' + ≥60分门槛 +
  // 每日上限 + 原子取批 + deliverEmail 幂等 + 压制名单，一个都不绕过）；不传维持原行为
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(Number).filter(Number.isFinite))].slice(0, 500) : [];
  const out = await sendApprovedBatch(c.env, limit, ids.length ? ids : undefined);
  return c.json(out);
});

// ---- 无回复自动跟进设置 ----
app.get("/api/settings/followup", async (c) => {
  return c.json({
    enabled: (await getSetting(c.env, "followup_enabled", "0")) === "1",
    delay_days: Number(await getSetting(c.env, "followup_delay_days", "4")) || 4,
    engaged_delay_days: Number(await getSetting(c.env, "engaged_follow_up_delay_days", "2")) || 2,
    max_followups: Number(await getSetting(c.env, "followup_max", "1")) || 1,
  });
});
app.post("/api/settings/followup", async (c) => {
  const b = await c.req.json<{ enabled?: boolean; delay_days?: number; engaged_delay_days?: number; max_followups?: number }>().catch(() => ({}));
  if (b.enabled != null) await setSetting(c.env, "followup_enabled", b.enabled ? "1" : "0");
  if (b.delay_days != null) await setSetting(c.env, "followup_delay_days", String(Math.max(1, Math.min(60, Number(b.delay_days) || 4))));
  if (b.engaged_delay_days != null) await setSetting(c.env, "engaged_follow_up_delay_days", String(Math.max(1, Math.min(60, Number(b.engaged_delay_days) || 2))));
  if (b.max_followups != null) await setSetting(c.env, "followup_max", String(Math.max(1, Math.min(5, Number(b.max_followups) || 1))));
  return c.json({ ok: true });
});
// ---- 无回复跟进：手动跑一批 ----
app.post("/api/followup/run", async (c) => {
  const body = await c.req.json<{ limit?: number; ids?: number[] }>().catch(() => ({}));
  const limit = Math.min(Math.max(Number(body.limit) || 10, 1), 50);
  // 批③C：传 ids 只跟进选中的（走同一条 sendFollowupBatch —— 开关/冷却/次数/每日上限/幂等/压制一个不绕；
  // engaged 的自动用「趁热」暖变体，所以「跟进选中」与「趁热跟进选中」共用本端点）
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(Number).filter(Number.isFinite))].slice(0, 500) : [];
  const out = await sendFollowupBatch(c.env, limit, ids.length ? ids : undefined);
  return c.json(out);
});

// 一键开聊默认话术（英文，{company} 占位；渲染时替换为公司名）
const DEFAULT_CHAT_SCRIPT =
  "Hi {company} team — TEJOY supplies wholesale Starlink accessories (mounts, cables, enclosures, power kits) to dealers & installers. May I send you our dealer price list?";

// ---- 发信设置（每日上限 + 公司名 + 合规地址 + 卖点 + 一键开聊话术）----
app.get("/api/settings/sending", async (c) => {
  const br = await getBreakerStatus(c.env);
  return c.json({
    daily_send_limit: Number(await getSetting(c.env, "daily_send_limit", "15")) || 15,
    company_name: await getSetting(c.env, "company_name", "TEJOY"),
    company_address: await getSetting(c.env, "company_address", ""),
    company_website: await getSetting(c.env, "company_website", c.env.SITE_URL || "https://tejoy.com"),
    selling_points: await getSetting(c.env, "selling_points", DEFAULT_SELLING_POINTS),
    chat_script: await getSetting(c.env, "chat_script", DEFAULT_CHAT_SCRIPT),
    // 自动化三开关 + 熔断状态（前端要能看能关；熔断后必须显眼告诉 Joe 为什么停了）
    auto_approve_enabled: (await getSetting(c.env, "auto_approve_enabled", "1")) === "1",
    auto_send_enabled: (await getSetting(c.env, "auto_send_enabled", "1")) === "1",
    auto_send_daily_limit: Number(await getSetting(c.env, "auto_send_daily_limit", "15")) || 15,
    auto_approve_min: await getAutoApproveMin(c.env),
    auto_sent_today: await autoSentToday(c.env),
    breaker: {
      window: br.window, unsubs: br.unsubs,
      rate: Math.round(br.rate * 1000) / 10,          // 百分数，一位小数
      enoughSample: br.enoughSample,
      windowSize: BREAKER_WINDOW,
      thresholdPct: BREAKER_THRESHOLD * 100,
      trippedAt: await getSetting(c.env, "auto_send_tripped_at", ""),
      tripReason: await getSetting(c.env, "auto_send_trip_reason", ""),
    },
  });
});
app.post("/api/settings/sending", async (c) => {
  const b = await c.req.json<{ daily_send_limit?: number; company_name?: string; company_address?: string; company_website?: string; selling_points?: string; chat_script?: string; auto_approve_enabled?: boolean; auto_send_enabled?: boolean; auto_send_daily_limit?: number; auto_approve_min?: number }>().catch(() => ({}));
  if (b.daily_send_limit != null) await setSetting(c.env, "daily_send_limit", String(Math.max(1, Math.min(500, Number(b.daily_send_limit) || 15))));
  if (b.auto_approve_enabled != null) await setSetting(c.env, "auto_approve_enabled", b.auto_approve_enabled ? "1" : "0");
  // 下限钉死在 APPROVE_MIN_SCORE：设更低也不生效（approveGateReason 照样拦），不给"设了却没用"的假象
  if (b.auto_approve_min != null) await setSetting(c.env, "auto_approve_min", String(Math.max(APPROVE_MIN_SCORE, Math.min(100, Number(b.auto_approve_min) || AUTO_APPROVE_MIN_DEFAULT))));
  if (b.auto_send_daily_limit != null) await setSetting(c.env, "auto_send_daily_limit", String(Math.max(1, Math.min(200, Number(b.auto_send_daily_limit) || 15))));
  if (b.auto_send_enabled != null) {
    const was = (await getSetting(c.env, "auto_send_enabled", "1")) === "1";
    await setSetting(c.env, "auto_send_enabled", b.auto_send_enabled ? "1" : "0");
    // 手动重开 = Joe 说"我查过了、改过了" → 清熔断印记 + **把熔断窗口的起点挪到此刻**。
    // ⚠️ 不挪起点的话熔断**不可恢复**：停了之后窗口再也不进新数据、永远卡在那个超标率，
    //    Joe 一重开，下一轮 cron 立刻拿同一批老数据再熔断一次，一封新信都发不出去。
    //    挪起点 ≠ 自动恢复（总工禁止的那个）：没有 Joe 手动点这一下，永远不会重开；
    //    重开之后窗口从 0 开始攒，攒够 30 封新的再判 —— 拿改之后的数据判，不拿旧账再判一次。
    if (b.auto_send_enabled && !was) {
      await setSetting(c.env, "auto_send_resumed_at", new Date().toISOString().replace("T", " ").slice(0, 19));
      await setSetting(c.env, "auto_send_tripped_at", "");
      await setSetting(c.env, "auto_send_trip_reason", "");
    }
  }
  if (b.company_name != null) await setSetting(c.env, "company_name", b.company_name.trim());
  if (b.company_address != null) await setSetting(c.env, "company_address", b.company_address.trim());
  if (b.company_website != null) await setSetting(c.env, "company_website", b.company_website.trim());
  if (b.selling_points != null) await setSetting(c.env, "selling_points", b.selling_points.trim());
  if (b.chat_script != null) await setSetting(c.env, "chat_script", b.chat_script.trim());
  return c.json({ ok: true });
});

// ---- 退订：一键退订(POST, RFC 8058) + 页面(GET) ----
app.post("/u/:token", async (c) => {
  await unsubscribeByToken(c.env, c.req.param("token"));
  return c.text("Unsubscribed", 200);
});
app.get("/u/:token", async (c) => {
  const ok = await unsubscribeByToken(c.env, c.req.param("token"));
  const msg = ok
    ? "You have been unsubscribed. You will not receive further emails from us."
    : "This unsubscribe link is invalid or has already been used.";
  return c.html(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
     <div style="font-family:Arial,sans-serif;max-width:520px;margin:80px auto;text-align:center;color:#222">
     <h2>TEJOY</h2><p style="font-size:16px;color:#444">${msg}</p></div>`
  );
});

// ---- P5 自动找客户：搜索发现 ----
app.post("/api/discover", async (c) => {
  const body = await c.req.json<{ keywords?: string[]; perKeyword?: number; countries?: string[] }>().catch(() => ({}));
  try {
    const out = await runDiscovery(c.env, body);
    return c.json(out);
  } catch (e: any) {
    return c.json({ error: e.message || String(e) }, 500);
  }
});

// ---- 批B 免费目录源：零 Serper 费。NMEA 单个 affcode（前端逐个调、间隔 10s 遵守 Crawl-delay）----
app.post("/api/discover/nmea", async (c) => {
  const b = await c.req.json<{ affcode?: string }>().catch(() => ({}));
  try {
    const out = await runNmeaDiscovery(c.env, b.affcode || "Dealer");
    return c.json(out);
  } catch (e: any) {
    return c.json({ error: e.message || String(e) }, 500);
  }
});
// rvwithtito RV 离网/太阳能安装商名单（网页外链采集，黑名单第三方域）
app.post("/api/discover/rvwithtito", async (c) => {
  try {
    const out = await runLinkHarvest(c.env, RVWITHTITO_URL, "rvwithtito", RVWITHTITO_BLACKLIST);   // URL+黑名单单一真源，与 cron 自动刷新共用
    return c.json(out);
  } catch (e: any) {
    return c.json({ error: e.message || String(e) }, 500);
  }
});

// ---- 找客户配置：目标国家 + 每关键词条数（含可选国家清单 + 关键词，供前端一次拿全）----
app.get("/api/settings/search", async (c) => {
  const cfg = await getSearchConfig(c.env);
  const keywords = await getKeywords(c.env);
  // 已勾选国家：读原始 setting（区分"从未设过"=默认 vs "设为空"=全不选），保证 UI 忠实回显
  const scRaw = await getSetting(c.env, "search_countries", "__UNSET__");
  const countries = scRaw === "__UNSET__"
    ? DEFAULT_COUNTRIES.slice()
    : scRaw.split(",").map((s) => s.trim().toLowerCase()).filter((x) => COUNTRIES[x]);
  // 国家清单（显示为 chips，可增删）：未定制过 → 展示全部目录
  const clRaw = await getSetting(c.env, "country_list", "");
  let countryList = clRaw.split(",").map((s) => s.trim().toLowerCase()).filter((x) => COUNTRIES[x]);
  if (!countryList.length) countryList = Object.keys(COUNTRIES);
  for (const cc of countries) if (!countryList.includes(cc)) countryList.push(cc);  // 勾选项必在清单
  // 关键词勾选态（#45）：null=未定制→全部启用
  const akRaw = await getSetting(c.env, "active_keywords", "__UNSET__");
  const activeKeywords = akRaw === "__UNSET__" ? null
    : akRaw.split("\n").map((s) => s.trim()).filter(Boolean);
  return c.json({
    countries,                         // 已勾选国家（gl 代码）
    countryList,                       // #45 国家清单（chips）
    perKeyword: cfg.perKeyword,
    allCountries: COUNTRIES,           // { gl: 中文名 } 全目录（供"添加国家"下拉）
    keywords,                          // 生效关键词（用于透明度预估）
    activeKeywords,                    // #45 已勾选关键词（null=全部）
    discoveryEnabled: (await getSetting(c.env, "discovery_enabled", "0")) === "1",   // #S1 后台每6h自动搜索开关（默认关）
    serper: await getSerperUsage(c.env),   // P0-c 今日 Serper 用量 + 预算
    backlog: await getBacklog(c.env),      // 批④：积压刹车条 —— 瓶颈不是线索不够，是管道里堵着
    // 队列⑦ 免费目录源每周自动刷新（零 Serper，默认开）
    dirAutoRefresh: (await getSetting(c.env, "directory_autorefresh_enabled", "1")) === "1",
    dirLastRefresh: await getSetting(c.env, "directory_last_refresh", ""),
  });
});
app.post("/api/settings/search", async (c) => {
  const b = await c.req.json<{ countries?: string[]; countryList?: string[]; activeKeywords?: string[] | null; perKeyword?: number; discoveryEnabled?: boolean; serperBudget?: number; dirAutoRefresh?: boolean }>().catch(() => ({}));
  if (typeof b.discoveryEnabled === "boolean") {
    await setSetting(c.env, "discovery_enabled", b.discoveryEnabled ? "1" : "0");   // #S1 Joe 后台开关
  }
  if (typeof b.dirAutoRefresh === "boolean") {
    await setSetting(c.env, "directory_autorefresh_enabled", b.dirAutoRefresh ? "1" : "0");   // 队列⑦ 每周自动刷新目录（零 Serper，默认开）
  }
  if (b.serperBudget != null) {
    const bn = Number(b.serperBudget);   // 允许 0（完全暂停）；非法值回落 200
    await setSetting(c.env, "serper_daily_budget", String(Math.max(0, Math.min(2500, Number.isFinite(bn) ? bn : 200))));   // P0-c 今日 Serper 预算上限
  }
  if (Array.isArray(b.countryList)) {
    const validL = b.countryList.map((x: string) => String(x).trim().toLowerCase()).filter((x: string) => COUNTRIES[x]);
    await setSetting(c.env, "country_list", validL.join(","));    // #45 持久化国家清单（允许为空）
  }
  if (Array.isArray(b.countries)) {
    const valid = b.countries.map((x: string) => String(x).trim().toLowerCase()).filter((x: string) => COUNTRIES[x]);
    await setSetting(c.env, "search_countries", valid.join(","));  // 允许空（全不选）；cron 侧 getSearchConfig 仍有默认兜底
  }
  if (Array.isArray(b.activeKeywords)) {
    await setSetting(c.env, "active_keywords", b.activeKeywords.map((s) => String(s).trim()).filter(Boolean).join("\n"));  // #45 持久化关键词勾选态
  }
  if (b.perKeyword != null) {
    await setSetting(c.env, "search_per_keyword", String(Math.max(1, Math.min(100, Number(b.perKeyword) || 8))));   // #45 放开到 100
  }
  return c.json({ ok: true });
});

// ---- 关键词池管理 ----
app.get("/api/keywords", async (c) => {
  const rows = await c.env.DB.prepare("SELECT id, keyword, weight, sent_count, reply_count FROM keywords ORDER BY weight DESC, id ASC").all();
  const keywords = (rows.results as any[]).map((k) => ({
    ...k,
    reply_rate: k.sent_count > 0 ? k.reply_count / k.sent_count : null,  // 无发送则为 null（新词，无数据）
  }));
  return c.json({ keywords, effective: await getKeywords(c.env) });
});
// 手动重算关键词权重（回复率加权），供调试/立即优化
app.post("/api/keywords/recompute", async (c) => {
  const out = await recomputeKeywordStats(c.env);
  return c.json(out);
});
app.post("/api/keywords", async (c) => {
  const b = await c.req.json<{ keyword?: string; seedDefaults?: boolean }>().catch(() => ({}));
  if (b.seedDefaults) { await seedDefaultKeywords(c.env); return c.json({ ok: true }); }
  const kw = (b.keyword || "").trim();
  if (!kw) return c.json({ error: "keyword 不能为空" }, 400);
  await c.env.DB.prepare("INSERT INTO keywords (keyword) VALUES (?) ON CONFLICT(keyword) DO NOTHING").bind(kw).run();
  return c.json({ ok: true });
});
app.delete("/api/keywords/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM keywords WHERE id=?").bind(Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});

// ---- 邮箱发现：单条（useHunter=true 才允许调 Hunter 花积分，默认免费抓取）----
app.post("/api/leads/:id/find-email", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ useHunter?: boolean }>().catch(() => ({}));
  const lead = await c.env.DB.prepare("SELECT * FROM leads WHERE id=?").bind(id).first<any>();
  if (!lead) return c.json({ error: "not found" }, 404);
  const r = await findLeadEmail(c.env, lead.website || "", !!body.useHunter);
  if (r.email) {
    await c.env.DB.prepare("UPDATE leads SET email=?, updated_at=datetime('now') WHERE id=?").bind(r.email, id).run();
  }
  return c.json({ id, ...r });
});

// ---- 邮箱发现：批量（给已分析但无邮箱的线索补邮箱）。默认免费抓取；useHunter=true 才对抓不到的走 Hunter ----
app.post("/api/emails/find-batch", async (c) => {
  const body = await c.req.json<{ limit?: number; useHunter?: boolean; ids?: number[] }>().catch(() => ({}));
  const limit = Math.min(Math.max(Number(body.limit) || 10, 1), 30);
  const useHunter = !!body.useHunter;
  // A2：传 ids 只处理选中的（仍受原有 status='analyzed' + 缺邮箱 + 有官网 过滤 + limit 上限）；不传维持原行为
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(Number).filter(Number.isFinite))].slice(0, 500) : [];
  const base = "SELECT id, website FROM leads WHERE status='analyzed' AND (email IS NULL OR email='') AND website IS NOT NULL AND website!=''";
  const rows = ids.length
    ? await c.env.DB.prepare(`${base} AND id IN (${ids.map(() => "?").join(",")}) ORDER BY id ASC LIMIT ?`).bind(...ids, limit).all()
    : await c.env.DB.prepare(`${base} ORDER BY id ASC LIMIT ?`).bind(limit).all();
  const leads = rows.results as any[];
  const results = [];
  for (const lead of leads) {
    const r = await findLeadEmail(c.env, lead.website, useHunter);
    if (r.email) {
      await c.env.DB.prepare("UPDATE leads SET email=?, updated_at=datetime('now') WHERE id=?").bind(r.email, lead.id).run();
    }
    results.push({ id: lead.id, website: lead.website, email: r.email, source: r.source });
  }
  const found = results.filter((r) => r.email).length;
  const hunterUsed = results.filter((r) => r.source === "hunter").length;  // 实际花掉的 Hunter 积分数
  return c.json({ processed: results.length, found, hunterUsed, results });
});

// ---- Hunter 状态：是否启用 + 剩余额度 + 待补邮箱线索数（account 接口不耗额度）----
app.get("/api/hunter/status", async (c) => {
  const targetRow = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM leads WHERE status='analyzed' AND (email IS NULL OR email='') AND website IS NOT NULL AND website!=''"
  ).first<{ n: number }>();
  const targets = targetRow?.n || 0;
  if (!c.env.EMAIL_FINDER_API_KEY) return c.json({ enabled: false, targets });
  try {
    const res = await fetch(`https://api.hunter.io/v2/account?api_key=${c.env.EMAIL_FINDER_API_KEY}`);
    const d: any = await res.json();
    const s = d?.data?.requests?.searches || {};
    return c.json({ enabled: true, targets, used: s.used ?? null, available: s.available ?? null });
  } catch (e: any) {
    return c.json({ enabled: true, targets, error: e.message || String(e) });
  }
});

// ---- 飞书通知设置 ----
app.get("/api/settings/notify", async (c) => {
  // notify_high_score_min 已删（两档制）：它只喂简报的「高分客户」清单，而那个清单已经删了 ——
  // 自动通道下"新出现一家 85 分"＝机器已经把信发出去了，列给 Joe 看没有动作含义。
  return c.json({
    configured: larkConfigured(c.env),        // 是否已配 webhook（secret 存在与否）
    hasSecret: !!c.env.LARK_WEBHOOK_SECRET,
    enabled: (await getSetting(c.env, "notify_enabled", "1")) !== "0",
  });
});
app.post("/api/settings/notify", async (c) => {
  const b = await c.req.json<{ enabled?: boolean }>().catch(() => ({}));
  if (b.enabled != null) await setSetting(c.env, "notify_enabled", b.enabled ? "1" : "0");
  return c.json({ ok: true });
});
// ---- 飞书通知：发测试卡片 ----
app.post("/api/notify/test", async (c) => {
  if (!larkConfigured(c.env)) return c.json({ ok: false, error: "尚未配置 LARK_WEBHOOK_URL（把飞书机器人 webhook 发给管理员注入）" }, 400);
  const r = await larkSend(c.env, testCard(c.env.ADMIN_URL || c.env.APP_URL));
  return c.json(r, r.ok ? 200 : 500);
});

// ---- Resend 退信/投诉 webhook（公开，Svix 签名校验）----
app.post("/api/webhooks/resend", async (c) => {
  const raw = await c.req.text();
  const ok = await verifyResendSignature(c.env, c.req.raw, raw);
  if (!ok) return c.json({ error: "invalid signature" }, 401);
  let event: any;
  try { event = JSON.parse(raw); } catch { return c.json({ error: "bad json" }, 400); }
  const r = await handleResendEvent(c.env, event);
  return c.json(r);
});

// ---- P4 回复处理：手动拉取新回复 ----
app.post("/api/replies/fetch", async (c) => {
  const out = await ingestReplies(c.env);
  return c.json(out, out.error ? 500 : 200);
});

// ---- 阶段三.2 给某条回复 AI 起草回复（供人工审核后发送）----
app.post("/api/replies/:id/draft", async (c) => {
  const id = Number(c.req.param("id"));
  const reply = await c.env.DB.prepare(
    `SELECT r.id, r.lead_id, r.from_email, r.subject, r.content, l.company_name
       FROM replies r LEFT JOIN leads l ON l.id = r.lead_id WHERE r.id = ?`
  ).bind(id).first<any>();
  if (!reply) return c.json({ error: "not found" }, 404);
  const profile = await getProfile(c.env);
  let original = "";
  if (reply.lead_id) {
    const a = await c.env.DB.prepare("SELECT recommended_email FROM lead_analysis WHERE lead_id = ?").bind(reply.lead_id).first<{ recommended_email: string }>();
    original = a?.recommended_email || "";
  }
  try {
    const draft = await writeReplyDraft(c.env, reply.company_name || reply.from_email || "", profile, original, reply.content || "");
    return c.json({ ok: true, draft });
  } catch (e: any) {
    return c.json({ error: e.message || String(e) }, 500);
  }
});

// ---- 回复列表 ----
app.get("/api/replies", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT r.id, r.lead_id, r.from_email, r.subject, r.summary, r.category, r.content, r.received_at,
            l.company_name, l.website
     FROM replies r LEFT JOIN leads l ON l.id = r.lead_id
     ORDER BY r.id DESC LIMIT 200`
  ).all();
  return c.json({ replies: rows.results });
});

// ---- Landing 落地页（公开）----
app.get("/catalog", (c) => c.html(catalogHtml()));

// ---- Landing 询盘写端点（公开）：honeypot + 频率限制 + 校验 + 去重 upsert + 推飞书 + 确认邮件 ----
app.post("/api/inbound", async (c) => {
  const b = await c.req.json<{ company_name?: string; email?: string; country?: string; where_sell?: string; monthly_volume?: string; company_url?: string }>().catch(() => ({}));
  // honeypot：隐藏字段被填 → 判定 bot，假成功、不入库
  if ((b.company_url || "").trim()) return c.json({ ok: true });

  const email = (b.email || "").trim().toLowerCase();
  const company = (b.company_name || "").trim().slice(0, 200);
  if (!company) return c.json({ error: "Company name is required" }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) return c.json({ error: "A valid email is required" }, 400);
  // country 白名单：非法 → null（别信任意 POST 值）。cc 保持小写做白名单/展示查表；
  // ⭐批④：落库一律大写（countryDb），别再制造 US/us 分裂
  const cc = (b.country || "").trim().toLowerCase();
  const country = COUNTRIES[cc] ? cc : null;
  const countryDb = country ? country.toUpperCase() : null;
  const whereSell = (b.where_sell || "").trim().slice(0, 300);
  const volume = (b.monthly_volume || "").trim().slice(0, 100);

  // 🔒 合规终极闸（复审加固）：命中持久压制名单(退订/退信/投诉) → 静默 ok，绝不入库/改状态/推飞书。
  // 不依赖可变 leads.status（那条会被"重复邮箱行 / 无 leads 行的压制条目"绕过），用与发信同一道 isEmailSuppressed。
  if (await isEmailSuppressed(c.env, email)) return c.json({ ok: true });

  // 限流（原则：正常量绝不丢真单；限流按 IP、只惩罚那个刷的 IP，不波及别人——全局桶会让一个刷子 DoS 所有人）。
  // 计数 = 该 IP 近 1h 在 throttle 表的 req 行数（标记 key = req:<ip>:<uuid>；Cron 清理 >1 天旧记录）。
  const ipRaw = c.req.header("cf-connecting-ip") || "0.0.0.0";
  const ip = (ipRaw.replace(/[^0-9a-fA-F:.]/g, "").slice(0, 45)) || "0.0.0.0"; // 清洗，防 LIKE 通配(%/_)注入
  const ipHourCount = (await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM inbound_throttle WHERE k LIKE ? AND last_at > datetime('now','-1 hour')"
  ).bind(`req:${ip}:%`).first<{ n: number }>())?.n || 0;
  // 硬背底：同 IP ≥30/hr → 该 IP 429 不入库（单 IP flood 本地化；30 远高于真买家，同 NAT 下几个买家也够不到）。
  if (ipHourCount >= 30) return c.json({ error: "too many requests" }, 429);
  // 软限：同 IP ≥10/hr → 该 IP 后续跳过飞书 inboundCard（仍入库、返 ok）；别的 IP 真询盘照常推。
  // IP 轮换仍能绕(已知残留)→ 靠 Turnstile 根治(用户推广前配)；现无流量，per-IP + honeypot 先够。
  const overSoftCap = ipHourCount >= 10;
  await c.env.DB.prepare("INSERT OR IGNORE INTO inbound_throttle (k, last_at) VALUES (?, datetime('now'))").bind(`req:${ip}:${crypto.randomUUID()}`).run();

  // 按邮箱去重 upsert。合规：退订/黑名单/退信/已成交/已忽略 的线索，绝不改 next_action/notes、也不作为"新询盘"推送
  // （否则知道邮箱即可 POST 把已退订/黑名单的人捞回"待跟进"，诱导销售联系→合规雷）。
  const SUPPRESSED_INBOUND = new Set(["unsubscribed", "blacklisted", "bounced", "won", "ignored"]);
  const note = `落地页询盘 | 在哪卖: ${whereSell || "-"} | 月走量: ${volume || "-"}`;
  // 去重取行：邮箱无 UNIQUE 约束、可能有重复行 → 压制态行优先返回，确保下方状态守卫命中（won/ignored 也拦）
  const existing = await c.env.DB.prepare(
    "SELECT id, status FROM leads WHERE lower(email)=? " +
    "ORDER BY CASE WHEN status IN ('unsubscribed','blacklisted','bounced','won','ignored') THEN 0 ELSE 1 END, id LIMIT 1"
  ).bind(email).first<{ id: number; status: string }>();
  let notify = !overSoftCap;   // 超软限：线索照常入库，只是不推飞书（防刷屏）
  if (existing) {
    if (SUPPRESSED_INBOUND.has(existing.status)) {
      notify = false; // 压制态：不改字段、不通知，静默返回 ok（不泄露状态）
    } else {
      await c.env.DB.prepare(
        "UPDATE leads SET next_action='跟进落地页询盘', next_action_date=date('now'), " +
        // notes 追加加长度上限（保留最近 4000 字符，防无限膨胀）
        "notes = substr(COALESCE(notes,'') || char(10) || '[' || datetime('now') || '] ' || ?, -4000), updated_at=datetime('now') WHERE id=?"
      ).bind(note, existing.id).run();
    }
  } else {
    await c.env.DB.prepare(
      "INSERT INTO leads (company_name, email, country, source, status, notes, next_action, next_action_date) " +
      "VALUES (?, ?, ?, 'landing', 'new', ?, '跟进落地页询盘', date('now'))"
    ).bind(company, email, countryDb, note.slice(0, 500)).run();
  }

  // 推飞书（压制态 / 超软限 时跳过；失败不影响入库）
  if (notify) {
    try {
      if (larkConfigured(c.env)) {
        await larkSend(c.env, inboundCard({ company, email, country: country ? COUNTRIES[country] : "-", whereSell, volume, appUrl: c.env.ADMIN_URL || c.env.APP_URL }));
      }
    } catch { /* 通知失败不影响 */ }
  }
  // 🔒 安全：已删除自动确认邮件——公开端点自动发信会被滥用成垃圾邮件炮打死域名声誉。
  //    团队从后台人工回；未来要自动确认须做双重 opt-in（发验证链接、点了才发）。

  return c.json({ ok: true });
});

// ---- 重扫状态（前端进度条轮询它；也是"还没 arm"的判据）----
app.get("/api/rescan/status", async (c) => {
  const startedAt = (await getSetting(c.env, "rescan_started_at", "")).trim();
  const doneAt = (await getSetting(c.env, "rescan_done_at", "")).trim();
  const total = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM leads").first<{ n: number }>())?.n || 0;
  const remaining = startedAt ? await rescanRemaining(c.env, startedAt) : 0;
  // 两组的**真实**条数 —— 确认弹窗要用它说清"会发生什么"。**绝不能在前端写死**：
  // 写死的数字今天恰好对，线索涨到 800 之后那段文案就变成一句谎话。
  const marks = RESCAN_RESET_STATUSES.map(() => "?").join(",");
  const resetGroup = (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM leads WHERE status IN (${marks})`)
    .bind(...RESCAN_RESET_STATUSES).first<{ n: number }>())?.n || 0;
  return c.json({
    armed: !!startedAt, startedAt, doneAt, total, remaining, done: total - remaining,
    resetGroup, refreshGroup: total - resetGroup,
    stats: await rescanStats(c.env),
  });
});

// ---- 开始重扫：重置 + 打时间戳（**这一步会动存量数据**）----
// ⚠️ 打时间戳必须和重置在同一个动作里、且戳在前：rescanTick 靠 `analyzed_at < rescan_started_at`
//    判断"谁还没扫"，戳晚于重置的话，中间被扫过的线索会被判成"已扫"而漏掉。
app.post("/api/rescan/start", async (c) => {
  // 安全闸：自动发送开着时不许开重扫 —— 重置会把 approved 打回 new，重扫过程中它们重新拿到 ≥60
  // 就会被立刻发出去，那正是"按刚被宣布作废的旧流程发信"。
  if ((await getSetting(c.env, "auto_send_enabled", "1")) === "1") {
    return c.json({ error: "请先关闭「自动发送」再开始重扫 —— 否则重扫过程中线索会边打分边被发出去（用的还是半新半旧的标准）" }, 409);
  }
  const startedAt = new Date().toISOString().replace("T", " ").slice(0, 19);
  await setSetting(c.env, "rescan_started_at", startedAt);
  await setSetting(c.env, "rescan_done_at", "");
  // 重置组 → 打回 new、清旧结论、清抓站失败计数（首页超时已从 8s 提到 18s，上次因超时判"抓不到"的这次可能抓得到）。
  // human_approved 一并归零：status 被打回 new = 批准已被撤销；留着 1 会让翻牌堆 UI 显示「已人工放行」
  // 并禁用按钮、反而让 Joe 按不了，而那次放行基于的正是这次要作废的旧证据。
  const marks = RESCAN_RESET_STATUSES.map(() => "?").join(",");
  await c.env.DB.prepare(
    `DELETE FROM lead_analysis WHERE lead_id IN (SELECT id FROM leads WHERE status IN (${marks}))`
  ).bind(...RESCAN_RESET_STATUSES).run();
  const r = await c.env.DB.prepare(
    `UPDATE leads SET status='new', fetch_fail_count=0, human_approved=0, updated_at=datetime('now')
      WHERE status IN (${marks})`
  ).bind(...RESCAN_RESET_STATUSES).run();
  const remaining = await rescanRemaining(c.env, startedAt);
  console.log(`rescan start: 重置 ${r.meta.changes} 条 → new；待重扫 ${remaining} 条`);
  return c.json({ ok: true, startedAt, reset: r.meta.changes || 0, remaining });
});

// ---- 重扫一批（前端自驱循环调它，直到 done）----
app.post("/api/rescan/batch", async (c) => {
  const b = await c.req.json<{ limit?: number }>().catch(() => ({}));
  const limit = Math.min(Math.max(Number(b.limit) || 10, 1), RESCAN_MAX_PER_CALL);
  const startedAt = (await getSetting(c.env, "rescan_started_at", "")).trim();
  if (!startedAt) return c.json({ error: "还没开始重扫（先点「重扫全部」）" }, 409);

  const batch = (await c.env.DB.prepare(
    `SELECT l.* FROM leads l LEFT JOIN lead_analysis a ON a.lead_id = l.id
      WHERE (a.lead_id IS NULL OR a.analyzed_at IS NULL OR a.analyzed_at < ?)
      ORDER BY l.id ASC LIMIT ?`
  ).bind(startedAt, limit).all()).results as any[];

  if (!batch.length) {
    // 收尾：统计 + 推飞书 + 记完成（幂等：rescan_done_at 已写就不再推）
    const stats = await rescanStats(c.env);
    if (!(await getSetting(c.env, "rescan_done_at", "")).trim()) {
      await setSetting(c.env, "rescan_done_at", new Date().toISOString().replace("T", " ").slice(0, 19));
      console.log(`rescan done: ≥${APPROVE_MIN_SCORE}=${stats.hi} <${APPROVE_MIN_SCORE}=${stats.lo} 抓不到=${stats.nil}`);
      try {
        if (larkConfigured(c.env)) {
          await larkSend(c.env, { msg_type: "text", content: { text:
            `TEJOY ✅ 全量重扫完成\n` +
            `· ${stats.hi} 家 ≥${APPROVE_MIN_SCORE}（自动通道）\n` +
            `· ${stats.lo} 家 <${APPROVE_MIN_SCORE}（翻牌堆待复核）\n` +
            `· ${stats.nil} 家 官网抓不到（未打分，不是不合格）\n\n` +
            `全部按最终标准重打完毕。自动发送仍是关闭状态 —— 要不要重开由 Joe 决定。` } });
        }
      } catch (e) { console.error("rescan-digest:", e); }
    }
    return c.json({ done: true, processed: 0, remaining: 0, stats });
  }

  let ok = 0, fetchFail = 0, hardFail = 0;
  for (const lead of batch) {
    // 只刷新组：status 不在重置名单里 → 只要新分数+新证据，不重写草稿（那封信已经发出去了）
    const scoreOnly = !RESCAN_RESET_STATUSES.includes(String(lead.status));
    try {
      // rescan:true 让 recordFetchFailure 的"别抹掉真分数"守卫让路 —— 重扫时旧分数已被宣布作废，
      // 抓不到就该诚实记成「官网抓不到·无法判断」，而不是留个作废标准的分数；
      // 且不让路会导致这条线索每次被重取、重扫永不完成（见 service.ts 那段注释）。
      const out = await analyzeLead(c.env, lead, { scoreOnly, rescan: true });   // OpenRouter 串行：for 里 await
      if (out.ok) ok++;
      else if (out.fetchFailed) fetchFail++;
      else hardFail++;
    } catch (e) { hardFail++; console.error("rescan:", lead.id, e); }
  }
  const remaining = await rescanRemaining(c.env, startedAt);
  console.log(`rescan batch: ok=${ok} 抓不到=${fetchFail} 失败=${hardFail} 剩余=${remaining}`);
  return c.json({ done: false, processed: batch.length, ok, fetchFail, hardFail, remaining, stats: await rescanStats(c.env) });
});

// ---- 非 /api 请求交给静态资源（后台前端）----
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

// ============ 批⑥A 全量重扫 ============
//
// 背景：这几天标准被重定了（H3-v2 去掉体量闸 + 来源背书 + 首页 18s 超时 + 证据页优先），
// 库里 433 家的分数是新旧标准的混合物 —— 一个混合物做不了任何决策。Joe 要求全部按最终标准重打。
//
// ⭐ 设计的三个关键点：
//
// 1) **走交互式批量通道，不走 cron**（Joe 驳回了我第一版的 cron 方案）。
//    他的标准："如果每天只能分析30-50个信息，我压根都不需要用AI了。" ——
//    cron 的 12 条/班是**无人值守后台**的保守值，拿它跑一次性批量任务是思维惯性错误。
//    通道容量早已被证明：Joe 手点「批量分析」一小时扫了两百多条。
//    所以重扫复用同一条通道（后台按钮 + 前端自驱循环，每批 ≤20 串行），428 条**当天跑完**。
//    → cron 那班一个字没动，Serper 烧钱速率自然也没动（重扫压根不经过 cron）。
//
// 2) **只刷新组安全的依据是 analyzeLead 的既有性质**，不是我新写的判断：
//    它推进 status 的那条 SQL 带 `AND status='new'` —— 一条 sent/replied/ignored 的线索走完
//    analyzeLead，analysis 换新、status 纹丝不动、更不可能触发发信（发信在 sendApprovedBatch 里，
//    这条路根本不经过它）。所以两组共用一个函数，只用 scoreOnly 区分要不要重写草稿。
//
// 3) **进度靠 DB 状态推导，不靠内存**：谁没扫 = `analysis 缺失 或 analyzed_at < rescan_started_at`。
//    这让整件事**天然可断点续跑** —— 浏览器关了/网断了/中途叫停，再点一次就从断点继续，
//    不需要任何"任务进度"表。
// 重置组：这些状态的线索会被打回 new 重新分档；其余状态只刷新 analysis、status 不动
const RESCAN_RESET_STATUSES = ["new", "analyzed", "approved", "queued", "pending"];
const RESCAN_MAX_PER_CALL = 20;   // 单次调用上限（与既有 /api/analyze/batch 的 20 一致 —— 那条通道 Joe 手点实测过）

/** 还有几条没重扫（analysis 缺失 或 analyzed_at 早于本轮重扫开始时间） */
async function rescanRemaining(env: Env, startedAt: string): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM leads l LEFT JOIN lead_analysis a ON a.lead_id = l.id
      WHERE a.lead_id IS NULL OR a.analyzed_at IS NULL OR a.analyzed_at < ?`
  ).bind(startedAt).first<{ n: number }>();
  return r?.n ?? 0;
}

/** 重扫的分档统计（完成播报 + 进度条都用它） */
async function rescanStats(env: Env): Promise<{ hi: number; lo: number; nil: number }> {
  const s = await env.DB.prepare(
    `SELECT SUM(CASE WHEN a.match_score >= ${APPROVE_MIN_SCORE} THEN 1 ELSE 0 END) AS hi,
            SUM(CASE WHEN a.match_score IS NOT NULL AND a.match_score < ${APPROVE_MIN_SCORE} THEN 1 ELSE 0 END) AS lo,
            SUM(CASE WHEN a.match_score IS NULL THEN 1 ELSE 0 END) AS nil
       FROM leads l JOIN lead_analysis a ON a.lead_id = l.id`
  ).first<{ hi: number; lo: number; nil: number }>();
  return { hi: s?.hi ?? 0, lo: s?.lo ?? 0, nil: s?.nil ?? 0 };
}

// Cron 定时任务：自动找客户 + 自动分析新线索（7×24 运行）
async function scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  // ⚠️ 全量重扫**不在这里** —— 它走交互式批量通道（/api/rescan/*，后台按钮驱动）。
  //    cron 这 12 条/班是**日常新增线索**的节奏；拿它跑一次性批量任务要 9 天，
  //    而 Joe 的标准是"428 条当天跑完"。两件事，两条通道，互不干扰。
  let inserted = 0, analyzed = 0, replies = 0, autoApproved = 0, autoSent = 0;

  // 1) 搜索找新客户（每关键词 5 条，控制用量）—— #S1 受 discovery_enabled 开关控制（默认关，防 cron 每 6h 全量烧 Serper 积分）
  try {
    if ((await getSetting(env, "discovery_enabled", "0")) === "1") {
      const d = await runDiscovery(env, { perKeyword: 5, maxCombos: 20 });   // P0-b 每轮只跑 20 组合(轮转)，不再全量 572；P0-c 预算内
      inserted = d.inserted;
    } else { console.log("discovery skipped: discovery_enabled=0"); }
  } catch (e) { console.error("discover:", e); }
  // 1.5) 队列⑦ 免费目录源每周自动刷新（NMEA + rvwithtito）——**零 Serper**，与上面的付费搜索开关无关。
  //      内部自判 >7 天才真跑、遵守 Crawl-delay 10 与礼貌 UA；抓到的新公司走同一条去重+分析管道（下面第 2 步会打分）。
  try {
    const dr = await runDirectoryRefresh(env);
    if (dr.ran) { inserted += dr.inserted; console.log(`directory refresh: +${dr.inserted}`, dr.detail); }
    else console.log("directory refresh skipped:", dr.reason);
  } catch (e) { console.error("dir-refresh:", e); }
  // 2) 分析未处理的新线索：循环分析到无 new 或达安全上限（Free 子请求预算保守，逐条 try/catch）。
  //    成功→status 转 analyzed→下批取到新的；本批全失败(多为持久问题:模型/网络)→停，别空转浪费子请求。
  const CRON_ANALYZE_MAX = 12; // 单轮最多分析条数（~8-12 安全区，别在一次 Cron 抽干 100+）
  let attempts = 0;
  let fetchSkipped = 0;
  // ⭐ 本轮已试过的 id 必须排除掉。抓站失败的线索**故意留在 status='new'**（等下一轮 cron 重试），
  //    而本 while 每批都按 `status='new' ORDER BY id ASC` 重取 —— 不排除的话同一批抓不到的线索
  //    会在**同一轮里**被反复取到，几个来回就把 fetch_fail_count 的 3 次上限烧穿，
  //    "留着下轮重试"直接变成"一轮内判死"，比不修还糟。
  const tried = new Set<number>();
  while (attempts < CRON_ANALYZE_MAX) {
    let batch: any[] = [];
    try {
      const take = Math.min(8, CRON_ANALYZE_MAX - attempts);
      const skip = [...tried];
      const rows = await env.DB.prepare(
        skip.length
          ? `SELECT * FROM leads WHERE status='new' AND id NOT IN (${skip.map(() => "?").join(",")}) ORDER BY id ASC LIMIT ?`
          : "SELECT * FROM leads WHERE status='new' ORDER BY id ASC LIMIT ?"
      ).bind(...skip, take).all();
      batch = rows.results as any[];
    } catch (e) { console.error("analyze-fetch:", e); break; }
    if (!batch.length) break;
    let okThisBatch = 0, hardFail = 0;
    for (const lead of batch) {
      attempts++; tried.add(Number(lead.id));
      try {
        const out = await analyzeLead(env, lead);
        if (out.ok) {
          analyzed++; okThisBatch++;
        } else if (out.fetchFailed) {
          // 抓不到是**这个站**的问题（限流/挂了/拦 UA），不是模型挂了 → 跳过继续，别拖累整轮
          fetchSkipped++;
          console.log(`analyze skip(fetch): #${lead.id} ${lead.website || ""} ${out.error || ""}`);
        } else {
          hardFail++; // 模型/DB 失败 → 多半是持久问题（OpenRouter 挂、额度尽）
        }
      } catch (e) { hardFail++; console.error("analyze:", lead.id, e); }
    }
    // 只有「真失败」（模型/DB）且本批零成功才停 —— 那多半是 OpenRouter 挂了，继续只是空转烧子请求。
    // 全是抓站失败 → **继续下一批**：它们已进 tried 不会被重取，后面的正常线索不该被这几条卡死。
    if (okThisBatch === 0 && hardFail > 0) break;
  }
  if (fetchSkipped) console.log(`analyze: ${fetchSkipped} 条因官网抓不到跳过（未打分，等下轮重试）`);

  // 2.5) 自动批准：≥auto_approve_min（默认 60）且有邮箱 → approved。
  //  · 两档制：60 是唯一决策线，≥60 走自动通道、<60 进翻牌堆由 Joe 复核。60-69 拍板区已取消。
  //  · **走 approveGateReason 那条既有护栏**，不另开判断口子 —— 它管着"有邮箱+已打分+≥60"。
  //  · <60 → **不动**：进翻牌堆等 Joe 复核，绝不替他做销毁性决定。
  try {
    if ((await getSetting(env, "auto_approve_enabled", "1")) === "1") {
      const autoMin = await getAutoApproveMin(env);
      const cands = (await env.DB.prepare(
        `SELECT l.id, l.email, a.match_score FROM leads l JOIN lead_analysis a ON a.lead_id=l.id
          WHERE l.status='analyzed' AND a.match_score >= ? AND l.email IS NOT NULL AND l.email != ''
          ORDER BY a.match_score DESC, l.id ASC LIMIT 50`
      ).bind(autoMin).all()).results as any[];
      for (const c of cands) {
        // 同一条护栏：任何一项不过（缺邮箱/未打分/<60）都不批准，理由照打
        const why = approveGateReason(c.email, c.match_score ?? null);
        if (why) { console.log(`auto-approve skip #${c.id}: ${why}`); continue; }
        const r = await env.DB.prepare(
          "UPDATE leads SET status='approved', updated_at=datetime('now') WHERE id=? AND status='analyzed'"
        ).bind(c.id).run();
        if (r.meta.changes === 1) autoApproved++;
      }
      if (autoApproved) console.log(`auto-approve: ${autoApproved} 条 ≥${autoMin}分有邮箱 → 待发送`);
    } else console.log("auto-approve skipped: auto_approve_enabled=0");
  } catch (e) { console.error("auto-approve:", e); }

  // 2.6) 熔断检查 → 自动发送。**熔断必须在发送之前**：先看伤口再决定要不要继续开枪。
  try {
    const br = await getBreakerStatus(env);
    if (br.shouldTrip && (await getSetting(env, "auto_send_enabled", "1")) === "1") {
      // 只熔断自动发送：auto_approve 继续跑、手动发送不受影响。熔断后**不自动恢复**，必须 Joe 手动开——
      // 自动恢复会退化成"烧一轮停一下再烧一轮"。
      await setSetting(env, "auto_send_enabled", "0");
      await setSetting(env, "auto_send_tripped_at", new Date().toISOString());
      await setSetting(env, "auto_send_trip_reason", `最近 ${br.window} 封自动开发信里 ${br.unsubs} 封退订 = ${(br.rate * 100).toFixed(1)}%`);
      console.error(`⚠️ 熔断：${br.unsubs}/${br.window} = ${(br.rate * 100).toFixed(1)}% ≥ 15% → auto_send_enabled=0`);
      try {
        if (larkConfigured(env)) {
          await larkSend(env, { msg_type: "text", content: { text:
            `TEJOY ⚠️ 自动发送已熔断\n最近 ${br.window} 封自动开发信里 ${br.unsubs} 封退订 = ${(br.rate * 100).toFixed(1)}%（阈值 15%）。\n` +
            `已自动停止**自动发送**；自动批准与手动发送不受影响。\n请检查线索来源与开发信内容，确认后到后台手动重开（不会自动恢复）。` } });
        }
      } catch { /* 通知失败不影响熔断本身 */ }
    }
    const autoOn = (await getSetting(env, "auto_send_enabled", "1")) === "1";
    if (!autoOn) {
      console.log("auto-send skipped: auto_send_enabled=0" + (br.shouldTrip ? "（本轮刚熔断）" : ""));
    } else {
      // 自动这条路自己的每日上限（默认 15，**不复用手动的 daily_send_limit=50**）。
      // 全局 50 的总闸由 sendApprovedBatch 内的 sentToday() 统一把守 —— 两个上限取更紧的那个，
      // 结构上不可能突破 50。详见 send.ts sendApprovedBatch 的注释。
      const autoLimit = Number(await getSetting(env, "auto_send_daily_limit", "15")) || 15;
      const autoRoom = Math.max(0, autoLimit - (await autoSentToday(env)));
      const take = Math.min(autoRoom, 5); // 每轮最多 5 封，摊到 4 次 cron，别一轮打光
      if (take > 0) {
        const r = await sendApprovedBatch(env, take, undefined, true);  // ← 同一条 sendApprovedBatch，autoSent=true
        autoSent = r.sent;
        if (autoSent) console.log(`auto-send: 发出 ${autoSent} 封（今日自动上限 ${autoLimit}，全局 ${r.dailyLimit}，今日已发 ${r.sentToday}）`);
      } else console.log(`auto-send: 今日自动额度已用尽（${autoLimit}/天）`);
    }
  } catch (e) { console.error("auto-send:", e); }

  // 3) 拉取并处理客户回复（P4；热回复会在 ingestReplies 内实时推飞书）
  try { if (env.LARK_IMAP_PASS) { const r = await ingestReplies(env); replies = r.ingested || 0; } } catch (e) { console.error("replies:", e); }
  // 3.5) 无回复自动跟进（仅当开关开启；每轮最多 5 封，遵守每日上限）
  try { await sendFollowupBatch(env, 5); } catch (e) { console.error("followup:", e); }
  // 3.6) 关键词优化：按真实回复率重算权重（放发送/回复之后，让新数据参与本轮加权）
  try { await recomputeKeywordStats(env); } catch (e) { console.error("kwstats:", e); }
  // 3.7) 清理落地页频率限制表（>1 天的旧记录，防膨胀）
  try { await env.DB.prepare("DELETE FROM inbound_throttle WHERE last_at < datetime('now','-1 day')").run(); } catch (e) { console.error("throttle-cleanup:", e); }

  // 4) 6 小时简报推飞书（配了 webhook + 未关闭 + 本轮有动静才推）
  //    两档制：简报报"机器干了什么"（自动批准/自动发信）+"有没有需要你的事"（翻牌堆积压），
  //    不再列「高分客户」——那个清单在自动通道下没有动作含义。
  try {
    if (larkConfigured(env) && (await getSetting(env, "notify_enabled", "1")) !== "0" && (inserted || analyzed || replies || autoApproved || autoSent)) {
      let needYou = 0;
      try {
        needYou = (await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM leads l JOIN lead_analysis a ON a.lead_id=l.id
            WHERE l.status IN ('analyzed','pending') AND a.match_score IS NOT NULL AND a.match_score < ${APPROVE_MIN_SCORE}`
        ).first<{ n: number }>())?.n || 0;
      } catch (e) { console.error("digest-needyou:", e); }
      await larkSend(env, digestCard({ inserted, analyzed, replies, autoApproved, autoSent, needYou, appUrl: env.ADMIN_URL || env.APP_URL }));
    }
  } catch (e) { console.error("digest:", e); }
}

export default { fetch: app.fetch, scheduled };
