// One conversation row per Strata landing phase (lib/marker.js). FakeSession
// enforces DSH's compaction log rules (one summary per compaction, exact spans).
import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeSession, userMessage } from "./helpers/fake-dsh.mjs";
import { compactCheckpointSource } from "@deepseek-ai/dsh-compaction";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

const { describeItems, inBatch, currentBatch } = await import("../lib/marker.js");

function sessionWith(count) {
  const session = new FakeSession();
  for (let i = 0; i < count; i += 1) session.append("user/message", userMessage(`message ${i} `.repeat(40)));
  return session;
}

/** What DSH's chat list draws: one row per compactionId, from the summary under it. */
function chatRows(session) {
  const rows = new Map();
  for (const event of session.events) {
    const id = event.data?.compactionId ?? (event.type === "user/message" ? event.data?.source?.compactionId : undefined);
    if (!id) continue;
    const row = rows.get(id) || { checkpoints: 0 };
    if (event.type === "compaction/summary") {
      row.items = event.data.shadowedSeqs.length;
      row.tokens = event.data.shadowedTokenCount;
      row.text = event.data.summary.map((block) => block.text).join("");
    }
    if (event.type === "user/message") row.checkpoints += 1;
    rows.set(id, row);
  }
  return [...rows.values()].filter((row) => row.checkpoints > 0);
}

/** DSH's token meter: the event right before each replace prices exactly its range. */
function assertShadowPrices(session) {
  session.events.forEach((event, index) => {
    if (event.type !== "user/message" || event.data?.source?.kind !== "compact-checkpoint") return;
    const claim = session.events[index - 1];
    assert.equal(claim.type, "compaction/prune");
    const replaced = event.replacedRange;
    assert.deepEqual(claim.data.shadowedRange, replaced);
  });
}

function plan(seqs, kind = "dropped") {
  return seqs.map((seq) => ({ start: seq, end: seq, seqs: [seq], tokens: 100 + seq, kind, label: kind === "fold" ? `f${seq}` : undefined }));
}

function land(session, batch, item) {
  const message = createUserMessage({ content: [{ type: "text", text: "model-facing text" }], source: compactCheckpointSource(batch.compactionId) });
  batch.replace({ ...item, message, rawOutput: [{ type: "text", text: "model-facing text" }] });
  session.events.at(-1).replacedRange = { start: item.start, end: item.end };
}

test("a phase with scattered replacements is one row: one summary up front, an exact prune before each replace", async () => {
  const session = sessionWith(6);
  const items = plan([6, 4, 2]);
  await inBatch(session, items, async (batch) => {
    assert.equal(currentBatch(session), batch);
    for (const item of items) land(session, batch, item);
  }, { language: "zh" });
  assert.equal(currentBatch(session), null);
  assertShadowPrices(session);
  assert.equal(session.events.filter((event) => event.type === "compaction/summary").length, 1);
  assert.equal(session.events.at(-1).type, "compaction/end");
  assert.equal(session.events.at(-1).data.error, undefined);
  const rows = chatRows(session);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tokens, 102 + 104 + 106, "totals in the line");
  assert.equal(rows[0].items, 1, "scattered ranges: DSH counts the first range only");
  assert.match(rows[0].text, /清理了 3 份过期的运行时上下文，共 3 条记录，约 312 tokens/);
  assert.doesNotMatch(rows[0].text, /archive|<strata|不是新指令|model-facing/);
});

test("back-to-back ranges: the summary names the whole hull, so DSH shows the true count", async () => {
  const session = sessionWith(6);
  const items = [
    { start: 4, end: 6, seqs: [4, 5, 6], tokens: 3000, kind: "fold", label: "f2" },
    { start: 1, end: 3, seqs: [1, 2, 3], tokens: 2000, kind: "fold", label: "f1" },
  ];
  await inBatch(session, items, async (batch) => {
    for (const item of items) land(session, batch, item);
  }, { language: "en" });
  const rows = chatRows(session);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].items, 6);
  assert.equal(rows[0].tokens, 5000);
  assert.match(rows[0].text, /^Strata tidied what the model sees: folded 2 earlier stretch\(es\) \(f2, f1\); 6 records, about 5\.0K tokens\./);
});

test("nested calls share the open phase; a single replacement is still one valid compaction", async () => {
  const session = sessionWith(4);
  const items = plan([3, 1], "fold");
  await inBatch(session, items, async () => {
    for (const item of items) await inBatch(session, [item], async (inner) => land(session, inner, item));
  });
  assert.equal(chatRows(session).length, 1);
  const single = sessionWith(2);
  const [item] = plan([2], "card");
  await inBatch(single, [item], async (batch) => land(single, batch, item));
  assert.equal(chatRows(single)[0].items, 1);
  assert.equal(chatRows(single)[0].tokens, 102);
});

test("nothing landed: no row (end carries the error); an empty phase writes nothing", async () => {
  const session = sessionWith(2);
  const items = plan([2]);
  await assert.rejects(inBatch(session, items, async (batch) => {
    batch.begin(items[0]);
    batch.fail(new Error("too big"));
    throw new Error("too big");
  }));
  assert.equal(session.events.at(-1).type, "compaction/end");
  assert.equal(session.events.at(-1).data.error, "too big");
  assert.equal(chatRows(session).length, 0);
  const quiet = sessionWith(1);
  await inBatch(quiet, [], async () => {});
  assert.equal(quiet.events.length, 1);
});

test("the people line in both languages", () => {
  const items = [{ kind: "fold", tokens: 9000, label: "f3", seqs: [1, 2] }, { kind: "fold", tokens: 4268, label: "f4", seqs: [3] }, { kind: "card", tokens: 500, seqs: [4] }];
  assert.equal(describeItems(items, "zh"), "Strata 整理了模型看到的上下文：折叠了 2 段较早的内容（f3, f4），把 1 段旧工具输出压成了卡片，共 4 条记录，约 13.8K tokens。这里的对话记录没有变，原文在本地存档里，需要时可以取回。");
  assert.match(describeItems(items, "en"), /^Strata tidied what the model sees: folded 2 earlier stretch\(es\) \(f3, f4\); turned 1 older tool output\(s\) into a card; 4 records, about 13\.8K tokens\./);
});
