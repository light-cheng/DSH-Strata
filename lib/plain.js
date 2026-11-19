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
import { localizeRejection } from "./command.js";

const ERROR_MS = 10 * 60 * 1000;

/** 0.039 → "3.9%", 0.184 → "18%", 0.5 → "50%". */
export function plainPct(ratio) {
  if (!Number.isFinite(ratio)) return "?";
  const value = ratio * 100;
  return `${value < 10 ? Math.round(value * 10) / 10 : Math.round(value)}%`;
}

const hhmm = (at) => new Date(at).toTimeString().slice(0, 5);

function eventWhat(event, t) {
  if (event.layer === "L1") return t("plain.whatCard");
  if (event.layer === "ctx") return t("plain.whatCtx");
  if (event.layer === "L2") {
    const n = Math.max(1, String(event.id || "").split(/[\s,]+/).filter(Boolean).length);
    return t(event.auto ? "plain.whatAuto" : "plain.whatModel", { n });
  }
  return t("plain.whatOfficial");
}

function nextText(settings, lines, ratio, t) {
  if (!settings.autoFold) return t("plain.nextOff");
  const midTurn = settings.midTurnFold ? t("plain.nextMidTurn", { force: plainPct(lines.autoFoldForcePct) }) : "";
  if (ratio >= lines.autoFoldPct) return t("plain.nextAbove", { pct: plainPct(lines.autoFoldPct) }) + midTurn;
  if (settings.nudge && lines.nudgeStage !== false) {
    return t("plain.nextNudge", { pct: plainPct(lines.autoFoldPct), n: settings.autoFoldAfterNudges, force: plainPct(lines.autoFoldForcePct) }) + midTurn;
  }
  return t("plain.nextLine", { pct: plainPct(lines.autoFoldPct) }) + midTurn;
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
    hover.push(nextText(settings, lines, ratio, t));
  }
  const error = activity.error && now - activity.error.at < ERROR_MS ? activity.error : null;
  const rejection = lastActivityRejection(sessionId);
  if (error) {
    hover.push(t("plain.error", { time: hhmm(error.at), what: t(error.layer === "L1" ? "plain.rejectionCard" : "plain.rejectionFold"), message: error.message }));
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
