// Model-free folds (automatic extractive digests): triggers, the cost check,
// the header, restorability, and runtime-context snapshot handling.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { addAssistantText, addToolRound, addUser, fakeAgent, fakeContext, FakeSession, filler } from "./helpers/fake-dsh.mjs";

const root = mkdtempSync(join(tmpdir(), "strata-auto-"));
process.env.STRATA_SHADOW_DIR = join(root, "archive");
process.env.STRATA_MIN_BENEFIT_TOKENS = "500";
process.env.STRATA_MIN_BENEFIT_RATIO = "0.000001";
process.env.STRATA_EXPECTED_REQUESTS = "200";
const { default: Engine } = await import("../index.js");
const { stratumOf } = await import("../lib/stratum.js");
after(() => rmSync(root, { recursive: true, force: true }));

function setup(id = `s-${Math.random().toString(16).slice(2)}`) {
  const ctx = fakeContext();
  const engine = new Engine(ctx, {});
  const session = new FakeSession({ id, cwd: join(root, "work") });
  session.listeners.push((s, event) => {
    for (const fn of ctx.handlers.get("session/event") || []) fn(s, event);
  });
  return { ctx, engine, session, agent: fakeAgent(session), layer: engine.strataLayer };
}

function addSnapshot(session, marker, chars = 3000) {
  const recall = `<mem0-relevant-memories>${marker} ${filler(marker, chars)}</mem0-relevant-memories>`;
  return session.append("user/message", {
    role: "user",
    content: [{ type: "text", text: `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${recall}` }],
    source: { kind: "runtime-context", form: "snapshot", sections: [{ name: "mem0:recall", text: recall }] },
  });
}

/** Two finished tasks with planted facts, then a live task (protected tail). */
function conversation(session, { snapshots = false } = {}) {
  addUser(session, "Task one: migrate the config. Decision: we keep PORT=8443 and drop the legacy flag.");
  if (snapshots) addSnapshot(session, "RECALL_A");
  for (let i = 0; i < 5; i += 1) addToolRound(session, { command: `cat conf/part${i}.yml`, output: `${i === 2 ? "Error: ENOENT conf/part2.yml not found\n" : ""}${filler(`part-${i} value=${7000 + i}`, 6000)}` });
  addAssistantText(session, "Config migrated; part2 was missing and is recreated from the template.");
  addUser(session, "Task two: tidy logs under /var/log/app/rotated.");
  if (snapshots) addSnapshot(session, "RECALL_B");
  for (let i = 0; i < 4; i += 1) addToolRound(session, { command: `gzip /var/log/app/rotated/${i}.log`, output: filler(`gz-${i}`, 5000) });
  addAssistantText(session, "Logs compressed.");
  addUser(session, "Task three: write the release note.");
  if (snapshots) addSnapshot(session, "RECALL_LIVE");
  for (let i = 0; i < 3; i += 1) addToolRound(session, { command: `cat notes/${i}.md`, output: filler(`note-${i}`, 600) });
}

/** Set the window so the session sits at `ratio` of it. */
function atRatio(layer, agent, session, ratio) {
  const total = layer.layout(session).totalTokens;
  layer.state(agent).window = Math.round(total / ratio);
  return total;
}

const autoRows = (layer, session) => layer.layout(session).rows.filter((row) => row.stratum === "fold" && row.auto);

test("triggers: below 50% never; 50–60% only after 2 unanswered nudges; 60% regardless; off switch", () => {
  const low = setup();
  conversation(low.session);
  atRatio(low.layer, low.agent, low.session, 0.45);
  low.layer.state(low.agent).unanswered = 5;
  assert.deepEqual(low.layer.autoFold(low.agent), [], "below autoFoldPct");

  const mid = setup();
  conversation(mid.session);
  atRatio(mid.layer, mid.agent, mid.session, 0.55);
  mid.layer.state(mid.agent).unanswered = 1;
  assert.deepEqual(mid.layer.autoFold(mid.agent), [], "one unanswered nudge is not enough");
  mid.layer.state(mid.agent).unanswered = 2;
  const ids = mid.layer.autoFold(mid.agent);
  assert.ok(ids.length >= 1, "two unanswered nudges at 55%");
  assert.ok(mid.layer.state(mid.agent).pending.every((fold) => fold.auto));

  const high = setup();
  conversation(high.session);
  atRatio(high.layer, high.agent, high.session, 0.62);
  assert.ok(high.layer.autoFold(high.agent).length >= 1, "above autoFoldForcePct with no nudges");

  const off = setup();
  conversation(off.session);
  atRatio(off.layer, off.agent, off.session, 0.9);
  off.layer.settings.autoFold = false;
  assert.deepEqual(off.layer.autoFold(off.agent), [], "STRATA_AUTO_FOLD=off");

  const busy = setup();
  conversation(busy.session);
  atRatio(busy.layer, busy.agent, busy.session, 0.9);
  const run = busy.layer.snapshot(busy.agent).runs[0];
  assert.match(busy.layer.propose(busy.agent, `${run.startRef}–${run.endRef} config\nMigrated the config; PORT=8443.`), /pending T1 fold/);
  assert.equal(busy.layer.state(busy.agent).unanswered, 0, "a model compress answers the nudges");
  assert.deepEqual(busy.layer.autoFold(busy.agent), [], "the model's own pending fold wins");
});

