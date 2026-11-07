// /strata for people: help, a short status, a sectioned detail and a guarded
// purge, in the UI language. The strata_status tool (for the model) stays the
// compact English text of StrataLayer.status.
//
// DSH shows command output as plain monospace text (no Markdown), so tables
// are aligned with spaces; CJK characters count as two columns.
//
// The command handler gets no locale. The composer dock reports the active UI
// language with each status poll (gui-routes.js); without one, the system
// locale decides.

import { readFileSync } from "node:fs";
import { readActivity } from "./activity.js";
import { archiveRootFor, archiveTotals, endedArchives, purgeArchive, purgeSessions } from "./archive.js";
import { kTokens } from "./economics.js";
import { readLedger } from "./ledger.js";
import { sanitizeSessionKey } from "../shadow.js";

const LANGUAGES = ["en", "zh"];
const dictionaries = new Map();
let reportedLanguage = "";

function dictionary(language) {
  if (!dictionaries.has(language)) {
    dictionaries.set(language, JSON.parse(readFileSync(new URL(`../locale/command/${language}.json`, import.meta.url), "utf8")));
  }
  return dictionaries.get(language);
}

/** The dock's active UI language (`zh-CN`, `en`, ...). Ignored when malformed. */
export function setUiLanguage(value) {
  const text = String(value || "").trim();
  if (/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(text)) reportedLanguage = text.toLowerCase();
}

/** `zh` or `en`: an explicit tag, else the dock's report, else the system locale. */
export function commandLanguage(explicit) {
  let tag = String(explicit || reportedLanguage || "");
  if (!tag) {
    try {
      tag = Intl.DateTimeFormat().resolvedOptions().locale || "";
    } catch {}
  }
  if (!tag) tag = process.env.LC_ALL || process.env.LANG || "en";
  const primary = tag.toLowerCase().split(/[-_.]/)[0];
  return LANGUAGES.includes(primary) ? primary : "en";
}

/** Translator for one language: t("detail.window"), t("status.usage", { used: "1K" }). */
export function translator(language) {
  const table = dictionary(commandLanguage(language));
  const fallback = dictionary("en");
  const lookup = (root, key) => key.split(".").reduce((node, part) => (node && typeof node === "object" ? node[part] : undefined), root);
  return (key, params = {}) => {
    const text = lookup(table, key) ?? lookup(fallback, key) ?? key;
    return String(text).replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
  };
}

// ------------------------------------------------------------------ layout

/** Is this a wide (CJK / full-width) character? */
const isWide = (code) => (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6);

/** Narrow and wide character counts. */
function measure(text) {
  let narrow = 0;
  let wide = 0;
  for (const char of String(text)) {
    if (isWide(char.codePointAt(0) || 0)) wide += 1;
    else narrow += 1;
  }
  return { narrow, wide };
}

/** Terminal columns: CJK and full-width characters take two. */
export function displayWidth(text) {
  const { narrow, wide } = measure(text);
  return narrow + 2 * wide;
}

// A wide character is two terminal columns, but in DSH's web view it is 1em
// against 0.6em for a Latin one, so no count of plain spaces lines up mixed
// text. Padding narrow shortfalls with spaces and wide ones with ideographic
// spaces (U+3000, as wide as a CJK character in both) gives every cell in a
// column the same width wherever it is shown.
const IDEOGRAPHIC_SPACE = "\u3000";
const fill = (cell, column) => {
  const { narrow, wide } = measure(cell);
  return `${" ".repeat(Math.max(0, column.narrow - narrow))}${IDEOGRAPHIC_SPACE.repeat(Math.max(0, column.wide - wide))}`;
};
const columnOf = (cells) => cells.map(measure).reduce((max, m) => ({ narrow: Math.max(max.narrow, m.narrow), wide: Math.max(max.wide, m.wide) }), { narrow: 0, wide: 0 });

/**
 * Rows of cells; the first column is left-aligned, the others right-aligned.
 * @param {string[][]} rows
 */
export function table(rows, indent = "  ") {
  const count = Math.max(0, ...rows.map((row) => row.length));
  const columns = Array.from({ length: count }, (_, index) => columnOf(rows.map((row) => row[index] ?? "")));
  return rows.map((row) => `${indent}${row.map((cell, index) => (index === 0 ? `${cell}${fill(cell, columns[0])}` : `${fill(cell, columns[index])}${cell}`)).join("   ")}`.trimEnd());
}

