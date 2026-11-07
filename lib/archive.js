// L3 local archive helpers (design §5). One directory per session:
//   raw-<hash>.txt (+ .meta.json)  tool output captured when tool/result arrives
//   cut-*.txt                      the span an L1 card replaced
//   official-*.txt                 the span an official summary replaced
//   fold-f<N>.json                 an L2 fold: tier, range, summary, children + pointers
//   cards.json                     card id → the seqs / tool call ids it replaced
// Files are 0600, directories 0700. Ids handed to the model are relative
// (file stem), never absolute paths.

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { rawName } from "../raw.js";

const SESSION_HEADER = /^# strata-session \S*\n/;
const FOLD_FILE = /^fold-f(\d+)\.json$/;
const TEXT_FILE = /^((?:cut|official|shadow)-\d+-[0-9a-f]{8})\.txt$/;
const RAW_FILE = /^(raw-[0-9a-f]{16})\.txt$/;

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {}
}

export function foldFile(dir, id) {
  return join(dir, `fold-${id}.json`);
}

/** Highest fold number already archived in this session directory. */
export function lastFoldNumber(dir) {
  let max = 0;
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const match = FOLD_FILE.exec(name);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}

/**
 * Write a fold record. Refuses to overwrite an existing fold.
 * @returns {string} the file path.
 */
export function writeFold(dir, record) {
  ensureDir(dir);
  const file = foldFile(dir, record.id);
  writeFileSync(file, JSON.stringify(record, null, 2), { mode: 0o600, flag: "wx" });
  chmodSync(file, 0o600);
  if (!existsSync(file)) throw new Error(`strata: fold ${record.id} was not archived`);
  return file;
}

export function readFold(dir, id) {
  try {
    return JSON.parse(readFileSync(foldFile(dir, id), "utf8"));
  } catch {
    return null;
  }
}

function stripHeader(text) {
  return String(text).replace(SESSION_HEADER, "");
}

/**
 * Resolve an archive id to stored text. Accepts cut-/official-/shadow- stems,
 * raw-<hash> stems and plain tool call ids.
 * @returns {{ ok: true, kind: string, id: string, text: string, label?: string } | { ok: false, reason: string }}
 */
export function readArchiveText(dir, id) {
  const ref = String(id || "").trim().replace(/\.txt$/, "");
  if (!ref || ref.includes("/") || ref.includes("\\") || ref.includes("..")) return { ok: false, reason: "invalid archive id" };
  const textMatch = /^(cut|official|shadow)-\d+-[0-9a-f]{8}$/.exec(ref);
  if (textMatch) {
    try {
      return { ok: true, kind: textMatch[1], id: ref, text: stripHeader(readFileSync(join(dir, `${ref}.txt`), "utf8")) };
    } catch {
      return { ok: false, reason: `archive entry ${ref} is missing (it may have been rotated out)` };
    }
  }
  const rawStem = /^raw-[0-9a-f]{16}$/.test(ref) ? ref : rawName(ref).replace(/\.txt$/, "");
  const file = join(dir, `${rawStem}.txt`);
  if (!existsSync(file)) return { ok: false, reason: `no archived tool output for ${ref}` };
  let meta = {};
  try {
    meta = JSON.parse(readFileSync(`${file}.meta.json`, "utf8"));
  } catch {}
  try {
    return { ok: true, kind: "raw", id: meta.toolCallId || ref, text: readFileSync(file, "utf8"), label: meta.label || meta.name || "" };
  } catch {
    return { ok: false, reason: `archived tool output for ${ref} is unreadable` };
  }
}

/**
 * Every searchable document in a session archive.
 * @returns {{ id: string, kind: string, text: string, label: string, mtimeMs: number }[]}
 */
export function listDocuments(dir) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const docs = [];
  for (const name of names) {
    const path = join(dir, name);
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    const fold = FOLD_FILE.exec(name);
    if (fold) {
      const record = readFold(dir, `f${fold[1]}`);
      if (!record) continue;
      docs.push({ id: record.id, kind: "fold", tier: record.tier || 1, text: `${record.topic || ""}\n${record.summary || ""}`, label: record.topic || "", mtimeMs });
      continue;
    }
    const text = TEXT_FILE.exec(name);
    if (text) {
      try {
        docs.push({ id: text[1], kind: text[1].split("-")[0] === "cut" ? "card" : "full", text: stripHeader(readFileSync(path, "utf8")), label: "", mtimeMs });
      } catch {}
      continue;
    }
    const raw = RAW_FILE.exec(name);
    if (raw) {
      let meta = {};
      try {
        meta = JSON.parse(readFileSync(`${path}.meta.json`, "utf8"));
      } catch {}
      try {
        docs.push({ id: meta.toolCallId || raw[1], kind: "raw", text: readFileSync(path, "utf8"), label: meta.label || meta.name || "", mtimeMs });
      } catch {}
    }
  }
  return docs;
}

