// Surface layout: one row per surface node with its stratum and tokens, the
// L0 protected zone, and the contiguous runs an L2 fold may cover.

import { messageText } from "../plan.js";
import { MAX_TIER, seqRef, stratumOf } from "./stratum.js";

function roleOf(event) {
  switch (event?.type) {
    case "user/message": return "user";
    case "assistant/message": return "assistant";
    case "tool/result": return "tool";
    case "system/message": return "system";
    default: return "other";
  }
}

function textOf(event) {
  if (event?.type === "user/message") return messageText(event.data);
  if (event?.type === "assistant/message") return messageText(event.data?.message);
  return messageText(event?.data);
}

function toolCallsOf(event) {
  if (event?.type !== "assistant/message") return [];
  const content = event.data?.message?.content;
  return Array.isArray(content) ? content.filter((block) => block?.type === "tool-call") : [];
}

function preview(text, max = 72) {
  const line = String(text || "").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * @param {any} session
 * @param {{ nodes: { tokens: number }[], totalTokens: number }} measurement
 * @param {{ keepRounds?: number, balancedBefore?: (session: any, seq: number) => boolean, balancedAfter?: (session: any, seq: number) => boolean }} [options]
 */
export function surfaceLayout(session, measurement, options = {}) {
  const keepRounds = options.keepRounds ?? 3;
  const seqs = session.surface.nodes;
  const priced = measurement.nodes || [];
  const rows = seqs.map((seq, index) => {
    const event = session.eventAt(seq);
    const strat = stratumOf(event);
    const calls = toolCallsOf(event);
    const text = textOf(event);
    return {
      seq,
      ref: seqRef(seq),
      index,
      type: event?.type || "",
      role: roleOf(event),
      stratum: strat.stratum,
      tier: strat.tier || 0,
      id: strat.id,
      tokens: priced[index]?.tokens ?? 0,
      toolCalls: calls.length,
      toolNames: calls.map((call) => call.name || call.toolName || "").filter(Boolean),
      toolCallId: event?.data?.message?.toolCallId || "",
      preview: preview(strat.stratum === "raw" ? text : text.replace(/^\[strata:[^\]]*\]\s*/, "")),
    };
  });
  // L0: the latest raw user message and the last `keepRounds` tool rounds
  // (from the assistant message that issued them to the end of the surface).
  let protectFrom = rows.length;
  let rounds = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index].toolCalls > 0) {
      rounds += 1;
      protectFrom = index;
      if (rounds >= keepRounds) break;
    }
  }
  // Trailing assistant prose after the last tool round is protected too.
  if (rounds === 0) {
    let index = rows.length - 1;
    while (index >= 0 && rows[index].role === "assistant") index -= 1;
    protectFrom = index + 1;
  }
  // The newest runtime-context snapshot is live and protected; older ones are
  // stale (docs/interop-dsh-mem0.md §1).
  let live = -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index].stratum === "context") {
      live = index;
      break;
    }
  }
  for (const row of rows) {
    row.live = row.stratum === "context" && row.index === live;
    row.stale = row.stratum === "context" && row.index !== live;
  }
  let lastUser = -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index].role === "user" && rows[index].stratum === "raw") {
      lastUser = index;
      break;
    }
  }
  const first = rows[0]?.role === "system" ? 1 : 0;
  const balancedBefore = options.balancedBefore || (() => true);
  const balancedAfter = options.balancedAfter || (() => true);
  const safe = (fn, seq) => {
    try {
      return fn(session, seq);
    } catch {
      return false;
    }
  };
  for (const row of rows) {
    row.protected = row.index < first || row.index >= protectFrom || row.index === lastUser || row.live;
    // Folds below T3 stay foldable: a range over them becomes the next tier.
    // Stale snapshots and dropped stubs may sit inside a fold range (they do
    // not break a run) but count as nothing worth folding.
    row.foldable = !row.protected && (row.stratum === "raw" || row.stratum === "card" || row.stale || row.stratum === "dropped" || (row.stratum === "fold" && row.tier < MAX_TIER));
    row.openOk = row.foldable && safe(balancedBefore, row.seq);
    row.closeOk = row.foldable && safe(balancedAfter, row.seq);
  }
  return { rows, protectFrom, lastUser, first, live, totalTokens: measurement.totalTokens };
}

