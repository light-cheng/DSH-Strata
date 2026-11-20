// Id lists in /strata detail and the dock: whole ids only (lib/ids.js).
import assert from "node:assert/strict";
import { test } from "node:test";
import { idsText, storedIds } from "../lib/ids.js";
import { translator } from "../lib/command.js";
import { recordActivityRejection, lastActivityRejection, recordActivity, readActivity, resetActivity } from "../lib/activity.js";
import { readLedger, recordLedger, resetLedger } from "../lib/ledger.js";

const zh = translator("zh");
const en = translator("en");

test("ids: single, consecutive, non-consecutive, very long", () => {
  assert.equal(idsText("f180", zh), "f180");
  assert.equal(idsText("cut-1794197378160-1650f5c5", zh), "cut-1794197378160-1650f5c5", "a long single id is kept whole");
  const run = Array.from({ length: 8 }, (_, i) => `f${180 - i}`).join(",");
  assert.equal(idsText(run, zh), "f180–f173（8 段）");
  assert.equal(idsText(run, en), "f180–f173 (8 folds)");
  assert.equal(idsText("f3,f4,f5", en), "f3–f5 (3 folds)", "ascending runs too");
  assert.equal(idsText("f180,f175", zh), "f180、f175");
  assert.equal(idsText("f180,f175,f170,f2", zh), "f180、f175 等 4 段");
  assert.equal(idsText("f180,f175,f170,f2", en), "f180, f175 and others (4 folds)");
  assert.equal(idsText("f180,auto-3,f178", zh), "f180、auto-3 等 3 段", "mixed prefixes are not a run");
  // 300 folds: stored capped at whole ids, shown with the real count.
  const long = Array.from({ length: 300 }, (_, i) => `f${1000 - i * 2}`).join(",");
  const stored = storedIds(long);
  assert.equal(stored.count, 300);
  assert.ok(stored.id.split(",").every((id) => /^f\d+$/.test(id)), "no half ids in storage");
  assert.equal(idsText(stored.id, zh, { count: stored.count }), "f1000、f998 等 300 段");
  const longRun = Array.from({ length: 300 }, (_, i) => `f${400 - i}`).join(",");
  const capped = storedIds(longRun);
  assert.equal(idsText(capped.id, zh, { count: capped.count }), "f400、f399 等 300 段", "a capped list does not claim a range it cannot see");
  assert.equal(idsText(longRun, zh), "f400–f101（300 段）");
  assert.equal(idsText("", zh), "");
});

test("ids: activity and ledger keep whole ids (no slice through an id)", () => {
  resetActivity();
  resetLedger();
  const ids = Array.from({ length: 12 }, (_, i) => `f${180 - i}`).join(",");
  assert.ok(ids.length > 40, "longer than the old 40-char cut");
  recordActivityRejection("s", "L2", "too small", { id: ids });
  assert.equal(lastActivityRejection("s").id, ids);
  assert.equal(lastActivityRejection("s").idCount, 12);
  recordActivity("s", { layer: "L2", id: ids, reclaimed: 1 });
  assert.equal(readActivity("s").events.at(-1).id, ids);
  recordLedger("s", { layer: "L2", id: ids, tokensFromStart: 10, reclaimed: 5, scale: 1.2 }, 1);
  const last = readLedger("s", 1, { priceMiss: 1, priceHit: 0.1 }).last;
  assert.equal(last.id, ids);
  assert.equal(last.scale, 1.2);
});
