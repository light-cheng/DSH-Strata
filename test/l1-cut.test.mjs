import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { addAssistantText, addToolRound, addUser, fakeAgent, fakeContext, FakeSession, filler } from "./helpers/fake-dsh.mjs";

const root = mkdtempSync(join(tmpdir(), "strata-l1-"));
process.env.STRATA_SHADOW_DIR = join(root, "archive");
process.env.STRATA_MIN_BENEFIT_TOKENS = "500";
process.env.STRATA_MIN_BENEFIT_RATIO = "0.000001";
const { default: Engine } = await import("../index.js");
const { stratumOf } = await import("../lib/stratum.js");
after(() => rmSync(root, { recursive: true, force: true }));

function setup(id) {
  const ctx = fakeContext();
  const engine = new Engine(ctx, {});
  const session = new FakeSession({ id, cwd: join(root, "work") });
  session.listeners.push((s, event) => {
    for (const fn of ctx.handlers.get("session/event") || []) fn(s, event);
  });
  return { ctx, engine, session, agent: fakeAgent(session), layer: engine.strataLayer };
}

function longTask(session, rounds = 8) {
  addUser(session, "Run the test suite and fix failures.");
  const ids = [];
  for (let i = 0; i < rounds; i += 1) {
    ids.push(addToolRound(session, { command: `npm test -- shard ${i}`, output: `${filler(`shard-${i} PASS`, 12000)}\nMARKER_${i}_ORIGINAL\n[exit code: 0]` }));
  }
  addAssistantText(session, "All shards pass.");
  return ids;
}

test("L1 cuts the newest finished chunk into a tagged card with an archive id", async () => {
  const { engine, session, agent, layer, ctx } = setup("session-l1");
  const ids = longTask(session);
  const before = layer.layout(session).totalTokens;
  await engine.finishTurn(agent);
  const rows = layer.layout(session).rows;
  const card = rows.find((row) => row.stratum === "card");
  assert.ok(card, `a card landed; logs: ${ctx.logs.join(" | ")}`);
  assert.ok(layer.layout(session).totalTokens < before);
  const event = session.eventAt(card.seq);
  const text = event.data.content.map((block) => block.text).join("\n");
  assert.match(text, /^\[strata:card id=cut-\d+-[0-9a-f]{8}\]/);
  assert.equal(text.includes(root), false, "card has no absolute archive path");
  assert.equal(stratumOf(event).id, card.id);
  const dir = join(process.env.STRATA_SHADOW_DIR, "session-l1");
  assert.ok(existsSync(join(dir, `${card.id}.txt`)), "cut file archived under the card id");
  assert.ok(readdirSync(dir).some((name) => name.startsWith("raw-")), "raw tool output captured on arrival");
  // The 3 newest tool rounds stay raw (L0).
  const rawTools = rows.filter((row) => row.role === "tool" && row.stratum === "raw");
  assert.ok(rawTools.length >= 3);

  // Restore the card from the archive.
  const restored = layer.decompress(agent, { id: card.id });
  assert.match(restored, /Card original/);
  assert.match(restored, /MARKER_\d_ORIGINAL/);
  assert.match(layer.decompress(agent, { id: ids[0] }), /MARKER_0_ORIGINAL/);

  // L1 never cuts a card again: a second turn end leaves the card alone.
  await engine.finishTurn(agent);
  assert.ok(layer.layout(session).rows.some((row) => row.seq === card.seq && row.stratum === "card"));

  // A tiny fold (just the card) is not worth a cache miss: it waits.
  const small = layer.snapshot(agent).runs[0];
  assert.match(layer.propose(agent, `${small.startRef}–${small.endRef} card only\nx`), /cache cost is higher/);
  layer.state(agent).pending = [];
  // Next task: the earlier rounds leave the protected tail and become foldable.
  addUser(session, "Now update the changelog.");
  for (let i = 0; i < 3; i += 1) addToolRound(session, { command: `edit CHANGELOG ${i}`, output: "edited" });
  addAssistantText(session, "Changelog updated.");
  // L2 may fold cards; full decompress walks fold → card → original.
  const run = layer.snapshot(agent).runs.sort((a, b) => b.tokens - a.tokens)[0];
  assert.ok(run.cards >= 1, "the foldable run includes the card");
  assert.match(layer.propose(agent, `${run.startRef}–${run.endRef} test shards\nShards 0..N passed.`), /pending fold f2/);
  await engine.finishTurn(agent);
  const full = layer.decompress(agent, { id: "f2", full: true });
  assert.match(full, /card cut-/);
  assert.match(full, /MARKER_\d_ORIGINAL/);
  const status = layer.status(agent);
  assert.match(status, /L1 cut-/);
  assert.match(status, /L2 f2/);
});

test("L1 stops above window × l1StopRatio", async () => {
  const { engine, session, agent, layer } = setup("session-stop");
  longTask(session);
  layer.state(agent).window = 30_000; // total ≈ 25K > 0.65 × 30K
  const nodes = [...session.surface.nodes];
  await engine.finishTurn(agent);
  assert.deepEqual(session.surface.nodes, nodes);
});

test("official summary is archived first and tagged full", async () => {
  const { engine, session, agent } = setup("session-full");
  longTask(session, 2);
  const { tagOfficialSummary } = await import("../index.js");
  const tagged = tagOfficialSummary({ summary: [{ type: "text", text: "summary" }] }, "official-1-aaaaaaaa");
  assert.match(tagged.summary[0].text, /^\[strata:full id=official-1-aaaaaaaa\]/);
  const event = { type: "user/message", data: { source: { kind: "compact-checkpoint" }, content: [{ type: "text", text: "stock preamble" }, ...tagged.summary] } };
  assert.deepEqual([stratumOf(event).stratum, stratumOf(event).id], ["full", "official-1-aaaaaaaa"]);
  assert.ok(engine && agent);
});
