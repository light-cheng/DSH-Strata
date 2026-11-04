import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { foldSurface } from "@deepseek-ai/dsh-session";
import { addAssistantText, addToolRound, addUser, fakeAgent, fakeContext, FakeSession, filler } from "./helpers/fake-dsh.mjs";

const root = mkdtempSync(join(tmpdir(), "strata-tiers-"));
process.env.STRATA_SHADOW_DIR = join(root, "archive");
process.env.STRATA_MIN_BENEFIT_TOKENS = "200";
process.env.STRATA_MIN_BENEFIT_RATIO = "0.000001";
process.env.STRATA_EXPECTED_REQUESTS = "200";
const { default: Engine } = await import("../index.js");
after(() => rmSync(root, { recursive: true, force: true }));

function setup(id) {
  const ctx = fakeContext();
  const engine = new Engine(ctx, {});
  const session = new FakeSession({ id, cwd: join(root, "work") });
  session.listeners.push((s, event) => {
    for (const fn of ctx.handlers.get("session/event") || []) fn(s, event);
  });
  return { engine, session, agent: fakeAgent(session), layer: engine.strataLayer };
}

/** One finished task with a unique fact in its tool output. */
function task(session, name, fact) {
  addUser(session, `Task ${name}.`);
  addToolRound(session, { command: `inspect ${name}`, output: `${filler(`${name}-log`, 4000)}\nFACT ${fact}\n${filler(`${name}-tail`, 2000)}` });
  addToolRound(session, { command: `verify ${name}`, output: filler(`${name}-verify`, 3000) });
  addAssistantText(session, `${name} done.`);
}

function tail(session) {
  addUser(session, "Current task.");
  for (let i = 0; i < 3; i += 1) addToolRound(session, { command: `step ${i}`, output: "ok" });
  addAssistantText(session, "Working.");
}

const rowsOf = (layer, session) => layer.layout(session).rows;
const tierOf = (layer, session, id) => rowsOf(layer, session).find((row) => row.id === id)?.tier;

async function foldRange(engine, layer, agent, rows, topic, summaryChars = 0) {
  const summary = summaryChars ? filler(`Summary of ${topic}`, summaryChars) : `Summary of ${topic}.`;
  const reply = layer.propose(agent, `${rows[0].ref}–${rows.at(-1).ref} ${topic}\n${summary}`);
  assert.match(reply, /pending T\d fold f\d+/, reply.slice(0, 300));
  const id = /fold (f\d+)/.exec(reply)[1];
  const result = await layer.flush(agent);
  assert.deepEqual(result.landed, [id], `landed: ${JSON.stringify(result)}`);
  void engine;
  return id;
}

/** Build T1 ×4 → T2 ×2 → T3 ×1 and return the ids. */
async function buildTiers() {
  const ctx = setup(`session-tiers-${Math.random().toString(16).slice(2)}`);
  const { engine, session, agent, layer } = ctx;
  const facts = ["ALPHA-1111", "BRAVO-2222", "CHARLIE-3333", "DELTA-4444"];
  facts.forEach((fact, index) => task(session, `t${index}`, fact));
  tail(session);
  // T1: each task (user message … final assistant text).
  const t1 = [];
  for (let index = 0; index < 4; index += 1) {
    const rows = rowsOf(layer, session);
    const users = rows.filter((row) => row.role === "user" && row.stratum === "raw" && /^Task t\d/.test(row.preview));
    const first = users[0];
    const next = rows.find((row) => row.index > first.index && (row.role === "user"));
    const span = rows.slice(first.index, next.index);
    t1.push(await foldRange(engine, layer, agent, span, `task ${index}`, 2400));
  }
  for (const id of t1) assert.equal(tierOf(layer, session, id), 1);
  // T2: pairs of adjacent T1 folds.
  const t2 = [];
  for (const pair of [[t1[0], t1[1]], [t1[2], t1[3]]]) {
    const rows = rowsOf(layer, session);
    const from = rows.find((row) => row.id === pair[0]);
    const to = rows.find((row) => row.id === pair[1]);
    t2.push(await foldRange(engine, layer, agent, rows.slice(from.index, to.index + 1), `pair ${pair.join("+")}`, 1200));
  }
  for (const id of t2) assert.equal(tierOf(layer, session, id), 2);
  // T3 over both T2 folds.
  const rows = rowsOf(layer, session);
  const from = rows.find((row) => row.id === t2[0]);
  const to = rows.find((row) => row.id === t2[1]);
  const t3 = await foldRange(engine, layer, agent, rows.slice(from.index, to.index + 1), "all earlier tasks");
  assert.equal(tierOf(layer, session, t3), 3);
  return { ...ctx, t1, t2, t3, facts };
}

test("multi-level folds: T1 → T2 → T3, tags, archive children, no T4", async () => {
  const { session, layer, agent, t1, t2, t3 } = await buildTiers();
  const row = rowsOf(layer, session).find((item) => item.id === t3);
  const text = session.eventAt(row.seq).data.content[0].text;
  assert.match(text, new RegExp(`^\\[strata:fold:t3 id=${t3} `));
  assert.match(text, new RegExp(`Contains: ${t2[0]} \\(T2\\), ${t2[1]} \\(T2\\)`));
  assert.match(text, /\[call-\d+\]/, "tool call ids from lower tiers stay listed");
  const record = JSON.parse(readFileSync(join(process.env.STRATA_SHADOW_DIR, session.id, `fold-${t3}.json`), "utf8"));
  assert.equal(record.tier, 3);
  assert.deepEqual(record.children.filter((child) => child.kind === "fold").map((child) => child.id), t2);
  for (const child of record.children) assert.ok(child.pointer.file || child.pointer.sessionSeq !== undefined);
  assert.match(record.children[0].pointer.sha256, /^[0-9a-f]{16}$/);
  const t1Record = JSON.parse(readFileSync(join(process.env.STRATA_SHADOW_DIR, session.id, `fold-${t1[0]}.json`), "utf8"));
  assert.ok(t1Record.children.some((child) => child.kind === "raw" && child.id.startsWith("call-") && child.pointer.file.startsWith("raw-")));
  // T3 is the top: refolding it is refused.
  assert.match(layer.propose(agent, `${row.ref}–${row.ref} more\nx`), /T3 is the highest tier/);
  const status = layer.status(agent);
  assert.match(status, /Folds by tier: T1 0 \(0\) · T2 0 \(0\) · T3 \S+ \(1\)/);
});

