import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { addAssistantText, addToolRound, addUser, fakeAgent, fakeContext, FakeSession, filler } from "./helpers/fake-dsh.mjs";

const root = mkdtempSync(join(tmpdir(), "strata-cmd-"));
process.env.STRATA_SHADOW_DIR = join(root, "archive");
const { default: Engine } = await import("../index.js");
const { commandLanguage, displayWidth, runCommand, setUiLanguage, table, translator } = await import("../lib/command.js");
const { readLedger, recordLedger, resetLedger } = await import("../lib/ledger.js");
const { recordActivity } = await import("../lib/activity.js");

after(() => rmSync(root, { recursive: true, force: true }));

function setup(id = `s-${Math.random().toString(16).slice(2)}`) {
  const ctx = fakeContext({ contextWindow: 1_000_000 });
  const engine = new Engine(ctx, {});
  const session = new FakeSession({ id, cwd: join(root, "work") });
  const agent = fakeAgent(session);
  addUser(session, "Task one: fix the build.");
  for (let i = 0; i < 6; i += 1) addToolRound(session, { command: `npm run build --step ${i}`, output: filler(`build-${i}`, 6000) });
  addAssistantText(session, "Build fixed.");
  addUser(session, "Task two: write docs.");
  for (let i = 0; i < 3; i += 1) addToolRound(session, { command: `cat docs/${i}.md`, output: filler(`docs-${i}`, 800) });
  return { engine, session, agent, layer: engine.strataLayer };
}

test("language: explicit tag, then the dock's report; zh-CN → zh, others → en", () => {
  assert.equal(commandLanguage("zh-CN"), "zh");
  assert.equal(commandLanguage("ja"), "en");
  setUiLanguage("zh-Hans");
  assert.equal(commandLanguage(), "zh");
  setUiLanguage("not a tag!");
  assert.equal(commandLanguage(), "zh", "a malformed report is ignored");
  setUiLanguage("en");
  assert.equal(commandLanguage(), "en");
});

test("help: no argument and `help` list every subcommand, in zh and en", () => {
  const { layer, agent } = setup();
  for (const input of ["", "help"]) {
    const en = runCommand(layer, agent, input, { language: "en" });
    assert.equal(en.kind, "success");
    for (const verb of ["/strata status", "/strata detail", "/strata detail full", "/strata search", "/strata purge", "/strata help"]) assert.ok(en.text.includes(verb), verb);
  }
  const zh = runCommand(layer, agent, "help", { language: "zh-CN" }).text;
  assert.match(zh, /检索本会话的本地存档/);
  assert.match(zh, /删除本会话的存档文件（需要确认）/);
  const bogus = runCommand(layer, agent, "bogus", { language: "en" });
  assert.equal(bogus.kind, "error");
  assert.match(bogus.text, /Unknown subcommand "bogus"[\s\S]*\/strata help/);
});

test("purge: plain `purge` only warns; `purge confirm` deletes", () => {
  const { layer, agent } = setup();
  const warn = runCommand(layer, agent, "purge", { language: "zh" }).text;
  assert.match(warn, /无法撤销/);
  assert.match(warn, /\/strata purge confirm/);
  assert.doesNotMatch(warn, /已删除/);
  assert.match(runCommand(layer, agent, "purge", { language: "en" }).text, /cannot be undone[\s\S]*\/strata purge confirm/);
  assert.match(runCommand(layer, agent, "purge confirm", { language: "en" }).text, /^Deleted \d+ archive files/);
  assert.match(runCommand(layer, agent, "purge confirm", { language: "zh" }).text, /^已删除本会话的 \d+ 个存档文件/);
});