/** Bytes used by one session archive. */
export function archiveBytes(dir) {
  let total = 0;
  try {
    for (const name of readdirSync(dir)) {
      try {
        total += statSync(join(dir, name)).size;
      } catch {}
    }
  } catch {}
  return total;
}

const PURGEABLE = /^(?:(?:cut|official|shadow)-\d+-[0-9a-f]{8}\.txt|raw-[0-9a-f]{16}\.txt(?:\.meta\.json)?|fold-f\d+\.json|cards\.json)$/;

/** Delete this plugin's archive files in one session directory (never other files). */
export function purgeArchive(dir) {
  let files = 0;
  let bytes = 0;
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return { files, bytes };
  }
  for (const name of names) {
    if (!PURGEABLE.test(name)) continue;
    const path = join(dir, name);
    try {
      const size = statSync(path).size;
      unlinkSync(path);
      files += 1;
      bytes += size;
    } catch {}
  }
  return { files, bytes };
}

/** Archive pointer for a child: file name relative to the session dir + sha256 prefix. */
export function pointerOf(dir, name) {
  try {
    const bytes = readFileSync(join(dir, name));
    return { file: name, sha256: createHash("sha256").update(bytes).digest("hex").slice(0, 16), bytes: bytes.length };
  } catch {
    return { file: name, missing: true };
  }
}

const CARD_INDEX = "cards.json";

export function readCardIndex(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, CARD_INDEX), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Remember which seqs / tool calls an L1 card replaced (for search paths). */
export function recordCard(dir, id, entry) {
  if (!id) return;
  ensureDir(dir);
  const index = readCardIndex(dir);
  index[id] = { seqs: entry.seqs || [], toolCallIds: entry.toolCallIds || [] };
  const file = join(dir, CARD_INDEX);
  writeFileSync(file, JSON.stringify(index), { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** Every fold record in a session directory. */
export function listFolds(dir) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const match = FOLD_FILE.exec(name);
    const record = match ? readFold(dir, `f${match[1]}`) : null;
    return record ? [record] : [];
  });
}

// ------------------------------------------------------------------ all sessions

/**
 * Archive root for these settings: settings.archiveDir (STRATA_SHADOW_DIR or
 * the settings page, "~" expanded), else <DSH_HOME>/strata.
 * @param {{ archiveDir?: string }} settings
 */
export function archiveRootFor(settings, env = process.env) {
  const configured = String(settings?.archiveDir || "").trim();
  if (configured) {
    const expanded = configured === "~" ? homedir() : configured.startsWith("~/") || configured.startsWith("~\\") ? join(homedir(), configured.slice(2)) : configured;
    return isAbsolute(expanded) ? expanded : resolve(expanded);
  }
  return join(env.DSH_HOME || join(homedir(), ".dsh"), "strata");
}

function ownerAlive(dir) {
  try {
    const pid = Number(readFileSync(join(dir, "owner"), "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (pid === process.pid) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error?.code === "EPERM";
  }
}

/**
 * One row per session directory under the archive root.
 * @returns {{ key: string, dir: string, bytes: number, files: number, newest: number, liveElsewhere: boolean }[]}
 */
export function listSessionArchives(root) {
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const rows = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = join(root, entry.name);
    let bytes = 0;
    let files = 0;
    let newest = 0;
    try {
      for (const name of readdirSync(dir)) {
        try {
          const info = statSync(join(dir, name));
          if (!info.isFile()) continue;
          bytes += info.size;
          files += 1;
          newest = Math.max(newest, info.mtimeMs);
        } catch {}
      }
    } catch {
      continue;
    }
    rows.push({ key: entry.name, dir, bytes, files, newest, liveElsewhere: ownerAlive(dir) });
  }
  return rows;
}

/** Bytes and session count of every archive under the root. */
export function archiveTotals(root) {
  const rows = listSessionArchives(root);
  return { sessions: rows.length, bytes: rows.reduce((sum, row) => sum + row.bytes, 0) };
}

/**
 * Archives of ended sessions: not open in this process (`open`, sanitized
 * session keys), not owned by another live DSH process, and (with
 * `olderThanMs`) untouched for that long.
 */
export function endedArchives(root, { open = new Set(), olderThanMs = 0, now = Date.now() } = {}) {
  return listSessionArchives(root).filter((row) => !open.has(row.key) && !row.liveElsewhere && (olderThanMs <= 0 || now - row.newest >= olderThanMs));
}

/** Delete the plugin's files in each listed session directory, then the directory if it is empty. */
export function purgeSessions(rows) {
  let files = 0;
  let bytes = 0;
  let sessions = 0;
  for (const row of rows) {
    const removed = purgeArchive(row.dir);
    files += removed.files;
    bytes += removed.bytes;
    for (const extra of ["owner"]) {
      try {
        unlinkSync(join(row.dir, extra));
      } catch {}
    }
    try {
      rmdirSync(row.dir);
    } catch {}
    if (removed.files > 0) sessions += 1;
  }
  return { sessions, files, bytes };
}