/** Label / value pairs: labels padded, values left as written. */
function pairs(rows, indent = "  ") {
  const column = columnOf(rows.map(([label]) => label));
  return rows.map(([label, value]) => `${indent}${label}${fill(label, column)}   ${value}`);
}

/** The engine's control state, localized when it is the usual "active (...)". */
const stateOf = (snap, t) => (/^active\b/.test(snap.control) ? t("active") : snap.control);

const pct = (value) => (Number.isFinite(value) ? `${Math.round(value * 1000) / 10}%` : "n/a");
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

// ------------------------------------------------------------------ outcomes

// StrataLayer records why the last turn end did or did not fold as compact
// English (the strata_status tool shows it to the model as is). /strata
// translates the known forms; anything else is shown as written.
const WHY = (t, text) => (text === " (forced)" ? t("outcome.forced") : text === " (above the automatic-fold line)" ? t("outcome.pressured") : "");
const OUTCOMES = [
  [/^off \(STRATA_AUTO_FOLD\)$/, (t) => t("outcome.off")],
  [/^skipped \(([\d.]+%): below ([\d.]+%)\)$/, (t, m) => t("outcome.belowLine", { ratio: m[1], line: m[2] })],
  [/^skipped \(([\d.]+%): below ([\d.]+%) and (\d+) of (\d+) unanswered nudges\)$/, (t, m) => t("outcome.belowForce", { ratio: m[1], force: m[2], unanswered: m[3], needed: m[4] })],
  [/^skipped \(already under the target ~(\S+)\)$/, (t, m) => t("outcome.underTarget", { target: m[1] })],
  [/^skipped \(pending fold (.+) covers the target\)$/, (t, m) => t("outcome.pendingCovers", { ids: m[1] })],
  [/^skipped \(waiting for (\S+) foldable growth since the last digest; \+(\S+) local so far\)$/, (t, m) => t("outcome.waitGrowth", { step: m[1], sofar: m[2] })],
  [/^skipped \(target ~(\S+) unreachable: what is left is (in the current turn, )?fixed, protected or already folded\)$/, (t, m) => t("outcome.unreachable", { target: m[1], current: m[2] ? t("outcome.unreachableCurrent") : "" })],
  [/^skipped \(the oldest round (\S+), ~(\S+) provider, would overshoot the target ~(\S+) by more than half\)$/, (t, m) => t("outcome.overshoot", { ref: m[1], tokens: m[2], target: m[3] })],
  [/^skipped \(rejected: ([\s\S]*)\)$/, (t, m) => t("outcome.rejected", { reason: m[1] })],
  [/^skipped \(no foldable run outside pending folds( before the current turn)?\)$/, (t, m) => t("outcome.noRun", { current: m[1] ? t("outcome.noRunCurrent") : "" })],
  [/^proposed (.+?) at ([\d.]+%) \(target ~(\S+)\)(?:; stopped before (\S+) \(~(\S+) provider\) to stay near the target)?$/, (t, m) => t("outcome.proposed", { ids: m[1], ratio: m[2], target: m[3], stop: m[4] ? t("outcome.proposedStop", { ref: m[4], tokens: m[5] }) : "" })],
  [/^proposed (.+?), not landed \(batch ~(\S+) below the (\S+) minimum\)$/, (t, m) => t("outcome.notLandedSmall", { ids: m[1], batch: m[2], min: m[3] })],
  [/^proposed (.+?), not landed \(cache cost: ([\s\S]*)\)$/, (t, m) => t("outcome.notLandedCost", { ids: m[1], why: m[2] })],
  [/^proposed (.+?), dropped \(range changed before landing\)$/, (t, m) => t("outcome.dropped", { ids: m[1] })],
  [/^landed model fold (.+?)( \(forced\)| \(above the automatic-fold line\))?(?:; ([\s\S]*))?$/, (t, m) => t("outcome.landedModel", { ids: m[1], why: WHY(t, m[2] || ""), rest: m[3] ? `；${localizeOutcome(m[3], t)}`.replace(/^；/, t("outcome.forced").startsWith("（") ? "；" : "; ") : "" })],
  [/^landed (.+?) before a step \(([\s\S]*)\)$/, (t, m) => t("outcome.landedMidTurn", { ids: m[1], rest: m[2] })],
  [/^landed (.+?)(?: with model fold (.+?))?( \(forced\)| \(above the automatic-fold line\))?$/, (t, m) => t("outcome.landed", { ids: m[1], model: m[2] ? t("outcome.withModel", { ids: m[2] }) : "", why: WHY(t, m[3] || "") })],
  [/^error: ([\s\S]*)$/, (t, m) => t("outcome.error", { message: m[1] })],
];

