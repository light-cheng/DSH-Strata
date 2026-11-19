// The dock's plain-language line and hover text (0.5).
//
// Built on the server in the UI language the dock reports, from figures that
// already exist: the ledger (reclaimed, net saving, requests to break even),
// the activity record (landings, last rejection, last failure, usage at the
// last turn end) and the fold lines for the session's window. No new
// estimate: the numbers match /strata detail.
//
// "Saved" is the ledger's net saving (cache-hit tokens not sent again minus
// the one-time re-billing, at the cache-miss price), not the raw reclaim: the
// reclaim is context room, the net is what the user pays less. Right after a
// landing the net is negative; the line then says when it turns positive.

import { kTokens } from "./economics.js";
import { lastActivityRejection, readActivity } from "./activity.js";
import { readLedger } from "./ledger.js";
import { foldLines, readSettings } from "./settings.js";
import { localizeRejection, pct } from "./command.js";

const ERROR_MS = 10 * 60 * 1000;

/** Same rounding as /strata detail (one decimal): 0.184 → "18.4%", 0.5 → "50%". */
export const plainPct = pct;

const hhmm = (at) => new Date(at).toTimeString().slice(0, 5);

function eventWhat(event, t) {
  if (event.layer === "L1") return t("plain.whatCard");
  if (event.layer === "ctx") return t("plain.whatCtx");
  // No count of parts: DSH's own compaction row counts records, not folds.
  if (event.layer === "L2") return t(event.auto ? "plain.whatAuto" : "plain.whatModel");
  return t("plain.whatOfficial");
}

/**
 * When the next turn end folds, by the same conditions as l2.js autoFold:
 * above the force line, or above the auto-fold line once enough reminders
 * went unanswered (none needed with reminders off); after a digest that
 * folded all it could, it also waits for new foldable work (or forcePct).
 */
function nextText(settings, lines, ratio, usage, t) {
  if (!settings.autoFold) return t("plain.nextOff");
  const midTurn = settings.midTurnFold ? t("plain.nextMidTurn", { force: plainPct(lines.autoFoldForcePct) }) : "";
  const stage = settings.nudge && lines.nudgeStage !== false;
  if (ratio < lines.autoFoldPct) {
    return (stage
      ? t("plain.nextNudge", { pct: plainPct(lines.autoFoldPct), n: settings.autoFoldAfterNudges, force: plainPct(lines.autoFoldForcePct) })
      : t("plain.nextLine", { pct: plainPct(lines.autoFoldPct) })) + midTurn;
  }
  const unanswered = Number(usage.unanswered) || 0;
  const due = ratio >= lines.autoFoldForcePct || !settings.nudge || unanswered >= settings.autoFoldAfterNudges;
  if (!due) {
    return t("plain.nextWaitNudge", { pct: plainPct(lines.autoFoldPct), left: settings.autoFoldAfterNudges - unanswered, force: plainPct(lines.autoFoldForcePct) }) + midTurn;
  }
  const scale = Number(usage.scale) > 0 ? Number(usage.scale) : 1;
  const waiting = ratio < settings.forcePct && usage.autoExhausted === true && usage.autoFoldedAt != null
    && (Number(usage.foldable) || 0) - usage.autoFoldedAt < settings.nudgeGrowthTokens / scale;
  if (waiting) return t("plain.nextWaitGrowth", { step: kTokens(settings.nudgeGrowthTokens), forced: plainPct(settings.forcePct) }) + midTurn;
  return t("plain.nextAbove", { pct: plainPct(lines.autoFoldPct) }) + midTurn;
}

/**
 * @param {string} sessionId
 * @param {(key: string, params?: object) => string} t
 * @param {{ settings?: any, now?: number }} [options]
 * @returns {{ line: string, hover: string[] }}
 */
export function plainStatus(sessionId, t, { settings = readSettings(), now = Date.now() } = {}) {
  const activity = readActivity(sessionId);
  const usage = activity.usage;
  const ledger = readLedger(sessionId, usage?.requests || 0, { priceMiss: settings.priceMiss, priceHit: settings.priceHit });
  const ratio = usage && usage.window > 0 ? usage.totalTokens / usage.window : NaN;

  let line;
  // The ledger and events live in this process; after a restart the surface may already hold folds.
  const folds = (usage?.tiers || []).reduce((sum, n) => sum + (Number(n) || 0), 0);
  const cards = Number(usage?.cards) || 0;
  const earlier = ledger.count === 0 && folds + cards > 0;
  if (ledger.count > 0 && ledger.net >= 0) line = t("plain.lineSaved", { tokens: kTokens(ledger.net), count: ledger.count });
  else if (ledger.count > 0 && Number.isFinite(ledger.toBreakEven)) line = t("plain.lineEarly", { count: ledger.count, n: ledger.toBreakEven });
  else if (ledger.count > 0) line = t("plain.lineCount", { count: ledger.count });
  else if (Number.isFinite(ratio)) line = t(earlier ? "plain.lineIdleRestart" : "plain.lineIdle", { pct: plainPct(ratio) });
  else line = t("plain.lineWaiting");

  const hover = [];
  const last = activity.events.at(-1);
  hover.push(!last
    ? earlier ? t("plain.lastNoneRestart", { folds, cards }) : t("plain.lastNone")
    : last.reclaimed
      ? t("plain.last", { time: hhmm(last.at), what: eventWhat(last, t), tokens: kTokens(last.reclaimed) })
      : t("plain.lastNoTokens", { time: hhmm(last.at), what: eventWhat(last, t) }));
  if (Number.isFinite(ratio)) {
    hover.push(t("plain.usage", { pct: plainPct(ratio), used: kTokens(usage.totalTokens), window: kTokens(usage.window) }));
    const lines = foldLines(settings, { window: usage.window, ...(usage.route || {}) });
    hover.push(nextText(settings, lines, ratio, usage, t));
  }
  const error = activity.error && now - activity.error.at < ERROR_MS ? activity.error : null;
  const rejection = lastActivityRejection(sessionId);
  if (error) {
    // No raw error text here: it is English and technical; /strata detail has it.
    hover.push(t(error.timeout ? "plain.errorTimeout" : "plain.error", { time: hhmm(error.at), what: t(error.layer === "L1" ? "plain.rejectionCard" : "plain.rejectionFold") }));
  } else if (rejection && (!last || rejection.at > last.at)) {
    hover.push(t("plain.rejection", { time: hhmm(rejection.at), what: t(rejection.layer === "L1" ? "plain.rejectionCard" : "plain.rejectionFold"), reason: localizeRejection(rejection.message, t) }));
  } else if (ledger.count > 0) {
    hover.push(t("plain.savedNote", { reclaimed: kTokens(ledger.reclaimed) }));
  }
  return { line, hover };
}

/** The one-time first-run note, in the UI language. */
export function introText(t, settings = readSettings()) {
  return { text: t("plain.intro", { mode: t(`mode.${settings.mode || "cost"}`) }), close: t("plain.introClose") };
}
