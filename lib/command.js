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
import { purgeArchive } from "./archive.js";
import { kTokens } from "./economics.js";
import { readLedger } from "./ledger.js";

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

/** Monospace columns: CJK and full-width characters take two. */
export function displayWidth(text) {
  let width = 0;
  for (const char of String(text)) {
    const code = char.codePointAt(0) || 0;
    width += (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) ? 2 : 1;
  }
  return width;
}

const padEnd = (text, width) => `${text}${" ".repeat(Math.max(0, width - displayWidth(text)))}`;
const padStart = (text, width) => `${" ".repeat(Math.max(0, width - displayWidth(text)))}${text}`;

/**
 * Rows of cells; the first column is left-aligned, the others right-aligned.
 * @param {string[][]} rows
 */
export function table(rows, indent = "  ") {
  const widths = [];
  for (const row of rows) row.forEach((cell, index) => (widths[index] = Math.max(widths[index] || 0, displayWidth(cell))));
  return rows.map((row) => `${indent}${row.map((cell, index) => (index === 0 ? padEnd(cell, widths[0]) : padStart(cell, widths[index]))).join("   ")}`.trimEnd());
}

/** Label / value pairs: labels padded, values left as written. */
function pairs(rows, indent = "  ") {
  const width = Math.max(...rows.map(([label]) => displayWidth(label)));
  return rows.map(([label, value]) => `${indent}${padEnd(label, width)}   ${value}`);
}

/** The engine's control state, localized when it is the usual "active (...)". */
const stateOf = (snap, t) => (/^active\b/.test(snap.control) ? t("active") : snap.control);

const pct = (value) => (Number.isFinite(value) ? `${Math.round(value * 1000) / 10}%` : "n/a");
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

// ------------------------------------------------------------------ texts

export function helpText(t) {
  const rows = [
    ["/strata status", t("help.status")],
    ["/strata detail", t("help.detail")],
    ["/strata detail full", t("help.detailFull")],
    ["/strata search <…>", `${t("help.search")}  (${t("help.searchExample")})`],
    ["/strata purge", t("help.purge")],
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
  if (configError) lines.push(t("detail.warning", { text: `DSH's automatic compaction is off for ${configError.targetKey}: ${String(configError.message).slice(0, 300)}` }));
  const failure = layer.engine?.officialFailure;
  if (failure) lines.push(t("detail.warning", { text: `DSH's official summary (L∞) failed ${failure.count} time(s) in a row: ${String(failure.message).slice(0, 200)}` }));
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
  out.push(...pairs([
    [t("detail.used"), `~${kTokens(snap.totalTokens)}  (${pct(snap.totalTokens / snap.window)})`],
    [t("detail.window"), `${kTokens(snap.window)}  (${t(fromProvider ? "detail.windowProvider" : "detail.windowFallback")})`],
    [t("detail.fixed"), `~${kTokens(snap.fixedTokens)}  (${pct(snap.fixedTokens / snap.window)})`],
    [t("detail.ratio"), `×${(snap.scale || 1).toFixed(2)}`],
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
    [t("detail.dropped"), "", String(s.dropped.count)],
  ]));

  // 3. Automatic folds
  const target = snap.fixedTokens + settings.autoFoldTargetPct * Math.max(0, snap.window - snap.fixedTokens);
  const tail = snap.layout?.tail;
  out.push("", t("detail.auto"));
  out.push(...pairs([
    [t("detail.rule"), settings.autoFold
      ? t("detail.ruleOn", { pct: pct(settings.autoFoldPct), nudges: settings.autoFoldAfterNudges, force: pct(settings.autoFoldForcePct), target: kTokens(target), targetPct: pct(settings.autoFoldTargetPct) })
      : t("detail.ruleOff")],
    [t("detail.last"), snap.lastAutoFold ? snap.lastAutoFold.outcome : t("detail.lastNone")],
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
    [t("detail.archive"), `${mb(snap.archiveBytes)} MB`],
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

/**
 * /strata [help | status | detail [full] | search <words> | purge [confirm]]
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
      if ((rest[0] || "").toLowerCase() !== "confirm") return { kind: "success", text: purgeWarning(t) };
      const removed = purgeArchive(layer.dir(agent));
      return { kind: "success", text: t("purge.done", { files: removed.files, mb: mb(removed.bytes) }) };
    }
    default:
      return { kind: "error", text: `${t("unknown", { verb })}\n${helpText(t)}` };
  }
}
