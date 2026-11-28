// Strata's read-only diagnosis status block (format 1).
//
// Another plugin's diagnosis session (DSH-Mem0's "let DSH diagnose") reads
// it through the `dshDiagnosisStrata` service (gate.js), and /strata detail
// ends with it so the user can copy it whole.
//
// The block itself is rendered by lib/diagnose-report.js, copied verbatim
// from DSH-Mem0 (source commit and sha256 in its header); the shared contract
// test (test/diagnosis-format.test.mjs) runs the fixture both plugins carry.
// This file only collects Strata's facts.
//
// Only counts, ratios, times and single words: no conversation text, no card
// or fold bodies, no tool arguments, no paths (the .bak path included), no
// keys. diagnose-report.js drops any value that is not a word, a
// non-negative number, an ISO time or a percentage, whole.

import { installedConflicts } from "./conflicts.js";
import { diagnosisBlock, diagnosisExtra } from "./diagnose-report.js";
import { hasActivitySession, lastActivityError, lastActivityRejection, latestActivitySession, readActivity } from "./activity.js";
import { readLedger } from "./ledger.js";
import { resetHint } from "./reset.js";
import { readSettings } from "./settings.js";

export const DIAGNOSIS_SERVICE = "dshDiagnosisStrata";
export const DIAGNOSIS_PLUGIN = "dsh-strata";
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
 * left out when there is no session, and, with `onlyKnown`, when this process
 * has nothing recorded for it (a session Strata never saw is not "0 folds").
 * @param {{ settings?: any, sessionId?: string | null, onlyKnown?: boolean, conflicts?: string[], reset?: any }} [options]
 * @returns {Record<string, string | number>}
 */
export function statusFacts({ settings = readSettings(), sessionId = latestActivitySession(), onlyKnown = false, conflicts, reset = resetHint() } = {}) {
  const facts = {};
  facts["x.mode"] = settings?.mode || "cost";
  facts["x.mode_source"] = SOURCES[settings?.modeSource] || "default";
  facts["x.auto_fold_pct"] = percent(settings?.autoFoldPct);
  if (sessionId && (!onlyKnown || knownSession(sessionId))) {
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

/** Has this process recorded anything for the session (activity or a ledger landing)? */
function knownSession(sessionId) {
  return hasActivitySession(sessionId) || readLedger(sessionId, 0, { priceMiss: 1, priceHit: 0 }).count > 0;
}

/**
 * The standard format-1 fields (DIAGNOSIS_FIELDS in diagnose-report.js) that
 * Strata has data for, as ordered pairs. Only `last_at`: the time of the last
 * failure or rejection, the same moment as x.last_issue_at. The rest of the
 * list describes one failure of a backend (type, component, endpoint, HTTP
 * status, message, durations, recovery) and Strata keeps none of it in a
 * form that fits, so it is left out.
 * @param {Record<string, unknown>} facts statusFacts output
 * @returns {Array<[string, string]>}
 */
export function standardFacts(facts) {
  // diagnosisBlock checks only the x. fields; standard ones are written as
  // given, so the time is normalised (and dropped if it is not one) here.
  const raw = facts?.["x.last_issue_at"];
  const at = typeof raw === "string" && /^\d{4}-\d{2}-\d{2}T/.test(raw) ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(at) ? [["last_at", new Date(at).toISOString()]] : [];
}

/**
 * The whole block for these facts: standard fields, then the x. fields, in a
 * `kind="status"` block from diagnose-report.js. "" when no field survives.
 * @param {Record<string, unknown>} facts
 * @param {{ version?: string }} [options]
 */
export function renderStatusBlock(facts, { version = "" } = {}) {
  const standard = standardFacts(facts);
  if (!standard.length && !diagnosisExtra(facts).length) return "";
  return diagnosisBlock(standard, { plugin: DIAGNOSIS_PLUGIN, version, kind: "status", extra: facts });
}

/**
 * The service: statusBlock({ lang, sessionId }) never throws; null when there
 * is nothing to say or anything fails. With `sessionId`, the session fields
 * are that session's (left out when this process has nothing for it);
 * without, they are the session written last in this process. `lang` is
 * accepted for the interface; keys and values are language-neutral.
 * @param {{ version?: string, collect?: typeof statusFacts }} [options]
 */
export function createDiagnosisService({ version = "", collect = statusFacts } = {}) {
  return {
    statusBlock({ sessionId } = {}) {
      try {
        const facts = sessionId ? collect({ sessionId: String(sessionId), onlyKnown: true }) : collect();
        return renderStatusBlock(facts, { version }) || null;
      } catch {
        return null;
      }
    },
  };
}
