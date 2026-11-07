// Round-sized digests (overshoot) and mid-turn digests (quality preset).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { addAssistantText, addToolRound, addUser, fakeAgent, fakeContext, FakeSession, filler } from "./helpers/fake-dsh.mjs";

const root = mkdtempSync(join(tmpdir(), "strata-mid-"));
process.env.STRATA_SHADOW_DIR = join(root, "archive");
process.env.STRATA_MIN_BENEFIT_TOKENS = "500";
process.env.STRATA_MIN_BENEFIT_RATIO = "0.000001";
process.env.STRATA_EXPECTED_REQUESTS = "200";
const { default: Engine } = await import("../index.js");
const { readSettings } = await import("../lib/settings.js");
const { foldableTokens } = await import("../lib/layout.js");
after(() => rmSync(root, { recursive: true, force: true }));

function setup(env = {}) {
  const ctx = fakeContext();
  const engine = new Engine(ctx, {});
  const session = new FakeSession({ id: `s-${Math.random().toString(16).slice(2)}`, cwd: join(root, "work") });
  session.listeners.push((s, event) => {
    for (const fn of ctx.handlers.get("session/event") || []) fn(s, event);
  });
  const layer = engine.strataLayer;
  Object.assign(layer.settings, readSettings({ ...process.env, ...env }));
  return { ctx, engine, session, agent: fakeAgent(session), layer };
}

function addSnapshot(session, marker) {
  const recall = `<mem0-relevant-memories>${marker} ${filler(marker, 2000)}</mem0-relevant-memories>`;
  return session.append("user/message", {
    role: "user",
    content: [{ type: "text", text: `Current runtime context.\n\n${recall}` }],
    source: { kind: "runtime-context", form: "snapshot", sections: [{ name: "mem0:recall", text: recall }] },
  });
}

/** A turn of `rounds` sequential tool rounds of ~chars each (the user's pwsh / read_image shape). */
function turn(session, label, rounds, chars) {
  addUser(session, `${label}: next batch`);
  for (let i = 0; i < rounds; i += 1) addToolRound(session, { command: `pwsh -c step ${label}.${i}`, output: filler(`${label}-${i}`, chars) });
  addAssistantText(session, `${label} done`);
}

/** A tool result whose call is not on the surface (or the reverse) is a broken pair. */
function assertPaired(session) {
  const nodes = session.surface.nodes.map((seq) => session.eventAt(seq));
  const calls = new Set();
  const results = new Set();
  for (const event of nodes) {
    for (const block of event?.data?.message?.content || []) if (block?.type === "tool-call") calls.add(block.id || block.toolCallId);
    if (event?.type === "tool/result") results.add(event.data.message.toolCallId);
  }
  for (const id of results) assert.ok(calls.has(id), `result ${id} has its call`);
  for (const id of calls) assert.ok(results.has(id), `call ${id} has its result`);
}

test("presets: cost is the default; quality lowers the lines and enables mid-turn digests; env overrides", () => {
  const cost = readSettings({});
  assert.deepEqual([cost.preset, cost.autoFoldPct, cost.autoFoldForcePct, cost.autoFoldTargetPct, cost.midTurnFold, cost.nudge], ["cost", 0.5, 0.6, 0.3, false, true]);
  const quality = readSettings({ STRATA_PRESET: "quality" });
  assert.equal(quality.preset, "quality");
  assert.ok(quality.autoFoldPct < cost.autoFoldPct && quality.autoFoldTargetPct < cost.autoFoldTargetPct);
  assert.equal(quality.midTurnFold, true);
  assert.equal(readSettings({ STRATA_PRESET: "quality", STRATA_MID_TURN_FOLD: "off" }).midTurnFold, false);
  assert.equal(readSettings({ STRATA_MID_TURN_FOLD: "on" }).midTurnFold, false, "cost stays turn-end only");
  assert.equal(readSettings({ STRATA_PRESET: "quality", STRATA_AUTO_FOLD_TARGET_PCT: "0.2" }).autoFoldTargetPct, 0.2);
  assert.equal(readSettings({ STRATA_NUDGE: "off" }).nudge, false);
  // Current-turn digests: quality only, on by default, off with either flag.
  assert.equal(cost.midTurnCurrent, false);
  assert.equal(quality.midTurnCurrent, false, "off until validated live");
  assert.equal(readSettings({ STRATA_PRESET: "quality", STRATA_MID_TURN_CURRENT: "on" }).midTurnCurrent, true);
  assert.equal(readSettings({ STRATA_MID_TURN_CURRENT: "on" }).midTurnCurrent, false, "cost never folds the current turn");
  assert.equal(readSettings({ STRATA_PRESET: "quality", STRATA_MID_TURN_CURRENT: "off" }).midTurnCurrent, false);
  assert.equal(readSettings({ STRATA_PRESET: "quality", STRATA_MID_TURN_FOLD: "off", STRATA_MID_TURN_CURRENT: "on" }).midTurnCurrent, false);
});

