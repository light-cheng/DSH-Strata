// Diagnosis status block (lib/diagnosis.js, format 1 via the copied
// lib/diagnose-report.js): the nine x. facts, the standard last_at field, the
// value rules, the header, the dshDiagnosisStrata service (sessionId optional,
// null on any error) and the /strata detail section. No path and no
// conversation text may reach the block. Temp DSH_HOME and archive.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { addToolRound, addUser, fakeAgent, fakeContext, FakeSession, filler } from "./helpers/fake-dsh.mjs";

const root = mkdtempSync(join(tmpdir(), "strata-diagnosis-"));
process.env.DSH_HOME = join(root, "home");
process.env.STRATA_SHADOW_DIR = join(root, "archive");
delete process.env.DSH_PROFILE_DIR;
delete process.env.STRATA_PRESET;

const { conflictWord, createDiagnosisService, DIAGNOSIS_SERVICE, noteConfigConflicts, renderStatusBlock, standardFacts, statusFacts } = await import("../lib/diagnosis.js");
const { DIAGNOSIS_EXTRA_MAX, diagnosisExtra } = await import("../lib/diagnose-report.js");
const { latestActivitySession, recordActivityError, recordActivityRejection, recordUsage, resetActivity } = await import("../lib/activity.js");
const { recordLedger, resetLedger } = await import("../lib/ledger.js");
const { checkSettingsReset, resetResetMemory } = await import("../lib/reset.js");
const { PAGE_DEFAULTS, readSettings, setPageConfig } = await import("../lib/settings.js");
const { runCommand } = await import("../lib/command.js");
const { default: Gate } = await import("../gate.js");
const { default: Engine } = await import("../index.js");
const pkg = JSON.parse((await import("node:fs")).readFileSync(new URL("../package.json", import.meta.url), "utf8"));

after(() => rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
  resetActivity();
  resetLedger();
  resetResetMemory();
  noteConfigConflicts([]);
  setPageConfig(null);
});

const NINE = ["x.mode", "x.mode_source", "x.auto_fold_pct", "x.context_pct", "x.fold_count", "x.last_issue", "x.last_issue_at", "x.conflict", "x.settings_reset"];
const SECRET_PATH = "/Users/someone/secret/project/build.log";
const SECRET_TEXT = "please refactor the payment module";

/** A session with usage, two landings, a rejection and a later (or same-ms: the failure wins) failure whose message carries a path and user text. */
function busySession(id = "diag-1") {
  recordUsage(id, { totalTokens: 420_000, window: 1_000_000 });
  recordLedger(id, { layer: "L1", id: "c1", tokensFromStart: 1000, reclaimed: 500 }, 1);
  recordLedger(id, { layer: "L2", id: "f1", tokensFromStart: 2000, reclaimed: 900 }, 2);
  recordActivityRejection(id, "L1", `"${SECRET_TEXT}" ${SECRET_PATH} reclaims only ~900 tokens`, { id: "c2" });
  recordActivityError(id, "L2", `fold failed reading ${SECRET_PATH}`, { id: "f2" });
  return id;
}

