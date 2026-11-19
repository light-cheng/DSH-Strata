// Strata's own small state file: <DSH_HOME>/strata/state.json.
//
// Only what must survive a restart and is not configuration: today, whether
// the first-run note was shown, per DSH profile. Kept out of
// cordis.patch.yml on purpose (DSH rewrites that file). Delete the file to
// see the note again.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** <DSH_HOME>/strata/state.json (DSH_HOME defaults to ~/.dsh), whatever the archive folder is. */
export function stateFile(env = process.env) {
  return join(env.DSH_HOME || join(homedir(), ".dsh"), "strata", "state.json");
}

/** The DSH profile this process serves: DSH_PROFILE, else `--profile <name>` on the command line, else "default". */
export function profileName(env = process.env, argv = process.argv) {
  if (env.DSH_PROFILE) return String(env.DSH_PROFILE);
  const index = argv.findIndex((arg) => arg === "--profile" || arg.startsWith("--profile="));
  if (index >= 0) {
    const value = argv[index].includes("=") ? argv[index].split("=").slice(1).join("=") : argv[index + 1];
    if (value && !value.startsWith("-")) return value;
  }
  return "default";
}

export function readState(file = stateFile()) {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function writeState(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

// Remembered in memory too, so an unwritable file still shows the note only once per process.
const shownHere = new Set();

/**
 * True exactly once per profile: the first call records it in the state file
 * and returns true; later calls (this process or after a restart) return false.
 * @param {{ file?: string, profile?: string, now?: number }} [options]
 */
export function takeIntro({ file = stateFile(), profile = profileName(), now = Date.now() } = {}) {
  const key = `${file}\0${profile}`;
  if (shownHere.has(key)) return false;
  const state = readState(file);
  const intro = state.intro && typeof state.intro === "object" ? state.intro : {};
  shownHere.add(key);
  if (intro[profile]) return false;
  try {
    writeState(file, { ...state, intro: { ...intro, [profile]: new Date(now).toISOString() } });
  } catch {}
  return true;
}

/** Tests only. */
export function resetIntroMemory() {
  shownHere.clear();
}