test("nudge re-arm: an unanswered nudge repeats after half a step, a quarter above forcePct", async () => {
  const { foldableTokens } = await import("../lib/layout.js");
  const { session, agent, layer } = setup();
  layer.settings.nudgeGrowthTokens = 4000;
  layer.state(agent).window = 1_000_000;
  addUser(session, "start");
  for (let i = 0; i < 6; i += 1) addToolRound(session, { command: `step ${i}`, output: filler(`a-${i}`, 6000) });
  const foldable = () => foldableTokens(layer.layout(session));
  assert.match(layer.nudge(agent), /Automatic context note/);
  assert.equal(layer.state(agent).unanswered, 1);
  const grow = (until, label) => {
    let fired = null;
    for (let i = 0; i < 200 && fired === null; i += 1) {
      addToolRound(session, { command: `${label} ${i}`, output: filler(`${label}-${i}`, 800) });
      const grown = foldable() - layer.state(agent).nudgedAt;
      const text = layer.nudge(agent);
      if (text) fired = grown;
      else assert.ok(grown < until, `${label}: no nudge although grown ${grown} >= ${until}`);
    }
    return fired;
  };
  const half = grow(2000, "half");
  assert.ok(half >= 2000 && half < 4000, `re-armed at half a step (fired at +${half})`);
  assert.equal(layer.state(agent).unanswered, 2);
  layer.state(agent).window = Math.round(layer.layout(session).totalTokens / 0.8);
  const quarter = grow(1000, "quarter");
  assert.ok(quarter >= 1000 && quarter < 2000, `re-armed at a quarter step above forcePct (fired at +${quarter})`);
});

test("an automatic fold lands through the cost check, says it is a digest, and stays restorable", async () => {
  const { ctx, engine, session, agent, layer } = setup();
  conversation(session);
  atRatio(layer, agent, session, 0.62);
  const landedEvents = [];
  ctx.emit = (name, payload) => landedEvents.push([name, payload]);
  const before = layer.layout(session).totalTokens;
  const ids = layer.autoFold(agent);
  const result = await layer.flush(agent);
  assert.deepEqual(result.landed.sort(), [...ids].sort());
  const after = layer.layout(session).totalTokens;
  assert.ok(after < before * 0.6, `context dropped (${before} → ${after})`);
  const rows = autoRows(layer, session);
  assert.equal(rows.length, ids.length);
  const event = session.eventAt(rows[0].seq);
  const text = event.data.content[0].text;
  assert.match(text, /^\[strata:fold:t1 id=f\d+ range=s\d+-s\d+ auto=1\]/);
  assert.match(text, /automatic extractive digest written by Strata, not by the model/);
  assert.match(text, /Automatic digest f\d+ · T1/);
  assert.match(text, /\[user s\d+\] Task one: migrate the config\. Decision: we keep PORT=8443/);
  assert.match(text, /→ bash cat conf\/part2\.yml/);
  assert.match(text, /= ERROR Error: ENOENT conf\/part2\.yml not found/);
  assert.equal(stratumOf(event).attrs.auto, "1");
  // Status counts automatic digests separately.
  assert.match(layer.status(agent), /of these, automatic digests [\d.]+K? \(\d+\)/);
  assert.match(layer.status(agent), /Automatic folds: at turn end above 50% after 2 unanswered nudges, or above 60%/);
  // Dock / Mem0 see a fold, flagged as automatic.
  const landed = landedEvents.filter(([name]) => name === "strata/fold-landed");
  assert.ok(landed.length >= 1 && landed.every(([, payload]) => payload.auto === true));
  assert.equal(layer.state(agent).changes.at(-1).layer, "L2");
  assert.equal(layer.state(agent).changes.at(-1).auto, true);
  // Archive record + restore.
  const id = rows[0].id;
  const fold = JSON.parse(readFileSync(join(engine.archiveDir(session.id), `fold-${id}.json`), "utf8"));
  assert.equal(fold.auto, true);
  const restored = layer.decompress(agent, { id, full: true });
  assert.match(restored, /value=7003/, "a number from a folded tool output comes back");
  assert.match(restored, /ENOENT conf\/part2\.yml not found/);
  assert.match(layer.search(agent, { query: "value=7004" }), new RegExp(id));
});

