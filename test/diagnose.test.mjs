// Making failures explain themselves (Windows report, 2026-11-07): the last
// L1/L2 failure in /strata detail, a neutral dock state for failed polls,
// fold-boundary refs that read backwards, payback in the ledger, and proof that
// the cost preset never lands a model fold mid-turn.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { after, test } from "node:test";
import { addAssistantText, addToolRound, addUser, fakeAgent, fakeContext, FakeSession, filler } from "./helpers/fake-dsh.mjs";

const root = mkdtempSync(join(tmpdir(), "strata-diag-"));
process.env.STRATA_SHADOW_DIR = join(root, "archive");
process.env.STRATA_MIN_BENEFIT_TOKENS = "500";
process.env.STRATA_MIN_BENEFIT_RATIO = "0.000001";
process.env.STRATA_EXPECTED_REQUESTS = "200";
const { default: Engine } = await import("../index.js");
const { readSettings } = await import("../lib/settings.js");
const { runCommand, translator } = await import("../lib/command.js");
const { isCancellation, lastActivityError, readActivity, recordActivity, recordActivityError, resetActivity, scrubErrorMessage } = await import("../lib/activity.js");
const { readLedger, recordLedger, resetLedger } = await import("../lib/ledger.js");
const { estimateFold } = await import("../lib/economics.js");
const { validateRange } = await import("../lib/fold.js");
const { bySurface } = await import("../lib/l2.js");
const { GUI_STATUS_PATH, registerGuiRoutes } = await import("../lib/gui-routes.js");
after(() => rmSync(root, { recursive: true, force: true }));

function setup(env = {}) {
  const ctx = fakeContext({ contextWindow: 1_000_000 });
  const engine = new Engine(ctx, {});
  const session = new FakeSession({ id: `s-${Math.random().toString(16).slice(2)}`, cwd: join(root, "work") });
  session.listeners.push((s, event) => {
    for (const fn of ctx.handlers.get("session/event") || []) fn(s, event);
  });
  const layer = engine.strataLayer;
  Object.assign(layer.settings, readSettings({ ...process.env, ...env }));
  return { ctx, engine, session, agent: fakeAgent(session), layer };
}

function turn(session, label, rounds, chars) {
  addUser(session, `${label}: next batch`);
  for (let i = 0; i < rounds; i += 1) addToolRound(session, { command: `pwsh -c step ${label}.${i}`, output: filler(`${label}-${i}`, chars) });
  addAssistantText(session, `${label} done`);
}

// ------------------------------------------------------------ last failure

test("error text: quoted parts and paths are scrubbed, whitespace collapsed, cut to 160", () => {
  assert.equal(scrubErrorMessage("ENOSPC: no space left on device, open 'C:\\Users\\me\\.dsh\\strata\\x\\f2.json'"), "ENOSPC: no space left on device, open …");
  assert.equal(scrubErrorMessage('Unexpected token in "user said: my password is hunter2"'), "Unexpected token in …");
  assert.equal(scrubErrorMessage("failed at /Users/me/secret/project/file.txt now"), "failed at … now");
  assert.equal(scrubErrorMessage("bad <tool-output>whatever the tool printed</tool-output> here"), "bad … here");
  assert.ok(!scrubErrorMessage("x <a>secret</a>").includes("<a>"));
  assert.equal(scrubErrorMessage("fold is not smaller than its range (900 >= 800)"), "fold is not smaller than its range (900 >= 800)");
  assert.ok(scrubErrorMessage("x".repeat(400)).length <= 160);
  assert.equal(scrubErrorMessage("a\n\n  b"), "a b");
});

test("activity: the last failure stays for /strata detail after a success clears the dock; a stale sweep does not clear it", () => {
  resetActivity();
  recordActivityError("s-e", "L2", "fold is not smaller than its range (900 >= 800)", { id: "f2" });
  assert.equal(readActivity("s-e").error.id, "f2");
  recordActivity("s-e", { layer: "ctx", id: "runtime-context", reclaimed: 100 });
  assert.equal(readActivity("s-e").error?.layer, "L2", "a stale-context sweep says nothing about folds");
  recordActivity("s-e", { layer: "L1", id: "c1", reclaimed: 100 });
  assert.equal(readActivity("s-e").error, null, "the dock clears on the next landing");
  assert.equal(lastActivityError("s-e").id, "f2", "detail still has it");
});

test("cancellation is not a failure; a timeout is", () => {
  const user = new AbortController();
  user.abort();
  assert.equal(isCancellation(new Error("aborted"), user.signal), true);
  const timeout = AbortSignal.abort(new DOMException("timed out", "TimeoutError"));
  assert.equal(isCancellation(new Error("timed out"), timeout), false);
  assert.equal(isCancellation(new Error("boom"), new AbortController().signal), false);
});

