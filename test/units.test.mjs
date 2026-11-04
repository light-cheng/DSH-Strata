import assert from "node:assert/strict";
import { test } from "node:test";
import { l1MayCut, l2MayFold, parseSeqRef, parseStratumTag, seqRef, stratumOf, stratumTag } from "../lib/stratum.js";
import { buildIndex, searchIndex, tokenize } from "../lib/search.js";
import { estimateFold, expectedRemainingRequests } from "../lib/economics.js";
import { parseCompress } from "../lib/fold.js";
import { minBenefitFor, readSettings } from "../lib/settings.js";

const checkpoint = (text) => ({ type: "user/message", data: { source: { kind: "compact-checkpoint" }, content: [{ type: "text", text }] } });

test("stratum tags round-trip and classify surface events", () => {
  const tag = stratumTag("fold", { id: "f3", range: "s00001-s00009" });
  assert.equal(tag, "[strata:fold id=f3 range=s00001-s00009]");
  assert.deepEqual(parseStratumTag(`${tag}\nbody`), { kind: "fold", attrs: { id: "f3", range: "s00001-s00009" } });
  assert.equal(stratumOf(checkpoint(`${tag}\nbody`)).stratum, "fold");
  assert.equal(stratumOf(checkpoint("[strata:card id=cut-1-aaaaaaaa]\n…")).id, "cut-1-aaaaaaaa");
  assert.equal(stratumOf(checkpoint("stock summary")).stratum, "full", "untagged checkpoint = full");
  assert.equal(stratumOf(checkpoint("Strata card.\nold layout")).stratum, "card");
  // A tag inside ordinary content is not trusted.
  assert.equal(stratumOf({ type: "tool/result", data: { message: { content: [{ type: "text", text: tag }] } } }).stratum, "raw");
  assert.equal(stratumOf({ type: "user/message", data: { content: [{ type: "text", text: tag }] } }).stratum, "raw");
});

test("no-double-compression rules", () => {
  assert.equal(l1MayCut("raw"), true);
  for (const stratum of ["card", "fold", "full"]) assert.equal(l1MayCut(stratum), false);
  assert.equal(l2MayFold(["raw", "card", "raw"]).ok, true);
  assert.equal(l2MayFold(["raw", "fold"]).ok, false);
  assert.equal(l2MayFold(["full"]).ok, false);
  assert.equal(l2MayFold([]).ok, false);
  assert.equal(seqRef(42), "s00042");
  assert.equal(parseSeqRef("s00042"), 42);
  assert.equal(parseSeqRef("42"), 42);
  assert.ok(Number.isNaN(parseSeqRef("m00042")));
});

test("compress content parsing", () => {
  assert.deepEqual(parseCompress("s00010–s00020 build fix\nline one\nline two"), { ok: true, start: 10, end: 20, topic: "build fix", summary: "line one\nline two" });
  assert.equal(parseCompress("s10..s20: topic\nx").ok, true);
  assert.equal(parseCompress("10-20\nx").ok, true);
  assert.equal(parseCompress("").ok, false);
  assert.equal(parseCompress("hello\nworld").ok, false);
});

test("BM25 search: identifiers, CJK bigrams, ranking", () => {
  assert.ok(tokenize("src/app.tsx failed").includes("app"));
  assert.ok(tokenize("构建失败").includes("失败"));
  const index = buildIndex([
    { id: "a", kind: "raw", text: "npm test failed: TypeError in parser.js line 40" },
    { id: "b", kind: "card", text: "docs updated, nothing failed" },
    { id: "c", kind: "fold", text: "部署脚本构建失败，原因是缺少环境变量 DEPLOY_KEY" },
    { id: "d", kind: "raw", text: `${"filler ".repeat(400)} needle-token-xyz ${"filler ".repeat(400)}` },
  ]);
  assert.equal(searchIndex(index, "TypeError parser")[0].id, "a");
  assert.equal(searchIndex(index, "构建失败")[0].id, "c");
  assert.equal(searchIndex(index, "DEPLOY_KEY")[0].id, "c");
  const deep = searchIndex(index, "needle-token-xyz");
  assert.equal(deep[0].id, "d");
  assert.match(deep[0].snippet, /needle-token-xyz/);
  assert.deepEqual(searchIndex(index, "zzzz-not-here"), []);
});

test("cost/benefit estimate", () => {
  const early = estimateFold({ tokensFromStart: 200_000, reclaimed: 30_000, remainingRequests: 10, priceMiss: 1, priceHit: 0.1 });
  assert.equal(early.worthIt, false, "a fold near the head re-bills a long tail");
  const late = estimateFold({ tokensFromStart: 40_000, reclaimed: 30_000, remainingRequests: 10, priceMiss: 1, priceHit: 0.1 });
  assert.equal(late.worthIt, true);
  assert.equal(late.paybackRequests, 3);
  assert.equal(expectedRemainingRequests(0), 4);
  assert.equal(expectedRemainingRequests(50), 50);
  assert.equal(expectedRemainingRequests(500), 200);
  assert.equal(expectedRemainingRequests(3, 9), 9);
  const settings = readSettings({});
  assert.equal(settings.nudgeGrowthTokens, 50_000);
  assert.equal(settings.forcePct, 0.75);
  assert.equal(minBenefitFor(settings, 1_000_000), 10_000);
  assert.equal(minBenefitFor(settings, 128_000), 5_000);
});