/** A StrataLayer outcome line in the UI language (unknown forms stay as written). */
export function localizeOutcome(text, t) {
  const value = String(text ?? "");
  for (const [pattern, render] of OUTCOMES) {
    const match = pattern.exec(value);
    if (match) return render(t, match);
  }
  return value;
}

// ------------------------------------------------------------------ texts

export function helpText(t) {
  const rows = [
    ["/strata status", t("help.status")],
    ["/strata detail", t("help.detail")],
    ["/strata detail full", t("help.detailFull")],
    ["/strata search <…>", `${t("help.search")}  (${t("help.searchExample")})`],
    ["/strata purge", t("help.purge")],
    ["/strata purge ended", t("help.purgeEnded")],
    ["/strata help", t("help.help")],
  ];
  return [t("help.title"), ...pairs(rows)].join("\n");
}

export function purgeWarning(t) {
  return [t("purge.warning"), t("purge.confirm")].join("\n");
}

function warnings(layer, t) {
  const lines = [];
  const configError = layer.engine?.pressureConfigError;
  if (configError) lines.push(t("detail.warning", { text: t("detail.warnConfig", { target: configError.targetKey, message: String(configError.message).slice(0, 300) }) }));
  const failure = layer.engine?.officialFailure;
  if (failure) lines.push(t("detail.warning", { text: t("detail.warnOfficial", { count: failure.count, message: String(failure.message).slice(0, 200) }) }));
  return lines;
}

export function shortStatus(layer, agent, t) {
  const snap = layer.snapshot(agent);
  const s = snap.strata;
  return [
    t("status.title", { state: stateOf(snap, t) }),
    ...warnings(layer, t),
    t("status.usage", { used: kTokens(snap.totalTokens), window: kTokens(snap.window), pct: pct(snap.totalTokens / snap.window) }),
    t("status.layers", { raw: kTokens(s.raw.tokens), card: kTokens(s.card.tokens), fold: kTokens(s.fold.tokens), full: kTokens(s.full.tokens) }),
    t("status.cache", { rate: snap.hitRate === null ? t("detail.noUsage") : pct(snap.hitRate) }),
    t("status.more"),
  ].join("\n");
}

/**
 * @param {any} layer - StrataLayer
 * @param {any} agent
 * @param {(key: string, params?: object) => string} t
 * @param {{ full?: boolean, changes?: number }} [options]
 */
