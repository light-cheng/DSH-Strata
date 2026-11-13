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

/**
 * A landing refused by a check (too small, does not pay back, the surface
 * changed, the summary is not smaller). Not a failure: it is reported as a
 * rejection (tool result, strata_status, /strata detail) and never turns the
 * dock red.
 */
export class StrataRejection extends Error {
  constructor(message) {
    super(message);
    this.name = "StrataRejection";
    this.rejection = true;
  }
}

/** @param {unknown} error */
export function isRejection(error) {
  return Boolean(error && typeof error === "object" && (/** @type {any} */ (error).rejection === true));
}

/**
 * The cost check: the saving over the expected remaining requests covers the
 * miss, and it does so within `maxPayback` requests.
 * @param {{ worthIt: boolean, paybackRequests: number }} estimate
 */
export function paysBack(estimate, maxPayback = Number.POSITIVE_INFINITY) {
  return estimate.worthIt && estimate.paybackRequests <= maxPayback;
}

/**
 * Minimum-gain gate for one landing (L1 card, a single model or automatic
 * fold). Reclaim is compared in provider tokens (local estimate × the
 * session's provider/heuristic ratio). Above the force line the cost check is
 * skipped, the size floor is not.
 * @param {{ estimate: ReturnType<typeof estimateFold>, scale?: number, minTokens: number, remainingRequests?: number, forced?: boolean }} input
 * @returns {{ ok: true } | { ok: false, code: "small" | "payback", reason: string }}
 */
export function landingGate({ estimate, scale = 1, minTokens, remainingRequests, maxPayback = Number.POSITIVE_INFINITY, forced = false }) {
  const provider = Math.round(estimate.reclaimed * (scale > 0 ? scale : 1));
  if (provider < minTokens) {
    return { ok: false, code: "small", reason: `reclaims only ~${kTokens(provider)} tokens, below the ${kTokens(minTokens)} minimum per landing` };
  }
  if (!forced && !paysBack(estimate, maxPayback)) {
    const payback = Number.isFinite(estimate.paybackRequests) ? `~${estimate.paybackRequests}` : "never";
    const limit = Math.min(Number.isFinite(remainingRequests) ? remainingRequests : Number.POSITIVE_INFINITY, maxPayback);
    const left = Number.isFinite(limit) ? `, more than the ~${limit} allowed (${limit === maxPayback ? "payback limit" : "requests expected to remain"})` : "";
    return { ok: false, code: "payback", reason: `the cache miss on ~${kTokens(estimate.missTokens)} tokens pays back after ${payback} requests${left}` };
  }
  return { ok: true };
}
