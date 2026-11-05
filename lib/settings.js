// Tunables (design §3). The engine Config schema belongs to the stock engine,
// so Strata's own knobs are read from STRATA_* environment variables, the same
// way the forked L1 code reads its limits.

function num(env, name, fallback) {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * @param {Record<string, string | undefined>} [env]
 */
export function readSettings(env = process.env) {
  return {
    /** Fallback window when the routed model reports none. */
    contextWindow: num(env, "STRATA_CONTEXT_WINDOW", 1_000_000),
    /** L1 stops above this share of the window (design: 0.65, was a fixed 650K). */
    l1StopRatio: num(env, "STRATA_L1_STOP_RATIO", 0.65),
    /** Nudge when foldable tokens grew this much since the last fold / nudge. */
    nudgeGrowthTokens: num(env, "STRATA_NUDGE_GROWTH_TOKENS", 50_000),
    /** Above this share of the window, nudge every turn and land folds regardless of cost. */
    forcePct: num(env, "STRATA_FORCE_PCT", 0.75),
    /** Minimum batch reclaim; smaller batches stay pending. max(this, window × minBenefitRatio). */
    minBenefitTokens: num(env, "STRATA_MIN_BENEFIT_TOKENS", 5_000),
    minBenefitRatio: num(env, "STRATA_MIN_BENEFIT_RATIO", 0.01),
    /** Upgrades (T1→T2→T3) sit further forward, so they need a bigger batch (design §4). */
    upgradeBenefitFactor: num(env, "STRATA_UPGRADE_BENEFIT_FACTOR", 1.5),
    /** Relative prices per token: cache miss and cache hit. Only the ratio matters. */
    priceMiss: num(env, "STRATA_PRICE_MISS", 1),
    priceHit: num(env, "STRATA_PRICE_HIT", 0.1),
    /** Override for the expected number of remaining model requests. */
    expectedRequests: num(env, "STRATA_EXPECTED_REQUESTS", 0),
    /** decompress returns at most this many characters inline. */
    restoreMaxChars: num(env, "STRATA_RESTORE_MAX_CHARS", 24_000),
    /** A pending fold is dropped after this many deferred turn ends. */
    maxDeferTurns: num(env, "STRATA_MAX_DEFER_TURNS", 3),
    keepRounds: num(env, "STRATA_KEEP_ROUNDS", 3),
    /** Stale runtime-context tokens that justify their own sweep: max(this, window × minBenefitRatio). */
    staleSweepTokens: num(env, "STRATA_STALE_SWEEP_TOKENS", 8_000),
  };
}

/** @typedef {ReturnType<typeof readSettings>} StrataSettings */

/** @param {StrataSettings} settings @param {number} window @param {boolean} [upgrade] */
export function minBenefitFor(settings, window, upgrade = false) {
  const base = Math.max(settings.minBenefitTokens, Math.floor(window * settings.minBenefitRatio));
  return upgrade ? Math.ceil(base * settings.upgradeBenefitFactor) : base;
}
