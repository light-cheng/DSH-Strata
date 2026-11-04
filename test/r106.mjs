import assert from "node:assert/strict";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflightConfig } from "../shell.js";
import { isPluginShadowName, rotateShadow, sanitizeSessionKey, sessionDir, shadowFileBody } from "../shadow.js";

assert.throws(() => preflightConfig({ thresholdRatio: 0.05 }), /retainRatio \(0\.16\)/);
assert.doesNotThrow(() => preflightConfig({ thresholdRatio: 0.8, retainTokens: 8192 }));
assert.equal(sanitizeSessionKey("../session-abc"), "session-abc");
assert.equal(sessionDir("/tmp/shadow", "session-abc"), "/tmp/shadow/session-abc");
assert.equal(isPluginShadowName("1793726992383-aaaaaaaa-bbbbbbbb.txt"), true);

const root = join(tmpdir(), `spine-106-${Date.now()}`);
mkdirSync(join(root, "session-live"), { recursive: true });
mkdirSync(join(root, "session-dead"), { recursive: true });
writeFileSync(join(root, "session-live", "owner"), "4242");
writeFileSync(join(root, "session-live", "cut-1000-aaaaaaa1.txt"), shadowFileBody("session-live", "keep"));
writeFileSync(join(root, "session-dead", "cut-1001-aaaaaaa2.txt"), shadowFileBody("session-dead", "drop"));
writeFileSync(join(root, "1793726992383-aaaaaaaa-bbbbbbbb.txt"), "legacy");
const keeper = join(root, "session-mine", "cut-2000-cccccccc.txt");
mkdirSync(join(root, "session-mine"), { recursive: true });
writeFileSync(keeper, shadowFileBody("session-mine", "current"));
const rotated = rotateShadow({
  dir: root,
  incomingBytes: 900,
  protectPath: keeper,
  sessionKey: "session-mine",
  cap: 1000,
  alive(pid) {
    return pid === 4242;
  },
});
assert.equal(rotated.ok, true);
assert.equal(statSync(join(root, "session-live", "cut-1000-aaaaaaa1.txt")).isFile(), true);
assert.throws(() => statSync(join(root, "session-dead", "cut-1001-aaaaaaa2.txt")));
assert.throws(() => statSync(join(root, "1793726992383-aaaaaaaa-bbbbbbbb.txt")));
const missing = rotateShadow({
  dir: root,
  incomingBytes: 50,
  protectPath: join(root, "session-mine", "cut-3000-dddddddd.txt"),
  sessionKey: "session-mine",
  cap: 40,
  unlink() {
    const error = new Error("gone");
    error.code = "ENOENT";
    throw error;
  },
});
assert.equal(missing.ok, true);
assert.equal(missing.failed, false);
rmSync(root, { recursive: true, force: true });
console.log("1.0.6 checks passed");
