// Superseded runtime-context snapshots (docs/interop-dsh-mem0.md §1): the
// newest stays live and untouched; older ones are never archived, carded or
// folded, and are dropped when the prefix already breaks or when it pays.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { addAssistantText, addToolRound, addUser, fakeAgent, fakeContext, FakeSession, filler } from "./helpers/fake-dsh.mjs";

const root = mkdtempSync(join(tmpdir(), "strata-ctx-"));
process.env.STRATA_SHADOW_DIR = join(root, "archive");
process.env.STRATA_MIN_BENEFIT_TOKENS = "500";
process.env.STRATA_MIN_BENEFIT_RATIO = "0.000001";
const { default: Engine } = await import("../index.js");
const { stratumOf } = await import("../lib/stratum.js");
const { readActivity, resetActivity } = await import("../lib/activity.js");
after(() => rmSync(root, { recursive: true, force: true }));

function setup(id = `s-${Math.random().toString(16).slice(2)}`) {
  const ctx = fakeContext();
  const engine = new Engine(ctx, {});
  const session = new FakeSession({ id, cwd: join(root, "work") });
  return { ctx, engine, session, agent: fakeAgent(session), layer: engine.strataLayer };
}

/** A DSH runtime-context snapshot carrying a mem0:recall section. */
function addSnapshot(session, marker, chars = 6000) {
  const recall = `<mem0-relevant-memories>${marker} ${filler(marker, chars)}</mem0-relevant-memories>`;
  return session.append("user/message", {
    role: "user",
    content: [{ type: "text", text: `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${recall}` }],
    source: { kind: "runtime-context", form: "snapshot", sections: [{ name: "working-directory:current", text: "cwd" }, { name: "mem0:recall", text: recall }] },
  });
}

/** Three finished turns, each opening with a new recall snapshot, then a live turn. */
function conversation(session) {
  for (let turn = 0; turn < 3; turn += 1) {
    addUser(session, `Question ${turn}`);
    addSnapshot(session, `RECALL_${turn}`);
    for (let i = 0; i < 2; i += 1) addToolRound(session, { command: `step ${turn}.${i}`, output: filler(`out-${turn}-${i}`, 4000) });
    addAssistantText(session, `Answer ${turn}`);
  }
  addUser(session, "Question 3");
  addSnapshot(session, "RECALL_LIVE");
  for (let i = 0; i < 3; i += 1) addToolRound(session, { command: `live ${i}`, output: filler(`live-${i}`, 500) });
}

const archived = (dir) => readdirSync(dir).map((name) => readFileSync(join(dir, name), "utf8")).join("\n");

test("layout: only the newest snapshot is live and protected; older ones are stale and not foldable weight", () => {
  const { session, layer } = setup();
  conversation(session);
  const layout = layer.layout(session);
  const contexts = layout.rows.filter((row) => row.stratum === "context");
  assert.equal(contexts.length, 4);
  assert.deepEqual(contexts.map((row) => row.live), [false, false, false, true]);
  assert.ok(contexts.at(-1).protected, "live snapshot is protected");
  assert.ok(contexts.slice(0, 3).every((row) => row.stale && row.foldable), "stale snapshots may sit inside a fold range");
});

test("fold over stale snapshots: archive keeps no recall text, children skip them, live snapshot untouched", async () => {
  const { engine, session, agent, layer } = setup();
  conversation(session);
  const run = layer.snapshot(agent).runs.sort((a, b) => b.tokens - a.tokens)[0];
  assert.match(layer.propose(agent, `${run.startRef}–${run.endRef} three answered questions\nAnswered questions 0-2.`), /pending T1 fold f1/);
  await engine.finishTurn(agent);
  const dir = join(process.env.STRATA_SHADOW_DIR, session.id);
  const text = archived(dir);
  assert.doesNotMatch(text, /RECALL_[012] /, "no superseded recall text in any archive file");
  const fold = JSON.parse(readFileSync(join(dir, "fold-f1.json"), "utf8"));
  assert.ok(fold.dropped.length >= 2, "stale snapshots recorded as dropped");
  assert.ok(fold.children.every((child) => !fold.dropped.includes(child.seq)));
  const live = session.surface.nodes.map((seq) => session.eventAt(seq)).filter((event) => stratumOf(event).stratum === "context");
  assert.equal(live.length, 1);
  assert.match(live[0].data.content[0].text, /RECALL_LIVE/);
});

test("sweep: stale snapshots drop when the prefix already broke (free) and when they pay; the live one never does", async () => {
  process.env.STRATA_STALE_SWEEP_TOKENS = "1000";
  process.env.STRATA_EXPECTED_REQUESTS = "200";
  try {
    resetActivity();
    const { session, agent, layer } = setup();
    // Settings are read per layer construction; rebuild so the env applies.
    const { default: Fresh } = await import("../index.js");
    const engine = new Fresh(fakeContext(), {});
    const fresh = engine.strataLayer;
    conversation(session);
    void layer;
    const before = fresh.layout(session).rows.filter((row) => row.stale).length;
    assert.equal(before, 3);
    const result = await fresh.sweepStale(agent);
    assert.equal(result.mode, "sweep");
    assert.equal(result.dropped.length, 3);
    const after = fresh.layout(session);
    assert.equal(after.rows.filter((row) => row.stale).length, 0);
    assert.equal(after.rows.filter((row) => row.stratum === "dropped").length, 3);
    assert.equal(after.rows.filter((row) => row.live).length, 1, "live snapshot stays");
    assert.equal(readActivity(session.id).events.at(-1).layer, "ctx", "the dock hears about it");
  } finally {
    delete process.env.STRATA_STALE_SWEEP_TOKENS;
    delete process.env.STRATA_EXPECTED_REQUESTS;
  }
});

