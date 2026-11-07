// Tunables (design §3).
//
// Precedence for every knob: STRATA_* environment variable > the settings page
// (the strata-gate row's Config, published into a process-wide store by
// gate.js) > the built-in default. Internal knobs (price ratio, upgrade factor,
// minimum batch, L1 caps, ...) are environment-only and not on the page.
//
// The engine of a preset row is built from the row the gate rewrites, so it
// never sees the gate's Config directly: the gate publishes its values here and
// every StrataLayer reads them through liveSettings(), which re-reads when the
// page or the environment changes. Mode and line changes therefore apply at the
// next turn end or step of every open session; the archive location applies to
// sessions that start after the change.

function num(env, name, fallback) {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const off = (value) => /^(0|off|false|no)$/i.test(String(value ?? "").trim());
const has = (env, name) => env[name] !== undefined && String(env[name]).trim() !== "";

/**
 * Modes (settings page `mode`, env STRATA_PRESET). "cost" (default) folds late
 * and only at turn end: fewer cache misses, more context carried. "quality"
 * keeps the context small: lower lines and target, and automatic digests may
 * also land mid-turn. "custom" takes the advanced fields of the page.
 * Explicit STRATA_* values override the mode.
 */
export const PRESETS = {
  cost: { autoFoldPct: 0.5, autoFoldForcePct: 0.6, autoFoldTargetPct: 0.3, protectedTailPct: 0.1, nudge: true, midTurnFold: false, midTurnCurrent: false },
  quality: { autoFoldPct: 0.25, autoFoldForcePct: 0.35, autoFoldTargetPct: 0.15, protectedTailPct: 0.1, nudge: true, midTurnFold: true, midTurnCurrent: false },
};
export const MODES = ["cost", "quality", "custom"];

/** Page defaults. Custom starts from the cost values. */
export const PAGE_DEFAULTS = {
  mode: "cost",
  autoFold: true,
  nudge: true,
  autoFoldPct: 50,
  autoFoldForcePct: 60,
  autoFoldTargetPct: 30,
  protectedTailPct: 10,
  midTurnFold: false,
  midTurnCurrent: false,
  archiveDir: "",
  archiveMaxMB: 1024,
  archiveKeepDays: 0,
};

// ------------------------------------------------------------------ store

const STORE = Symbol.for("@lightcheng/dsh-strata/settings-page");
/** @returns {{ values: Record<string, any> | null, version: number }} */
function store() {
  globalThis[STORE] ??= { values: null, version: 0 };
  return globalThis[STORE];
}

/** Unwrap a schemastery volatile reference, leaving plain objects as they are. */
export function unwrapConfig(raw) {
  const value = raw && typeof raw.get === "function" ? raw.get() : raw;
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** Publish the settings page's values (gate.js). null clears them. */
export function setPageConfig(raw) {
  const s = store();
  s.values = raw == null ? null : { ...unwrapConfig(raw) };
  s.version += 1;
}

/** The values the page last published (raw, before defaults). */
export function pageConfig() {
  return store().values;
}

// ------------------------------------------------------------------ resolve

const ratio = (value, fallback, { allowZero = false } = {}) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) return fallback;
  return n > 1 ? n / 100 : n;
};

/**
 * @param {Record<string, string | undefined>} [env]
 * @param {Record<string, any> | null} [page] - settings page values (raw)
 */
