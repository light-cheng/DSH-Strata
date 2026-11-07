import assert from "node:assert/strict";
import { test } from "node:test";
import { markBusy, readActivity, recordActivity, recordActivityError, recordUsage, resetActivity } from "../lib/activity.js";
import { GUI_STATUS_PATH, registerGuiRoutes, statusPayload } from "../lib/gui-routes.js";

test("activity: events per session, errors cleared by the next success, busy counter", () => {
  resetActivity();
  recordActivity("session-a", { layer: "L1", id: "cut-1", reclaimed: 18234.4 });
  recordActivityError("session-a", "L2", "boom");
  assert.equal(readActivity("session-a").error.layer, "L2");
  recordActivity("session-a", { layer: "L2", id: "f1", reclaimed: 23300, tier: 1 });
  const a = readActivity("session-a");
  assert.deepEqual(a.events.map((e) => [e.layer, e.reclaimed, e.tier]), [["L1", 18234, 0], ["L2", 23300, 1]]);
  assert.equal(a.error, null);
  markBusy("session-a", true);
  assert.equal(readActivity("session-a").busy, true);
  markBusy("session-a", false);
  assert.equal(readActivity("session-a").busy, false);
  recordUsage("session-a", { totalTokens: 48700, window: 1000000, tiers: [1, 0, 0] });
  assert.equal(readActivity("session-a").usage.totalTokens, 48700);
  assert.deepEqual(readActivity("session-b").events, [], "sessions do not leak into each other");
});

function routeHarness({ rejection } = {}) {
  const routes = [];
  const child = {
    webServer: { register(route) { routes.push(route); return () => {}; } },
    get(name) { return name === "connection" ? { requestRejection: () => rejection } : undefined; },
    effect(fn) { fn(); },
  };
  registerGuiRoutes({ inject(_names, fn) { fn(child); } }, "9.9.9");
  return routes;
}

function call(route, url, method = "GET") {
  const res = { headers: {}, statusCode: 0, body: "", setHeader(k, v) { this.headers[k] = v; }, end(b = "") { this.body = b; } };
  route.handler({ url, method }, res);
  return res;
}

test("status route: per-session JSON, session id validated, fence respected, GET only", () => {
  resetActivity();
  recordActivity("session-x", { layer: "L∞", id: "official", reclaimed: 5000 });
  const [route] = routeHarness();
  assert.equal(route.path, GUI_STATUS_PATH);
  const ok = call(route, `${GUI_STATUS_PATH}?session=session-x`);
  assert.equal(ok.statusCode, 200);
  const body = JSON.parse(ok.body);
  assert.equal(body.version, "9.9.9");
  assert.equal(body.events[0].layer, "L∞");
  assert.equal(call(route, `${GUI_STATUS_PATH}?session=../etc`).statusCode, 400);
  assert.equal(call(route, `${GUI_STATUS_PATH}?session=session-x`, "POST").statusCode, 405);
  const [fenced] = routeHarness({ rejection: 403 });
  assert.equal(call(fenced, `${GUI_STATUS_PATH}?session=session-x`).statusCode, 403);
  assert.deepEqual(Object.keys(statusPayload("session-x", "1")).sort(), ["busy", "error", "events", "now", "takeover", "usage", "version"]);
});

test("strataBudget: stages follow the L1 stop line and the force line; summaries keep their budget when tight", async () => {
  const { createBudget } = await import("../lib/budget.js");
  const { readSettings } = await import("../lib/settings.js");
  const settings = { ...readSettings({}), contextWindow: 100000 };
  let total = 10000;
  const budget = createBudget({ tokenMeter: { measure: () => ({ totalTokens: total }) } }, settings);
  const session = { id: "budget-test" };
  assert.equal(budget.pressure(session).stage, "normal");
  assert.equal(budget.allowance(session, "mem0:recall", 2200), 2200);
  total = 70000;
  assert.equal(budget.pressure(session).stage, "tight");
  assert.equal(budget.allowance(session, "mem0:recall", 2200), 1100);
  assert.equal(budget.allowance(session, "plugin:dsh-mem0:profile", 1375), 1375);
  total = 80000;
  assert.equal(budget.pressure(session).stage, "critical");
  assert.equal(budget.allowance(session, "plugin:dsh-mem0:profile", 1375), 512);
  assert.equal(budget.allowance(session, "mem0:recall", 300), 300);
  assert.equal(typeof budget.countTokens("hello world"), "number");
  const broken = createBudget({ tokenMeter: { measure() { throw new Error("x"); }, estimateText() { throw new Error("y"); } } }, settings);
  assert.equal(broken.pressure({ id: "nobody" }).stage, "normal", "never throws");
  assert.equal(broken.allowance({ id: "nobody" }, "mem0:recall", 900), 900);
  assert.equal(broken.countTokens("abcd"), 1);
});

