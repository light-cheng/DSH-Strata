import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPluginShadows, rotateShadow, shadowFileBody, shadowMaxBytes } from "../shadow.js";

const root = join(tmpdir(), `spine-shadow-${Date.now()}`);
mkdirSync(root, { recursive: true });

function plant(name, session, bytes, mtimeMs) {
  const body = shadowFileBody(session, "x".repeat(Math.max(0, bytes - 40)));
  const path = join(root, name);
  writeFileSync(path, body.slice(0, bytes));
  const at = new Date(mtimeMs);
  // utimes via stat after write; set mtime with the fs function imported below if needed
  return path;
}

function stamp(path, mtimeMs) {
  const at = mtimeMs / 1000;
  utimesSync(path, at, at);
}

const cap = 1000;
const otherOld = plant("cut-1000-aaaaaaa1.txt", "session-other", 300, 1_000);
const otherNew = plant("cut-1001-aaaaaaa2.txt", "session-other", 300, 2_000);
const mineOld = plant("cut-1002-aaaaaaa3.txt", "session-mine", 300, 3_000);
const mineNew = plant("cut-1003-aaaaaaa4.txt", "session-mine", 300, 4_000);
const keeper = plant("cut-1004-aaaaaaa5.txt", "session-mine", 200, 5_000);
stamp(otherOld, 1_000);
stamp(otherNew, 2_000);
stamp(mineOld, 3_000);
stamp(mineNew, 4_000);
stamp(keeper, 5_000);
const stranger = join(root, "notes.txt");
writeFileSync(stranger, "leave me");
chmodSync(stranger, 0o644);
const beforeMode = statSync(stranger).mode & 0o777;

const first = rotateShadow({
  dir: root,
  incomingBytes: 250,
  protectPath: keeper,
  sessionKey: "session-mine",
  cap,
});
assert.equal(first.ok, true);
assert.equal(statSync(keeper).isFile(), true);
assert.equal(statSync(stranger).isFile(), true);
assert.equal(statSync(stranger).mode & 0o777, beforeMode);
const left = listPluginShadows(root).map((file) => file.name);
assert.equal(left.includes("cut-1000-aaaaaaa1.txt"), false);
assert.equal(left.includes("cut-1004-aaaaaaa5.txt"), true);
assert.ok(first.used + 250 <= Math.floor(cap * 0.8) || left.length === 1);

const huge = rotateShadow({
  dir: root,
  incomingBytes: cap + 50,
  protectPath: join(root, "cut-9999-bbbbbbbb.txt"),
  sessionKey: "session-mine",
  cap,
});
assert.equal(huge.ok, true);
assert.equal(huge.oversize, true);
assert.equal(statSync(stranger).isFile(), true);

const locked = join(root, "locked");
mkdirSync(locked);
const lockedFile = join(locked, "cut-2000-cccccccc.txt");
writeFileSync(lockedFile, shadowFileBody("session-other", "y".repeat(80)));
const blocked = rotateShadow({
  dir: locked,
  incomingBytes: 40,
  protectPath: join(locked, "cut-2001-dddddddd.txt"),
  sessionKey: "session-mine",
  cap: 50,
  unlink() {
    throw new Error("EPERM");
  },
});
assert.equal(blocked.ok, false);
assert.equal(blocked.failed, true);
const oversizeBlocked = rotateShadow({
  dir: locked,
  incomingBytes: 80,
  protectPath: join(locked, "cut-2002-eeeeeeee.txt"),
  sessionKey: "session-mine",
  cap: 50,
  unlink() {
    throw new Error("EPERM");
  },
});
assert.equal(oversizeBlocked.ok, false);
assert.equal(oversizeBlocked.failed, true);
assert.equal(oversizeBlocked.oversize, true);
assert.equal(shadowMaxBytes({ SPINE_SHADOW_MAX_BYTES: "128" }), 128);
assert.equal(shadowMaxBytes({}), 128 * 1024 * 1024);

rmSync(root, { recursive: true, force: true });
console.log("shadow rotation checks passed");