test("statusFacts: all nine facts from settings, activity, ledger, conflicts and the reset hint", () => {
  const id = busySession();
  const reset = { bak: join(root, "profile", "cordis.patch.yml.bak-1764201600000"), seen: false };
  const facts = statusFacts({ settings: readSettings({}, { ...PAGE_DEFAULTS, mode: "quality" }), sessionId: id, conflicts: ["dsh-live-compact"], reset });
  assert.deepEqual(Object.keys(facts), NINE);
  assert.equal(facts["x.mode"], "quality");
  assert.equal(facts["x.mode_source"], "settings");
  assert.equal(facts["x.auto_fold_pct"], "25%");
  assert.equal(facts["x.context_pct"], "42%");
  assert.equal(facts["x.fold_count"], 2);
  assert.equal(facts["x.last_issue"], "fold_failed");
  assert.match(facts["x.last_issue_at"], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(facts["x.conflict"], "dsh-live-compact");
  assert.equal(facts["x.settings_reset"], "yes");
});

test("statusFacts: defaults, env source, failure types, no session, conflicts as one word", () => {
  const base = statusFacts({ settings: readSettings({}, null), sessionId: "", conflicts: [], reset: null });
  assert.deepEqual(base, { "x.mode": "cost", "x.mode_source": "default", "x.auto_fold_pct": "50%", "x.conflict": "none", "x.settings_reset": "no" });
  assert.equal(statusFacts({ settings: readSettings({ STRATA_PRESET: "quality" }, null), sessionId: "", conflicts: [], reset: null })["x.mode_source"], "env");

  recordActivityError("s-fail", "L1", "boom", { timeout: true });
  assert.equal(statusFacts({ sessionId: "s-fail", conflicts: [], reset: null })["x.last_issue"], "card_timeout");
  recordActivityError("s-fold", "L2", "boom");
  assert.equal(statusFacts({ sessionId: "s-fold", conflicts: [], reset: null })["x.last_issue"], "fold_failed");
  recordUsage("s-quiet", { totalTokens: 1, window: 0 });
  const quiet = statusFacts({ sessionId: "s-quiet", conflicts: [], reset: null });
  assert.equal(quiet["x.last_issue"], "none");
  assert.equal("x.last_issue_at" in quiet, false);
  assert.equal("x.context_pct" in quiet, false, "no window, no percentage");

  assert.equal(conflictWord("@light-cheng/dsh-strata"), "light-cheng.dsh-strata");
  noteConfigConflicts(["billion-context"]);
  assert.equal(statusFacts({ sessionId: "", reset: null })["x.conflict"], "billion-context");
});

test("latestActivitySession: the session written last", () => {
  assert.equal(latestActivitySession(), "");
  recordUsage("a", { totalTokens: 1, window: 10 });
  recordUsage("b", { totalTokens: 1, window: 10 });
  assert.equal(latestActivitySession(), "b");
  recordActivityRejection("a", "L1", "x");
  assert.equal(latestActivitySession(), "a");
});

const HEADER = (version) => `<dsh-diagnosis plugin="dsh-strata" version="${version}" kind="status" format="1">`;

test("values: words, counts, ISO times and percentages pass; sentences, paths, long values, booleans and negatives are dropped", () => {
  for (const ok of ["cost", "fold_failed", "dsh-live-compact", "light-cheng.dsh-strata", 3, 0, "42.5%", "2026-11-27T10:00:00.000Z"]) {
    assert.deepEqual(diagnosisExtra({ "x.v": ok }), [["x.v", ok]], String(ok));
  }
  assert.deepEqual(diagnosisExtra({ "x.v": 2.6 }), [["x.v", 3]], "a number is a count: rounded");
  for (const bad of ["two words", SECRET_PATH, "C:\\Users\\x", "a/b", "x".repeat(41), "", null, undefined, Number.NaN, -1, true, false, { a: 1 }, ["a"], "line\nbreak", "key: value"]) {
    assert.deepEqual(diagnosisExtra({ "x.v": bad }), [], String(bad));
  }
});

test("renderStatusBlock: header, one key per line, footer; bad keys and values dropped whole; at most 12 x. fields", () => {
  const block = renderStatusBlock({
    "x.mode": "cost",
    "x.bad": SECRET_TEXT,
    "x.path": SECRET_PATH,
    "x.long": "y".repeat(80),
    "X.Upper": "cost",
    "mode": "cost",
    "x.Bad-Key": "cost",
    "x.fold_count": 3,
  }, { version: "0.5.0" });
  assert.equal(block, `${HEADER("0.5.0")}\nx.mode: cost\nx.fold_count: 3\n</dsh-diagnosis>`);
  assert.equal(renderStatusBlock({ "x.bad": "a sentence here" }, { version: "1" }), "", "nothing left: empty");
  assert.match(renderStatusBlock({ "x.a": "b" }, { version: '1"><x' }), /^<dsh-diagnosis plugin="dsh-strata" version="1x" kind="status" format="1">$/m);
  assert.match(renderStatusBlock({ "x.a": "b" }), /^<dsh-diagnosis plugin="dsh-strata" kind="status" format="1">$/m, "no version, no attribute");

  const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`x.f${i}`, i]));
  assert.equal(renderStatusBlock(many).split("\n").length - 2, DIAGNOSIS_EXTRA_MAX);
});

