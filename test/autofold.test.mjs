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
  // The model folds only the first two tool rounds of the run.
  const small = run.rows.filter((row) => row.closeOk)[2];
  assert.match(busy.layer.propose(busy.agent, `${run.startRef}–${small.ref} config\nMigrated the config; PORT=8443.`), /pending T1 fold/);
  assert.equal(busy.layer.state(busy.agent).unanswered, 0, "a model compress answers the nudges");
  // A pending model fold no longer blocks automatic folds: it counts toward the target,
  // and automatic folds go around its range.
  const modelSeqs = new Set(busy.layer.state(busy.agent).pending[0].seqs);
  const autoIds = busy.layer.autoFold(busy.agent);
  assert.ok(autoIds.length >= 1, "still far above the target: automatic folds join the batch");
  for (const fold of busy.layer.state(busy.agent).pending.filter((item) => item.auto)) assert.ok(fold.seqs.every((seq) => !modelSeqs.has(seq)), "never overlaps the model's fold");
  assert.match(busy.layer.status(busy.agent), /Automatic fold at last turn end: proposed f\d+/);
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

/** DSH's meter: totalTokens includes what is outside the surface (tool definitions …); surfaceTokens is the surface sum. */
function withOverhead(ctx, overhead, { scale = 1, breakdown = true } = {}) {
  const base = ctx.tokenMeter;
  ctx.tokenMeter = { ...base, measure: (s) => { const m = base.measure(s); return { ...m, surfaceTokens: m.totalTokens, totalTokens: Math.round((m.totalTokens + overhead()) * scale) }; } };
  if (breakdown) {
    const get = ctx.get?.bind(ctx);
    ctx.get = (name) => (name === "sessionProjections" ? { snapshot: () => ({ values: { contextBreakdown: { systemTokens: 0, toolsTokens: overhead(), messageTokens: 0 } } }) } : get?.(name));
  }
}

const reclaimOf = (layer, agent) => layer.state(agent).pending.reduce((sum, fold) => sum + fold.tokens - fold.foldTokens, 0);

test("normal case: no overhead, target is 30% of the window; status shows fixed overhead", () => {
  const { session, agent, layer } = setup();
  conversation(session);
  const total = atRatio(layer, agent, session, 0.62);
  const window = layer.state(agent).window;
  assert.equal(layer.layout(session).fixedTokens, 0);
  assert.ok(layer.autoFold(agent).length >= 1);
  assert.ok(reclaimOf(layer, agent) >= total - window * 0.3 || layer.state(agent).pending.length >= 2, "folds toward 30% of the window");
  assert.match(layer.status(agent), /Fixed overhead \(system prompt, tool definitions and similar; never folded\): ~0 \(0%\)/);
  assert.match(layer.status(agent, { detail: true }), /Fixed overhead/);
});

