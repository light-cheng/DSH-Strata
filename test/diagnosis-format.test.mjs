// Contract test for diagnosis block format 1, shared with DSH-Mem0.
//
// lib/diagnose-report.js and test/fixtures/diagnosis-format-1.json are copied
// verbatim from light-cheng/DSH-Mem0 (commit 52e9e87). Mem0's
// test/diagnosis-format.test.js runs the same fixture against the same module,
// so a case that fails here fails the same way there. Also checks that both
// copies are still byte-identical to the originals.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  DIAGNOSIS_EXTRA_KEY,
  DIAGNOSIS_EXTRA_MAX,
  DIAGNOSIS_FORMAT_VERSION,
  diagnosisBlock,
  diagnosisFacts,
} from "../lib/diagnose-report.js";

const MODULE_SHA256 = "14bfcf6873ee674c75a64825c2982033e6cd9a7409b4c3b3b1cceabce079f3f6";
const FIXTURE_SHA256 = "a8f6fdbb3350029171ae1696513fc87ac628ce1e202a790aad6161eb9cf93122";
const HEADER_LINES = 5;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fixtureBytes = readFileSync(new URL("./fixtures/diagnosis-format-1.json", import.meta.url));
const fixture = JSON.parse(fixtureBytes.toString("utf8"));

function render({ plugin, version, kind, entry, facts, extra }) {
  return diagnosisBlock(entry ? diagnosisFacts(entry) : facts, { plugin, version, kind, extra }).split("\n");
}

test("the copies are byte-identical to DSH-Mem0 52e9e87", () => {
  assert.equal(sha256(fixtureBytes), FIXTURE_SHA256, "fixture");
  const text = readFileSync(new URL("../lib/diagnose-report.js", import.meta.url), "utf8");
  const lines = text.split("\n");
  assert.match(lines.slice(0, HEADER_LINES).join("\n"), /light-cheng\/DSH-Mem0, commit 52e9e87[\s\S]*format 1[\s\S]*Do not edit here/);
  assert.equal(sha256(lines.slice(HEADER_LINES).join("\n")), MODULE_SHA256, "module body below the source header");
});

test("the fixture is format 1 with 12 cases", () => {
  assert.equal(fixture.format, DIAGNOSIS_FORMAT_VERSION);
  assert.equal(fixture.cases.length, 12);
});

for (const { name, input, expected } of fixture.cases) {
  test(`format 1: ${name}`, () => {
    assert.deepEqual(render(input), expected);
  });
}

test("every block in the fixture has kind, and its x. fields follow the rules", () => {
  for (const { name, expected } of fixture.cases) {
    assert.match(expected[0], / kind="(failure|status)" format="1">$/, name);
    assert.equal(expected.at(-1), "</dsh-diagnosis>", name);
    const keys = expected.slice(1, -1).map((line) => line.slice(0, line.indexOf(":")));
    const extra = keys.filter((key) => key.startsWith("x."));
    assert.ok(extra.length <= DIAGNOSIS_EXTRA_MAX, name);
    for (const key of extra) assert.match(key, DIAGNOSIS_EXTRA_KEY, name);
    const first = keys.findIndex((key) => key.startsWith("x."));
    if (first >= 0) assert.ok(keys.slice(first).every((key) => key.startsWith("x.")), name);
    for (const line of expected.slice(1, -1)) assert.doesNotMatch(line, /</, name);
  }
});

test("the Strata case: our nine x. fields, word for word", async () => {
  const strata = fixture.cases.find((entry) => entry.input.plugin === "dsh-strata" && entry.input.version);
  assert.ok(strata);
  assert.deepEqual(strata.expected, [
    '<dsh-diagnosis plugin="dsh-strata" version="0.3.1" kind="status" format="1">',
    "x.mode: auto",
    "x.mode_source: preset",
    "x.auto_fold_pct: 80%",
    "x.context_pct: 63.5%",
    "x.fold_count: 4",
    "x.last_issue: fold_timeout",
    "x.last_issue_at: 2026-11-27T08:20:00.000Z",
    "x.conflict: none",
    "x.settings_reset: no",
    "</dsh-diagnosis>",
  ]);
  // Strata's own renderer gives the same lines for the same facts.
  const { renderStatusBlock } = await import("../lib/diagnosis.js");
  const ours = renderStatusBlock(strata.input.extra, { version: strata.input.version }).split("\n");
  const withoutStandard = [ours[0], ...ours.slice(1).filter((line) => line.startsWith("x.") || line.startsWith("</"))];
  assert.deepEqual(withoutStandard, strata.expected);
  // The one standard field Strata adds (last_at) goes before the x. fields.
  assert.deepEqual(ours.filter((line) => !withoutStandard.includes(line)), ["last_at: 2026-11-27T08:20:00.000Z"]);
});