test("digest unit is a tool round: many small rounds land within ~1% of the target, not a whole turn over it", async () => {
  const { ctx, session, agent, layer } = setup();
  const base = ctx.tokenMeter;
  ctx.tokenMeter = { ...base, measure: (s) => { const m = base.measure(s); return { ...m, surfaceTokens: m.totalTokens, totalTokens: Math.round(m.totalTokens * 3) }; } };
  const get = ctx.get?.bind(ctx);
  ctx.get = (name) => (name === "sessionProjections" ? { snapshot: () => ({ values: { contextBreakdown: { systemTokens: 0, toolsTokens: 0, messageTokens: 0 } } }) } : get?.(name));
  layer.state(agent).window = 1_000_000;
  // Turns of 20 rounds × ~3K local (~9K provider): one turn ≈ 18% of the window.
  let t = 0;
  let landed = [];
  while (landed.length === 0 && t < 12) {
    turn(session, `t${t}`, 20, 12_000);
    t += 1;
    layer.state(agent).unanswered = 5;
    landed = await layer.turnEnd(agent);
  }
  assert.ok(landed.length >= 2, `several round digests landed: ${landed}`);
  const layout = layer.layout(session);
  const target = layout.fixedTokens + 0.3 * (1_000_000 - layout.fixedTokens);
  assert.ok(Math.abs(layout.totalTokens - target) <= 15_000, `within 1.5% of the target: ${layout.totalTokens} vs ${Math.round(target)}`);
  assertPaired(session);
  // Each digest covers whole rounds: it starts at a user message or a call and ends at a result or reply.
  for (const fold of layer.layout(session).rows.filter((row) => row.stratum === "fold")) assert.ok(fold.auto);
});

test("the walk stops before a round that would overshoot the target by more than half of it", () => {
  const { session, agent, layer } = setup();
  addUser(session, "old work");
  for (let i = 0; i < 4; i += 1) addToolRound(session, { command: `cat small${i}`, output: filler(`small${i}`, 20_000) }); // ~5K each
  addToolRound(session, { command: "cat big.log", output: filler("big", 480_000) }); // ~120K
  addAssistantText(session, "ok");
  turn(session, "tail", 3, 2000);
  const layout = layer.layout(session);
  const small = layout.rows.filter((row) => row.foldable).reduce((sum, row) => sum + (row.preview.includes("big") ? 0 : row.tokens), 0);
  // need ≈ the small rounds + 3K: the big round would overshoot by ~110K (> half of 120K).
  const need = small + 3_000;
  layer.state(agent).window = Math.round((layout.totalTokens - need) / 0.3);
  layer.settings.autoFoldPct = 0.32;
  layer.settings.autoFoldForcePct = 0.33;
  layer.state(agent).unanswered = 5;
  const ids = layer.autoFold(agent);
  assert.ok(ids.length >= 1, `the small rounds fold (${layer.state(agent).lastAutoFold.outcome})`);
  const pending = layer.state(agent).pending;
  assert.ok(pending.every((fold) => fold.tokens < 60_000), "the big round is not in any digest");
  assert.match(layer.state(agent).lastAutoFold.outcome, /stopped before s\d+–s\d+ \(~[\d.]+K provider\) to stay near the target/);
  assert.equal(layer.state(agent).autoExhausted, false, "a deliberate stop does not arm the regrowth guard");
});