test("high overhead (~40% of the window): target counts only the foldable part, and no refold without new growth", async () => {
  const { ctx, session, agent, layer } = setup();
  conversation(session);
  const surface = layer.layout(session).totalTokens;
  // total = surface + 0.4 W at 65% → W = surface / 0.25.
  const window = Math.round(surface / 0.25);
  layer.state(agent).window = window;
  const overhead = Math.round(window * 0.4);
  withOverhead(ctx, () => overhead);
  const layout = layer.layout(session);
  assert.equal(layout.fixedTokens, overhead);
  assert.match(layer.status(agent), new RegExp(`Fixed overhead .*: ~[\\d.]+K \\(40%\\)`));
  const target = overhead + 0.3 * (window - overhead);
  const need = layout.totalTokens - target;
  const ids = layer.autoFold(agent);
  assert.ok(ids.length >= 1, "due at 65%");
  const reclaim = reclaimOf(layer, agent);
  assert.ok(reclaim >= need, `reaches the target (${reclaim} >= ${need})`);
  // The old rule (30% of the whole window) would have needed far more.
  const oldNeed = layout.totalTokens - 0.3 * window;
  assert.ok(need < oldNeed / 3, `new need ${need} vs old ${oldNeed}`);
  assert.equal(ids.length, 1, "one run is enough; the old rule would have folded both");
  const landed = await layer.flush(agent);
  assert.deepEqual(landed.landed.sort(), [...ids].sort());
  assert.ok(layer.state(agent).autoFoldedAt != null);
  // Next turns: still above 60% because of the overhead, little new work → nothing proposed.
  for (let turn = 0; turn < 3; turn += 1) {
    addUser(session, `small follow-up ${turn}`);
    // Some new work, but less than a nudge step (50K): enough to put the session back above the target.
    for (let i = 0; i < 4; i += 1) addToolRound(session, { command: `echo ${turn}.${i}`, output: filler(`t${turn}-${i}`, 4000) });
    layer.state(agent).unanswered = 5;
    // Keep the session above the 60% trigger (and below 75%), as a high-overhead session sits.
    layer.state(agent).window = Math.round(layer.layout(session).totalTokens / 0.7);
    assert.deepEqual(layer.autoFold(agent), [], `turn ${turn}: no refold`);
    assert.equal(layer.state(agent).pending.length, 0);
  }
  // The guard is what stops it: without the record of the last automatic fold it would refold.
  const mark = layer.state(agent).autoFoldedAt;
  layer.state(agent).autoFoldedAt = null;
  assert.ok(layer.autoFold(agent).length >= 1, "without the guard the remaining runs would be refolded");
  layer.state(agent).pending.length = 0;
  layer.state(agent).autoFoldedAt = mark;
  // New work of a nudge step re-enables it.
  for (let i = 0; layer.layout(session).rows.reduce((n, r) => n + (r.foldable ? r.tokens : 0), 0) - mark < layer.settings.nudgeGrowthTokens && i < 400; i += 1) addToolRound(session, { command: `grow ${i}`, output: filler(`g${i}`, 4000) });
  layer.state(agent).window = Math.round(layer.layout(session).totalTokens / 0.7);
  assert.ok(layer.autoFold(agent).length >= 1, "after +nudgeGrowthTokens it folds again");
});

test("no proposal when everything left is fixed or protected; the force line still folds", () => {
  const { ctx, session, agent, layer } = setup();
  conversation(session);
  // A large protected tail (the live task's last rounds).
  for (let i = 0; i < 3; i += 1) addToolRound(session, { command: `cat big${i}`, output: filler(`big-${i}`, 24000) });
  const layout0 = layer.layout(session);
  const foldable = layout0.rows.reduce((sum, row) => sum + (row.foldable ? row.tokens : 0), 0);
  const kept = layout0.totalTokens - foldable;
  // At 70% (< 75%) with some overhead, even folding every foldable row cannot reach the target.
  const window = Math.round(layout0.totalTokens / 0.6);
  layer.state(agent).window = window;
  const overhead = Math.round(window * 0.7) - layout0.totalTokens;
  withOverhead(ctx, () => overhead);
  const target = overhead + 0.3 * (window - overhead);
  assert.ok(overhead + kept > target, "setup: unreachable target");
  layer.state(agent).unanswered = 5;
  assert.deepEqual(layer.autoFold(agent), [], "unreachable below the force line");
  // Above 75% it still folds what it can.
  layer.state(agent).window = Math.round(layer.layout(session).totalTokens / 0.8);
  assert.ok(layer.autoFold(agent).length >= 1, "forced above 75%");
});

test("fixed overhead stays flat while raw grows, though the provider counts dense text 1.6× the local estimate", () => {
  for (const breakdown of [true, false]) {
    const { ctx, session, agent, layer } = setup();
    const tools = 4000;
    withOverhead(ctx, () => tools, { scale: 1.6, breakdown });
    addUser(session, "Read the five day logs each turn.");
    layer.state(agent).window = 1_000_000;
    const first = layer.layout(session);
    const fixedSeen = [first.fixedTokens];
    for (let turn = 0; turn < 5; turn += 1) {
      addUser(session, `turn ${turn}`);
      for (let i = 0; i < 5; i += 1) addToolRound(session, { name: "read", command: `logs/day0${i}.log`, output: filler(`2026-11-0${i} E0${turn}${i}38 12:00:0${i}`, 44000) });
      fixedSeen.push(layer.layout(session).fixedTokens);
    }
    const last = layer.layout(session);
    const surface = last.surfaceTokens;
    // The old rule (total − surface) grows with every read: 0.6 × surface + 1.6 × tools.
    assert.ok(last.totalTokens - surface > fixedSeen[0] * 5, `old rule would have grown (${last.totalTokens - surface})`);
    const spread = Math.max(...fixedSeen) - Math.min(...fixedSeen);
    assert.ok(spread <= fixedSeen[0] * 0.1, `${breakdown ? "with" : "without"} breakdown: fixed stayed flat (${fixedSeen.join(", ")})`);
    if (breakdown) assert.ok(Math.abs(last.fixedTokens - 1.6 * tools) < 50, `fixed = scale × tools (${last.fixedTokens})`);
    assert.ok(Math.abs(last.scale - 1.6) < 0.05, `scale ${last.scale}`);
    assert.match(layer.status(agent), /Provider counts run ×1\.6\d the local estimate/);
  }
});