test("an L2 landing failure shows in /strata detail (zh / en) with layer, id, time and scrubbed message; a stopped turn records nothing", async () => {
  const { session, agent, layer } = setup();
  for (let t = 0; t < 3; t += 1) turn(session, `old${t}`, 6, 4_000);
  addUser(session, "now");
  addToolRound(session, { command: "ls", output: "ok" });
  const run = layer.snapshot(agent).runs.sort((a, b) => a.start - b.start)[0];
  const end = run.rows.filter((row) => row.closeOk)[3];
  assert.match(layer.propose(agent, `${run.startRef}–${end.ref} early\nearly work.`), /pending T1 fold/);
  const id = layer.state(agent).pending[0].id;
  layer.commitFold = async () => {
    throw new Error("write failed for 'C:\\Users\\me\\.dsh\\strata\\f.json' (EPERM)");
  };
  // A stopped turn first: nothing recorded.
  const stopped = new AbortController();
  stopped.abort();
  await layer.flush(agent, stopped.signal, { force: true }).catch(() => {});
  assert.equal(lastActivityError(session.id), null);
  assert.match(layer.propose(agent, `${run.startRef}–${end.ref} early\nearly work.`), /pending T1 fold/);
  const again = layer.state(agent).pending[0].id;
  await layer.flush(agent, new AbortController().signal, { force: true });
  const error = lastActivityError(session.id);
  assert.equal(error.layer, "L2");
  assert.equal(error.id, again);
  assert.ok(!error.message.includes("Users"), error.message);
  const zh = runCommand(layer, agent, "detail", { language: "zh" }).text;
  const line = zh.split("\n").find((l) => l.includes("上次失败"));
  assert.match(line, new RegExp(`上次失败\\s+\\d\\d:\\d\\d:\\d\\d  L2 折叠 ${again}：write failed for … \\(EPERM\\)  【输入框旁的图标因此显示红色`));
  const en = runCommand(layer, agent, "detail", { language: "en" }).text;
  assert.match(en, new RegExp(`Last failure\\s+\\d\\d:\\d\\d:\\d\\d  L2 fold ${again}: write failed for … \\(EPERM\\)`));
  assert.ok(id);
  // Fresh session: "none".
  const other = setup();
  assert.match(runCommand(other.layer, other.agent, "detail", { language: "zh" }).text, /上次失败\s+本进程内没有/);
});

// ------------------------------------------------------------ dock

function loadClient() {
  let module;
  const window = { __ModuleLoader__: { load(def) { module = def.factory((name) => (name === "react" ? { createElement() {}, useEffect() {}, useLayoutEffect() {}, useRef() {}, useState() {} } : {})); } } };
  runInNewContext(readFileSync(new URL("../client.js", import.meta.url), "utf8"), { window });
  return module.__test;
}

test("dock: failed polls show a neutral 'status unavailable', never red; a stored failure is red and names the layer", () => {
  const { dockState, zh, en } = loadClient();
  const tz = (key) => zh[key];
  const now = 1_000_000;
  const data = { takeover: "active", usage: { totalTokens: 384_100, window: 1_000_000 }, error: null, now };
  assert.deepEqual(dockState(tz, { data, misses: 0, play: {}, now }).state, "idle");
  assert.equal(dockState(tz, { data, misses: 1, play: {}, now }).state, "idle", "one missed poll is noise");
  const unavailable = dockState(tz, { data, misses: 2, play: {}, now });
  assert.deepEqual([unavailable.state, unavailable.label], ["unavailable", "状态暂不可用"]);
  assert.match(unavailable.title, /不是压缩失败/);
  assert.equal(dockState(tz, { data: null, misses: 5, play: {}, now }).state, "unavailable", "never red without a stored failure");
  const fold = dockState(tz, { data: { ...data, error: { layer: "L2", at: now - 1000 } }, misses: 0, play: {}, now });
  assert.deepEqual([fold.state, fold.label], ["error", "折叠失败"]);
  assert.equal(dockState(tz, { data: { ...data, error: { layer: "L1", at: now - 1000 } }, misses: 0, play: {}, now }).label, "切卡片失败");
  assert.equal(dockState(tz, { data: { ...data, error: { layer: "L2", at: now - 11 * 60_000 } }, misses: 0, play: {}, now }).state, "idle", "red fades after 10 minutes (server clock)");
  assert.equal(dockState((key) => en[key], { data, misses: 3, play: {}, now }).label, "Status unavailable");
  assert.ok(Object.keys(en).every((key) => key in zh) && Object.keys(zh).every((key) => key in en), "zh / en parity");
});

