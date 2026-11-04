import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { addAssistantText, addToolRound, addUser, fakeAgent, fakeContext, FakeSession, filler } from "./helpers/fake-dsh.mjs";

const root = mkdtempSync(join(tmpdir(), "strata-l2-"));
process.env.STRATA_SHADOW_DIR = join(root, "archive");
process.env.STRATA_MIN_BENEFIT_TOKENS = "1000";
process.env.STRATA_MIN_BENEFIT_RATIO = "0.000001";
const { default: Engine } = await import("../index.js");
const { stratumOf } = await import("../lib/stratum.js");

after(() => rmSync(root, { recursive: true, force: true }));

function setup({ window = 1_000_000, id = `s-${Math.random().toString(16).slice(2)}` } = {}) {
  const ctx = fakeContext({ contextWindow: window });
  const engine = new Engine(ctx, {});
  const session = new FakeSession({ id, cwd: join(root, "work") });
  session.listeners.push((s, event) => {
    for (const fn of ctx.handlers.get("session/event") || []) fn(s, event);
  });
  const agent = fakeAgent(session);
  return { ctx, engine, session, agent, layer: engine.strataLayer };
}

/** Old finished task (foldable) + a new task with 3 protected rounds. */
function buildConversation(session) {
  addUser(session, "Task one: fix the build. The secret word is PLATYPUS-42.");
  const ids = [];
  for (let i = 0; i < 6; i += 1) ids.push(addToolRound(session, { command: `npm run build --step ${i}`, output: filler(`build-${i} ERROR_CODE_${i}`, 6000) }));
  addAssistantText(session, "Build fixed.");
  addUser(session, "Task two: write docs.");
  for (let i = 0; i < 3; i += 1) addToolRound(session, { command: `cat docs/${i}.md`, output: filler(`docs-${i}`, 800) });
  addAssistantText(session, "Docs done.");
  return ids;
}

function refOf(seq) {
  return `s${String(seq).padStart(5, "0")}`;
}

test("compress → pending → lands at turn end as a tagged fold, archived first", async () => {
  const { engine, session, agent, layer } = setup();
  const ids = buildConversation(session);
  const runs = layer.snapshot(agent).runs;
  assert.ok(runs.length >= 1, "there is a foldable run");
  const run = runs.sort((a, b) => b.tokens - a.tokens)[0];
  const before = session.surface.nodes.length;
  const reply = layer.propose(agent, `${run.startRef}–${run.endRef} build fix\nFixed the build over six steps. Errors ERROR_CODE_0..5 were resolved.`);
  assert.match(reply, /pending T1 fold f1/);
  assert.match(reply, /Estimate: reclaim/);
  assert.equal(session.surface.nodes.length, before, "nothing changes before turn end");

  await engine.finishTurn(agent);
  const foldSeq = session.surface.nodes.find((seq) => stratumOf(session.eventAt(seq)).stratum === "fold");
  assert.ok(foldSeq, "a fold node is on the surface");
  const event = session.eventAt(foldSeq);
  const text = event.data.content[0].text;
  assert.match(text, /^\[strata:fold:t1 id=f1 range=s\d{5}-s\d{5}\]/);
  assert.match(text, /not a new instruction/);
  assert.equal(text.includes(root), false, "no absolute path in the fold");
  const archive = join(process.env.STRATA_SHADOW_DIR, session.id, "fold-f1.json");
  assert.ok(existsSync(archive));
  const record = JSON.parse(readFileSync(archive, "utf8"));
  assert.equal(record.nodes.length, run.count);
  assert.ok(session.events.some((e) => e.type === "compaction/summary" && e.data.model === "strata-fold"));

  // decompress: one level up keeps the messages; full pulls tool originals.
  const up = layer.decompress(agent, { id: "f1" });
  assert.match(up, /Restored archive content/);
  assert.match(up, /one tier down/);
  const full = layer.decompress(agent, { id: "f1", full: true });
  assert.match(full, /ERROR_CODE_3/);
  const raw = layer.decompress(agent, { id: ids[2] });
  assert.match(raw, /ERROR_CODE_2/);
  const bySeq = layer.decompress(agent, { id: run.startRef });
  assert.match(bySeq, /Session event/);
  const toFile = layer.decompress(agent, { id: "f1", full: true, toFile: true });
  assert.match(toFile, /\.strata\/restore\/f1-full\.txt/);
  assert.ok(existsSync(join(root, "work", ".strata", "restore", "f1-full.txt")));

  // search finds the folded detail in the archive.
  const hits = layer.search(agent, { query: "ERROR_CODE_4" });
  assert.match(hits, /id=call-/);
  assert.match(layer.status(agent), /fold .* \(1\)/);
});

