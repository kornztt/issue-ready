/**
 * IssueReady audit history — PURE module (no Forge imports, unit-testable).
 *
 * Every project audit appends one snapshot to a capped per-project list
 * stored in KVS: { at, averageScore, total, byVerdict }. The project page
 * renders the list as a trend (average score over time); the weekly
 * scheduled audit keeps it growing without anyone opening the page.
 */

export const HISTORY_LIMIT = 20;

export function buildSnapshot(report, at) {
  return {
    at: at || new Date().toISOString(),
    averageScore: report.averageScore,
    total: report.total,
    byVerdict: { ...report.byVerdict },
  };
}

export function appendSnapshot(history, snapshot, limit = HISTORY_LIMIT) {
  const list = [...(Array.isArray(history) ? history : []), snapshot];
  return list.slice(-limit);
}

/** Score change between the last two snapshots; null if fewer than two. */
export function trendDelta(history) {
  if (!Array.isArray(history) || history.length < 2) return null;
  return history[history.length - 1].averageScore - history[history.length - 2].averageScore;
}
