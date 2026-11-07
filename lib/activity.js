// Per-session activity for the composer dock (v0.2.0).
//
// Every preset runs its own Strata engine, but they all load this module once
// per process, so the record is shared and the status route can answer for
// any session. Nothing here is persisted; it describes what happened in this
// DSH process since it started.

const MAX_SESSIONS = 64;
const MAX_EVENTS = 8;

/** @type {Map<string, { events: any[], error: any, lastError: any, usage: any, busy: number }>} */
const sessions = new Map();

function entry(sessionId) {
  const key = String(sessionId || "");
  let item = sessions.get(key);
  if (item) {
    sessions.delete(key);
    sessions.set(key, item);
    return item;
  }
  item = { events: [], error: null, lastError: null, usage: null, busy: 0 };
  sessions.set(key, item);
  while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  return item;
}

/**
 * A layer changed the context: L1 card, L2 fold landing, L∞ official summary.
 * @param {string} sessionId
 * @param {{ layer: "L1" | "L2" | "L∞", id?: string, reclaimed?: number, tier?: number, auto?: boolean }} change
 */
export function recordActivity(sessionId, change) {
  if (!sessionId) return;
  const item = entry(sessionId);
  item.events.push({
    layer: change.layer,
    id: String(change.id || ""),
    reclaimed: Math.max(0, Math.round(change.reclaimed || 0)),
    tier: change.tier || 0,
    ...(change.auto ? { auto: true } : {}),
    at: Date.now(),
  });
  if (item.events.length > MAX_EVENTS) item.events.splice(0, item.events.length - MAX_EVENTS);
  // A card, fold or summary landing clears the dock's red; a stale-context sweep says nothing about them.
  if (change.layer !== "ctx") item.error = null;
}

/**
 * Error text safe to show and to send to the dock: Strata's own wording only.
 * Quoted parts (paths, payloads, anything a message or tool result could put
 * in an error) are replaced with "…", whitespace collapsed, cut to 160 chars.
 * @param {unknown} message
 */
export function scrubErrorMessage(message) {
  let text = String(message ?? "");
  text = text
    .replace(/<([A-Za-z][\w:-]*)[^<>]*>[\s\S]*?<\/\1>/g, "…")
    .replace(/"[^"\n]*"|'[^'\n]*'|`[^`\n]*`|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|<[^<>\n]{0,400}>/g, "…")
    .replace(/[A-Za-z]:\\[^\s,;)]+|(?:^|\s)\/(?:[^\s/,;)]+\/)+[^\s,;)]*/g, (match) => (match.startsWith(" ") ? " …" : "…"))
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

/** Was this failure a cancellation (the user stopped the turn), not a fault? Timeouts are faults. */
export function isCancellation(error, signal) {
  if (signal?.aborted) return signal.reason?.name !== "TimeoutError";
  return error?.name === "AbortError";
}

/**
 * A cut or a fold failed; the dock turns red until the next success.
 * /strata detail keeps showing the last one (layer, id, time, message).
 * @param {string} sessionId
 * @param {"L1" | "L2"} layer
 * @param {unknown} message
 * @param {{ id?: string, timeout?: boolean }} [extra]
 */
export function recordActivityError(sessionId, layer, message, extra = {}) {
  if (!sessionId) return;
  const error = { layer, message: scrubErrorMessage(message), at: Date.now(), ...(extra.id ? { id: String(extra.id).slice(0, 40) } : {}), ...(extra.timeout ? { timeout: true } : {}) };
  const item = entry(sessionId);
  item.error = error;
  item.lastError = error;
}

/** Usage after a turn end: total tokens, window and folds per tier. */
export function recordUsage(sessionId, usage) {
  if (!sessionId) return;
  entry(sessionId).usage = { ...usage, at: Date.now() };
}

/** Maintenance in progress (turn-end flush and cut). Nested calls are counted. */
export function markBusy(sessionId, busy) {
  if (!sessionId) return;
  const item = entry(sessionId);
  item.busy = Math.max(0, item.busy + (busy ? 1 : -1));
}

/** @param {string} sessionId */
export function readActivity(sessionId) {
  const item = sessions.get(String(sessionId || ""));
  if (!item) return { events: [], error: null, usage: null, busy: false };
  return { events: [...item.events], error: item.error, usage: item.usage, busy: item.busy > 0 };
}

/** The last failure of this process for the session, kept after later successes (for /strata detail). */
export function lastActivityError(sessionId) {
  return sessions.get(String(sessionId || ""))?.lastError || null;
}

/** Tests only. */
export function resetActivity() {
  sessions.clear();
}