test("status route: a throwing request answers 500 JSON instead of hanging the poll", () => {
  const routes = [];
  const child = { webServer: { register(route) { routes.push(route); return () => {}; } }, get() { return { requestRejection: () => undefined }; }, effect(fn) { fn(); } };
  registerGuiRoutes({ inject(_n, fn) { fn(child); } }, "1");
  const res = { headers: {}, statusCode: 0, body: "", setHeader(k, v) { this.headers[k] = v; }, end(b = "") { this.body = b; this.writableEnded = true; } };
  routes[0].handler({ url: "http://[", method: "GET" }, res);
  assert.equal(res.statusCode, 500);
  assert.equal(JSON.parse(res.body).error, "status unavailable");
  assert.equal(routes[0].path, GUI_STATUS_PATH);
});

// ------------------------------------------------------------ fold-boundary refs

test("a run that starts at a fold: detail names the fold, and the printed refs are accepted by compress", async () => {
  // The Windows shape: f1 folded most of the turns before the latest user
  // message, one message stayed after it, then the protected user message.
  const { session, agent, layer } = setup();
  for (let t = 0; t < 2; t += 1) turn(session, `old${t}`, 4, 4_000);
  addUser(session, "one long turn");
  for (let i = 0; i < 6; i += 1) addToolRound(session, { command: `step ${i}`, output: filler(`l${i}`, 4_000) });
  const first = layer.snapshot(agent).runs.sort((a, b) => a.start - b.start)[0];
  const cut = first.rows.filter((row) => row.closeOk).at(-2);
  assert.match(layer.propose(agent, `${first.startRef}–${cut.ref} early\nearly work.`), /pending T1 fold/);
  const flushed = await layer.flush(agent, undefined, { force: true });
  assert.equal(flushed.landed.length, 1);
  for (let i = 6; i < 10; i += 1) addToolRound(session, { command: `step ${i}`, output: filler(`l${i}`, 4_000) });
  const runs = layer.snapshot(agent).runs;
  const run = runs.find((r) => r.rows[0].stratum === "fold");
  assert.ok(run, "a run starts at the fold");
  assert.equal([...runs].sort(bySurface)[0], run, "oldest-first walks (auto fold, landing order) see it first");
  assert.notEqual([...runs].sort((a, b) => a.start - b.start)[0], run, "seq order would put it last");
  assert.ok(run.rows[0].seq > run.rows.at(-1).seq, `the fold's own seq is later: ${run.startRef}–${run.endRef}`);
  const foldId = run.rows[0].id;
  const zh = runCommand(layer, agent, "detail", { language: "zh" }).text;
  assert.ok(zh.includes(`${foldId}(${run.startRef})–${run.endRef}`), zh.split("\n").filter((l) => l.includes(run.endRef)).join("\n"));
  assert.ok(zh.includes(`compress 照原样使用这些编号即可（${run.startRef}–${run.endRef}）`));
  // Detail lists it first (surface order), not after newer runs (seq order).
  const listed = zh.split("\n").filter((l) => /^  (f\d+\(s\d+\)|s\d+)–/.test(l));
  assert.ok(listed[0].includes(`${foldId}(${run.startRef})`), listed.join("\n"));
  // strata_status gives the model the plain refs with a note; compress takes them as printed.
  assert.ok(layer.status(agent).includes(`${run.startRef}–${run.endRef} (starts at fold ${foldId}; refs as printed)`), layer.status(agent));
  const checked = validateRange(layer.layout(session), { start: run.start, end: run.end }, []);
  assert.equal(checked.ok, true, checked.reason);
  assert.equal(checked.tier, 2, "a range over f1 becomes T2");
  // Through compress: the refs pass; only the (tiny) range size can refuse it.
  assert.doesNotMatch(layer.propose(agent, `${run.startRef}–${run.endRef} upgrade\nx`), /before its start|not on the current surface|protected|splits|without its result/);
});

// ------------------------------------------------------------ ledger payback

test("ledger: the Windows numbers — a fold that passed the cost check reads as payback progress, not a loss", () => {
  resetLedger();
  // f1: re-billed ~216.5K, reclaimed ~19.9K, landed after request 150; the cost check guessed 150 more requests.
  const remaining = 150;
  const check = estimateFold({ tokensFromStart: 216_500, reclaimed: 19_900, remainingRequests: remaining, priceMiss: 1, priceHit: 0.1 });
  assert.equal(check.worthIt, true, "the cost check passes at ~150 remaining requests");
  assert.equal(check.paybackRequests, 89);
  recordLedger("s-win", { layer: "L2", id: "f1", tokensFromStart: 216_500, reclaimed: 19_900, remainingRequests: remaining, landing: "cost" }, 150);
  const prices = { priceMiss: 1, priceHit: 0.1 };
  const right = readLedger("s-win", 150, prices);
  assert.equal(Math.round(right.net), -176_940, "right after landing the whole re-billing shows");
  assert.equal(right.last.payback, 89);
  assert.equal(right.last.since, 0);
  const later = readLedger("s-win", 153, prices);
  assert.equal(later.last.since, 3);
  assert.equal(later.toBreakEven, 86);
  assert.ok(later.projectedNet > 100_000, `projected ${later.projectedNet}`);
  assert.equal(readLedger("s-win", 240, prices).toBreakEven, 0);
});