test("sweep below threshold only drops what sits after an existing prefix break", async () => {
  const { session, agent, layer } = setup();
  conversation(session);
  const layout = layer.layout(session);
  const stale = layout.rows.filter((row) => row.stale);
  const result = await layer.sweepStale(agent, { fromIndex: stale[1].index });
  assert.equal(result.mode, "free");
  assert.deepEqual(result.dropped.sort(), [stale[1].seq, stale[2].seq].sort());
  const none = await setup().layer.sweepStale(fakeAgent(new FakeSession()));
  assert.equal(none.mode, "none");
});

test("fold landing emits strata/fold-landed for optional consumers", async () => {
  const { engine, session, agent, layer, ctx } = setup();
  const seen = [];
  ctx.emit = (name, payload) => seen.push([name, payload]);
  conversation(session);
  const run = layer.snapshot(agent).runs.sort((a, b) => b.tokens - a.tokens)[0];
  layer.propose(agent, `${run.startRef}–${run.endRef} answered questions\nAnswered questions 0-2 about the build.`);
  await engine.finishTurn(agent);
  const landed = seen.find(([name]) => name === "strata/fold-landed");
  assert.ok(landed, "event emitted");
  assert.equal(landed[1].foldId, "f1");
  assert.equal(landed[1].sessionId, session.id);
  assert.match(landed[1].summary, /Answered questions 0-2/);
});

test("archived spans (official summary, card shadow) never carry runtime-context snapshot text", () => {
  const { engine, session } = setup();
  const recall = "<mem0-relevant-memories>secret recall</mem0-relevant-memories>";
  const messages = [
    { role: "user", content: [{ type: "text", text: "Please read the notes." }], source: { kind: "user" } },
    { role: "user", content: [{ type: "text", text: `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${recall}` }], source: { kind: "runtime-context", form: "snapshot", sections: [{ name: "mem0:recall", text: recall }] } },
    { role: "assistant", content: [{ type: "text", text: "Done reading." }] },
  ];
  const file = join(process.env.STRATA_SHADOW_DIR, session.id, "official-1-deadbeef.txt");
  engine.saveShadow(messages, true, file, session.id);
  const text = readFileSync(file, "utf8");
  assert.ok(!text.includes("mem0-relevant-memories"), "recall text leaked into the archive");
  assert.ok(!text.includes("secret recall"));
  assert.match(text, /\[strata:dropped kind=runtime-context\]/);
  assert.match(text, /Please read the notes\./);
  assert.match(text, /Done reading\./);
});

test("archived spans omit system prompts (regenerated per request) with a one-line marker", () => {
  const { engine, session } = setup();
  const messages = [
    { role: "system", content: [{ type: "text", text: "You are a coding agent.\n<mem0-user-profile>\nLikes oolong tea\n</mem0-user-profile>" }] },
    { role: "user", content: [{ type: "text", text: "Please read the notes." }], source: { kind: "user" } },
    { role: "system", content: "In-history prompt update with <mem0-user-profile>x</mem0-user-profile>" },
  ];
  const file = join(process.env.STRATA_SHADOW_DIR, session.id, "official-2-deadbeef.txt");
  engine.saveShadow(messages, true, file, session.id);
  const text = readFileSync(file, "utf8");
  assert.ok(!text.includes("mem0-user-profile"));
  assert.ok(!text.includes("coding agent"));
  assert.equal(text.match(/\[system prompt omitted\]/g)?.length, 2);
  assert.match(text, /\[user\]\nPlease read the notes\./);
});

test("strata_status warns when DSH's automatic compaction is off because maxTokens leaves no budget", async () => {
  const ctx = fakeContext({ contextWindow: 60000 });
  const engine = new Engine(ctx, { headroomTokens: 4096 });
  const session = new FakeSession({ id: `s-cfg-${Math.random().toString(16).slice(2)}`, cwd: join(root, "work") });
  session.route = { provider: "deepseek-official", model: "workbuddy/deepseek-v4.1-flash", maxTokens: 256000 };
  addUser(session, "hello");
  const agent = fakeAgent(session);
  await assert.rejects(engine.compactIfNeeded(agent, "pressure", new AbortController().signal));
  const status = engine.strataLayer.status(agent);
  assert.match(status, /^Warning: DSH's automatic compaction is off for deepseek-official\/workbuddy\/deepseek-v4\.1-flash: .*no message budget/m);
  session.route = { ...session.route, maxTokens: 8192 };
  await engine.compactIfNeeded(agent, "pressure", new AbortController().signal);
  assert.doesNotMatch(engine.strataLayer.status(agent), /^Warning: DSH's automatic compaction/m, "cleared once a pressure check succeeds");
});