test("dock client: events landing between two polls play the most significant one, not the last", async () => {
  const { readFileSync } = await import("node:fs");
  const { runInNewContext } = await import("node:vm");
  let mod;
  const window = { __ModuleLoader__: { load: ({ factory }) => { mod = factory(() => ({ createElement() {}, useEffect() {}, useLayoutEffect() {}, useRef() {}, useState() {} })); } } };
  runInNewContext(readFileSync(new URL("../client.js", import.meta.url), "utf8"), { window });
  const { pickEvent, eventLabel } = mod.__test;
  const labels = { fold: "Fold", autoFold: "Auto fold" };
  assert.equal(eventLabel((key) => labels[key], { layer: "L2", tier: 1, reclaimed: 3100, auto: true }), "Auto fold T1 −3.1K", "automatic digests show as a fold, labelled as automatic");
  assert.equal(eventLabel((key) => labels[key], { layer: "L2", tier: 2, reclaimed: 900 }), "Fold T2 −900");
  // One turn-end maintenance: fold f1, then an L1 card, then a stale sweep.
  const events = [
    { layer: "L1", reclaimed: 3500, at: 100 },
    { layer: "L2", tier: 1, reclaimed: 8409, at: 210 },
    { layer: "L1", reclaimed: 3734, at: 220 },
    { layer: "ctx", reclaimed: 481, at: 230 },
  ];
  assert.equal(pickEvent(events, 150).layer, "L2", "fold beats the card and the sweep that followed it");
  assert.equal(pickEvent(events, 150).at, 230, "the play mark still advances to the newest event");
  assert.equal(pickEvent(events, 230), null, "nothing new");
  assert.equal(pickEvent([{ layer: "L1", reclaimed: 10, at: 5 }, { layer: "L∞", reclaimed: 1, at: 6 }], 0).layer, "L∞");
  assert.equal(pickEvent([{ layer: "L1", reclaimed: 10, at: 5 }, { layer: "L1", reclaimed: 900, at: 6 }], 0).reclaimed, 900);
});

test("strataBudget trace: off by default, one JSON line per allowance call when STRATA_BUDGET_TRACE is set", async () => {
  const { mkdtempSync, readFileSync, existsSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createBudget } = await import("../lib/budget.js");
  const { readSettings } = await import("../lib/settings.js");
  const dir = mkdtempSync(join(tmpdir(), "strata-trace-"));
  const file = join(dir, "budget.jsonl");
  const budget = createBudget({ tokenMeter: { measure: () => ({ totalTokens: 70000 }) } }, { ...readSettings({}), contextWindow: 100000 });
  delete process.env.STRATA_BUDGET_TRACE;
  budget.allowance({ id: "s1" }, "mem0:recall", 2200);
  assert.equal(existsSync(file), false);
  process.env.STRATA_BUDGET_TRACE = file;
  try {
    assert.equal(budget.allowance({ id: "s1" }, "mem0:recall", 2200), 1100);
    const line = JSON.parse(readFileSync(file, "utf8").trim());
    assert.deepEqual({ session: line.session, name: line.name, wanted: line.wanted, allowance: line.allowance, stage: line.stage, ratio: line.ratio }, { session: "s1", name: "mem0:recall", wanted: 2200, allowance: 1100, stage: "tight", ratio: 0.7 });
  } finally {
    delete process.env.STRATA_BUDGET_TRACE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settings page client: zh / en parity, defaults match the Config, save and reset ops, validation", async () => {
  const { readFileSync } = await import("node:fs");
  const { runInNewContext } = await import("node:vm");
  const { PAGE_DEFAULTS } = await import("../lib/settings.js");
  let mod;
  const window = { __ModuleLoader__: { load: ({ factory }) => { mod = factory(() => ({ createElement() {}, useEffect() {}, useLayoutEffect() {}, useRef() {}, useState() {} })); } } };
  runInNewContext(readFileSync(new URL("../client.js", import.meta.url), "utf8"), { window });
  const { settingsEn, settingsZh, normalise, draftProblem, saveOps, resetOps, DEFAULTS } = mod.__test;
  assert.deepEqual(Object.keys(settingsZh).sort(), Object.keys(settingsEn).sort(), "same keys in zh and en");
  assert.deepEqual({ ...DEFAULTS }, PAGE_DEFAULTS, "page defaults match lib/settings.js");
  assert.match(settingsZh.advanced, /仅在自定义模式下生效/);
  for (const key of ["autoFoldPctHint", "nudgeHint", "autoFoldHint", "archiveMaxMBHint", "archiveKeepDaysHint", "modeApplies"]) assert.match(settingsZh[key], /立即生效/, key);
  assert.match(settingsZh.archiveDirHint, /对新会话生效/);
  const initial = normalise({});
  assert.equal(initial.mode, "cost");
  assert.equal(normalise({ mode: "turbo" }).mode, "cost");
  assert.deepEqual(JSON.parse(JSON.stringify(saveOps({ ...initial, mode: "quality", nudge: false }, initial))), [{ op: "set", path: ["mode"], value: "quality" }, { op: "set", path: ["nudge"], value: false }]);
  assert.deepEqual(JSON.parse(JSON.stringify(saveOps({ ...initial }, { ...initial, mode: "quality" }))), [{ op: "unset", path: ["mode"] }], "back to a default value unsets it");
  assert.deepEqual(JSON.parse(JSON.stringify(saveOps({ ...initial, archiveMaxMB: "2048" }, initial))), [{ op: "set", path: ["archiveMaxMB"], value: 2048 }]);
  assert.equal(resetOps().length, Object.keys(PAGE_DEFAULTS).length);
  assert.equal(draftProblem(initial), "");
  assert.equal(draftProblem({ ...initial, archiveKeepDays: "1.5" }), "invalidNumber");
  assert.equal(draftProblem({ ...initial, mode: "custom", autoFoldPct: 60, autoFoldForcePct: 50 }), "linesOrder");
  assert.equal(draftProblem({ ...initial, mode: "custom", autoFoldTargetPct: 55 }), "linesOrder");
  assert.equal(draftProblem({ ...initial, mode: "cost", autoFoldPct: 60, autoFoldForcePct: 50 }), "", "advanced values only checked in custom");
});
