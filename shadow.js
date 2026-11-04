import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

const PLUGIN_NAME = /^(?:(?:cut|official|shadow)-\d+-[0-9a-f]{8}|raw-[0-9a-f]{16}|\d+-[0-9a-f]{8}-[0-9a-f]{8}|\d+-[0-9a-f]{8,16})\.txt$/;
const SESSION_MARK = /^# spine-session (\S+)/;

export function isPluginShadowName(name) {
  return PLUGIN_NAME.test(name);
}

export function sanitizeSessionKey(key) {
  const safe = String(key || "default").replace(/[^A-Za-z0-9_-]/g, "");
  return safe || "default";
}

export function sessionDir(root, key) {
  return join(root, sanitizeSessionKey(key));
}

function ownerPid(dir) {
  try {
    const text = readFileSync(join(dir, "owner"), "utf8").trim();
    const pid = Number(text);
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function shadowFileBody(sessionKey, body) {
  const key = String(sessionKey || "default").replace(/\s+/g, "");
  return `# spine-session ${key}\n${body || ""}`;
}

export function shadowMaxBytes(env = process.env) {
  const bytes = Number(env.SPINE_SHADOW_MAX_BYTES);
  if (Number.isFinite(bytes) && bytes > 0) return Math.floor(bytes);
  const mb = Number(env.SPINE_SHADOW_MAX_MB);
  if (Number.isFinite(mb) && mb > 0) return Math.floor(mb * 1024 * 1024);
  return 128 * 1024 * 1024;
}

function readSessionKey(file) {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(240);
    const count = readSync(fd, buf, 0, buf.length, 0);
    const line = buf.subarray(0, count).toString("utf8").split("\n")[0] || "";
    return SESSION_MARK.exec(line)?.[1] || "";
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

export function listPluginShadows(dir) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files = [];
  for (const name of names) {
    if (!isPluginShadowName(name)) continue;
    const path = resolve(dir, name);
    try {
      const info = statSync(path);
      if (!info.isFile()) continue;
      files.push({
        name,
        path,
        size: info.size,
        mtimeMs: info.mtimeMs,
        sessionKey: readSessionKey(path),
      });
    } catch {}
  }
  return files;
}

function byAge(left, right) {
  return left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name);
}

export function listShadowEntries(dir, alive = processAlive) {
  const entries = [];
  let names = [];
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch {
    return entries;
  }
  for (const entry of names) {
    const path = resolve(dir, entry.name);
    if (entry.isFile() && isPluginShadowName(entry.name)) {
      try {
        const info = statSync(path);
        entries.push({
          name: entry.name,
          path,
          size: info.size,
          mtimeMs: info.mtimeMs,
          sessionKey: "",
          legacy: true,
          live: false,
        });
      } catch {}
      continue;
    }
    if (!entry.isDirectory()) continue;
    const live = ownerPid(path) ? alive(ownerPid(path)) : false;
    for (const file of listPluginShadows(path)) {
      entries.push({ ...file, legacy: false, live, sessionKey: file.sessionKey || entry.name });
    }
  }
  return entries;
}

export function rotateShadow({ dir, incomingBytes, protectPath, protectPaths = [], sessionKey, cap, unlink = unlinkSync, alive = processAlive }) {
  const files = listShadowEntries(dir, alive);
  const protect = new Set([protectPath, ...protectPaths].filter(Boolean).map((path) => resolve(path)));
  const current = sanitizeSessionKey(sessionKey);
  let used = files.reduce((sum, file) => sum + file.size, 0);
  const low = Math.floor(cap * 0.8);
  const oversize = incomingBytes > cap;
  if (!oversize && used + incomingBytes <= cap) {
    return { ok: true, deleted: 0, freed: 0, used, cap, oversize: false, failed: false };
  }
  const legacy = [];
  const dead = [];
  const mine = [];
  for (const file of files) {
    if (protect.has(file.path)) continue;
    if (file.live && file.sessionKey !== current) continue;
    if (file.legacy) legacy.push(file);
    else if (file.sessionKey === current) mine.push(file);
    else dead.push(file);
  }
  legacy.sort(byAge);
  dead.sort(byAge);
  mine.sort(byAge);
  let deleted = 0;
  let freed = 0;
  let failed = false;
  for (const file of [...legacy, ...dead, ...mine]) {
    if (!oversize && used + incomingBytes <= low) break;
    try {
      unlink(file.path);
    } catch (error) {
      if (error?.code === "ENOENT") {
        used -= file.size;
        freed += file.size;
        deleted += 1;
        continue;
      }
      failed = true;
      break;
    }
    used -= file.size;
    freed += file.size;
    deleted += 1;
    if (file.name.startsWith("raw-")) {
      try {
        unlink(`${file.path}.meta.json`);
      } catch {}
    }
  }
  const fits = used + incomingBytes <= cap;
  return {
    ok: !failed && (oversize || fits),
    deleted,
    freed,
    used,
    cap,
    oversize,
    failed,
  };
}