/** Three earlier turns, then a current turn that grows past the quality force line. */
function midTurnSession(env = {}) {
  const s = setup({ STRATA_PRESET: "quality", STRATA_MID_TURN_CURRENT: "on", ...env });
  const { session, layer, agent } = s;
  addSnapshot(s.session, "OLD_RECALL");
  for (let t = 0; t < 3; t += 1) turn(session, `old${t}`, 6, 16_000);
  // DSH opens a turn before its user message; compaction events inside it must carry it.
  session.append("turn/start", { turn: "turn-current" });
  addUser(session, "current: inspect the screenshots");
  const live = addSnapshot(session, "LIVE_RECALL");
  for (let i = 0; i < 8; i += 1) addToolRound(session, { name: "read_image", command: `shots/${i}.png`, output: filler(`img-${i}`, 16_000) });
  layer.state(agent).window = Math.round(layer.layout(session).totalTokens / 0.45);
  return { ...s, live: live.seq };
}

test("mid-turn (STRATA_MID_TURN_CURRENT=off): only earlier turns fold; the current turn's call/result pairs and the live snapshot stay", async () => {
  const { session, agent, layer, live } = midTurnSession({ STRATA_MID_TURN_CURRENT: "off" });
  const before = layer.layout(session);
  const currentSeqs = before.rows.slice(before.turnStart).map((row) => row.seq);
  layer.state(agent).nudgedAt = 123;
  layer.state(agent).unanswered = 2;
  const landed = await layer.midTurnFold(agent);
  assert.ok(landed.length >= 1, "digests landed mid-turn");
  const after = layer.layout(session);
  for (const seq of currentSeqs) assert.ok(session.surface.nodes.includes(seq), `current-turn node ${seq} untouched`);
  assert.ok(session.surface.nodes.includes(live), "live runtime-context snapshot untouched");
  assertPaired(session);
  // Order: digests sit before the current turn, oldest first.
  const foldIdx = after.rows.filter((row) => row.stratum === "fold").map((row) => row.index);
  assert.ok(foldIdx.every((index) => index < after.turnStart));
  assert.ok(after.totalTokens < before.totalTokens);
  // The compaction events belong to the open turn (DSH rejects the log otherwise).
  const lifecycle = session.events.filter((event) => event.type === "compaction/start" || event.type === "compaction/end");
  assert.ok(lifecycle.length >= 2 && lifecycle.every((event) => event.data.turn === "turn-current"));
  // Bookkeeping after a mid-turn landing.
  const state = layer.state(agent);
  assert.equal(state.pending.length, 0);
  assert.equal(state.baseline, foldableTokens(after));
  assert.equal(state.autoFoldedAt, state.baseline);
  assert.equal(state.nudgedAt, null);
  assert.equal(state.unanswered, 0);
  assert.equal(state.lastAutoFold, undefined, "the turn-end line is not overwritten");
  assert.match(layer.status(agent), /Mid-turn digests \(before a step, above 35%, earlier turns only\): \d+ landed; last: landed f\d+/);
});

test("mid-turn: a pending model fold stays pending (lands at turn end); digests go around it", async () => {
  const { session, agent, layer } = midTurnSession();
  const runs = layer.snapshot(agent).runs;
  const run = runs.sort((a, b) => a.start - b.start)[0];
  const end = run.rows.filter((row) => row.closeOk)[2];
  assert.match(layer.propose(agent, `${run.startRef}–${end.ref} early\nearly work.`), /pending T1 fold/);
  const model = layer.state(agent).pending[0];
  const landed = await layer.midTurnFold(agent);
  assert.ok(landed.length >= 1);
  assert.ok(!landed.includes(model.id));
  assert.deepEqual(layer.state(agent).pending.map((fold) => fold.id), [model.id], "model fold still pending");
  for (const row of layer.layout(session).rows.filter((r) => r.stratum === "fold")) assert.ok(!model.seqs.includes(row.seq));
  // Its range is still valid and lands at turn end.
  const flushed = await layer.flush(agent);
  assert.ok(flushed.landed.includes(model.id));
});