test("standard fields: last_at (the last issue's time) comes first; nothing else from the standard list", () => {
  const id = busySession("diag-std");
  const facts = statusFacts({ sessionId: id, conflicts: [], reset: null });
  assert.deepEqual(standardFacts(facts), [["last_at", facts["x.last_issue_at"]]]);
  const lines = renderStatusBlock(facts, { version: "0.5.0" }).split("\n");
  assert.equal(lines[1], `last_at: ${facts["x.last_issue_at"]}`);
  assert.ok(lines.slice(2, -1).every((line) => line.startsWith("x.")), "x. fields after the standard ones");
  const keys = lines.slice(1, -1).map((line) => line.slice(0, line.indexOf(":")));
  assert.deepEqual(keys.filter((key) => !key.startsWith("x.")), ["last_at"]);

  recordUsage("diag-calm", { totalTokens: 1, window: 10 });
  const calm = statusFacts({ sessionId: "diag-calm", conflicts: [], reset: null });
  assert.deepEqual(standardFacts(calm), [], "no issue, no last_at");
  assert.doesNotMatch(renderStatusBlock(calm), /\nlast_at:/);
  assert.deepEqual(standardFacts({ "x.last_issue_at": "2026-11-27T16:20:00+08:00" }), [["last_at", "2026-11-27T08:20:00.000Z"]], "normalised to UTC");
  for (const bad of [SECRET_PATH, "2026-13-45T99:00:00Z", "yesterday", 1764201600000, null]) assert.deepEqual(standardFacts({ "x.last_issue_at": bad }), [], String(bad));
});

test("no path and no conversation text reaches the block, from a rejection, a failure or the .bak", () => {
  const id = busySession("diag-leak");
  const reset = { bak: SECRET_PATH, seen: false };
  const block = renderStatusBlock(statusFacts({ sessionId: id, conflicts: [], reset }), { version: pkg.version });
  assert.ok(block);
  assert.equal(block.includes("/Users"), false);
  assert.equal(block.includes("secret"), false);
  assert.equal(block.includes("payment"), false);
  assert.equal(block.includes("bak"), false);
  assert.equal(block.includes("f2") || block.includes("c2"), false, "no ids");
  for (const line of block.split("\n").slice(1, -1)) assert.match(line, /^(?:last_at|x\.[a-z0-9_]{1,32}): [A-Za-z0-9_.:%-]+$/);
});

test("service: statusBlock returns the block; any error gives null, never a throw", async () => {
  busySession("diag-svc");
  const service = createDiagnosisService({ version: pkg.version });
  const block = service.statusBlock({ lang: "zh" });
  assert.ok(block.startsWith(`${HEADER(pkg.version)}\n`));
  assert.match(block, /\nx\.fold_count: 2\n/, "latest session");
  assert.match(block, /\n<\/dsh-diagnosis>$/);

  const broken = createDiagnosisService({ collect: () => { throw new Error("boom"); } });
  assert.equal(broken.statusBlock({ lang: "en" }), null);
  assert.equal(createDiagnosisService({ collect: () => ({}) }).statusBlock(), null, "nothing to report");
});

test("service: sessionId picks that session; a session with no data gets no session fields", () => {
  busySession("diag-a");
  recordUsage("diag-b", { totalTokens: 100, window: 1000 });
  const service = createDiagnosisService({ version: pkg.version });
  const SESSION = ["x.context_pct", "x.fold_count", "x.last_issue", "x.last_issue_at"];
  const keysOf = (block) => block.split("\n").slice(1, -1).map((line) => line.slice(0, line.indexOf(":")));

  // Without sessionId: the session written last (diag-b, quiet).
  const latest = service.statusBlock({ lang: "en" });
  assert.match(latest, /\nx\.context_pct: 10%\n/);
  assert.match(latest, /\nx\.fold_count: 0\n/);
  assert.match(latest, /\nx\.last_issue: none\n/);
  assert.doesNotMatch(latest, /\nlast_at:/);

  // With sessionId: that session, even though another was written later.
  const picked = service.statusBlock({ lang: "zh", sessionId: "diag-a" });
  assert.match(picked, /\nx\.context_pct: 42%\n/);
  assert.match(picked, /\nx\.fold_count: 2\n/);
  assert.match(picked, /\nx\.last_issue: fold_failed\n/);
  assert.match(picked, /\nlast_at: \d{4}-/);

  // A session this process never saw: no session fields, no last_at, the rest stays.
  const unknown = service.statusBlock({ lang: "en", sessionId: "never-seen" });
  const keys = keysOf(unknown);
  for (const key of [...SESSION, "last_at"]) assert.equal(keys.includes(key), false, key);
  assert.deepEqual(keys, ["x.mode", "x.mode_source", "x.auto_fold_pct", "x.conflict", "x.settings_reset"]);

  // A session known only through the ledger still counts as having data.
  recordLedger("diag-ledger", { layer: "L2", id: "f9", tokensFromStart: 10, reclaimed: 5 }, 1);
  assert.match(service.statusBlock({ sessionId: "diag-ledger" }), /\nx\.fold_count: 1\n/);

  // An empty sessionId is the same as none.
  assert.equal(service.statusBlock({ sessionId: "" }), service.statusBlock({}));
  assert.equal(typeof service.statusBlock(), "string", "no options at all");
});