export function readSettings(env = process.env, page = pageConfig()) {
  const p = page && typeof page === "object" ? page : {};
  const pageHas = (key) => p[key] !== undefined && p[key] !== null && p[key] !== "";
  const envMode = has(env, "STRATA_PRESET") ? String(env.STRATA_PRESET).trim().toLowerCase() : "";
  const pageMode = pageHas("mode") ? String(p.mode).trim().toLowerCase() : "";
  const modeOf = (value) => (MODES.includes(value) ? value : "cost");
  const mode = envMode ? modeOf(envMode) : pageMode ? modeOf(pageMode) : "cost";
  // The page always carries every key (its Config fills defaults), so the
  // default mode reads as "default", not "page".
  const modeSource = envMode ? "env" : pageMode && pageMode !== PAGE_DEFAULTS.mode ? "page" : "default";
  // Custom starts from cost and takes the page's advanced fields.
  const base = mode === "custom"
    ? {
      autoFoldPct: ratio(p.autoFoldPct, PRESETS.cost.autoFoldPct),
      autoFoldForcePct: ratio(p.autoFoldForcePct, PRESETS.cost.autoFoldForcePct),
      autoFoldTargetPct: ratio(p.autoFoldTargetPct, PRESETS.cost.autoFoldTargetPct),
      protectedTailPct: ratio(p.protectedTailPct, PRESETS.cost.protectedTailPct, { allowZero: true }),
      midTurnFold: typeof p.midTurnFold === "boolean" ? p.midTurnFold : PAGE_DEFAULTS.midTurnFold,
      midTurnCurrent: typeof p.midTurnCurrent === "boolean" ? p.midTurnCurrent : PAGE_DEFAULTS.midTurnCurrent,
    }
    : PRESETS[mode];
  const flag = (name, fallback) => (has(env, name) ? !off(env[name]) : fallback);
  const pageFlag = (key, fallback) => (typeof p[key] === "boolean" ? p[key] : fallback);
  // Mid-turn digests: quality or custom only (cost stays turn-end only).
  const midTurnAllowed = mode !== "cost";
  const midTurnFold = midTurnAllowed && flag("STRATA_MID_TURN_FOLD", base.midTurnFold);
  return {
    /** "cost", "quality" or "custom" (see PRESETS). Kept as `preset` for older readers. */
    preset: mode,
    mode,
    /** Where the mode came from: "env", "page" or "default". */
    modeSource,
    /** L2 nudges (the model is asked to fold). Off leaves folding to automatic digests; compress stays available. */
    nudge: flag("STRATA_NUDGE", pageFlag("nudge", base.nudge)),
    /** Quality / custom: land automatic digests of earlier turns before a step when context is above the force line. */
    midTurnFold,
    /** With mid-turn digests: also digest the current turn's completed tool rounds outside the protected tail. */
    midTurnCurrent: midTurnFold && flag("STRATA_MID_TURN_CURRENT", base.midTurnCurrent),
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
    autoFold: has(env, "STRATA_AUTO_FOLD") ? !off(env.STRATA_AUTO_FOLD) : pageFlag("autoFold", true),
    /** Fold automatically at turn end above this share once autoFoldAfterNudges nudges went unanswered ... */
    autoFoldPct: num(env, "STRATA_AUTO_FOLD_PCT", base.autoFoldPct),
    autoFoldAfterNudges: num(env, "STRATA_AUTO_FOLD_AFTER_NUDGES", 2),
    /** ... and above this share regardless of nudges. */
    autoFoldForcePct: num(env, "STRATA_AUTO_FOLD_FORCE_PCT", base.autoFoldForcePct),
    /** Fold the oldest runs until the context would drop to about this share. */
    autoFoldTargetPct: num(env, "STRATA_AUTO_FOLD_TARGET_PCT", base.autoFoldTargetPct),
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
    protectedTailPct: has(env, "STRATA_PROTECTED_TAIL_PCT")
      ? (off(env.STRATA_PROTECTED_TAIL_PCT) ? 0 : num(env, "STRATA_PROTECTED_TAIL_PCT", base.protectedTailPct))
      : base.protectedTailPct,
    /** Stale runtime-context tokens that justify their own sweep: max(this, window × minBenefitRatio). */
    staleSweepTokens: num(env, "STRATA_STALE_SWEEP_TOKENS", 8_000),
    /** Archive root ("" = <DSH_HOME>/strata). STRATA_SHADOW_DIR wins. New sessions only. */
    archiveDir: has(env, "STRATA_SHADOW_DIR") ? String(env.STRATA_SHADOW_DIR) : typeof p.archiveDir === "string" ? p.archiveDir.trim() : "",
    /** Warn when all archives together exceed this many MB (0 = never). Nothing is deleted. */
    archiveMaxMB: has(env, "STRATA_ARCHIVE_MAX_MB") ? Math.max(0, Number(env.STRATA_ARCHIVE_MAX_MB) || 0) : Number.isFinite(Number(p.archiveMaxMB)) && p.archiveMaxMB !== null && p.archiveMaxMB !== "" ? Math.max(0, Number(p.archiveMaxMB)) : PAGE_DEFAULTS.archiveMaxMB,
    /** Delete archives of ended sessions untouched for this many days (0 = never, the default). */
    archiveKeepDays: has(env, "STRATA_ARCHIVE_KEEP_DAYS") ? Math.max(0, Number(env.STRATA_ARCHIVE_KEEP_DAYS) || 0) : Math.max(0, Number(p.archiveKeepDays) || 0),
  };
}