test("decompress walks one tier at a time; full:true goes straight to the originals", async () => {
  const { layer, agent, t1, t2, t3, facts } = await buildTiers();
  const top = layer.decompress(agent, { id: t3 });
  assert.match(top, new RegExp(`T3.*one tier down.*Next tier: ${t2[0]}, ${t2[1]}`));
  assert.match(top, new RegExp(`\\[fold ${t2[0]} T2\\] → decompress`));
  assert.equal(facts.some((fact) => top.includes(fact)), false, "one tier down does not dump originals");
  const mid = layer.decompress(agent, { id: t2[0] });
  assert.match(mid, new RegExp(`Next tier: ${t1[0]}, ${t1[1]}`));
  const low = layer.decompress(agent, { id: t1[1] });
  assert.match(low, /BRAVO-2222/, "T1 opens to the messages and tool output");
  const full = layer.decompress(agent, { id: t3, full: true, toFile: true });
  assert.match(full, /\.strata\/restore\//);
  const fullText = readFileSync(join(root, "work", ".strata", "restore", `${t3}-full.txt`), "utf8");
  for (const fact of facts) assert.ok(fullText.includes(fact), `full restore contains ${fact}`);
});

test("search_context reports the tier of a hit and its expansion path", async () => {
  const { layer, agent, t1, t2, t3 } = await buildTiers();
  const hits = layer.search(agent, { query: "CHARLIE-3333" });
  assert.match(hits, /\[raw tool output\] id=call-/);
  assert.match(hits, new RegExp(`path: ${t3}\\(T3\\) → ${t2[1]}\\(T2\\) → ${t1[2]}\\(T1\\) → raw call-\\d+ \\[on the surface\\]`));
  const foldHit = layer.search(agent, { query: "pair" });
  assert.match(foldHit, /\[T2 fold\] id=f\d+/);
  assert.match(foldHit, new RegExp(`path: ${t3}\\(T3\\) → f\\d+\\(T2\\)`));
});

test("upgrade folds need ×1.5 the minimum batch; status lists upgradable groups", async () => {
  process.env.STRATA_MIN_BENEFIT_TOKENS = "1000";
  const { engine, session, agent, layer } = setup("session-upgrade");
  process.env.STRATA_MIN_BENEFIT_TOKENS = "200";
  task(session, "a", "A-1");
  task(session, "b", "B-2");
  tail(session);
  for (let index = 0; index < 2; index += 1) {
    const rows = rowsOf(layer, session);
    const first = rows.find((row) => row.role === "user" && row.stratum === "raw" && /^Task/.test(row.preview));
    const next = rows.find((row) => row.index > first.index && row.role === "user");
    await foldRange(engine, layer, agent, rows.slice(first.index, next.index), `task ${index}`);
  }
  assert.match(layer.status(agent), /Upgradable fold groups[\s\S]*f1\(T1\) \+ f2\(T1\).*→ T2/);
  const rows = rowsOf(layer, session).filter((row) => row.stratum === "fold");
  const reclaim = rows[0].tokens + rows[1].tokens;
  assert.ok(reclaim < 1500, `test needs a small upgrade (reclaim bound ${reclaim})`);
  const reply = layer.propose(agent, `${rows[0].ref}–${rows[1].ref} both\nx`);
  assert.match(reply, /pending T2 fold/);
  assert.match(reply, /upgrade to T2 .* ×1\.5/);
  const result = await layer.flush(agent);
  assert.deepEqual(result.deferred, ["f3"], "below 1.5 × 1000 it waits");
});

test("DSH dsh-session accepts replace over ranges that contain checkpoints", () => {
  // Real @deepseek-ai/dsh-session surface fold, not the fake: T1 replaces, then T2 over two T1 checkpoints.
  const events = [];
  const add = (type, data, extra = {}) => events.push({ seq: events.length, type, data, ...extra }) - 1;
  const msg = (text) => ({ role: "user", content: [{ type: "text", text }] });
  add("system/message", { role: "system", content: [{ type: "text", text: "sys" }] }, { surfaceOp: "append" });
  for (let i = 0; i < 4; i += 1) add("user/message", msg(`u${i}`), { surfaceOp: "append" });
  const a = add("user/message", msg("[strata:fold:t1 id=f1]"), { surfaceOp: { op: "replace", startSeq: 1, endSeq: 2 }, sourceEventSeqs: [1, 2] });
  const b = add("user/message", msg("[strata:fold:t1 id=f2]"), { surfaceOp: { op: "replace", startSeq: 3, endSeq: 4 }, sourceEventSeqs: [3, 4] });
  const c = add("user/message", msg("[strata:fold:t2 id=f3]"), { surfaceOp: { op: "replace", startSeq: a, endSeq: b }, sourceEventSeqs: [a, b] });
  assert.deepEqual(foldSurface(events).nodes, [0, c]);
  add("user/message", msg("bad"), { surfaceOp: { op: "replace", startSeq: c, endSeq: c }, sourceEventSeqs: [1] });
  assert.throws(() => foldSurface(events), /must include every shadowed surface node/);
});
