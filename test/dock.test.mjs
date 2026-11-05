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