export function detailText(layer, agent, t, options = {}) {
  const snap = layer.snapshot(agent);
  const settings = layer.settings;
  const s = snap.strata;
  const out = [t("detail.title", { state: stateOf(snap, t) }), ...warnings(layer, t)];

  // 1. Overview
  const fromProvider = Boolean(layer.state?.(agent)?.window);
  out.push("", t("detail.overview"));
  const root = archiveRootFor(settings);
  const totals = archiveTotals(root);
  const over = settings.archiveMaxMB > 0 && totals.bytes > settings.archiveMaxMB * 1048576;
  out.push(...pairs([
    [t("detail.mode"), t("detail.modeValue", { mode: t(`mode.${settings.mode || settings.preset || "cost"}`), source: t(`source.${settings.modeSource || "default"}`) })],
    [t("detail.used"), `~${kTokens(snap.totalTokens)}  (${pct(snap.totalTokens / snap.window)})`],
    [t("detail.window"), `${kTokens(snap.window)}  (${t(fromProvider ? "detail.windowProvider" : "detail.windowFallback")})`],
    [t("detail.fixed"), `~${kTokens(snap.fixedTokens)}  (${pct(snap.fixedTokens / snap.window)})`],
    [t("detail.ratio"), `×${(snap.scale || 1).toFixed(2)}`],
    [t("detail.nudge"), t(settings.nudge ? "on" : "off")],
    [t("detail.archive"), `${mb(snap.archiveBytes)} MB`],
    [t("detail.archiveAll"), t("detail.archiveAllValue", { mb: mb(totals.bytes), n: totals.sessions, cap: over ? t("detail.archiveOver", { cap: settings.archiveMaxMB }) : settings.archiveMaxMB > 0 ? t("detail.archiveCap", { cap: settings.archiveMaxMB }) : "" })],
    [t("detail.archiveDir"), root],
  ]));

  // 2. Layers
  out.push("", t("detail.layers"));
  const row = (label, bucket) => [label, kTokens(bucket.tokens), String(bucket.count)];
  out.push(...table([
    [t("detail.layer"), t("detail.tokens"), t("detail.items")],
    row(t("detail.raw"), s.raw),
    row(t("detail.card"), s.card),
    row(t("detail.fold"), s.fold),
    ...[1, 2, 3].map((tier) => row(t("detail.foldTier", { tier }), s.tiers[tier] || { tokens: 0, count: 0 })),
    row(t("detail.foldAuto"), s.auto),
    row(t("detail.full"), s.full),
    row(t("detail.context"), s.context),
    row(t("detail.stale"), s.stale),
    row(t("detail.dropped"), s.dropped),
  ]));

  // 3. Automatic folds
  const target = snap.fixedTokens + settings.autoFoldTargetPct * Math.max(0, snap.window - snap.fixedTokens);
  const tail = snap.layout?.tail;
  const lines = snap.lines || { autoFoldPct: settings.autoFoldPct, autoFoldForcePct: settings.autoFoldForcePct, official: 0, officialPct: 0, clamped: false };
  const clampedTo = [...new Set([lines.autoFoldPct, lines.autoFoldForcePct].filter((value, index) => value !== [settings.autoFoldPct, settings.autoFoldForcePct][index]).map(pct))].join(" / ");
  out.push("", t("detail.auto"));
  out.push(...pairs([
    [t("detail.rule"), settings.autoFold
      ? t("detail.ruleOn", { pct: pct(lines.autoFoldPct), nudges: settings.autoFoldAfterNudges, force: pct(lines.autoFoldForcePct), target: kTokens(target), targetPct: pct(settings.autoFoldTargetPct) }) +
        (settings.midTurnFold ? t(settings.midTurnCurrent ? "detail.ruleMidTurnCurrent" : "detail.ruleMidTurn", { force: pct(lines.autoFoldForcePct) }) : "")
      : t("detail.ruleOff")],
    [t("detail.official"), layer.engine?.pressureConfigError ? t("detail.officialOff")
      : lines.official > 0
      ? t("detail.officialValue", { tokens: kTokens(lines.official), pct: `${Math.round(lines.officialPct * 100)}%` }) + (lines.clamped ? t("detail.officialClamped", { pct: clampedTo }) : "")
      : t("detail.officialUnknown")],
    [t("detail.last"), snap.lastAutoFold ? localizeOutcome(snap.lastAutoFold.outcome, t) : t("detail.lastNone")],
    [t("detail.tail"), tail
      ? t("detail.tailValue", { rounds: tail.rounds, tokens: kTokens(tail.tokens * (snap.scale || 1)), cap: tail.capped && settings.protectedTailPct ? t("detail.tailCapped", { pct: pct(settings.protectedTailPct) }) : "" })
      : t("detail.tailUnknown")],
  ]));

  // 4. Foldable ranges
  out.push("", t("detail.ranges", { tokens: kTokens(snap.foldable) }));
  if (!snap.runs.length) out.push(`  ${t("detail.rangesNone")}`);
  const runs = [...snap.runs].sort((left, right) => left.start - right.start);
  const shown = options.full ? runs : runs.slice(0, 8);
  for (const run of shown) {
    out.push(`  ${t("detail.range", {
      start: run.startRef,
      end: run.endRef,
      tokens: kTokens(run.tokens),
      count: run.count,
      cards: run.cards ? t("detail.rangeCards", { n: run.cards }) : "",
      folds: run.folds ? t("detail.rangeFolds", { n: run.folds, tier: Math.min(run.tier, 3) }) : "",
    })}`);
    if (options.full) {
      for (const item of run.rows) out.push(`      ${item.ref}  ${item.stratum === "card" ? `card ${item.id}` : item.stratum === "fold" ? `fold ${item.id} T${item.tier}` : item.role}  ${kTokens(item.tokens)}  ${item.preview || ""}`.trimEnd());
    }
  }
  if (runs.length > shown.length) out.push(`  ${t("detail.rangesMore", { n: runs.length - shown.length })}`);
  if (runs.length && !options.full) out.push(`  ${t("detail.rangesFull")}`);
  if (snap.pending.length) {
    out.push(`  ${t("detail.pending", { list: snap.pending.map((fold) => `${fold.id} T${fold.tier || 1} ~${kTokens(fold.tokens - fold.foldTokens)}`).join(", ") })}`);
  }

  // 5. Cache and cost
  const ledger = readLedger(agent.session?.id, snap.usage.length, { priceMiss: settings.priceMiss, priceHit: settings.priceHit });
  const byLayer = Object.entries(ledger.byLayer).map(([layerName, count]) => `${layerName} ${count}`).join(" · ");
  out.push("", t("detail.cache"));
  out.push(...pairs([
    [t("detail.hitRate"), snap.hitRate === null ? t("detail.noUsage") : pct(snap.hitRate)],
    ...(snap.usage.length ? [[t("detail.hitRecent"), snap.usage.slice(-5).map((item) => pct(item.rate)).join("  ")]] : []),
    [t("detail.landed"), `${ledger.count}${byLayer ? `  (${byLayer})` : ""}`],
    [t("detail.rebilled"), `~${kTokens(ledger.rebilled)}`],
    [t("detail.reclaimed"), `~${kTokens(ledger.reclaimed)}`],
    [t("detail.net"), t("detail.netValue", { tokens: `${ledger.net < 0 ? "−" : ""}${kTokens(Math.abs(ledger.net))}`, ratio: `${settings.priceHit}/${settings.priceMiss}` })],
  ]));

  // 6. Recent context changes (the dock's record)
  out.push("", t("detail.changes"));
  const events = readActivity(agent.session?.id).events.slice(-(options.changes || 5));
  if (!events.length) out.push(`  ${t("detail.changesNone")}`);
  const label = (event) =>
    event.layer === "L1" ? t("detail.changeL1")
      : event.layer === "L2" ? t(event.auto ? "detail.changeL2auto" : "detail.changeL2", { tier: event.tier || 1 })
        : event.layer === "ctx" ? t("detail.changeCtx")
          : t("detail.changeOfficial");
  out.push(...table(events.map((event) => [
    `${new Date(event.at).toTimeString().slice(0, 8)}  ${label(event)}${event.id ? `  ${event.id}` : ""}`,
    event.reclaimed ? t("detail.changeReclaimed", { tokens: kTokens(event.reclaimed) }) : "",
  ])));
  return out.join("\n");
}

