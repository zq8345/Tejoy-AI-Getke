// 最小 IMAP 客户端（Cloudflare Workers via cloudflare:sockets）
// 只做我们需要的：LOGIN → SELECT INBOX → UID SEARCH → UID FETCH BODY.PEEK[]
import { connect } from "cloudflare:sockets";
import type { Env } from "./index";
import { assertEgressAllowed } from "./devguard";
import { IMAP_BATCH, computeBatch } from "./imap-batch";
export { IMAP_BATCH, computeBatch } from "./imap-batch";

const enc = new TextEncoder();
const dec = new TextDecoder();

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}

// 带缓冲的流读取器：支持按行读 + 按字节数读（IMAP literal）
class Reader {
  private buf = new Uint8Array(0);
  constructor(private r: ReadableStreamDefaultReader<Uint8Array>) {}
  private async fill(): Promise<boolean> {
    const { value, done } = await this.r.read();
    if (done || !value) return false;
    this.buf = concat(this.buf, value);
    return true;
  }
  async readLine(): Promise<string | null> {
    while (true) {
      const i = this.buf.indexOf(0x0a);
      if (i >= 0) {
        const line = this.buf.slice(0, i + 1);
        this.buf = this.buf.slice(i + 1);
        return dec.decode(line).replace(/\r?\n$/, "");
      }
      if (!(await this.fill())) {
        if (this.buf.length) { const l = dec.decode(this.buf); this.buf = new Uint8Array(0); return l; }
        return null;
      }
    }
  }
  async readN(n: number): Promise<Uint8Array> {
    while (this.buf.length < n) { if (!(await this.fill())) break; }
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return out;
  }
}

interface CmdResult { status: string; lines: string[]; literals: Uint8Array[] }

async function runCmd(rd: Reader, wr: WritableStreamDefaultWriter<Uint8Array>, tag: string, cmd: string): Promise<CmdResult> {
  await wr.write(enc.encode(`${tag} ${cmd}\r\n`));
  const lines: string[] = [];
  const literals: Uint8Array[] = [];
  while (true) {
    const line = await rd.readLine();
    if (line === null) throw new Error("IMAP 连接中断");
    const m = line.match(/\{(\d+)\+?\}$/); // 行尾 literal {n}
    if (m) {
      lines.push(line);
      literals.push(await rd.readN(Number(m[1])));
      continue; // literal 之后继续读同一响应的后续行
    }
    lines.push(line);
    if (line.startsWith(tag + " ")) {
      const status = line.slice(tag.length + 1).split(" ")[0]; // OK / NO / BAD
      return { status, lines, literals };
    }
  }
}

