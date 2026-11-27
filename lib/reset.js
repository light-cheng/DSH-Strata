// Settings reset by DSH: detect it and say so (design: plan B, hint only).
//
// DSH desktop's startup-failure dialog offers "Disable third-party plugins,
// back up the profile patch and restart". It renames the whole
// cordis.patch.yml to cordis.patch.yml.bak-<ms> and leaves an empty template,
// so the strata-gate block (the settings page) is gone and Strata runs on its
// defaults without a word.
//
// Strata keeps a fingerprint: the NAMES (never the values) of the page fields
// that were not at their default, and when that was recorded. It is written at
// every start and after every settings save, and only when some field is not
// at its default (an all-default page never overwrites the last record).
//
// A hint is raised when all three hold:
//   1. the last record lists at least one field;
//   2. every listed field is now at its default;
//   3. the profile folder holds a cordis.patch.yml.bak-<ms> whose time is later
//      than that record. The time comes from the file name (DSH's Date.now() at
//      the rename), not the mtime: a rename keeps the mtime, i.e. the time the
//      patch was last written, which is always before the record.
// The profile folder comes from the host only (DSH's profileContext.dir, else
// DSH_PROFILE_DIR); without one, detection is skipped silently.
//
// The hint shows in /strata detail while it stands, and once in the dock's
// hover card (the dock acknowledges it). Saving a non-default value on the
// settings page clears it. Strata never reads the .bak file (its name, plus a
// stat to see it is a plain file) and never writes cordis.patch.yml or the backup.
//
// State: <DSH_HOME>/strata/.state/settings-<profile>.json, beside the
// first-run marker (lib/state.js).

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PAGE_DEFAULTS } from "./settings.js";
import { profileName, stateDir } from "./state.js";

// Same pattern as DSH-Mem0's lib/patch-backup.js.
const BAK = /^cordis\.patch\.yml\.bak-(\d{10,16})$/;

/** Does one page value equal its default? Missing / empty counts as default (the Config fills it). */
export function isDefaultValue(key, value) {
  const fallback = PAGE_DEFAULTS[key];
  if (value === undefined || value === null) return true;
  if (typeof fallback === "number") return value === "" || Number(value) === fallback;
  if (typeof fallback === "string") return String(value).trim() === fallback;
  return value === fallback;
}

/** Names of the page fields not at their default, in PAGE_DEFAULTS order. */
export function nonDefaultFields(page) {
  if (!page || typeof page !== "object") return [];
  return Object.keys(PAGE_DEFAULTS).filter((key) => !isDefaultValue(key, page[key]));
}

/**
 * The profile folder, from the host only. No guess from DSH_HOME and a name.
 * @param {{ dir?: string } | undefined} context ctx.get("profileContext")
 */
export function profileDirOf(context, env = process.env) {
  if (context?.dir) return String(context.dir);
  if (env.DSH_PROFILE_DIR) return String(env.DSH_PROFILE_DIR);
  return "";
}

export function resetStateFile(profile = profileName(), dir = stateDir()) {
  return join(dir, `settings-${encodeURIComponent(profile).replace(/\*/g, "%2A")}.json`);
}

function readState(file) {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return {
        fields: Array.isArray(value.fields) ? value.fields.filter((name) => typeof name === "string") : [],
        recordedAt: Number(value.recordedAt) || 0,
        hint: value.hint && typeof value.hint === "object" && typeof value.hint.bak === "string" ? value.hint : null,
      };
    }
  } catch {}
  return { fields: [], recordedAt: 0, hint: null };
}

function writeState(file, dir, state) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * The newest cordis.patch.yml.bak-<ms> in the folder whose time is later than
 * `after`: `{ path, stamp }`. The time is read from the name; a name that does
 * not match is skipped. As in DSH-Mem0, a number that is not a plausible
 * Date.now() (13 digits, 2001…2286) falls back to the file's mtime. Never
 * reads the file.
 */
export function newestBackup(profileDir, after) {
  let names;
  try {
    names = readdirSync(profileDir);
  } catch {
    return null;
  }
  let best = null;
  for (const name of names) {
    const match = BAK.exec(String(name));
    if (!match) continue;
    const path = join(profileDir, name);
    let stamp = Number(match[1]);
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      if (!(stamp >= 1e12 && stamp < 1e13)) stamp = stat.mtimeMs;
    } catch {
      continue;
    }
    if (stamp > after && (!best || stamp > best.stamp)) best = { path, stamp };
  }
  return best;
}

// The last check per state file, so the dock and /strata detail need no disk read.
const CURRENT = Symbol.for("@lightcheng/dsh-strata/settings-reset");
function current() {
  globalThis[CURRENT] ??= { file: "", dir: "", state: null };
  return globalThis[CURRENT];
}

/**
 * Record the fingerprint and look for a reset. Called at start and after each
 * settings save (gate.js). Never throws.
 * @param {{ page?: Record<string, any> | null, profileDir?: string, profile?: string, dir?: string, now?: number }} options
 * @returns {{ fields: string[], recordedAt: number, hint: { bak: string, bakStamp: number, detectedAt: number, seen: boolean } | null } | null}
 */
export function checkSettingsReset({ page, profileDir = "", profile = profileName(), dir = stateDir(), now = Date.now() } = {}) {
  try {
    if (!page || typeof page !== "object") return null;
    const file = resetStateFile(profile, dir);
    const before = readState(file);
    const state = { ...before };
    const changed = nonDefaultFields(page);
    // Detection uses the previous record; a standing hint is kept (and stays seen) until cleared.
    if (!state.hint && profileDir && state.fields.length > 0 && state.fields.every((key) => isDefaultValue(key, page[key]))) {
      const bak = newestBackup(profileDir, state.recordedAt);
      if (bak) state.hint = { bak: bak.path, bakStamp: bak.stamp, detectedAt: now, seen: false };
    }
    // Non-default values on the page: record them, and a saved page clears the hint.
    if (changed.length > 0) {
      state.fields = changed;
      state.recordedAt = now;
      state.hint = null;
    }
    if (JSON.stringify(state) !== JSON.stringify(before)) writeState(file, dir, state);
    Object.assign(current(), { file, dir, state });
    return state;
  } catch {
    return null;
  }
}

/** The standing hint, if any: { bak, seen, ... }. */
export function resetHint() {
  return current().state?.hint || null;
}

/** The dock showed the hint in its hover card: do not show it there again. */
export function ackResetHint() {
  const c = current();
  if (!c.state?.hint || c.state.hint.seen) return { ok: true };
  c.state = { ...c.state, hint: { ...c.state.hint, seen: true } };
  return { ok: writeState(c.file, c.dir, c.state) };
}

/** Tests only. */
export function resetResetMemory() {
  globalThis[CURRENT] = { file: "", dir: "", state: null };
}
