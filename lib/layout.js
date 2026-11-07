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
 * @param {{ keepRounds?: number, tailCapTokens?: number, toolsTokens?: number, gapFloor?: number, balancedBefore?: (session: any, seq: number) => boolean, balancedAfter?: (session: any, seq: number) => boolean }} [options]
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
      auto: strat.stratum === "fold" && strat.attrs?.auto === "1",
      tokens: priced[index]?.tokens ?? 0,
      toolCalls: calls.length,
      toolNames: calls.map((call) => call.name || call.toolName || "").filter(Boolean),
      toolCallId: event?.data?.message?.toolCallId || "",
      // DSH and Strata notices (model switch, nudges) are user-role messages but not user input.
      notice: (event?.data?.source?.form || event?.data?.message?.source?.form) === "notice",
      preview: preview(strat.stratum === "raw" ? text : text.replace(/^\[strata:[^\]]*\]\s*/, "")),
    };
  });
  // DSH's totalTokens is anchored on the provider's real prompt size (latest
  // usage plus a heuristic delta), while surfaceTokens and every node's tokens
  // are the chars/4 heuristic. Dense text (logs, digits, JSON) tokenizes much
  // heavier than chars/4, so total − surface also holds the estimator error on
  // every message, which grows with the session. Fixed overhead is therefore
  // measured in heuristic units (system rows + DSH's heuristic toolsTokens, or
  // the smallest gap seen when that is unavailable) and scaled by the session's
  // provider/heuristic ratio, like every message.
  const surfaceTokens = Number.isFinite(measurement.surfaceTokens) ? measurement.surfaceTokens : rows.reduce((sum, row) => sum + row.tokens, 0);
  const totalTokens = measurement.totalTokens || 0;
  const gapTokens = Math.max(0, totalTokens - surfaceTokens);
  const systemTokens = rows.reduce((sum, row) => sum + (row.role === "system" ? row.tokens : 0), 0);
  const clampScale = (value) => (Number.isFinite(value) && value > 0 ? Math.min(8, Math.max(0.25, value)) : 1);
  let scale;
  let fixedTokens;
  let toolsTokens;
  if (Number.isFinite(options.toolsTokens)) {
    // DSH's heuristic tool price is known: one ratio for the whole request.
    toolsTokens = options.toolsTokens;
    scale = totalTokens > 0 ? clampScale(totalTokens / (surfaceTokens + toolsTokens)) : 1;
    fixedTokens = Math.round(scale * (systemTokens + toolsTokens));
  } else {
    // Otherwise the smallest gap seen (already in provider units) is the
    // off-surface part; the ratio comes from the surface alone.
    const floor = Math.min(gapTokens, Number.isFinite(options.gapFloor) ? options.gapFloor : gapTokens);
    scale = surfaceTokens > 0 && totalTokens > 0 ? clampScale((totalTokens - floor) / surfaceTokens) : 1;
    toolsTokens = Math.round(floor / scale);
    fixedTokens = Math.round(floor + scale * systemTokens);
  }
  // L0: the latest raw user message and the last `keepRounds` tool rounds
  // (from the assistant message that issued them to the end of the surface).
  // The tail is capped at options.tailCapTokens (provider tokens, e.g. 10% of
  // the window): older rounds drop out of it once the tail would exceed the
  // cap. The newest round always stays, whole, whatever its size. Rounds start
  // at the assistant message that made the calls, so the boundary never
  // separates a call from its results.
  const capLocal = Number.isFinite(options.tailCapTokens) && options.tailCapTokens > 0 ? options.tailCapTokens / scale : Number.POSITIVE_INFINITY;
  let protectFrom = rows.length;
  let rounds = 0;
  let available = 0;
  let capped = false;
  let suffix = 0;
  const suffixFrom = (index) => rows.slice(index).reduce((sum, row) => sum + row.tokens, 0);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index].toolCalls > 0) {
      available += 1;
      suffix = suffixFrom(index);
      if (rounds >= 1 && suffix > capLocal) {
        capped = true;
        break;
      }
      rounds += 1;
      protectFrom = index;
      if (rounds >= keepRounds) break;
    }
  }
  // Trailing assistant prose after the last tool round is protected too.
  if (available === 0) {
    let index = rows.length - 1;
    while (index >= 0 && rows[index].role === "assistant") index -= 1;
    protectFrom = index + 1;
  }
  const tail = {
    rounds,
    of: capped ? rounds + countRoundsBefore(rows, protectFrom, keepRounds - rounds) : rounds,
    keepRounds,
    tokens: suffixFrom(protectFrom),
    capped,
    capTokens: Number.isFinite(capLocal) ? options.tailCapTokens : 0,
  };
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
  // Where the current turn starts: the latest user input (notices are not input).
  let turnStart = -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index].role === "user" && rows[index].stratum === "raw" && !rows[index].notice) {
      turnStart = index;
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
    // The latest user input stays too when a notice (nudge, model switch) came after it.
    row.protected = row.index < first || row.index >= protectFrom || row.index === lastUser || row.index === turnStart || row.live;
    // Folds below T3 stay foldable: a range over them becomes the next tier.
    // Stale snapshots and dropped stubs may sit inside a fold range (they do
    // not break a run) but count as nothing worth folding.
    row.foldable = !row.protected && (row.stratum === "raw" || row.stratum === "card" || row.stale || row.stratum === "dropped" || (row.stratum === "fold" && row.tier < MAX_TIER));
    row.openOk = row.foldable && safe(balancedBefore, row.seq);
    row.closeOk = row.foldable && safe(balancedAfter, row.seq);
  }
  return { rows, protectFrom, tail, lastUser, turnStart, first, live, totalTokens: measurement.totalTokens, fixedTokens, scale, surfaceTokens, gapTokens, toolsTokens, systemTokens };
}

/** Tool rounds before `index`, at most `limit` (to say "2 of 3" when the cap trimmed the tail). */
function countRoundsBefore(rows, index, limit) {
  let count = 0;
  for (let at = index - 1; at >= 0 && count < limit; at -= 1) if (rows[at].toolCalls > 0) count += 1;
  return count;
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
  const totals = { raw: bucket(), card: bucket(), fold: bucket(), full: bucket(), context: bucket(), stale: bucket(), dropped: bucket(), auto: bucket(), tiers: { 1: bucket(), 2: bucket(), 3: bucket() } };
  for (const row of layout.rows) {
    const target = row.stale ? totals.stale : totals[row.stratum] || totals.raw;
    target.tokens += row.tokens;
    target.count += 1;
    if (row.stratum === "fold") {
      if (row.auto) {
        totals.auto.tokens += row.tokens;
        totals.auto.count += 1;
      }
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