function q(s: string): string { return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`; }

// ⭐ 批⑧ Bug1 根因：**这个数和 IMAP_BATCH(30) 在数学上不可能同时成立** —— 收回复因此静默断了。
//
// 2026-07-16 对真邮箱实测的分段耗时：
//   连接+登录+SELECT+SEARCH = 3.9s（不慢）
//   **每封 UID FETCH ≈ 4.4s** —— 逐封一个来回，慢的是往返次数不是传输量
//   → 3 封就 17.7s；连跑三次：23.8s ✓ / **25.3s ✗超时** / 21.7s ✓ —— **贴着 25s 线掷硬币**
//   → 而 IMAP_BATCH=30 意味着单次会话要 30×4.4+3.9 ≈ **136 秒**：
//     **只要积压 6 封以上，这条链 100% 失败**，且失败完全静默（见 replies.ts 里 r.error 那段）。
//
// 两处一起改才有意义：
//   1. 下面的 UID FETCH 改成**一个命令取完整批**（一次往返）—— 这是根治，不是调参
//   2. 超时给足：收回复是整条链上最值钱的一步（一个真客户回信 > 分析 12 条新线索），
//      不该为了"别拖垮 cron"把它掐死；何况它已挪到 cron 最前面（index.ts step 0）。
const IMAP_SESSION_TIMEOUT_MS = 90000;
//
// ⭐ P0-1 追加：**这个 90s 是"Joe 手点拉取"的值，不是 cron 的值。**
//    cron 一轮总共只有 15 分钟，收回复排在 step 0 —— 它慢一分半，后面发信就少发两三封。
//    所以 cron 传 REPLY_CRON_TIMEOUT_MS(25s) 进来，Joe 手点走默认 90s（他自己在屏幕前等，等得起）。
//    25s 够不够？批⑧ 把逐封 FETCH 改成一条命令取整批后，**实测整个会话 7.9s** —— 25s 有 3 倍余量。
//    真超了也不要紧：imap_last_uid 游标天然可续，下一班（现在只隔 1 小时，不是 6 小时）接着收。
export const REPLY_CRON_TIMEOUT_MS = 25000;

export interface FetchResult {
  maxUid: number;          // 邮箱内全体最大 UID（首次基线用它）
  processedMaxUid: number; // M1：本批实际"尝试处理到"的最大 UID —— 游标只推进到这里，避免跳过第 31+ 封
  attempted: number;       // 本批尝试处理的新 UID 数（== IMAP_BATCH 时代表可能还有更多，需继续抽干）
  messages: { uid: number; raw: Uint8Array }[];
}

// 连接 Lark IMAP，拉取 UID > sinceUid 的新邮件（首次 sinceUid<=0 时只取基线不回填）。
// M2：整个会话被 IMAP_SESSION_TIMEOUT_MS 总超时兜住，超时抛错，由上层 try/catch 兜住不拖垮 Cron。
export async function fetchNewMessages(env: Env, sinceUid: number, maxCount = IMAP_BATCH, timeoutMs = IMAP_SESSION_TIMEOUT_MS): Promise<FetchResult> {
  const host = env.LARK_IMAP_HOST || "imap.larksuite.com";
  const port = Number(env.LARK_IMAP_PORT) || 993;
  const user = env.LARK_IMAP_USER || env.SENDER_EMAIL || "hello@tejoy.net";
  const pass = env.LARK_IMAP_PASS;
  if (!pass) throw new Error("缺少 LARK_IMAP_PASS（Lark 公共邮箱的 IMAP 应用密码）");

  // ⚠️ IMAP 走 cloudflare:sockets 的 connect()，**不经过 fetch** —— 全局闸门包不住它，
  //    所以这里单独问一句。③ 号事故（本地连真 IMAP 拉到客户真信）走的正是这条路。
  assertEgressAllowed(env, host, "IMAP connect");
  const socket = connect({ hostname: host, port }, { secureTransport: "on", allowHalfOpen: false });
  const wr = socket.writable.getWriter();
  const rd = new Reader(socket.readable.getReader());

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`IMAP 会话超时（>${timeoutMs / 1000}s）`)), timeoutMs);
  });

  const session = async (): Promise<FetchResult> => {
    await rd.readLine(); // 服务器问候 * OK ...
    const login = await runCmd(rd, wr, "a1", `LOGIN ${q(user)} ${q(pass)}`);
    if (login.status !== "OK") throw new Error("IMAP 登录失败：" + login.lines.slice(-1)[0]);

    // ⚠️ 这两条命令的 status 以前**没人看** —— 这是批⑧ 我只堵了一半的那个洞。
    //    SELECT/SEARCH 返回 NO/BAD（邮箱被锁、被限流、权限变了）时代码照样往下走，
    //    最后得到 allUids=[] → "没有新邮件" → **返回成功、不报错、不告警**。
    //    跟批⑧ 修掉的 FETCH 那个病一模一样：我给 FETCH 加了响铃，漏了这里。
    const sel = await runCmd(rd, wr, "a2", "SELECT INBOX");
    if (sel.status !== "OK") throw new Error("IMAP SELECT INBOX 失败：" + sel.lines.slice(-1)[0]);

    const search = await runCmd(rd, wr, "a3", "UID SEARCH ALL");
    if (search.status !== "OK") throw new Error("IMAP UID SEARCH 失败：" + search.lines.slice(-1)[0]);

    // ⭐ **"真的没新邮件" 和 "响应解析不出来" 必须区分开** —— 它俩以前长得一模一样（都是 allUids=[]）。
    //    · 邮箱是空的：服务器**仍会**回一行 `* SEARCH`（后面没数字）→ 正常，不报错
    //    · 一行 `* SEARCH` 都没有：格式变了 / 回了我们不认识的东西（如 ESEARCH 走 `* ESEARCH`）
    //      → **解析器坏了**，不是"没有新邮件"。必须响，否则又是"静默断了不知道多久"。
    const searchLine = search.lines.find((l) => /^\* SEARCH/i.test(l));
    if (searchLine === undefined) {
      throw new Error(
        `IMAP SEARCH 解析失败：命令返回 OK 但一行 * SEARCH 都没有（服务器响应格式可能变了）。` +
        `响应=${search.lines.slice(0, 3).join(" | ").slice(0, 200)}`
      );
    }
    const allUids = (searchLine.replace(/^\* SEARCH/i, "").trim().match(/\d+/g) || []).map(Number);
    const { newUids, attempted, processedMaxUid, maxUid } = computeBatch(allUids, sinceUid, maxCount);

    // 首次运行（无基线）：只记录基线，不回填历史邮件
    if (sinceUid <= 0) {
      await runCmd(rd, wr, "a9", "LOGOUT").catch(() => {});
      return { maxUid, processedMaxUid: maxUid, attempted: 0, messages: [] };
    }

    // ⭐ 批⑧ Bug1 根治：**一个命令取完整批**，不再逐封往返。
    //   实测每封往返 ≈4.4s，而慢的是往返次数不是传输量 —— 30 封逐封要 132s（必然超时），
    //   合成一条 `UID FETCH 3,4,5 (BODY.PEEK[])` 只花一个来回。
    //   runCmd 本来就把一次响应里的多个 literal 都收进 literals[]，所以它天然支持多封。
    const messages: { uid: number; raw: Uint8Array }[] = [];
    if (newUids.length) {
      const f = await runCmd(rd, wr, "b0", `UID FETCH ${newUids.join(",")} (BODY.PEEK[])`);
      // 从响应行里**读出** UID，而不是假设"返回顺序 == 我们给的顺序"：
      // 服务器没义务按序返回，被删/取不到的 UID 会直接缺席 —— 按位置配会**整体错位**
      // （把 A 的正文安到 B 头上，等于把 A 的回复算成 B 回了你）。
      let li = 0;
      for (let i = 0; i < f.lines.length; i++) {
        const line = f.lines[i];
        if (!/\{\d+\+?\}\s*$/.test(line)) continue;   // 不是"后面跟着 literal"的那种行
        const raw = f.literals[li++];
        if (!raw) continue;
        // ⚠️ UID 的位置**两种形态都存在**，实测踩过：
        //   A：`* 3 FETCH (UID 3 BODY[] {9069}`        ← UID 在同一行
        //   B：`* 3 FETCH (BODY[] {9069}` … ` UID 3)`  ← UID 在 **literal 之后的下一行**
        //   **Lark 走的是 B。** 我第一版只认 A → 一封都配不上 → fetched=0 →
        //   跟原来那个病一模一样（静默地一封都收不到）。两种都认。
        //   绝不拿 `* 3` 里那个数字兜底：那是**序号(seq)不是 UID**，用它会整体错位。
        const um = line.match(/UID\s+(\d+)/i) || (f.lines[i + 1] || "").match(/UID\s+(\d+)/i);
        if (um) messages.push({ uid: Number(um[1]), raw });
        else console.error(`IMAP: 取到正文但读不出 UID，跳过。行=${line.slice(0, 80)}`);
      }
      // ⚠️ 拿到了正文却一个 UID 都配不出 = **解析器坏了**，不是"没有新邮件"。
      //    这两件事在旧代码里长得一模一样（都是 messages=[]）→ 必须让它响，
      //    否则又是一次"静默断了不知道多久"。
      if (f.literals.length && !messages.length) {
        throw new Error(`IMAP 解析失败：取到 ${f.literals.length} 封正文但一个 UID 都读不出（服务器响应格式可能变了）`);
      }
      // ⭐⭐ 2026-07-17 生产实证暴露的洞（批⑧ 我只堵了上面那一半）：
      //    **FETCH 一个 literal 都没返回**时，上面那句的 `f.literals.length` 是 0 → 不触发 →
      //    messages=[] → 无错、无告警，而 computeBatch 的 processedMaxUid 已经 = 本批最大 UID
      //    → **游标照样推进，这批信被永久跳过。**
      //    生产上就这么发生了：游标从 2 跳到 5、`replies` 仍是 0 —— 3 封信（很可能包含
      //    Michael 那封真客户回信）**被无声地跨过去了**。
      //
      //    M1 那条"尝试过就算已处理"的原意是对的（防被删的 UID 让下轮无限重试），
      //    但它和"整批 FETCH 失败"长得一模一样。区分标准：
      //      · **一部分**取到了 → 剩下的多半是真被删了 → 照常推进（M1 原意）
      //      · **一封都没取到**（而 SEARCH 明明说有）→ 这不是"都被删了"，是**这次 FETCH 整个失败了**
      //        → throw。抛出去游标就不会推进（下面的 return 到不了），下一班原地重试。
      //
      //    ⚠️ **这个修法有代价，写清楚不藏着**：如果一批里的信**真的全被删了**，
      //       游标会卡住、每班重试、每天吼一条飞书 —— 那正是 M1 当初要防的无限重试。
      //       我仍然认为这个取舍是对的：
      //         **卡住 + 吼**（有人会看见、手动推一下游标就好）
      //         ≫ **静默永久丢一个真客户的回信**（没人会知道，永远找不回来）。
      //       Joe 现在每一封真实回复都是钱。宁可我们被吵，也不能让它无声消失。
      if (newUids.length && !messages.length) {
        throw new Error(
          `IMAP FETCH 失败：SEARCH 说有 ${newUids.length} 封新邮件（UID ${newUids.join(",")}），` +
          `但一封正文都没取到。**游标不推进**，下一班重试 —— 推进的话这些信就被永久跳过了。` +
          `（若确认这些 UID 是真被删了，手动把 imap_last_uid 推到 ${newUids[newUids.length - 1]} 即可解卡。）`
        );
      }
    }

    await runCmd(rd, wr, "a9", "LOGOUT").catch(() => {});
    return { maxUid, processedMaxUid, attempted, messages };
  };

  try {
    return await Promise.race([session(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    try { await wr.close(); } catch {}
    try { socket.close(); } catch {}
  }
}