/** Archives of sessions that are neither this one, open in this process, nor written by another live DSH. */
function endedRows(layer, agent) {
  const open = new Set([agent?.session?.id, ...(layer.engine?.sessionState?.keys?.() || [])].filter(Boolean).map((key) => sanitizeSessionKey(key)));
  open.add(sanitizeSessionKey(layer.state?.(agent)?.key));
  // This session's own folder, wherever its root is pinned.
  const own = layer.dir?.(agent);
  return endedArchives(archiveRootFor(layer.settings), { open }).filter((row) => row.dir !== own);
}

function purgeEnded(layer, agent, t, confirmed) {
  const rows = endedRows(layer, agent);
  if (!rows.length) return { kind: "success", text: t("purgeEnded.none") };
  if (!confirmed) {
    const bytes = rows.reduce((sum, row) => sum + row.bytes, 0);
    return { kind: "success", text: [t("purgeEnded.warning", { sessions: rows.length, mb: mb(bytes) }), t("purgeEnded.confirm")].join("\n") };
  }
  const removed = purgeSessions(rows);
  return { kind: "success", text: t("purgeEnded.done", { sessions: removed.sessions, files: removed.files, mb: mb(removed.bytes) }) };
}

/**
 * /strata [help | status | detail [full] | search <words> | purge [ended] [confirm]]
 * @param {any} layer - StrataLayer
 * @param {any} agent
 * @param {string} input - text after /strata
 * @param {{ language?: string }} [options]
 */
export function runCommand(layer, agent, input, options = {}) {
  const t = translator(options.language);
  const [verb = "", ...rest] = String(input || "").trim().split(/\s+/).filter(Boolean);
  switch (verb.toLowerCase()) {
    case "":
    case "help":
    case "?":
      return { kind: "success", text: helpText(t) };
    case "status":
      return { kind: "success", text: shortStatus(layer, agent, t) };
    case "detail":
      return { kind: "success", text: detailText(layer, agent, t, { full: /^(full|all)$/i.test(rest[0] || "") }) };
    case "search":
      if (!rest.length) return { kind: "error", text: t("searchUsage") };
      return { kind: "success", text: layer.search(agent, { query: rest.join(" "), limit: 10 }) };
    case "purge": {
      if ((rest[0] || "").toLowerCase() === "ended") return purgeEnded(layer, agent, t, (rest[1] || "").toLowerCase() === "confirm");
      if ((rest[0] || "").toLowerCase() !== "confirm") return { kind: "success", text: purgeWarning(t) };
      const removed = purgeArchive(layer.dir(agent));
      return { kind: "success", text: t("purge.done", { files: removed.files, mb: mb(removed.bytes) }) };
    }
    default:
      return { kind: "error", text: `${t("unknown", { verb })}\n${helpText(t)}` };
  }
}
