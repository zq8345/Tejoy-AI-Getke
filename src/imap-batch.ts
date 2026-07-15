// IMAP 增量拉取的纯逻辑（无 socket 依赖，便于单测 M1 游标回归）。
export const IMAP_BATCH = 30; // 单次会话最多 FETCH 的新邮件数

// 根据全体 UID 与游标算出本批要处理的窗口。
// 关键（M1）：processedMaxUid 只到"本批取到的最后一个新 UID"（升序取前 maxCount 个），
// 不用全体 maxUid 回写游标 —— 否则一次 >maxCount 封时会永久跳过溢出的邮件。
export function computeBatch(allUids: number[], sinceUid: number, maxCount = IMAP_BATCH): {
  newUids: number[]; attempted: number; processedMaxUid: number; maxUid: number;
} {
  const sorted = [...allUids].sort((a, b) => a - b);
  const maxUid = sorted.length ? sorted[sorted.length - 1] : 0;
  const newUids = sorted.filter((u) => u > sinceUid).slice(0, maxCount);
  const attempted = newUids.length;
  // 尝试过的最大 UID 即视为已处理（含无正文/被删的 UID，避免下轮无限重试）；无新邮件则游标不动
  const processedMaxUid = attempted ? newUids[attempted - 1] : sinceUid;
  return { newUids, attempted, processedMaxUid, maxUid };
}
