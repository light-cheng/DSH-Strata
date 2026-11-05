// Shared token budget for plugins that inject context (interop §2).
//
// Provided once at the root as the cordis service `strataBudget`. DSH-Mem0
// (or any plugin) injects it optionally and asks how much it may add this
// turn; without Strata it keeps its own limits. Counting uses DSH's tokenMeter,
// the same meter Strata's thresholds use.

import { appendFileSync } from "node:fs";
import { readActivity } from "./activity.js";
import { readSettings } from "./settings.js";

const CRITICAL_CAP = 512;

/**
 * @param {{ tokenMeter?: { measure(session: any): { totalTokens: number } } }} services
 * @param {ReturnType<typeof readSettings>} [settings]
 */
export function createBudget(services, settings = readSettings()) {
  const windowOf = (session) => {
    const usage = readActivity(session?.id).usage;
    return usage?.window > 0 ? usage.window : settings.contextWindow;
  };
  // Contract with DSH-Mem0 (interop §2): synchronous, no I/O, never throws.
  const pressure = (session) => {
    try {
      const window = windowOf(session);
      let totalTokens = 0;
      try {
        totalTokens = services.tokenMeter?.measure(session)?.totalTokens ?? 0;
      } catch {
        totalTokens = readActivity(session?.id).usage?.totalTokens ?? 0;
      }
      const ratio = window > 0 ? totalTokens / window : 0;
      const stage = ratio >= settings.forcePct ? "critical" : ratio >= settings.l1StopRatio ? "tight" : "normal";
      return { totalTokens, window, ratio, stage };
    } catch {
      return { totalTokens: 0, window: settings.contextWindow, ratio: 0, stage: "normal" };
    }
  };
  /**
   * How many tokens the named section may use this turn.
   * normal: all of `wanted`; tight (≥ L1 stop line): half, except summary sections
   * (names ending in ":profile"); critical (≥ force line): at most 512.
   */
  // Test-only trace (joint test J5): one JSON line per allowance call. Off
  // unless STRATA_BUDGET_TRACE names a file; the no-I/O contract holds otherwise.
  const trace = (record) => {
    const file = process.env.STRATA_BUDGET_TRACE;
    if (!file) return;
    try {
      appendFileSync(file, `${JSON.stringify({ at: Date.now(), ...record })}\n`, { mode: 0o600 });
    } catch {}
  };
  const allowance = (session, name, wanted) => {
    const want = Math.max(0, Math.floor(Number(wanted) || 0));
    try {
      const p = pressure(session);
      let granted = want;
      if (p.stage === "critical") granted = Math.min(want, CRITICAL_CAP);
      else if (p.stage === "tight" && !String(name || "").endsWith(":profile")) granted = Math.floor(want / 2);
      trace({ session: session?.id, name: String(name || ""), wanted: want, allowance: granted, stage: p.stage, ratio: Math.round(p.ratio * 1000) / 1000, totalTokens: p.totalTokens, window: p.window });
      return granted;
    } catch {
      return want;
    }
  };
  /** Same counting as Strata's thresholds (DSH tokenMeter); falls back to chars / 4. */
  const countTokens = (text) => {
    const value = String(text ?? "");
    try {
      const counted = services.tokenMeter?.estimateText?.(value);
      if (Number.isFinite(counted)) return counted;
    } catch {}
    return Math.ceil(value.length / 4);
  };
  return { version: 1, pressure, allowance, countTokens };
}
