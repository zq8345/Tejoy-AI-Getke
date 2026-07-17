// 固定并发池 + 轮次时间预算。
//
// 为什么单独一个文件：pool 原来长在 index.ts 里（批⑦ 提速用的），而 send.ts 现在也要用它。
// send.ts 只 `import type { Env } from "./index"`（类型导入，编译期擦除，不成环）——
// 真去 import 一个**函数**就成了真循环依赖。抽出来两边都干净。
// （同 imap-batch.ts 的处理）

/** 固定大小并发池：n 个 worker 轮流取 items，返回结果按原序。 */
export async function pool<T, R>(items: T[], n: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

// ⭐ P0-1：一轮 cron 的时间预算。**这是平台限制，不是业务旋钮。**
//    业务旋钮（每天发几封）在 settings 里，归 Joe —— 谁都不许拿这里的数去砍他的数。
//
// Cloudflare Cron Trigger 的墙是 15 分钟。这里留 2 分钟余量：
//   · 一封信的耗时不是常数（实测 31-43s，抖动 40%）—— 贴着 15 分钟发，最后一封很可能被拦腰砍断
//   · 同一轮里收回复/discovery/analyze 也在花时间
export const ROUND_BUDGET_MS = 13 * 60 * 1000;

/**
 * 一轮 cron 的时间预算表。start 传 cron 进来那一刻。
 *
 * ⭐ 为什么用**时间**而不是"折算出的条数"（总工原方案是"按 15 分钟折算 ≈ 25 封"）：
 *   折算把我今天实测的 37s **焊死成了一个常数**。可它不是常数 —— 实测就在 31~43s 之间抖了 40%，
 *   而且模型换一个、限流一次、提示词长一点，这个数就变了。焊死之后：
 *     · 模型变快 → 我们还在发 25 封，白白浪费预算（又一次"我们自己塞的数砍 Joe"）
 *     · 模型变慢 → 25 封跑不完，被 wall time 拦腰砍断，**且我们不知道**
 *   看表则**自适应**：发到时间到为止。快就多发、慢就少发，永远贴着真实的墙，不用任何估值。
 *
 * ⚠️ 这依赖"Workers 里 Date.now() 会推进"。**已实测**（2026-07-16，本地 wrangler dev）：
 *   连续 3 次 fetch，Date.now() 读数 2/4/6ms 稳定推进 ✓
 *   注意：生产的 Date.now() 是**冻结在最后一次 I/O 时刻**的（防时序攻击），本地 dev 不完全一样。
 *   但我们**只需要它跨 fetch 推进** —— 每发一封信都有 fetch（OpenRouter + Resend），
 *   所以生产上同样成立。纯 CPU 空转时不推进不影响这个用法。
 */
export class RoundBudget {
  constructor(private start: number, private total = ROUND_BUDGET_MS) {}
  /** 还剩多少毫秒（不会为负） */
  remaining(): number { return Math.max(0, this.total - (Date.now() - this.start)); }
  elapsed(): number { return Date.now() - this.start; }
  /** 还够不够干一件预计要花 needMs 的事 */
  has(needMs: number): boolean { return this.remaining() > needMs; }
}

// ⭐ P0-1 产能估算：**用来当场告诉 Joe"你填的数能不能达到"**，不是用来砍他的数。
//
// Joe 原话："把每天发多少封的权限交给我，我会根据情况自己去调整。"
// 所以：他填多少就是多少，系统**不设上限**；但如果物理上跑不到，**必须当场说**，
// 不能让他以为发了 500 而实际只发了 200 —— 那是换一种方式骗他。
export const SEND_CONCURRENCY = 3;        // 并发（瓶颈是 AI 写草稿，不是 Resend）
export const ROUNDS_PER_DAY = 24;         // cron = 0 * * * *
// ⚠️ 这是**实测中位数**（2026-07-16，qwen3.7-max，连打 5 次：31.2/35.2/37.1/38.6/43.3s），
//    不是拍的。它只用于**给 Joe 看的估算**；真正的执行闸是 RoundBudget（看表，不用这个数）。
//    模型/提示词换了就会变 —— 变了这里的估算会不准，但**执行不会错**（那边看表）。
export const MEASURED_SEND_MS = 37000;

/** 当前配置一天最多约能发几封（估算，用于界面提示） */
export function estimateDailyCapacity(): { perRound: number; perDay: number; roundsPerDay: number } {
  // 每轮留 60s 余量（最慢一封实测 43s），剩下的时间按并发折算
  const usableMs = Math.max(0, ROUND_BUDGET_MS - 60_000);
  const perRound = Math.floor((usableMs / MEASURED_SEND_MS) * SEND_CONCURRENCY);
  return { perRound, perDay: perRound * ROUNDS_PER_DAY, roundsPerDay: ROUNDS_PER_DAY };
}
