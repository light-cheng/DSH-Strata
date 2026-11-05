// Per-session activity for the composer dock (v0.2.0).
//
// Every preset runs its own Strata engine, but they all load this module once
// per process, so the record is shared and the status route can answer for
// any session. Nothing here is persisted; it describes what happened in this
// DSH process since it started.

const MAX_SESSIONS = 64;
const MAX_EVENTS = 8;

/** @type {Map<string, { events: any[], error: any, usage: any, busy: number }>} */
const sessions = new Map();

function entry(sessionId) {
  const key = String(sessionId || "");
  let item = sessions.get(key);
  if (item) {
    sessions.delete(key);
    sessions.set(key, item);
    return item;
  }
  item = { events: [], error: null, usage: null, busy: 0 };
  sessions.set(key, item);
  while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  return item;
}

/**
 * A layer changed the context: L1 card, L2 fold landing, L∞ official summary.
 * @param {string} sessionId
 * @param {{ layer: "L1" | "L2" | "L∞", id?: string, reclaimed?: number, tier?: number }} change
 */
export function recordActivity(sessionId, change) {
  if (!sessionId) return;
  const item = entry(sessionId);
  item.events.push({
    layer: change.layer,
    id: String(change.id || ""),
    reclaimed: Math.max(0, Math.round(change.reclaimed || 0)),
    tier: change.tier || 0,
    at: Date.now(),
  });
  if (item.events.length > MAX_EVENTS) item.events.splice(0, item.events.length - MAX_EVENTS);
  item.error = null;
}

/** A cut or a fold failed; the dock turns red until the next success. */
export function recordActivityError(sessionId, layer, message) {
  if (!sessionId) return;
  entry(sessionId).error = { layer, message: String(message || "").slice(0, 240), at: Date.now() };
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

/** Tests only. */
export function resetActivity() {
  sessions.clear();
}
