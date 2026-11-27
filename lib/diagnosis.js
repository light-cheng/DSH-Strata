// Strata's read-only diagnosis status block (part 1, format pending).
//
// Another plugin's diagnosis session (DSH-Mem0's "let DSH diagnose") reads
// it through the `dshDiagnosisStrata` service (gate.js), and /strata detail
// ends with it so the user can copy it whole.
//
// TEMPORARY: renderStatusBlock below is a local stand-in. Once format 1 is
// final, replace it with diagnose-report.js copied from DSH-Mem0 (source repo,
// commit and format version in its header) and add the shared contract test.
//
// Only counts, ratios, times and single words: no conversation text, no card
// or fold bodies, no tool arguments, no paths (the .bak path included), no
// keys. Every value goes through a whitelist; a value that fails is dropped
// whole, never cut to half a sentence.

import { installedConflicts } from "./conflicts.js";
import { lastActivityError, lastActivityRejection, latestActivitySession, readActivity } from "./activity.js";
import { readLedger } from "./ledger.js";
import { resetHint } from "./reset.js";
import { readSettings } from "./settings.js";

export const DIAGNOSIS_SERVICE = "dshDiagnosisStrata";
export const DIAGNOSIS_PLUGIN = "dsh-strata";
export const DIAGNOSIS_FORMAT = "1";
/** At most this many x. fields in one block. */
export const MAX_X_FIELDS = 12;

const X_KEY = /^x\.[a-z0-9_]{1,32}$/;
// Same word rule as DSH-Mem0's diagnose-report.js.
const WORD = /^[A-Za-z0-9_.-]{1,40}$/;
const NUMBER = /^-?\d{1,15}(?:\.\d{1,6})?$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const PERCENT = /^\d{1,3}(?:\.\d{1,2})?%$/;

/** A value fit for the block (a word, a number, an ISO time or a percentage), else null. */
export function cleanValue(value) {
  if (value === null || value === undefined || typeof value === "object") return null;
  if (typeof value === "number") return Number.isFinite(value) ? cleanValue(String(value)) : null;
  const text = String(value);
  if (NUMBER.test(text) || ISO.test(text) || PERCENT.test(text) || WORD.test(text)) return text;
  return null;
}

const percent = (ratio) => (Number.isFinite(ratio) && ratio >= 0 ? `${Math.round(ratio * 1000) / 10}%` : null);
const iso = (at) => (Number.isFinite(at) && at > 0 ? new Date(at).toISOString() : null);
const SOURCES = { env: "env", page: "settings", default: "default" };

// Conflicts the gate found in the resolved config (configConflicts), shared per process.
const CONFLICTS = Symbol.for("@lightcheng/dsh-strata/diagnosis-conflicts");

/** gate.js: the conflicting rows it saw in the last resolved preset config. */
export function noteConfigConflicts(names) {
  globalThis[CONFLICTS] = Array.isArray(names) ? names.map(String) : [];
}

function notedConflicts() {
  return Array.isArray(globalThis[CONFLICTS]) ? globalThis[CONFLICTS] : [];
}

/** A package name as one word: "@scope/name" → "scope.name". */
export function conflictWord(name) {
  return String(name || "").replace(/^@/, "").replace(/\//g, ".");
}

/** The last failure or rejection of the session, whichever is newer: `{ type, at }` or null. */
function lastIssue(sessionId) {
  const error = lastActivityError(sessionId);
  const rejection = lastActivityRejection(sessionId);
  const fromError = error && { type: `${error.layer === "L1" ? "card" : "fold"}_${error.timeout ? "timeout" : "failed"}`, at: error.at };
  const fromRejection = rejection && { type: "rejected", at: rejection.at };
  if (fromError && fromRejection) return fromRejection.at > fromError.at ? fromRejection : fromError;
  return fromError || fromRejection || null;
}

/**
 * The nine x. facts, from what Strata already keeps (settings, the activity
 * record, the ledger, the conflict check, the reset hint). Session fields are
 * left out when there is no session.
 * @param {{ settings?: any, sessionId?: string | null, conflicts?: string[], reset?: any }} [options]
 * @returns {Record<string, string | number>}
 */
export function statusFacts({ settings = readSettings(), sessionId = latestActivitySession(), conflicts, reset = resetHint() } = {}) {
  const facts = {};
  facts["x.mode"] = settings?.mode || "cost";
  facts["x.mode_source"] = SOURCES[settings?.modeSource] || "default";
  facts["x.auto_fold_pct"] = percent(settings?.autoFoldPct);
  if (sessionId) {
    const usage = readActivity(sessionId).usage;
    if (usage && usage.window > 0) facts["x.context_pct"] = percent(usage.totalTokens / usage.window);
    facts["x.fold_count"] = readLedger(sessionId, 0, { priceMiss: 1, priceHit: 0 }).count;
    const issue = lastIssue(sessionId);
    facts["x.last_issue"] = issue ? issue.type : "none";
    if (issue) facts["x.last_issue_at"] = iso(issue.at);
  }
  const names = conflicts ?? [...new Set([...installedConflicts().map((item) => item.name), ...notedConflicts()])];
  facts["x.conflict"] = names.length ? conflictWord(names[0]) : "none";
  facts["x.settings_reset"] = reset ? "yes" : "no";
  return facts;
}

/**
 * TEMPORARY local renderer: replace with DSH-Mem0's diagnose-report.js once
 * format 1 is final. One `key: value` per line between the header and footer;
 * keys that are not x.<word> and values that fail the whitelist are dropped.
 * @param {Record<string, unknown>} facts
 * @param {{ version?: string }} [options]
 */
export function renderStatusBlock(facts, { version = "" } = {}) {
  const lines = [];
  for (const [key, raw] of Object.entries(facts || {})) {
    if (!X_KEY.test(key) || lines.length >= MAX_X_FIELDS) continue;
    const value = cleanValue(raw);
    if (value !== null) lines.push(`${key}: ${value}`);
  }
  if (!lines.length) return "";
  const v = String(version || "").replace(/[^0-9A-Za-z.+-]/g, "");
  const attrs = [`plugin="${DIAGNOSIS_PLUGIN}"`, `format="${DIAGNOSIS_FORMAT}"`, `kind="status"`, ...(v ? [`version="${v}"`] : [])];
  return [`<dsh-diagnosis ${attrs.join(" ")}>`, ...lines, "</dsh-diagnosis>"].join("\n");
}

/**
 * The service's statusBlock: never throws; null when there is nothing to say
 * or anything fails. `lang` is accepted for the interface; keys and values are
 * language-neutral.
 * @param {{ version?: string, collect?: typeof statusFacts }} [options]
 */
export function createDiagnosisService({ version = "", collect = statusFacts } = {}) {
  return {
    statusBlock(_options = {}) {
      try {
        return renderStatusBlock(collect(), { version }) || null;
      } catch {
        return null;
      }
    },
  };
}
