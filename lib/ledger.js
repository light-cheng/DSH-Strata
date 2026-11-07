// Per-session ledger of landed context changes (cards, folds, official
// summaries, dropped snapshots) for /strata detail.
//
// recordChange keeps only the last 20 changes; this keeps running totals, so
// the cost of every change since the process started is counted once. Like
// activity.js it lives in memory, per DSH process.
//
// Prices follow economics.js: a change starting at P re-bills tokensFromStart
// once, of which (tokensFromStart − reclaimed) is a cache miss that would have
// been a hit; every later request then carries `reclaimed` fewer hit tokens.

const MAX_SESSIONS = 64;

/** @type {Map<string, { count: number, byLayer: Record<string, number>, rebilled: number, reclaimed: number, missTokens: number, reclaimedAtRequest: number, projectedHit: number, last: any }>} */
const sessions = new Map();

/**
 * @param {string} sessionId
 * @param {{ layer?: string, id?: string, tokensFromStart?: number, reclaimed?: number, remainingRequests?: number }} change
 * @param {number} requests - model requests made before this change landed
 *
 * remainingRequests is the cost check's guess at landing (economics.js
 * expectedRemainingRequests): the projected saving uses it.
 */
export function recordLedger(sessionId, change, requests) {
  if (!sessionId) return;
  const key = String(sessionId);
  let item = sessions.get(key);
  if (!item) {
    item = { count: 0, byLayer: {}, rebilled: 0, reclaimed: 0, missTokens: 0, reclaimedAtRequest: 0, projectedHit: 0, last: null };
    sessions.set(key, item);
    while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  }
  const fromStart = Math.max(0, Number(change?.tokensFromStart) || 0);
  const reclaimed = Math.max(0, Number(change?.reclaimed) || 0);
  const layer = String(change?.layer || "?");
  item.count += 1;
  item.byLayer[layer] = (item.byLayer[layer] || 0) + 1;
  item.rebilled += fromStart;
  item.reclaimed += reclaimed;
  item.missTokens += Math.max(0, fromStart - reclaimed);
  const at = Math.max(0, Number(requests) || 0);
  const remaining = Math.max(0, Number(change?.remainingRequests) || 0);
  item.reclaimedAtRequest += reclaimed * at;
  item.projectedHit += reclaimed * remaining;
  item.last = { layer, id: String(change?.id || "").slice(0, 40), landing: String(change?.landing || ""), missTokens: Math.max(0, fromStart - reclaimed), reclaimed, request: at, remaining };
}

/** Requests after which a change's hit savings cover its one-time miss cost (∞ when it reclaims nothing). */
function paybackOf(missTokens, reclaimed, miss, hit) {
  const perRequest = reclaimed * hit;
  const cost = missTokens * Math.max(0, miss - hit);
  if (cost <= 0) return 0;
  return perRequest > 0 ? Math.ceil(cost / perRequest) : Number.POSITIVE_INFINITY;
}

/**
 * Totals and the estimated net saving after `requestsNow` requests, in
 * tokens at the cache-miss price (relative prices from settings).
 * @param {string} sessionId
 * @param {number} requestsNow
 * @param {{ priceMiss: number, priceHit: number }} prices
 */
export function readLedger(sessionId, requestsNow, prices) {
  const item = sessions.get(String(sessionId || ""));
  if (!item) return { count: 0, byLayer: {}, rebilled: 0, reclaimed: 0, cost: 0, benefit: 0, net: 0, perRequest: 0, toBreakEven: 0, projectedNet: 0, last: null };
  const miss = prices.priceMiss > 0 ? prices.priceMiss : 1;
  const hit = Math.max(0, prices.priceHit);
  const now = Math.max(0, Number(requestsNow) || 0);
  // Hit tokens not sent again: each change saves `reclaimed` on every request after it.
  const savedRequests = Math.max(0, item.reclaimed * now - item.reclaimedAtRequest);
  const cost = (item.missTokens * Math.max(0, miss - hit)) / miss;
  const benefit = (savedRequests * hit) / miss;
  const net = benefit - cost;
  // From here on every request saves this much (all changes so far apply).
  const perRequest = (item.reclaimed * hit) / miss;
  const toBreakEven = net >= 0 ? 0 : perRequest > 0 ? Math.ceil(-net / perRequest) : Number.POSITIVE_INFINITY;
  // What the cost checks expected: each change's saving over the requests it guessed were left.
  const projectedNet = (item.projectedHit * hit) / miss - cost;
  const last = item.last
    ? { ...item.last, payback: paybackOf(item.last.missTokens, item.last.reclaimed, miss, hit), since: Math.max(0, now - item.last.request) }
    : null;
  return { count: item.count, byLayer: { ...item.byLayer }, rebilled: item.rebilled, reclaimed: item.reclaimed, cost, benefit, net, perRequest, toBreakEven, projectedNet, last };
}

/** Tests only. */
export function resetLedger() {
  sessions.clear();
}
