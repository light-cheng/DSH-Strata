// Strata's own small state, outside cordis.patch.yml (DSH rewrites that file).
//
// Today only whether the first-run note was shown, per DSH profile: one
// marker file per profile, <DSH_HOME>/strata/.state/intro-<profile>, created
// with O_EXCL, so two DSH processes never overwrite each other and there is no
// temp file to leave behind. The dot folder is skipped by the archive listing
// (archive.js listSessionArchives), so purge and totals ignore it. Delete the
// marker (or the .state folder) to see the note again.
//
// The note is two-phase: the status route offers it while no marker exists
// (introPending); the dock acknowledges once it has shown it (ackIntro), and
// only then is the marker written.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** <DSH_HOME>/strata/.state (DSH_HOME defaults to ~/.dsh), whatever the archive folder is. */
export function stateDir(env = process.env) {
  return join(env.DSH_HOME || join(homedir(), ".dsh"), "strata", ".state");
}

/**
 * The DSH profile this process serves: DSH_PROFILE (DSH sets it for the
 * processes it starts), else the last part of DSH_PROFILE_DIR, else
 * `--profile <name>` on the command line, else "default".
 */
export function profileName(env = process.env, argv = process.argv) {
  if (env.DSH_PROFILE) return String(env.DSH_PROFILE);
  if (env.DSH_PROFILE_DIR) {
    const last = String(env.DSH_PROFILE_DIR).replace(/[\\/]+$/, "").split(/[\\/]/).pop();
    if (last) return last;
  }
  const index = argv.findIndex((arg) => arg === "--profile" || arg.startsWith("--profile="));
  if (index >= 0) {
    const value = argv[index].includes("=") ? argv[index].split("=").slice(1).join("=") : argv[index + 1];
    if (value && !value.startsWith("-")) return value;
  }
  return "default";
}

/** Marker path for one profile; the name is encoded so any profile name is a valid file name (Windows too). */
export function introMarker(profile = profileName(), dir = stateDir()) {
  return join(dir, `intro-${encodeURIComponent(profile).replace(/\*/g, "%2A")}`);
}

// Acknowledged in this process (also when the marker could not be written), so a tab does not get it twice.
const ackedHere = new Set();

/** Should the dock offer the first-run note? True until it is acknowledged for this profile. */
export function introPending({ profile = profileName(), dir = stateDir() } = {}) {
  const marker = introMarker(profile, dir);
  if (ackedHere.has(marker)) return false;
  return !existsSync(marker);
}

/**
 * The dock showed the note: write the marker. Returns { ok, error? };
 * an existing marker is ok (another tab or process got there first).
 * @param {{ profile?: string, dir?: string, now?: number }} [options]
 */
export function ackIntro({ profile = profileName(), dir = stateDir(), now = Date.now() } = {}) {
  const marker = introMarker(profile, dir);
  ackedHere.add(marker);
  const failed = (error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) });
  try {
    // 0700 like the archive folders (README, Privacy); only folders created here get it.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    return failed(error);
  }
  try {
    writeFileSync(marker, `${new Date(now).toISOString()}\n`, { flag: "wx", mode: 0o600 });
    return { ok: true };
  } catch (error) {
    // Another tab or process wrote it first.
    return error?.code === "EEXIST" ? { ok: true } : failed(error);
  }
}

/** Tests only. */
export function resetIntroMemory() {
  ackedHere.clear();
}