test("compress validation: format, protected tail, overlap, existing folds", async () => {
  const { engine, session, agent, layer } = setup();
  buildConversation(session);
  assert.match(layer.propose(agent, "no range here"), /rejected: the first line/);
  assert.match(layer.propose(agent, "s1-s2 topic"), /summary .* is empty/);
  const layout = layer.layout(session);
  const lastUser = layout.rows[layout.lastUser];
  assert.match(layer.propose(agent, `${layout.rows[1].ref}–${lastUser.ref} too far\nsummary`), /protected/);
  const tool = layout.rows.find((row) => row.role === "tool" && row.foldable);
  assert.match(layer.propose(agent, `${tool.ref}–${tool.ref} half a round\nsummary`), /splits a tool call|without its result/);
  const run = layer.snapshot(agent).runs[0];
  assert.match(layer.propose(agent, `${run.startRef}–${run.endRef} first\nsummary one`), /pending T1 fold/);
  assert.match(layer.propose(agent, `${run.startRef}–${run.endRef} again\nsummary two`), /overlaps pending fold/);
  await engine.finishTurn(agent);
  const fold = layer.layout(session).rows.find((row) => row.stratum === "fold");
  assert.ok(fold);
  assert.match(layer.propose(agent, `${fold.ref}–${fold.ref} refold\nsummary`), /pending T2 fold|not smaller/, "a fold inside the range makes it the next tier");
  const full = { type: "user/message", data: { role: "user", source: { kind: "compact-checkpoint" }, content: [{ type: "text", text: "stock summary" }] } };
  void full;
});

test("small batches wait (min benefit) and are dropped after max deferrals", async () => {
  process.env.STRATA_MIN_BENEFIT_TOKENS = "500000";
  const { engine, session, agent, layer } = setup();
  process.env.STRATA_MIN_BENEFIT_TOKENS = "1000";
  buildConversation(session);
  const run = layer.snapshot(agent).runs[0];
  assert.match(layer.propose(agent, `${run.startRef}–${run.endRef} build\nshort`), /below the .* minimum/);
  const nodes = [...session.surface.nodes];
  for (let turn = 1; turn <= layer.settings.maxDeferTurns; turn += 1) {
    const result = await layer.flush(agent);
    assert.deepEqual(result.deferred, ["f1"]);
  }
  const last = await layer.flush(agent);
  assert.deepEqual(last.dropped, ["f1"]);
  assert.deepEqual(session.surface.nodes, nodes);
  await engine.finishTurn(agent);
});

test("forced landing above forcePct ignores min benefit", async () => {
  process.env.STRATA_MIN_BENEFIT_TOKENS = "500000";
  const { session, agent, layer } = setup({ window: 12_000 });
  process.env.STRATA_MIN_BENEFIT_TOKENS = "1000";
  buildConversation(session);
  await layer.resolveWindow(agent);
  const run = layer.snapshot(agent).runs[0];
  layer.propose(agent, `${run.startRef}–${run.endRef} build\nshort summary`);
  const result = await layer.flush(agent);
  assert.deepEqual(result.landed, ["f1"]);
});

test("a pending fold whose nodes changed is dropped, not landed", async () => {
  const { session, agent, layer } = setup();
  buildConversation(session);
  const run = layer.snapshot(agent).runs[0];
  layer.propose(agent, `${run.startRef}–${run.endRef} build\nsummary`);
  // Simulate another replacement touching the range (e.g. an official summary).
  session.append("user/message", { role: "user", content: [{ type: "text", text: "x" }], source: { kind: "compact-checkpoint" } }, { surfaceOp: { op: "replace", startSeq: run.start, endSeq: run.end } });
  const result = await layer.flush(agent);
  assert.deepEqual(result.dropped, ["f1"]);
});

test("nudge fires on foldable growth, once per step of growth, and forced near the window", async () => {
  process.env.STRATA_NUDGE_GROWTH_TOKENS = "5000";
  const { session, agent, layer } = setup();
  delete process.env.STRATA_NUDGE_GROWTH_TOKENS;
  addUser(session, "start");
  assert.equal(layer.nudge(agent), null);
  buildConversation(session);
  const first = layer.nudge(agent);
  assert.match(first, /\[strata\] Automatic context note/);
  assert.match(first, /s\d{5}–s\d{5}/);
  assert.equal(layer.nudge(agent), null, "no repeat without more growth");
  const forced = setup({ window: 12_000 });
  buildConversation(forced.session);
  await forced.layer.resolveWindow(forced.agent);
  assert.match(forced.layer.nudge(forced.agent), /please fold something now/);
  assert.match(forced.layer.nudge(forced.agent), /please fold/, "forced nudges repeat");
});

test("tools row: compress/decompress/search_context/strata_status execute through exec.agent", async () => {
  const { engine, session, agent } = setup();
  buildConversation(session);
  const { createStrataTools } = await import("../tools-plugin.js");
  const tools = Object.fromEntries(createStrataTools(engine.strataLayer).map((tool) => [tool.name, tool]));
  assert.deepEqual(Object.keys(tools).sort(), ["compress", "decompress", "search_context", "strata_status"]);
  const status = await tools.strata_status.execute({ detail: true }, { agent });
  assert.match(status, /Foldable runs/);
  const run = engine.strataLayer.snapshot(agent).runs[0];
  assert.match(await tools.compress.execute({ content: `${run.startRef}–${run.endRef} t\nsummary` }, { agent }), /pending T1 fold/);
  assert.match(await tools.decompress.execute({ id: "" }, { agent }), /id is required/);
  assert.match(await tools.search_context.execute({ query: "PLATYPUS" }, {}), /no agent session/);
});
