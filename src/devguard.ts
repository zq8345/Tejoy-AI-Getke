// ============================================================================
// dev 出站闸门 —— 本地进程不许碰真实第三方
// ============================================================================
//
// 为什么有这个文件（三次事故，同一个形状）：
//   ① 测发信 → 真发出 2 封到 x.com（我以为是不存在的域，其实是 X 的真域名，有正经 MX）
//   ② 清 directory_last_refresh → 真抓了一次 nmea.org
//   ③ 本地测批⑧ → 连真 IMAP 拉到客户真信 → 推了两条到 **Joe 的真飞书群**
//
// 三次的根因是同一个：**dev 进程对真实第三方发了一次真实出站调用**，
// 而我每次都是**事后**才发现"我以为它是隔离的"。
//
// 所以这里不在飞书/IMAP/目录抓取上各加一道 if —— 那样第五个我没想到的面
// 照样会咬第四次，而这三次**恰恰每次都是我没想到的那个面**。
// 往上收敛：**整个 Worker 的出站只有两个口子** —— fetch 和 IMAP 的 connect。守这两个。
//
// 规则（dev 生效时）：**只准出到 localhost，其余一律拒**。
// 想打真实主机？必须在 .dev.vars 里**逐个主机点名** DEV_EGRESS_ALLOW=imap.larksuite.com
// —— 让"我要碰真东西"变成一个**必须明写、且会打横幅**的动作，而不是默认行为。
//
// ⚠️ 生产零影响：闸门只在 DEV_LOCAL=1 时装，而 DEV_LOCAL **只存在于 .dev.vars**
//    （wrangler dev 才读的文件，生产 secrets 里没有）。生产不装闸门 = 行为一个字节不变。
//    我**故意没做成"默认拦、生产要显式解锁"**：那样总工哪天忘了设变量，生产就会
//    **全静默**（不发信、不推飞书、不调 AI）—— 那正是批⑧刚修掉的那种病，
//    拿它换我的测试安全不划算。这个取舍写在这里，不藏着。
//
// 这是**第二层**。第一层是：本地 .dev.vars 里**根本不该有**真实副作用目标
// （Joe 的群地址、真 IMAP 密码）。两层互不依赖，都不靠我记性。

export const BUILD_MARKER = "batch8-devguard";
let installed = false;

function hostOf(u: string): string {
  try { return new URL(u).hostname.toLowerCase(); } catch { return ""; }
}

function isLocal(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "[::1]";
}

/** .dev.vars 里点名放行的主机（逗号分隔）。空 = 一个真实主机都不许碰。 */
function allowList(env: any): string[] {
  return String(env?.DEV_EGRESS_ALLOW || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function devGuardOn(env: any): boolean {
  return String(env?.DEV_LOCAL || "") === "1";
}

/** 出站前问一句：这个主机现在准不准碰？不准就抛（**抛，不是静默跳过** —— 静默是另一种病）。 */
export function assertEgressAllowed(env: any, target: string, why: string): void {
  if (!devGuardOn(env)) return;                  // 生产：不装闸门，直接放行
  const host = hostOf(target) || target.toLowerCase();
  if (isLocal(host)) return;
  if (allowList(env).includes(host)) {
    console.warn(`🔓 [DEV 闸门] 已点名放行 ${host}（${why}）—— 这是**真实主机**，你正在对外产生真副作用`);
    return;
  }
  throw new Error(
    `🚧 [DEV 闸门] 拦下一次真实出站：${why} → ${host}\n` +
    `   本地进程默认只准出到 localhost。这道闸是因为连着三次事故加的：\n` +
    `   真发信到 x.com / 真抓 nmea.org / **真推 Joe 的飞书群**。\n` +
    `   确实要碰真的？在 .dev.vars 里点名：DEV_EGRESS_ALLOW=${host}\n` +
    `   —— 点名之前先想清楚：这一下的副作用是真的，落在 Joe 身上。`
  );
}

/** 装到全局 fetch 上：飞书、Resend、AI、目录抓取——所有走 fetch 的出站一次全兜住。 */
export function installDevEgressGuard(env: any): void {
  if (installed || !devGuardOn(env)) return;
  installed = true;
  const orig = globalThis.fetch;
  globalThis.fetch = ((input: any, init?: any) => {
    const url = typeof input === "string" ? input : (input?.url ?? String(input));
    assertEgressAllowed(env, url, "fetch");
    return orig(input as any, init);
  }) as typeof fetch;
  console.warn(
    `🚧 [DEV 闸门] 已装：本地出站仅限 localhost` +
    (allowList(env).length ? `；点名放行 = ${allowList(env).join(", ")}` : `；无点名放行`)
  );
}
