// 最小 IMAP 客户端（Cloudflare Workers via cloudflare:sockets）
// 只做我们需要的：LOGIN → SELECT INBOX → UID SEARCH → UID FETCH BODY.PEEK[]
import { connect } from "cloudflare:sockets";
import type { Env } from "./index";
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

const IMAP_SESSION_TIMEOUT_MS = 25000; // M2：整个 IMAP 会话总超时，防止无限阻塞拖垮 Cron

export interface FetchResult {
  maxUid: number;          // 邮箱内全体最大 UID（首次基线用它）
  processedMaxUid: number; // M1：本批实际"尝试处理到"的最大 UID —— 游标只推进到这里，避免跳过第 31+ 封
  attempted: number;       // 本批尝试处理的新 UID 数（== IMAP_BATCH 时代表可能还有更多，需继续抽干）
  messages: { uid: number; raw: Uint8Array }[];
}

// 连接 Lark IMAP，拉取 UID > sinceUid 的新邮件（首次 sinceUid<=0 时只取基线不回填）。
// M2：整个会话被 IMAP_SESSION_TIMEOUT_MS 总超时兜住，超时抛错，由上层 try/catch 兜住不拖垮 Cron。
export async function fetchNewMessages(env: Env, sinceUid: number, maxCount = IMAP_BATCH): Promise<FetchResult> {
  const host = env.LARK_IMAP_HOST || "imap.larksuite.com";
  const port = Number(env.LARK_IMAP_PORT) || 993;
  const user = env.LARK_IMAP_USER || env.SENDER_EMAIL || "hello@tejoy.net";
  const pass = env.LARK_IMAP_PASS;
  if (!pass) throw new Error("缺少 LARK_IMAP_PASS（Lark 公共邮箱的 IMAP 应用密码）");

  const socket = connect({ hostname: host, port }, { secureTransport: "on", allowHalfOpen: false });
  const wr = socket.writable.getWriter();
  const rd = new Reader(socket.readable.getReader());

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`IMAP 会话超时（>${IMAP_SESSION_TIMEOUT_MS / 1000}s）`)), IMAP_SESSION_TIMEOUT_MS);
  });

  const session = async (): Promise<FetchResult> => {
    await rd.readLine(); // 服务器问候 * OK ...
    const login = await runCmd(rd, wr, "a1", `LOGIN ${q(user)} ${q(pass)}`);
    if (login.status !== "OK") throw new Error("IMAP 登录失败：" + login.lines.slice(-1)[0]);

    await runCmd(rd, wr, "a2", "SELECT INBOX");

    const search = await runCmd(rd, wr, "a3", "UID SEARCH ALL");
    const searchLine = search.lines.find((l) => /^\* SEARCH/i.test(l)) || "";
    const allUids = (searchLine.replace(/^\* SEARCH/i, "").trim().match(/\d+/g) || []).map(Number);
    const { newUids, attempted, processedMaxUid, maxUid } = computeBatch(allUids, sinceUid, maxCount);

    // 首次运行（无基线）：只记录基线，不回填历史邮件
    if (sinceUid <= 0) {
      await runCmd(rd, wr, "a9", "LOGOUT").catch(() => {});
      return { maxUid, processedMaxUid: maxUid, attempted: 0, messages: [] };
    }

    const messages: { uid: number; raw: Uint8Array }[] = [];
    for (let i = 0; i < newUids.length; i++) {
      const uid = newUids[i];
      const f = await runCmd(rd, wr, "b" + i, `UID FETCH ${uid} (BODY.PEEK[])`);
      if (f.literals.length) messages.push({ uid, raw: f.literals[0] });
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