test("mid-turn: off in the cost preset and with STRATA_MID_TURN_FOLD=off; below the force line nothing happens", async () => {
  for (const env of [{ STRATA_PRESET: "cost" }, { STRATA_MID_TURN_FOLD: "off" }]) {
    const { agent, layer } = midTurnSession(env);
    assert.deepEqual(await layer.midTurnFold(agent), []);
  }
  const { session, agent, layer } = midTurnSession();
  layer.state(agent).window = Math.round(layer.layout(session).totalTokens / 0.3);
  assert.deepEqual(await layer.midTurnFold(agent), []);
  assert.match(layer.state(agent).lastMidTurnFold.outcome, /below 35%/);
});

test("mid-turn runs in the pressure path before L∞; L∞ runs only if the digests were not enough", async () => {
  const stock = Object.getPrototypeOf(Engine.prototype);
  const original = stock.compactIfNeeded;
  const calls = [];
  try {
    // "not enough": earlier turns only; "current": the same turn, with its finished rounds digested too.
    for (const [label, currentRounds, env] of [["enough", 8, {}], ["not enough", 40, { STRATA_MID_TURN_CURRENT: "off" }], ["current", 40, { STRATA_MID_TURN_CURRENT: "on" }]]) {
      const s = setup({ STRATA_PRESET: "quality", ...env });
      const { session, layer, agent, engine } = s;
      for (let t = 0; t < 3; t += 1) turn(session, `old${t}`, 6, 16_000);
      session.append("turn/start", { turn: `turn-${label}` });
      addUser(session, "current");
      for (let i = 0; i < currentRounds; i += 1) addToolRound(session, { command: `pwsh ${i}`, output: filler(`c${i}`, 16_000) });
      const window = Math.round((layer.layout(session).totalTokens - (currentRounds - 8) * 4000) / 0.45);
      layer.state(agent).window = window;
      // Stock L∞ stand-in: compacts only above 50% of the window.
      stock.compactIfNeeded = async function (a) {
        const total = this.ctx.tokenMeter.measure(a.session).totalTokens;
        calls.push({ label, ratio: total / window, ran: total >= window * 0.5 });
        return null;
      };
      await engine.compactIfNeeded(agent, "pressure", new AbortController().signal);
      assert.ok(layer.state(agent).midTurnLanded >= 1, `${label}: digests landed first`);
    }
  } finally {
    stock.compactIfNeeded = original;
  }
  assert.equal(calls.length, 3);
  assert.equal(calls[0].ran, false, `digests were enough: ${calls[0].ratio}`);
  assert.equal(calls[1].ran, true, `the current turn alone is above the L∞ line: ${calls[1].ratio}`);
  assert.equal(calls[2].ran, false, `current-turn digests keep it under the L∞ line: ${calls[2].ratio}`);
});

test("turn end: later passes use the estimated total, not DSH's total still anchored on the last request", async () => {
  const { ctx, session, agent, layer } = setup({ STRATA_PRESET: "quality", STRATA_NUDGE: "off" });
  const base = ctx.tokenMeter;
  // DSH re-anchors its total on the next request; until then a landing does not show in it.
  let anchored = null;
  let generation = session.surface.replaceGeneration;
  ctx.tokenMeter = { ...base, measure: (s) => {
    const m = base.measure(s);
    const real = m.totalTokens * 2;
    if (s.surface.replaceGeneration !== generation && anchored != null) return { ...m, surfaceTokens: m.totalTokens, totalTokens: anchored };
    anchored = real;
    return { ...m, surfaceTokens: m.totalTokens, totalTokens: real };
  } };
  const get = ctx.get?.bind(ctx);
  ctx.get = (name) => (name === "sessionProjections" ? { snapshot: () => ({ values: { contextBreakdown: { systemTokens: 0, toolsTokens: 0, messageTokens: 0 } } }) } : get?.(name));
  for (let t = 0; t < 3; t += 1) turn(session, `t${t}`, 18, 16_000);
  layer.state(agent).window = Math.round(layer.layout(session).totalTokens / 0.53);
  const window = layer.state(agent).window;
  const landed = await layer.turnEnd(agent);
  assert.ok(landed.length >= 2);
  generation = session.surface.replaceGeneration;
  anchored = null; // the next request re-anchors
  const after = layer.layout(session);
  const target = 0.15 * window;
  assert.ok(Math.abs(after.totalTokens - target) <= 0.03 * window, `near the 15% target, not far below it: ${(after.totalTokens / window * 100).toFixed(1)}%`);
});