/**
 * Contiguous foldable runs, trimmed so both ends keep tool calls paired.
 * @param {ReturnType<typeof surfaceLayout>} layout
 */
export function foldableRuns(layout) {
  const runs = [];
  let current = [];
  const flush = () => {
    let start = 0;
    let end = current.length - 1;
    while (start <= end && !current[start].openOk) start += 1;
    while (end >= start && !current[end].closeOk) end -= 1;
    if (start <= end) {
      const rows = current.slice(start, end + 1);
      runs.push({
        start: rows[0].seq,
        end: rows.at(-1).seq,
        startRef: rows[0].ref,
        endRef: rows.at(-1).ref,
        count: rows.length,
        tokens: rows.reduce((sum, row) => sum + row.tokens, 0),
        cards: rows.filter((row) => row.stratum === "card").length,
        folds: rows.filter((row) => row.stratum === "fold").length,
        tier: Math.max(0, ...rows.filter((row) => row.stratum === "fold").map((row) => row.tier)) + 1,
        tools: rows.flatMap((row) => row.toolNames),
        rows,
      });
    }
    current = [];
  };
  for (const row of layout.rows) {
    if (row.foldable) current.push(row);
    else if (current.length) flush();
  }
  if (current.length) flush();
  return runs;
}

/**
 * Groups of adjacent folds that can be upgraded together: the span from the
 * first to the last fold of a foldable run holding two or more folds.
 * @param {ReturnType<typeof surfaceLayout>} layout
 */
export function upgradeGroups(layout) {
  const groups = [];
  for (const run of foldableRuns(layout)) {
    const folds = run.rows.filter((row) => row.stratum === "fold");
    if (folds.length < 2) continue;
    const first = run.rows.indexOf(folds[0]);
    const last = run.rows.indexOf(folds.at(-1));
    const rows = run.rows.slice(first, last + 1);
    groups.push({
      start: rows[0].seq,
      end: rows.at(-1).seq,
      startRef: rows[0].ref,
      endRef: rows.at(-1).ref,
      tokens: rows.reduce((sum, row) => sum + row.tokens, 0),
      folds: folds.map((row) => `${row.id}(T${row.tier})`),
      tier: Math.max(...folds.map((row) => row.tier)) + 1,
    });
  }
  return groups;
}

/** Tokens by stratum on the current surface; folds also by tier. */
export function strataTotals(layout) {
  const bucket = () => ({ tokens: 0, count: 0 });
  const totals = { raw: bucket(), card: bucket(), fold: bucket(), full: bucket(), context: bucket(), stale: bucket(), dropped: bucket(), tiers: { 1: bucket(), 2: bucket(), 3: bucket() } };
  for (const row of layout.rows) {
    const target = row.stale ? totals.stale : totals[row.stratum] || totals.raw;
    target.tokens += row.tokens;
    target.count += 1;
    if (row.stratum === "fold") {
      const tier = totals.tiers[row.tier || 1] || (totals.tiers[row.tier] = bucket());
      tier.tokens += row.tokens;
      tier.count += 1;
    }
  }
  return totals;
}

/** Foldable tokens: raw + card outside the protected zone (design §3 note). Stale snapshots are dropped, not folded. */
export function foldableTokens(layout) {
  return layout.rows.reduce((sum, row) => sum + (row.foldable && !row.stale && row.stratum !== "dropped" ? row.tokens : 0), 0);
}

/** Superseded runtime-context snapshots still on the surface. */
export function staleSnapshots(layout) {
  return layout.rows.filter((row) => row.stale);
}