test("auto fold converts the provider-unit need into local units (scale 1.6)", () => {
  const { ctx, session, agent, layer } = setup();
  conversation(session);
  withOverhead(ctx, () => 0, { scale: 1.6 });
  const layout = layer.layout(session);
  const window = Math.round(layout.totalTokens / 0.62);
  layer.state(agent).window = window;
  const need = (layout.totalTokens - 0.3 * window) / 1.6;
  assert.ok(layer.autoFold(agent).length >= 1);
  const reclaim = reclaimOf(layer, agent);
  assert.ok(reclaim >= need, `local reclaim ${reclaim} covers the local need ${need}`);
});

/** Grow foldable work in small rounds until `check` returns non-null; returns the local growth at that point. */
function growUntil(layer, agent, session, from, check, label, limit = 600) {
  const { foldableTokens: measure } = layer.__layout;
  for (let i = 0; i < limit; i += 1) {
    addToolRound(session, { command: `${label} ${i}`, output: filler(`${label}-${i}`, 800) });
    const result = check();
    if (result) return measure(layer.layout(session)) - from;
  }
  return Infinity;
}

test("ratio 1.7: the nudge step and its re-arm are provider tokens; ratio 1 behaves as before", async () => {
  const layoutModule = await import("../lib/layout.js");
  for (const scale of [1, 1.7]) {
    const { ctx, session, agent, layer } = setup();
    layer.__layout = layoutModule;
    withOverhead(ctx, () => 2000, { scale });
    layer.settings.nudgeGrowthTokens = 8000;
    layer.state(agent).window = 10_000_000;
    addUser(session, "start");
    for (let i = 0; i < 3; i += 1) addToolRound(session, { command: `seed ${i}`, output: filler(`seed-${i}`, 400) });
    const local = () => layoutModule.foldableTokens(layer.layout(session));
    const start = local();
    layer.state(agent).baseline = start;
    const first = growUntil(layer, agent, session, start, () => layer.nudge(agent), `n${scale}`);
    const step = 8000 / scale;
    assert.ok(first >= step && first < step + 600, `scale ${scale}: first nudge after ~${Math.round(step)} local (= 8000 provider), got ${first}`);
    if (scale > 1) assert.ok(first < 8000, "fires before 8000 local tokens");
    const mark = layer.state(agent).nudgedAt;
    const half = growUntil(layer, agent, session, mark, () => layer.nudge(agent), `h${scale}`);
    assert.ok(half >= step / 2 && half < step / 2 + 600, `scale ${scale}: re-arm after ~${Math.round(step / 2)} local, got ${half}`);
    const text = layer.status(agent, { detail: true });
    assert.match(text, new RegExp(`next nudge at \\+4\\.0K \\(provider; ~${(4000 / scale / 1000).toFixed(1).replace(".", "\\.")}K local at ×${scale.toFixed(2).replace(".", "\\.")}\\)`));
  }
});

test("ratio 1.7: after an automatic fold the guard waits for 50K provider tokens of growth", async () => {
  const layoutModule = await import("../lib/layout.js");
  for (const scale of [1, 1.7]) {
    const { ctx, session, agent, layer } = setup();
    withOverhead(ctx, () => 0, { scale });
    layer.settings.nudgeGrowthTokens = 8000;
    conversation(session);
    atRatio(layer, agent, session, 0.62);
    assert.ok(layer.autoFold(agent).length >= 1);
    await layer.flush(agent);
    const mark = layer.state(agent).autoFoldedAt;
    assert.ok(mark != null);
    let grown = 0;
    for (let i = 0; i < 600; i += 1) {
      addToolRound(session, { command: `g${i}`, output: filler(`g-${i}`, 800) });
      layer.state(agent).unanswered = 5;
      layer.state(agent).window = Math.round(layer.layout(session).totalTokens / 0.7);
      grown = layoutModule.foldableTokens(layer.layout(session)) - mark;
      const ids = layer.autoFold(agent);
      if (ids.length) break;
    }
    const step = 8000 / scale;
    assert.ok(grown >= step && grown < step + 600, `scale ${scale}: guard released after ~${Math.round(step)} local (= 8000 provider), got ${grown}`);
    assert.match(layer.status(agent), new RegExp(`the next waits for \\+8\\.0K \\(provider; ~${(8000 / scale / 1000).toFixed(1).replace(".", "\\.")}K local at ×${scale.toFixed(2).replace(".", "\\.")}\\) foldable growth`));
  }
});