test("detail shows payback, break-even and the projected net (zh)", () => {
  const { session, agent, layer } = setup();
  turn(session, "a", 2, 1000);
  layer.recordChange(agent, { layer: "L2", id: "f1", start: 3, tokensFromStart: 216_500, reclaimed: 19_900, landing: "cost" });
  const zh = runCommand(layer, agent, "detail", { language: "zh" }).text;
  assert.match(zh, /回本进度\s+最近一次 f1：预计 ~89 次请求回本，已过 0 次（通过了成本检查：落地时预计还有 ~200 次请求）/);
  assert.match(zh, /净节省转正\s+还需 ~89 次请求（每次约省 2\.0K）/);
  assert.match(zh, /预计最终净节省\s+约 \+221\.1K tokens/);
  assert.match(zh, /估算净节省\s+约 −176\.9K tokens.*；刚落地时为负是正常的/);
  const en = runCommand(layer, agent, "detail", { language: "en" }).text;
  assert.match(en, /Payback\s+last change f1: ~89 requests to pay back, 0 so far \(passed the cost check: expected ~200 more requests\)/);
});

// ------------------------------------------------------------ cost: no model fold mid-turn

test("cost preset: a pending model fold never lands mid-turn, even far above the force line; it lands at the turn end (agent idle after a completed turn)", async () => {
  const { ctx, engine, session, agent, layer } = setup({ STRATA_PRESET: "cost" });
  assert.equal(layer.settings.midTurnFold, false);
  for (let t = 0; t < 3; t += 1) turn(session, `old${t}`, 6, 8_000);
  session.append("turn/end", { reason: { kind: "completed" } });
  session.append("turn/start", { turn: "long" });
  addUser(session, "one long turn");
  for (let i = 0; i < 6; i += 1) addToolRound(session, { command: `step ${i}`, output: filler(`l${i}`, 8_000) });
  const run = layer.snapshot(agent).runs.sort((a, b) => a.start - b.start)[0];
  const end = run.rows.filter((row) => row.closeOk)[4];
  assert.match(layer.propose(agent, `${run.startRef}–${end.ref} early\nearly work.`), /pending T1 fold/);
  const id = layer.state(agent).pending[0].id;
  // 80% of the window: above cost's 60% force line.
  layer.state(agent).window = Math.round(layer.layout(session).totalTokens / 0.8);
  const stock = Object.getPrototypeOf(Engine.prototype);
  const original = stock.compactIfNeeded;
  stock.compactIfNeeded = async () => null;
  try {
    for (let step = 0; step < 3; step += 1) {
      await engine.compactIfNeeded(agent, "pressure", new AbortController().signal);
      await engine.compactIfNeeded(agent, "step", new AbortController().signal);
    }
  } finally {
    stock.compactIfNeeded = original;
  }
  assert.deepEqual(layer.state(agent).pending.map((fold) => fold.id), [id], "still pending mid-turn");
  assert.equal(layer.layout(session).rows.filter((row) => row.stratum === "fold").length, 0, "nothing folded mid-turn");
  // "running" never runs maintenance.
  for (const fn of ctx.handlers.get("agent/status") || []) fn({ agent, status: "running" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(layer.state(agent).pending.map((fold) => fold.id), [id]);
  // The turn ends: DSH appends turn/end, the agent goes idle, maintenance lands it.
  session.append("turn/end", { reason: { kind: "completed" } });
  for (const fn of ctx.handlers.get("agent/status") || []) fn({ agent, status: "idle" });
  for (let i = 0; i < 50 && layer.state(agent).pending.length; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(layer.layout(session).rows.some((row) => row.stratum === "fold" && row.id === id), "landed at the turn end");
});

test("a real DSH agent refuses maintenance while a turn is driving, so a turn-end flush cannot run mid-turn", async () => {
  const types = readFileSync(new URL("../node_modules/@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts", import.meta.url), "utf8");
  assert.match(types, /Run one non-turn maintenance task from the true idle phase/);
  assert.match(types, /@throws synchronously when turn-driving or another maintenance task already owns the agent/);
  // The engine's only L2 flush paths: finishTurn (agent idle, via runMaintenance) and midTurnFold (off in cost).
  const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.equal((source.match(/layer\.turnEnd\(/g) || []).length, 1);
  assert.match(source, /agent\.runMaintenance\(async \(agentSignal\) => \{\n\s+const op = AbortSignal\.any/);
  assert.equal(translator("zh")("detail.lastError"), "上次失败");
});
