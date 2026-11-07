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
const off = (value) => /^(0|off|false|no)$/i.test(String(value ?? "").trim());

/**
 * Presets (STRATA_PRESET). "cost" (default) folds late and only at turn end:
 * fewer cache misses, more context carried. "quality" keeps the context small:
 * lower lines and target, and automatic digests may also land mid-turn.
 * Explicit STRATA_* values override the preset.
 */
export const PRESETS = {
  cost: { autoFoldPct: 0.5, autoFoldForcePct: 0.6, autoFoldTargetPct: 0.3, nudge: true, midTurnFold: false },
  quality: { autoFoldPct: 0.25, autoFoldForcePct: 0.35, autoFoldTargetPct: 0.15, nudge: true, midTurnFold: true },
};

export function readSettings(env = process.env) {
  const presetName = String(env.STRATA_PRESET || "cost").trim().toLowerCase() === "quality" ? "quality" : "cost";
  const preset = PRESETS[presetName];
  const flag = (name, fallback) => (env[name] === undefined || String(env[name]).trim() === "" ? fallback : !off(env[name]));
  return {
    /** "cost" or "quality" (see PRESETS). */
    preset: presetName,
    /** L2 nudges (the model is asked to fold). STRATA_NUDGE=off leaves folding to automatic digests; compress stays available. */
    nudge: flag("STRATA_NUDGE", preset.nudge),
    /** Quality preset only: land automatic digests of earlier turns before a step when context is above the force line. */
    midTurnFold: presetName === "quality" && flag("STRATA_MID_TURN_FOLD", preset.midTurnFold),
    /** Fallback window when the routed model reports none. */
    contextWindow: num(env, "STRATA_CONTEXT_WINDOW", 1_000_000),
    /** L1 stops above this share of the window (design: 0.65, was a fixed 650K). */
    l1StopRatio: num(env, "STRATA_L1_STOP_RATIO", 0.65),
    /** Nudge when foldable tokens grew this much since the last fold / nudge. */
    nudgeGrowthTokens: num(env, "STRATA_NUDGE_GROWTH_TOKENS", 50_000),
    /** Above this share of the window, nudge every turn and land folds regardless of cost. */
    forcePct: num(env, "STRATA_FORCE_PCT", 0.75),
    /** An ignored nudge re-arms after this share of nudgeGrowthTokens (below forcePct). */
    nudgeRearmRatio: num(env, "STRATA_NUDGE_REARM_RATIO", 0.5),
    /** ... and after this share above forcePct. */
    nudgeForcedRearmRatio: num(env, "STRATA_NUDGE_FORCED_REARM_RATIO", 0.25),
    /** Model-free folds (automatic extractive digests). STRATA_AUTO_FOLD=off disables them. */
    autoFold: !off(env.STRATA_AUTO_FOLD ?? "on"),
    /** Fold automatically at turn end above this share once autoFoldAfterNudges nudges went unanswered ... */
    autoFoldPct: num(env, "STRATA_AUTO_FOLD_PCT", preset.autoFoldPct),
    autoFoldAfterNudges: num(env, "STRATA_AUTO_FOLD_AFTER_NUDGES", 2),
    /** ... and above this share regardless of nudges. */
    autoFoldForcePct: num(env, "STRATA_AUTO_FOLD_FORCE_PCT", preset.autoFoldForcePct),
    /** Fold the oldest runs until the context would drop to about this share. */
    autoFoldTargetPct: num(env, "STRATA_AUTO_FOLD_TARGET_PCT", preset.autoFoldTargetPct),
    /** A digest keeps at most this share of the folded text (characters), at least 1200 characters. */
    autoDigestRatio: num(env, "STRATA_AUTO_DIGEST_RATIO", 0.12),
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
    /** Cap on the protected tail, as a share of the window in provider tokens; 0 or off disables it. The newest round always stays. */
    protectedTailPct: off(env.STRATA_PROTECTED_TAIL_PCT) ? 0 : num(env, "STRATA_PROTECTED_TAIL_PCT", 0.1),
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