/** @typedef {ReturnType<typeof readSettings>} StrataSettings */

/**
 * Settings that follow the settings page: returns `holder.cached` while the
 * page did not change, else a fresh object. The environment is read when the
 * holder is first used and again on each page change. Each holder (a
 * StrataLayer) keeps its own object, so a test that edits one does not leak.
 * @param {{ cached?: StrataSettings, cachedVersion?: number }} holder
 */
export function liveSettings(holder) {
  const version = store().version;
  if (!holder.cached || holder.cachedVersion !== version) {
    holder.cached = readSettings();
    holder.cachedVersion = version;
  }
  return holder.cached;
}

/** @param {StrataSettings} settings @param {number} window @param {boolean} [upgrade] */
export function minBenefitFor(settings, window, upgrade = false) {
  const base = Math.max(settings.minBenefitTokens, Math.floor(window * settings.minBenefitRatio));
  return upgrade ? Math.ceil(base * settings.upgradeBenefitFactor) : base;
}

// ------------------------------------------------------------------ small windows

/** How far below DSH's official-summary line the clamped lines sit. */
export const CLAMP_MARGIN = 0.05;

/**
 * DSH's official summary (L∞) fires at min(thresholdRatio × window,
 * window − maxTokens − headroom) (compaction-basic resolveCompactSpec).
 * @param {{ window: number, maxTokens?: number, headroomTokens?: number, thresholdRatio?: number }} input
 * @returns {number} tokens; 0 when the window leaves no pressure budget
 */
export function officialLine({ window, maxTokens = 0, headroomTokens = 65536, thresholdRatio = 0.8 }) {
  if (!(window > 0)) return 0;
  return Math.max(0, Math.floor(Math.min(window * thresholdRatio, window - (maxTokens || 0) - (headroomTokens || 0))));
}

/**
 * The auto-fold and force lines for one window. When the official-summary line
 * sits below a configured line, that line drops to (official − 5 points), so
 * Strata folds before DSH summarizes. The target is unchanged. 1M windows are
 * unaffected.
 * @param {StrataSettings} settings
 * @param {{ window: number, maxTokens?: number, headroomTokens?: number, thresholdRatio?: number }} route
 */
export function foldLines(settings, route) {
  const window = route.window;
  const official = officialLine(route);
  const officialPct = window > 0 ? official / window : 0;
  const limit = Math.max(CLAMP_MARGIN, officialPct - CLAMP_MARGIN);
  const clamp = (value) => (officialPct > 0 && value > limit ? limit : value);
  const autoFoldPct = clamp(settings.autoFoldPct);
  const autoFoldForcePct = clamp(settings.autoFoldForcePct);
  return {
    autoFoldPct,
    autoFoldForcePct,
    official,
    officialPct,
    clamped: autoFoldPct !== settings.autoFoldPct || autoFoldForcePct !== settings.autoFoldForcePct,
  };
}
