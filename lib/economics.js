// Prefix-cache cost/benefit of landing a fold (design §4).
//
// DeepSeek bills a request prefix as cache hit only up to the first changed
// byte. A fold that starts at position P re-bills everything after P once as a
// miss on the next request. In exchange every later request carries
// `reclaimed` fewer tokens.
//
//   cost    = (tokensFromStart − reclaimed) × (priceMiss − priceHit)   one time
//   benefit = reclaimed × priceHit × remainingRequests
//
// Both are in "relative price × tokens"; only the ratio priceHit/priceMiss
// matters. The estimate ignores the value of staying under the window (that is
// what the force threshold is for).

/**
 * @param {{ tokensFromStart: number, reclaimed: number, remainingRequests: number, priceMiss: number, priceHit: number }} input
 */
export function estimateFold({ tokensFromStart, reclaimed, remainingRequests, priceMiss, priceHit }) {
  const r = Math.max(0, reclaimed);
  const tail = Math.max(0, tokensFromStart - r);
  const cost = tail * Math.max(0, priceMiss - priceHit);
  const perRequest = r * priceHit;
  const benefit = perRequest * Math.max(0, remainingRequests);
  const paybackRequests = perRequest > 0 ? Math.ceil(cost / perRequest) : Number.POSITIVE_INFINITY;
  return {
    reclaimed: r,
    missTokens: tail,
    cost,
    benefit,
    paybackRequests,
    worthIt: r > 0 && benefit >= cost,
  };
}

/**
 * Expected remaining model requests: at least as many as this session has
 * already made (a Lindy-style guess), clamped to [4, 200].
 * @param {number} requestsSoFar
 * @param {number} [override]
 */
export function expectedRemainingRequests(requestsSoFar, override = 0) {
  if (override > 0) return override;
  return Math.min(200, Math.max(4, requestsSoFar));
}

/** Compact token count for messages: 18234 → "18.2K". */
export function kTokens(tokens) {
  if (!Number.isFinite(tokens)) return "∞";
  if (Math.abs(tokens) < 1000) return String(Math.round(tokens));
  return `${(tokens / 1000).toFixed(1)}K`;
}

/** One-line human/model readable estimate. */
export function describeEstimate(estimate) {
  const payback = Number.isFinite(estimate.paybackRequests) ? `${estimate.paybackRequests} requests` : "never";
  return `reclaim ~${kTokens(estimate.reclaimed)} tokens; one-time cache miss on ~${kTokens(estimate.missTokens)} tokens; pays back after ~${payback}`;
}