test("status is short; search needs words", () => {
  const { layer, agent } = setup();
  const text = runCommand(layer, agent, "status", { language: "en" }).text;
  assert.match(text, /^Strata Context: active \(L1 cards/);
  assert.match(runCommand(layer, agent, "status", { language: "zh" }).text, /^Strata 分层上下文：运行中（L1 卡片/);
  assert.ok(text.split("\n").length <= 7);
  assert.equal(runCommand(layer, agent, "search", { language: "en" }).kind, "error");
});

test("detail: six sections in order, localized, with window source and per-node list only in `full`", () => {
  const { layer, agent, session } = setup();
  recordActivity(session.id, { layer: "L2", id: "f1", tier: 1, reclaimed: 12_000, auto: true });
  const zh = runCommand(layer, agent, "detail", { language: "zh" }).text;
  const heads = ["1. 概览", "2. 分层（本地估算）", "3. 自动折叠", "4. 可折叠范围", "5. 缓存与成本", "6. 最近的上下文变化"];
  let at = -1;
  for (const head of heads) {
    const next = zh.indexOf(head);
    assert.ok(next > at, `${head} after the previous section`);
    at = next;
  }
  assert.match(zh, /上下文窗口\s+1000\.0K  \(默认值，服务商未报告\)/);
  assert.match(zh, /受保护的末尾/);
  assert.match(zh, /自动折叠 T1  f1\s+−12\.0K/);
  assert.match(zh, /逐条列表：\/strata detail full/);
  const full = runCommand(layer, agent, "detail full", { language: "en" }).text;
  assert.match(full, /^ {6}s\d+ /m, "per-message rows in full");
  assert.doesNotMatch(runCommand(layer, agent, "detail", { language: "en" }).text, /^ {6}s\d+ /m);
});

test("detail layers: numbers right-aligned in one column, CJK counted double", () => {
  assert.equal(displayWidth("折叠"), 4);
  assert.equal(displayWidth("fold"), 4);
  const rows = table([["层", "Tokens"], ["原文", "12.3K"], ["运行时上下文（过期）", "800"]]);
  const ends = rows.map((line) => displayWidth(line));
  assert.equal(new Set(ends).size, 1, `rows end in one column: ${JSON.stringify(rows)}`);
  const { layer, agent } = setup();
  const zh = runCommand(layer, agent, "detail", { language: "zh" }).text.split("\n");
  const start = zh.indexOf("2. 分层（本地估算）");
  const layerRows = zh.slice(start + 1, start + 11);
  assert.equal(new Set(layerRows.map((line) => displayWidth(line))).size, 1, layerRows.join("\n"));
  // In the web view a CJK character is 1em and a Latin one 0.6em, so each row
  // must hold the same number of each kind, not just the same terminal width.
  const kinds = (line) => {
    const wide = [...line].filter((char) => displayWidth(char) === 2).length;
    return `${[...line].length - wide}/${wide}`;
  };
  assert.equal(new Set(layerRows.map(kinds)).size, 1, layerRows.join("\n"));
  const overview = zh.slice(zh.indexOf("1. 概览") + 1, zh.indexOf("1. 概览") + 5).map((line) => line.slice(0, line.search(/ {3}\S/) + 3));
  assert.equal(new Set(overview.map(kinds)).size, 1, overview.join("\n"));
});

test("ledger: running totals per session, net saving from requests since each change", () => {
  resetLedger();
  // 20K re-billed, 10K reclaimed after request 2; 5K re-billed, 5K reclaimed after request 4.
  recordLedger("s-led", { layer: "L2", tokensFromStart: 20_000, reclaimed: 10_000 }, 2);
  recordLedger("s-led", { layer: "L1", tokensFromStart: 5_000, reclaimed: 5_000 }, 4);
  const prices = { priceMiss: 1, priceHit: 0.1 };
  const at4 = readLedger("s-led", 4, prices);
  assert.equal(at4.count, 2);
  assert.deepEqual(at4.byLayer, { L2: 1, L1: 1 });
  assert.equal(at4.rebilled, 25_000);
  assert.equal(at4.reclaimed, 15_000);
  // cost: (20K − 10K) miss × (1 − 0.1); benefit: 10K × 2 requests × 0.1.
  assert.equal(Math.round(at4.cost), 9_000);
  assert.equal(Math.round(at4.benefit), 2_000);
  const at14 = readLedger("s-led", 14, prices);
  // benefit: 10K × 12 + 5K × 10 = 170K hit tokens × 0.1.
  assert.equal(Math.round(at14.benefit), 17_000);
  assert.equal(Math.round(at14.net), 8_000);
  assert.equal(readLedger("other", 10, prices).count, 0);
});

test("ledger is fed by recordChange and shown in detail", () => {
  const { layer, agent, session } = setup();
  layer.recordChange(agent, { layer: "L1", id: "c1", start: 3, tokensFromStart: 40_000, reclaimed: 6_000 });
  const ledger = readLedger(session.id, 0, { priceMiss: 1, priceHit: 0.1 });
  assert.equal(ledger.count, 1);
  assert.equal(ledger.rebilled, 40_000);
  const en = runCommand(layer, agent, "detail", { language: "en" }).text;
  assert.match(en, /Changes landed \(this process\)\s+1  \(L1 1\)/);
  assert.match(en, /Re-billed once \(cumulative\)\s+~40\.0K/);
  assert.match(en, /Reclaimed \(cumulative\)\s+~6\.0K/);
  assert.match(en, /Estimated net saving\s+~−/);
});

test("strata_status (model) output is unchanged English", () => {
  const { layer, agent } = setup();
  setUiLanguage("zh-CN");
  const text = layer.status(agent);
  assert.match(text, /^Strata Context: active \(L1 cards/);
  assert.doesNotMatch(text, /[一-鿿]/);
  setUiLanguage("en");
});

test("translator falls back to English keys and keeps unknown placeholders", () => {
  const t = translator("zh");
  assert.equal(t("detail.changeReclaimed", { tokens: "1K" }), "−1K");
  assert.equal(t("no.such.key"), "no.such.key");
});