/** Seqs of each tool round (the call message and its results) in surface order, from `from`. */
function roundsOf(session, fromSeq) {
  const rounds = [];
  for (const seq of session.surface.nodes) {
    if (seq < fromSeq) continue;
    const event = session.eventAt(seq);
    const calls = (event?.data?.message?.content || []).filter((block) => block?.type === "tool-call");
    if (event?.type === "assistant/message" && calls.length) rounds.push([seq]);
    else if (event?.type === "tool/result" && rounds.length) rounds.at(-1).push(seq);
  }
  return rounds;
}

test("current turn: earlier turns first, then this turn's finished rounds, each whole; the tail, the user message and the live snapshot stay", async () => {
  const { session, agent, layer, live } = midTurnSession();
  const before = layer.layout(session);
  const userSeq = before.rows[before.turnStart].seq;
  const tailSeqs = before.rows.slice(before.protectFrom).map((row) => row.seq);
  const currentRounds = roundsOf(session, userSeq);
  layer.state(agent).nudgedAt = 123;
  layer.state(agent).unanswered = 2;
  const landed = await layer.midTurnFold(agent);
  assert.ok(landed.length >= 2, `digests landed: ${layer.state(agent).lastMidTurnFold?.outcome}`);
  const after = layer.layout(session);
  assertPaired(session);
  assert.ok(session.surface.nodes.includes(userSeq), "the turn's user message stays");
  assert.ok(session.surface.nodes.includes(live), "the live snapshot stays");
  for (const seq of tailSeqs) assert.ok(session.surface.nodes.includes(seq), `protected tail node ${seq} stays`);
  // Each current-turn round is either all on the surface or all folded.
  let foldedRounds = 0;
  for (const round of currentRounds) {
    const present = round.filter((seq) => session.surface.nodes.includes(seq)).length;
    assert.ok(present === 0 || present === round.length, `round ${round[0]} whole (${present}/${round.length})`);
    if (present === 0) foldedRounds += 1;
  }
  assert.ok(foldedRounds >= 1 && foldedRounds < currentRounds.length, `some current rounds folded (${foldedRounds}/${currentRounds.length})`);
  // Folded rounds are the oldest ones of the turn, and every older turn went first.
  const presentFlags = currentRounds.map((round) => session.surface.nodes.includes(round[0]));
  assert.deepEqual(presentFlags, presentFlags.map((_, i) => i >= foldedRounds), "oldest rounds fold first");
  assert.equal(after.rows.slice(0, after.turnStart).filter((row) => row.stratum === "raw" && row.role === "tool").length, 0, "older turns digested before the current one");
  const folds = after.rows.filter((row) => row.stratum === "fold");
  assert.ok(folds.some((row) => row.index > after.turnStart), "a digest sits inside the current turn");
  assert.ok(folds.every((row) => row.index < after.protectFrom));
  // The compaction events belong to the open turn.
  const lifecycle = session.events.filter((event) => event.type === "compaction/start" || event.type === "compaction/end");
  assert.ok(lifecycle.length >= 2 && lifecycle.every((event) => event.data.turn === "turn-current"));
  // Bookkeeping: model folds untouched, baseline and autoFoldedAt at the new foldable, nudges reset.
  const state = layer.state(agent);
  assert.equal(state.pending.length, 0);
  assert.equal(state.baseline, foldableTokens(after));
  assert.equal(state.autoFoldedAt, state.baseline);
  assert.equal(state.nudgedAt, null);
  assert.equal(state.unanswered, 0);
  assert.equal(state.lastAutoFold, undefined);
  assert.match(layer.status(agent), /Mid-turn digests \(before a step, above 35%, earlier turns first, then this turn's finished rounds outside the protected tail\): \d+ landed/);
  // A folded current-turn round restores word for word.
  assert.ok(landed.some((id) => /img-\d line with some content/.test(layer.decompress(agent, { id }))));
});

test("current turn: the step in flight (a call still waiting for a result) and the newest round are never folded", async () => {
  const { session, agent, layer } = midTurnSession({ STRATA_PROTECTED_TAIL_PCT: "0.001" });
  // The newest round has two parallel calls; one result is still out.
  const call = session.append("assistant/message", {
    turn: 1,
    message: { role: "assistant", content: [{ type: "tool-call", id: "fly-1", name: "read_image", arguments: { command: "a.png" } }, { type: "tool-call", id: "fly-2", name: "read_image", arguments: { command: "b.png" } }] },
  });
  const result = session.append("tool/result", { turn: 1, message: { role: "tool", toolCallId: "fly-1", content: [{ type: "text", text: filler("fly", 40_000) }] } });
  const before = layer.layout(session);
  assert.ok(before.tail.capped, "the cap leaves only the newest round in the tail");
  assert.equal(before.rows[before.protectFrom].seq, call.seq);
  const landed = await layer.midTurnFold(agent);
  assert.ok(landed.length >= 1);
  assert.ok(session.surface.nodes.includes(call.seq) && session.surface.nodes.includes(result.seq), "the step in flight stays");
  const after = layer.layout(session);
  const callIndex = after.rows.find((row) => row.seq === call.seq).index;
  assert.ok(after.rows.filter((row) => row.stratum === "fold").every((row) => row.index < callIndex));
  // Every earlier current-turn round is whole: folded or not.
  for (const round of roundsOf(session, 0).filter((r) => r[0] < call.seq)) {
    const present = round.filter((seq) => session.surface.nodes.includes(seq)).length;
    assert.ok(present === 0 || present === round.length);
  }
});

test("current turn: a stale snapshot inside the turn may fold; the live one stays", async () => {
  const { session, agent, layer, live } = midTurnSession();
  // A newer snapshot mid-turn makes the earlier one stale.
  for (let i = 0; i < 2; i += 1) addToolRound(session, { name: "read_image", command: `more/${i}.png`, output: filler(`more-${i}`, 16_000) });
  const newest = addSnapshot(session, "NEWER_RECALL");
  for (let i = 0; i < 3; i += 1) addToolRound(session, { name: "read_image", command: `last/${i}.png`, output: filler(`last-${i}`, 16_000) });
  layer.state(agent).window = Math.round(layer.layout(session).totalTokens / 0.45);
  const landed = await layer.midTurnFold(agent);
  assert.ok(landed.length >= 1);
  assert.ok(session.surface.nodes.includes(newest.seq), "the live snapshot stays");
  assert.equal(layer.layout(session).rows.find((row) => row.seq === newest.seq).live, true);
  assert.ok(!session.surface.nodes.includes(live), "the stale one folded with its rounds");
  assertPaired(session);
});

test("current turn: off with STRATA_MID_TURN_CURRENT=off; L1's next cut after a current-turn digest stays behind it", async () => {
  {
    const { session, agent, layer } = midTurnSession({ STRATA_MID_TURN_CURRENT: "off" });
    const turnStart = layer.layout(session).turnStart;
    const currentSeqs = layer.layout(session).rows.slice(turnStart).map((row) => row.seq);
    await layer.midTurnFold(agent);
    for (const seq of currentSeqs) assert.ok(session.surface.nodes.includes(seq));
  }
  const { engine, session, agent, layer } = midTurnSession();
  const landed = await layer.midTurnFold(agent);
  const turnStart = layer.layout(session).turnStart;
  const midFolds = layer.layout(session).rows.filter((row) => row.stratum === "fold" && row.index > turnStart).map((row) => row.seq);
  assert.ok(midFolds.length >= 1);
  // The turn goes on and ends; turn-end L2 and L1 run.
  for (let i = 0; i < 6; i += 1) addToolRound(session, { name: "bash", command: `pwsh -c tail ${i}`, output: filler(`tail-${i}`, 12_000) });
  addAssistantText(session, "done");
  session.append("turn/end", { turn: "turn-current" });
  await engine.finishTurn(agent);
  assertPaired(session);
  const rows = layer.layout(session).rows;
  const lastFold = Math.max(...rows.filter((row) => row.stratum === "fold").map((row) => row.index));
  for (const card of rows.filter((row) => row.stratum === "card")) assert.ok(card.index > lastFold, "L1 cuts only after the newest fold");
  for (const id of landed) assert.match(layer.decompress(agent, { id }), /line with some content/);
});