test("user's Windows shape: early model fold, a deferred model compress, ratio 1.96 → a digest by the turn that crosses 60%", async () => {
  const { ctx, session, agent, layer } = setup();
  withOverhead(ctx, () => 15300, { scale: 1.96 });
  layer.state(agent).window = 1_000_000;
  let day = 0;
  const turn = () => {
    addUser(session, `read the next five logs (${day})`);
    for (let i = 0; i < 5; i += 1, day += 1) addToolRound(session, { name: "read", command: `logs/day${day}.log`, output: filler(`2026 E0${day} line`, 44800) });
    addAssistantText(session, "done");
  };
  const finish = async () => {
    layer.autoFold(agent);
    return layer.flush(agent);
  };
  for (let t = 0; t < 4; t += 1) {
    turn();
    await finish();
  }
  // The model folds the early work itself (T1 f1), as in the user's session.
  const early = layer.layout(session).rows.filter((row) => row.foldable);
  const half = early.findLast((row) => row.closeOk && row.index < early.length / 2);
  assert.match(layer.propose(agent, `${early[0].ref}–${half.ref} early logs\nDays 0-9 read; codes noted.`), /pending T1 fold/);
  assert.equal((await layer.flush(agent)).landed.length, 1);
  turn();
  // A later small model compress is deferred by the cost check and stays pending.
  const rows = layer.layout(session).rows.filter((row) => row.foldable && row.stratum === "raw");
  const one = rows.find((row) => row.role === "assistant" && row.toolCalls > 0);
  const result = rows[rows.indexOf(one) + 1];
  layer.settings.minBenefitTokens = 100_000;
  assert.match(layer.propose(agent, `${one.ref}–${result.ref} one log\nday read.`), /deferred, NOT applied/);
  layer.settings.minBenefitTokens = 500;
  let landedAuto = null;
  for (let t = 0; t < 3 && !landedAuto; t += 1) {
    turn();
    const ratio = layer.layout(session).totalTokens / 1_000_000;
    const before = new Set(layer.state(agent).pending.map((fold) => fold.id));
    const ids = layer.autoFold(agent);
    const flushed = await layer.flush(agent);
    if (ratio >= 0.6) {
      assert.ok(before.size >= 1 || t > 0, "a model fold was pending");
      assert.ok(ids.length >= 1, `turn crossing 60% (${(ratio * 100).toFixed(1)}%) proposes a digest: ${layer.state(agent).lastAutoFold?.outcome}`);
      landedAuto = flushed.landed.filter((id) => ids.includes(id));
      assert.ok(landedAuto.length >= 1, `and lands it: ${JSON.stringify(flushed)}`);
    }
  }
  assert.ok(landedAuto, "context crossed 60% within three turns");
  assert.match(layer.status(agent, { detail: true }), new RegExp(`Automatic fold at last turn end: landed ${landedAuto[0]}`));
});

test("last turn-end outcome: below 50%, waiting for growth, and errors are reported", async () => {
  const { session, agent, layer } = setup();
  conversation(session);
  atRatio(layer, agent, session, 0.4);
  layer.autoFold(agent);
  assert.match(layer.status(agent), /Automatic fold at last turn end: skipped \(40%: below 50%\)\./);
  atRatio(layer, agent, session, 0.55);
  layer.state(agent).unanswered = 1;
  layer.autoFold(agent);
  assert.match(layer.status(agent), /skipped \(55%: below 60% and 1 of 2 unanswered nudges\)/);
  atRatio(layer, agent, session, 0.62);
  layer.state(agent).autoFoldedAt = layer.snapshot(agent).foldable;
  layer.autoFold(agent);
  assert.match(layer.status(agent), /skipped \(waiting for \+50\.0K \(provider; ~50\.0K local at ×1\.00\) foldable growth since the last digest; \+0 local so far\)/);
});