test("gate provides dshDiagnosisStrata; a failing provide does not break the gate", () => {
  const provided = new Map();
  const ctx = fakeContext();
  ctx.provide = (name, value) => provided.set(name, value);
  new Gate(ctx, {});
  assert.ok(provided.has("strataPresetGate"));
  const service = provided.get(DIAGNOSIS_SERVICE);
  assert.equal(DIAGNOSIS_SERVICE, "dshDiagnosisStrata");
  assert.equal(typeof service?.statusBlock, "function");
  assert.match(service.statusBlock({ lang: "en" }), new RegExp(`version="${pkg.version.replace(/\./g, "\\.")}"`));

  const strict = fakeContext();
  strict.provide = (name) => {
    if (name === DIAGNOSIS_SERVICE) throw new Error("taken");
  };
  assert.doesNotThrow(() => new Gate(strict, {}));
  setPageConfig(null);
});

test("/strata detail ends with the diagnostic section (zh and en), for this session, with no path", () => {
  const profileDir = join(root, "profiles", "desk");
  mkdirSync(profileDir, { recursive: true });
  const engine = new Engine(fakeContext({ contextWindow: 1_000_000 }), {});
  const session = new FakeSession({ id: "diag-detail", cwd: join(root, "work") });
  const agent = fakeAgent(session);
  addUser(session, SECRET_TEXT);
  addToolRound(session, { command: `cat ${SECRET_PATH}`, output: filler("cat", 400) });
  recordActivityRejection("diag-detail", "L2", `${SECRET_PATH} too small`);
  recordUsage("someone-else", { totalTokens: 1, window: 10 });

  const zh = runCommand(engine.strataLayer, agent, "detail", { language: "zh" }).text;
  const section = zh.slice(zh.indexOf("7. 诊断信息（可复制）"));
  assert.ok(zh.indexOf("7. 诊断信息（可复制）") > zh.indexOf("6. 最近的上下文变化"));
  assert.match(section, /^7\. 诊断信息（可复制）\n```\n<dsh-diagnosis plugin="dsh-strata" version="[^"]+" kind="status" format="1">\n[\s\S]*\n<\/dsh-diagnosis>\n```$/);
  assert.match(section, /\nx\.last_issue: rejected\n/, "this session, not the latest one");
  assert.equal(section.includes("/Users"), false);
  assert.equal(section.includes("payment"), false);
  assert.match(runCommand(engine.strataLayer, agent, "detail", { language: "en" }).text, /\n7\. Diagnostic info \(copy\)\n```\n<dsh-diagnosis /);

  // With a standing reset hint the block says yes, without the .bak path.
  const T0 = Date.parse("2026-11-01T00:00:00Z");
  checkSettingsReset({ page: { ...PAGE_DEFAULTS, mode: "quality" }, profileDir, profile: "desk", now: T0 });
  writeFileSync(join(profileDir, `cordis.patch.yml.bak-${T0 + 1000}`), "[]\n");
  assert.ok(checkSettingsReset({ page: PAGE_DEFAULTS, profileDir, profile: "desk", now: T0 + 2000 })?.hint, "hint raised");
  const withReset = runCommand(engine.strataLayer, agent, "detail", { language: "zh" }).text;
  const tail = withReset.slice(withReset.indexOf("7. 诊断信息"));
  assert.match(tail, /\nx\.settings_reset: yes\n/);
  assert.equal(tail.includes("bak"), false);
});