test("snapshots: stale ones inside the range are dropped, never archived; live snapshot, latest user and tail untouched", async () => {
  const { engine, session, agent, layer } = setup();
  conversation(session, { snapshots: true });
  const layout = layer.layout(session);
  const live = layout.rows[layout.live].seq;
  const lastUser = layout.rows[layout.lastUser].seq;
  const tail = layout.rows.slice(layout.protectFrom).map((row) => row.seq);
  atRatio(layer, agent, session, 0.95);
  layer.autoFold(agent);
  for (const fold of layer.state(agent).pending) {
    assert.ok(!fold.seqs.includes(live), "live snapshot not covered");
    assert.ok(!fold.seqs.includes(lastUser), "latest user message not covered");
    assert.ok(!fold.seqs.some((seq) => tail.includes(seq)), "protected tail not covered");
    assert.ok(!/RECALL_/.test(fold.summary), "no recall text in the digest");
  }
  assert.ok(layer.state(agent).pending.some((fold) => fold.dropped.length > 0), "stale snapshots in range are dropped");
  await layer.flush(agent);
  const after = session.surface.nodes;
  assert.ok(after.includes(live) && after.includes(lastUser) && tail.every((seq) => after.includes(seq)));
  const dir = engine.archiveDir(session.id);
  const archived = readdirSync(dir).filter((name) => name.startsWith("fold-")).map((name) => readFileSync(join(dir, name), "utf8")).join("\n");
  assert.ok(archived.length > 0);
  assert.ok(!archived.includes("RECALL_A") && !archived.includes("RECALL_B"), "stale recall never archived");
});

test("cost check: an automatic fold that does not pay is dropped at once, not deferred; forced above 75% lands", async () => {
  const cheap = setup();
  conversation(cheap.session);
  atRatio(cheap.layer, cheap.agent, cheap.session, 0.62);
  cheap.layer.settings.expectedRequests = 1;
  cheap.layer.settings.priceHit = 0.0001; // the saving per request is worth almost nothing
  const ids = cheap.layer.autoFold(cheap.agent);
  assert.ok(ids.length >= 1);
  const result = await cheap.layer.flush(cheap.agent);
  assert.deepEqual(result.landed, []);
  assert.deepEqual(result.dropped.sort(), [...ids].sort());
  assert.equal(cheap.layer.state(cheap.agent).pending.length, 0, "re-proposed fresh next turn instead");

  const forced = setup();
  conversation(forced.session);
  atRatio(forced.layer, forced.agent, forced.session, 0.8);
  forced.layer.settings.expectedRequests = 1;
  forced.layer.autoFold(forced.agent);
  const landed = await forced.layer.flush(forced.agent);
  assert.ok(landed.landed.length >= 1, "above forcePct the cost check is waived, as for model folds");
});

test("engine turn end runs the automatic fold before the flush", async () => {
  const { engine, session, agent, layer } = setup();
  conversation(session);
  atRatio(layer, agent, session, 0.7);
  session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  await engine.finishTurn(agent);
  assert.ok(autoRows(layer, session).length >= 1);
});

test("digest: user words without system reminders, read bodies skipped, shell errors kept", () => {
  const { agent, session, layer } = setup();
  addUser(session, `<system-reminder>${filler("reminder only", 500)}</system-reminder>`);
  addUser(session, `<system-reminder>${filler("skills listing", 2000)}</system-reminder>\nAudit note: the backup lives at /srv/backups/heron.tar.`);
  addToolRound(session, { name: "read", command: "config/deploy.yaml", output: `<path>/ws/config/deploy.yaml</path>\n<type>file</type>\n<content>\n1: # deploy\n2: cache_path: /opt/q\n${filler("3: x", 6000)}\n</content>` });
  addToolRound(session, { command: "python3 tools/verify.py", output: `verifying 64 blocks\n[stderr]\nTraceback (most recent call last):\n  File "verify.py", line 4, in <module>\nValueError: checksum mismatch for block 0x3fa2\n[exit code: 1]` });
  addToolRound(session, { command: "python3 tools/check_db.py", output: `connecting ...\n[stderr]\nERROR 1045 (28000): Access denied for user 'svc'@'10.4.2.9'\n[exit code: 1]` });
  addToolRound(session, { command: "cat ok.txt", output: `all good, no Error here\n${filler("ok", 4000)}` });
  addAssistantText(session, "Done.");
  addUser(session, "Next task.");
  for (let i = 0; i < 3; i += 1) addToolRound(session, { command: `cat n${i}`, output: filler(`n${i}`, 400) });
  atRatio(layer, agent, session, 0.62);
  assert.ok(layer.autoFold(agent).length >= 1);
  const text = layer.state(agent).pending.map((fold) => fold.content || fold.summary || "").join("\n");
  assert.match(text, /\[user s\d+\] Audit note: the backup lives at \/srv\/backups\/heron\.tar\./);
  assert.doesNotMatch(text, /skills listing|reminder only|\[user s\d+\] *\n/);
  assert.match(text, /= 1: # deploy \[\d+ lines\]/);
  assert.doesNotMatch(text, /<path>/);
  assert.match(text, /= ERROR verifying 64 blocks \[\d+ lines, exit 1\] \| ValueError: checksum mismatch for block 0x3fa2/);
  assert.match(text, /= ERROR connecting \.\.\. \[\d+ lines, exit 1\] \| ERROR 1045 \(28000\): Access denied for user 'svc'@'10\.4\.2\.9'/);
  assert.match(text, /= all good, no Error here \[\d+ lines\]$/m);
});
