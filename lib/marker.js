// The conversation row DSH draws for Strata's surface replacements.
//
// DSH's chat list draws one "Context compacted" row per compactionId
// (dsh-client-ui-chat compactionDefinition / CompactionItem). The title and
// the "N history items (~X tokens)" line are DSH's own templates, filled from
// the compaction/summary's shadowedSeqs length and shadowedTokenCount; only
// the expanded body comes from `summary`. The model reads the checkpoint
// user/message, never `summary`.
//
// DSH's log check (dsh-session-format-v3-to-v4 `compact`/`span`) allows one
// compaction open at a time, exactly one compaction/summary per compaction,
// and every summary or prune must name an exact current surface span. Its
// token meter needs a shadow-price event (summary or prune) right before each
// replace (dsh-token-meter surface-projection).
//
// So one landing phase (a turn-end flush of several folds, one sweep of stale
// snapshots, one L1 cut) is one compaction: start, one summary written before
// the first replace from the phase's plan (totals and a short line for
// people), then per range a compaction/prune with its exact price and the
// replace, then end. Model-facing text never goes into `summary`.

import { CompactionId } from "@deepseek-ai/dsh-compaction";
import { randomUUID } from "node:crypto";
import { commandLanguage, translator } from "./command.js";
import { kTokens } from "./economics.js";

const open = new WeakMap();

/** The turn a session currently has open (latest turn/start not followed by turn/end), or null; what DSH's log check expects on compaction events. */
export function openTurnOf(session) {
  const last = Number.isFinite(session.seq) ? session.seq - 1 : (session.snapshotEvents?.().at(-1)?.seq ?? 0);
  for (let seq = last; seq >= 0; seq -= 1) {
    const event = session.eventAt?.(seq);
    if (event?.type === "turn/start") return event.data?.turn ?? null;
    if (event?.type === "turn/end") return null;
  }
  return null;
}

/**
 * The short line people see when they expand the row, in the UI language.
 * @param {{ kind: "fold"|"card"|"dropped", tokens: number, seqs?: number[], label?: string }[]} items
 */
export function describeItems(items, language) {
  const t = translator(language ?? commandLanguage());
  const of = (kind) => items.filter((item) => item.kind === kind);
  const parts = [];
  const folds = of("fold");
  if (folds.length) {
    const ids = folds.map((item) => item.label).filter(Boolean);
    parts.push(t("marker.fold", { count: folds.length, ids: ids.length ? t("marker.ids", { ids: ids.join(", ") }) : "" }));
  }
  if (of("card").length) parts.push(t("marker.card", { count: of("card").length }));
  if (of("dropped").length) parts.push(t("marker.dropped", { count: of("dropped").length }));
  const tokens = items.reduce((sum, item) => sum + (item.tokens || 0), 0);
  const records = items.reduce((sum, item) => sum + (item.seqs?.length || 0), 0);
  return t("marker.line", { parts: parts.join(t("marker.join")), records, tokens: kTokens(tokens) });
}

/**
 * The span the summary names: the whole plan when its ranges sit back to back
 * on the surface (DSH then shows the true item count), else the first range
 * replaced (the count is then that range's; the body states the totals).
 */
function summarySpan(session, plan, first) {
  const nodes = session.surface?.nodes || [];
  const placed = plan
    .map((item) => ({ item, from: nodes.indexOf(item.start), to: nodes.indexOf(item.end) }))
    .filter((entry) => entry.from >= 0 && entry.to >= entry.from)
    .sort((left, right) => left.from - right.from);
  if (placed.length === plan.length && placed.length > 1) {
    const hull = nodes.slice(placed[0].from, placed.at(-1).to + 1);
    const covered = placed.flatMap((entry) => entry.item.seqs);
    if (hull.length === covered.length && hull.every((seq, index) => seq === covered[index])) {
      return { start: hull[0], end: hull.at(-1), seqs: hull };
    }
  }
  return { start: first.start, end: first.end, seqs: [...first.seqs] };
}

/** One compaction (one conversation row) for a planned landing phase. */
export class MarkerBatch {
  /** @param {any} session @param {{ start: number, end: number, seqs: number[], tokens: number, kind: string, label?: string }[]} plan */
  constructor(session, plan, { language } = {}) {
    this.session = session;
    this.plan = plan;
    this.language = language;
    this.compactionId = CompactionId(randomUUID());
    this.lifecycle = null;
    this.replaced = 0;
    this.lastError = null;
  }

  /** compaction/start and the one summary, before the first replace. */
  begin(first) {
    if (this.lifecycle) return;
    const lifecycle = { compactionId: this.compactionId, turn: openTurnOf(this.session) };
    this.startEvent = this.session.append("compaction/start", lifecycle);
    this.lifecycle = lifecycle;
    const span = summarySpan(this.session, this.plan.length ? this.plan : [first], first);
    this.summaryEvent = this.session.append("compaction/summary", {
      compactionId: this.compactionId,
      summary: [{ type: "text", text: describeItems(this.plan.length ? this.plan : [first], this.language) }],
      shadowedRange: { start: span.start, end: span.end },
      shadowedSeqs: span.seqs,
      shadowedTokenCount: (this.plan.length ? this.plan : [first]).reduce((sum, item) => sum + (item.tokens || 0), 0),
      provider: first.provider || "local",
      model: first.model || "strata",
      ...(first.rawOutput === undefined ? {} : { rawOutput: first.rawOutput }),
    });
  }

  /**
   * Exact shadow price (compaction/prune) and the surface replace for one range.
   * @param {{ start: number, end: number, seqs: number[], tokens: number, message: any, kind: string, label?: string, rawOutput?: any[], provider?: string, model?: string }} item
   */
  replace(item) {
    this.begin(item);
    this.session.append("compaction/prune", {
      shadowedRange: { start: item.start, end: item.end },
      shadowedSeqs: [...item.seqs],
      shadowedTokenCount: item.tokens,
    });
    this.session.append("user/message", item.message, {
      surfaceOp: { op: "replace", startSeq: item.start, endSeq: item.end },
      sourceEventSeqs: [this.startEvent.seq, this.summaryEvent.seq, ...item.seqs],
    });
    this.replaced += 1;
  }

  /** A planned range that will not land (stale or rejected): left out of the summary if it is not written yet. */
  drop(start) {
    if (!this.lifecycle) this.plan = this.plan.filter((item) => item.start !== start);
  }

  /** A replacement that failed before it landed; reported on the end event if nothing landed. */
  fail(error) {
    this.lastError = error instanceof Error ? error.message : String(error);
  }

  close() {
    if (!this.lifecycle) return;
    const lifecycle = this.lifecycle;
    this.lifecycle = null;
    try {
      this.session.append("compaction/end", this.replaced === 0 ? { ...lifecycle, error: this.lastError || "nothing landed" } : lifecycle);
    } catch {}
  }
}

/** The session's open phase, if any. */
export function currentBatch(session) {
  return open.get(session) || null;
}

/**
 * Run `fn(batch)` inside the session's open phase, or a new phase for `plan`
 * closed when `fn` returns. Replacements made inside share one compaction.
 */
export async function inBatch(session, plan, fn, options = {}) {
  const outer = open.get(session);
  if (outer) return fn(outer);
  const batch = new MarkerBatch(session, plan, options);
  open.set(session, batch);
  try {
    return await fn(batch);
  } finally {
    open.delete(session);
    batch.close();
    try {
      await options.flush?.();
    } catch {}
  }
}
