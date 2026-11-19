import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { after, test } from "node:test";
import { addAssistantText, addToolRound, addUser, fakeAgent, fakeContext, FakeSession, filler } from "./helpers/fake-dsh.mjs";

// Never the user's ~/.dsh: the state file and archives go to a temp home.
const root = mkdtempSync(join(tmpdir(), "strata-plain-"));
process.env.DSH_HOME = join(root, "home");
process.env.STRATA_SHADOW_DIR = join(root, "archive");
delete process.env.DSH_PROFILE;

const { default: Engine } = await import("../index.js");
const { localizeOutcome, localizeRejection, runCommand, translator } = await import("../lib/command.js");
const { recordActivity, recordActivityError, recordActivityRejection, recordUsage, resetActivity } = await import("../lib/activity.js");
const { recordLedger, resetLedger } = await import("../lib/ledger.js");
const { readSettings } = await import("../lib/settings.js");
const { plainPct, plainStatus } = await import("../lib/plain.js");
const { profileName, readState, resetIntroMemory, stateFile, takeIntro } = await import("../lib/state.js");
const { statusPayload } = await import("../lib/gui-routes.js");
const { landingGate, estimateFold } = await import("../lib/economics.js");
const { setTakeover } = await import("../lib/takeover.js");

after(() => rmSync(root, { recursive: true, force: true }));

const zh = translator("zh");
const en = translator("en");

test("rejection reasons: every English form has zh and en text; unknown text stays as written", () => {
  const small = landingGate({ estimate: { reclaimed: 1200 }, minTokens: 2000 }).reason;
  assert.equal(localizeRejection(small, zh), "回收太少：只有约 1.2K，低于每次至少 2.0K 的下限");
  assert.equal(localizeRejection(small, en), "too little to reclaim: ~1.2K, below the 2.0K minimum per landing");
  const estimate = estimateFold({ tokensFromStart: 90_000, reclaimed: 3000, remainingRequests: 4, priceMiss: 1, priceHit: 0.1 });
  const payback = landingGate({ estimate, minTokens: 2000, remainingRequests: 4, maxPayback: 30 }).reason;
  assert.match(payback, /pays back after ~\d+ requests, more than the ~4 allowed \(requests expected to remain\)/);
  assert.match(localizeRejection(payback, zh), /^不划算：要重新计费约 87\.0K，\d+ 次请求后才回本，超过允许的约 4 次（预计剩下的请求数）$/);
  assert.match(localizeRejection(payback, en), /^not worth it: ~87\.0K would be re-billed and it pays back only after \d+ requests, more than the ~4 allowed \(requests expected to remain\)$/);
  assert.equal(localizeRejection("the cache miss on ~5.0K tokens pays back after never requests", zh), "不划算：要重新计费约 5.0K，永远回不了本");
  assert.equal(localizeRejection("the card (~1.5K tokens) is not smaller than the span (~1.2K tokens)", zh), "卡片（约 1.5K）不比原文（约 1.2K）小");
  assert.equal(localizeRejection("summary is not smaller than the shadowed content (900 >= 800)", zh), "摘要（900）不比被替换的内容（800）小");
  assert.equal(localizeRejection("fold is not smaller than its range (900 >= 800)", zh), "折叠后（900）不比原范围（800）小");
  assert.equal(localizeRejection("the selected span is no longer on the surface", zh), "选中的范围已经不在上下文里了");
  // Automatic digests: the compress reply with its range prefix and advice.
  const autoReject = "s00010–s00020: this fold reclaims only ~900 tokens, below the 2.0K minimum per landing; pick a larger range (strata_status lists the foldable runs) or leave it";
  assert.equal(localizeRejection(autoReject, zh), "s00010–s00020: 回收太少：只有约 900，低于每次至少 2.0K 的下限；可以选更大的范围，或者不折");
  assert.equal(localizeOutcome(`skipped (rejected: ${autoReject})`, zh), "跳过（被拒绝：s00010–s00020: 回收太少：只有约 900，低于每次至少 2.0K 的下限；可以选更大的范围，或者不折）");
  assert.match(localizeOutcome("proposed f2, not landed (cache cost: reclaim ~3.0K tokens; one-time cache miss on ~87.0K tokens; pays back after ~29 requests)", zh), /缓存成本不划算：可回收约 3\.0K；一次性缓存未命中约 87\.0K；29 次请求后回本/);
  assert.equal(localizeRejection("something new", zh), "something new");
});

test("plain line: waiting, idle, early (net below zero), saved; numbers are the ledger's", () => {
  resetActivity();
  resetLedger();
  const settings = readSettings({}, {});
  const id = "plain-a";
  assert.equal(plainStatus(id, zh, { settings }).line, "Strata 待命");
  recordUsage(id, { totalTokens: 39_000, window: 1_000_000, requests: 3, route: { maxTokens: 16_000 } });
  const idle = plainStatus(id, zh, { settings });
  assert.equal(idle.line, "Strata · 上下文 3.9%，还没整理过");
  assert.deepEqual(idle.hover, [
    "最近：还没有整理过。",
    "现在：上下文用了约 3.9%（39.0K / 1000.0K）",
    "下次：涨到约 50% 时先提醒模型折叠；提醒 2 次没回应，或涨到 60%，就在轮末自动整理",
  ]);
  // A fold lands at request 3: 52.5K re-billed, 38.5K reclaimed (the Mac run's numbers).
  recordActivity(id, { layer: "L2", id: "f3,f2,f1", reclaimed: 38_500, tier: 1, auto: true });
  recordLedger(id, { layer: "L2", id: "f3,f2,f1", tokensFromStart: 52_500, reclaimed: 38_500, remainingRequests: 4 }, 3);
  const early = plainStatus(id, zh, { settings });
  assert.equal(early.line, "Strata · 已整理 1 次，约 4 次请求后开始省");
  assert.match(early.hover[0], /^最近：\d\d:\d\d 自动把 3 段较早的内容折成了摘要，腾出约 38\.5K$/);
  assert.equal(early.hover[3], "累计腾出约 38.5K；「已省」按缓存价格折算，扣掉了重新计费（细节见 /strata detail）");
  assert.equal(plainStatus(id, en, { settings }).line, "Strata · tidied 1×, saving starts in ~4 requests");
  // 40 requests later the saving is well past the re-billing.
  recordUsage(id, { totalTokens: 120_000, window: 1_000_000, requests: 43, route: { maxTokens: 16_000 } });
  const saved = plainStatus(id, zh, { settings });
  // net = 38.5K × 40 × 0.1 − 14K × 0.9 = 154K − 12.6K
  assert.equal(saved.line, "Strata · 本会话已省约 141.4K（1 次整理）");
  assert.equal(plainStatus(id, en, { settings }).line, "Strata · ~141.4K saved this session (tidied 1×)");
  assert.equal(plainPct(0.184), "18%");
  // After a restart the ledger is empty but the conversation still holds folds.
  recordUsage("plain-restart", { totalTokens: 38_300, window: 1_000_000, requests: 1, tiers: [1, 1, 0], cards: 0 });
  const restarted = plainStatus("plain-restart", zh, { settings });
  assert.equal(restarted.line, "Strata · 上下文 3.8%，本次启动后还没整理");
  assert.equal(restarted.hover[0], "最近：本次启动后还没有整理；对话里已有 2 个折叠、0 张卡片。");
});

test("plain hover: rejection after the last landing, failure first; next line follows nudges, auto fold and mid-turn", () => {
  resetActivity();
  resetLedger();
  const id = "plain-b";
  recordUsage(id, { totalTokens: 300_000, window: 1_000_000, requests: 5, route: { maxTokens: 16_000 } });
  recordActivityRejection(id, "L1", "reclaims only ~1.2K tokens, below the 2.0K minimum per landing", { id: "cut-1" });
  const cost = readSettings({}, {});
  const rejected = plainStatus(id, zh, { settings: cost });
  assert.match(rejected.hover.at(-1), /^\d\d:\d\d 有一次切卡片没做：回收太少：只有约 1\.2K，低于每次至少 2\.0K 的下限（校验拦下的，不算失败）$/);
  assert.match(plainStatus(id, en, { settings: cost }).hover.at(-1), /a card was skipped: too little to reclaim/);
  recordActivityError(id, "L2", "boom", { id: "f1" });
  assert.match(plainStatus(id, zh, { settings: cost }).hover.at(-1), /^\d\d:\d\d 折叠失败：boom/);

  const next = (settings, total = 300_000) => {
    recordUsage(id, { totalTokens: total, window: 1_000_000, requests: 5, route: { maxTokens: 16_000 } });
    return plainStatus(id, zh, { settings }).hover[2];
  };
  assert.equal(next(readSettings({}, { nudge: false })), "下次：涨到约 50% 时，会在这一轮结束时整理");
  assert.equal(next(readSettings({}, { autoFold: false })), "下次：自动整理已关，只靠模型自己折叠和 DSH 官方摘要");
  assert.equal(next(readSettings({}, { mode: "quality" })), "下次：已过整理线 25%，这一轮结束时会按需整理；一轮中途超过 35% 也会先整理");
  // DeepSeek V4 (384K output reservation): both lines lowered to 50%, one line, no nudge stage.
  recordUsage(id, { totalTokens: 100_000, window: 1_000_000, requests: 5, route: { maxTokens: 384_000 } });
  assert.equal(plainStatus(id, zh, { settings: cost }).hover[2], "下次：涨到约 50% 时，会在这一轮结束时整理");
});

test("first-run note: once per profile, kept in <DSH_HOME>/strata/state.json, survives a restart, delete the file to reset", () => {
  resetIntroMemory();
  const file = stateFile();
  assert.equal(file, join(root, "home", "strata", "state.json"));
  assert.equal(profileName({}, ["node", "dsh", "--profile", "web"]), "web");
  assert.equal(profileName({}, ["node", "dsh", "--profile=desktop"]), "desktop");
  assert.equal(profileName({ DSH_PROFILE: "x" }, []), "x");
  assert.equal(takeIntro({ profile: "web" }), true);
  assert.equal(takeIntro({ profile: "web" }), false, "same process");
  resetIntroMemory();
  assert.equal(takeIntro({ profile: "web" }), false, "after a restart");
  assert.equal(takeIntro({ profile: "desktop" }), true, "another profile gets its own");
  assert.ok(readState().intro.web && readState().intro.desktop);
  assert.doesNotMatch(readFileSync(file, "utf8"), /cordis/);
  rmSync(file);
  resetIntroMemory();
  assert.equal(takeIntro({ profile: "web" }), true, "deleting the file resets it");
  // A broken file is treated as empty, not as an error.
  writeFileSync(file, "{not json");
  resetIntroMemory();
  assert.equal(takeIntro({ profile: "web" }), true);
});

test("status payload: plain text in the dock's language; the note only after a turn end with Strata in charge, once", () => {
  resetActivity();
  resetLedger();
  resetIntroMemory();
  rmSync(stateFile(), { force: true });
  setTakeover("active");
  const id = "plain-c";
  const first = statusPayload(id, "1", { language: "zh" });
  assert.equal(first.plain.line, "Strata 待命");
  assert.equal(first.intro, undefined, "no turn end yet");
  assert.equal(existsSync(stateFile()), false);
  recordUsage(id, { totalTokens: 20_000, window: 1_000_000, requests: 1 });
  const shown = statusPayload(id, "1", { language: "zh" });
  assert.equal(shown.intro.text, "Strata 已在工作：当前是成本优先。可以在 插件 → Strata 分层上下文 → Strata 设置 里调整。");
  assert.equal(shown.intro.close, "知道了");
  assert.equal(statusPayload(id, "1", { language: "zh" }).intro, undefined, "only once");
  resetIntroMemory();
  assert.equal(statusPayload("plain-d", "1", { language: "en" }).intro, undefined, "not again after a restart or in a new session");
  resetIntroMemory();
  rmSync(stateFile());
  recordUsage("plain-e", { totalTokens: 1, window: 1_000_000 });
  assert.match(statusPayload("plain-e", "1", { language: "en" }).intro.text, /^Strata is working: mode Cost first\. Change it in Plugins → Strata Context → Strata settings\.$/);
  resetIntroMemory();
  rmSync(stateFile());
  setTakeover("stock", "test");
  assert.equal(statusPayload("plain-e", "1", { language: "en" }).intro, undefined, "not when Strata is not in charge");
  setTakeover("active");
});

test("nudges off: the rule says the turn end does not wait for reminders, and the engine does not wait either", async () => {
  const ctx = fakeContext({ contextWindow: 1_000_000 });
  const engine = new Engine(ctx, {});
  const session = new FakeSession({ id: "plain-nudge", cwd: join(root, "work") });
  const agent = fakeAgent(session);
  addUser(session, "Task one.");
  for (let i = 0; i < 6; i += 1) addToolRound(session, { command: `cat ${i}`, output: filler(`out-${i}`, 6000) });
  addAssistantText(session, "Done.");
  addUser(session, "Task two.");
  for (let i = 0; i < 3; i += 1) addToolRound(session, { command: `ls ${i}`, output: filler(`ls-${i}`, 400) });
  const layer = engine.strataLayer;
  const base = layer.settings;
  layer.settings = { ...base, nudge: false, autoFoldPct: 0.005, autoFoldForcePct: 0.9, autoFoldTargetPct: 0.002 };
  const text = runCommand(layer, agent, "detail", { language: "zh" }).text;
  assert.match(text, /规则[\s　]+轮末超过 0.5% 时（提醒模型折叠已关，不等提醒），从最早的内容开始折叠/);
  assert.doesNotMatch(text, /连续 2 次提醒/);
  assert.match(runCommand(layer, agent, "detail", { language: "en" }).text, /at turn end above 0.5% \(reminders are off, so no waiting for them\)/);
  assert.match(layer.status(agent), /above 0.5% \(nudges off: no waiting for them\)/);
  // Above the lower line with no nudge ever sent, the turn end folds anyway.
  assert.equal(layer.state(agent).unanswered || 0, 0);
  const ids = layer.autoFold(agent);
  assert.ok(ids.length > 0, layer.state(agent).lastAutoFold?.outcome);
  // With nudges on, the same state waits for them.
  layer.state(agent).pending = [];
  layer.settings = { ...base, nudge: true, autoFoldPct: 0.005, autoFoldForcePct: 0.9, autoFoldTargetPct: 0.002 };
  assert.deepEqual(layer.autoFold(agent), []);
  assert.match(layer.state(agent).lastAutoFold.outcome, /0 of 2 unanswered nudges/);
  layer.settings = base;
});

test("dock client: the plain line by default; landing label, red failure, grey unavailable and not-active win over it", () => {
  let mod;
  const window = { __ModuleLoader__: { load: ({ factory }) => { mod = factory(() => ({ createElement() {}, useEffect() {}, useLayoutEffect() {}, useRef() {}, useState() {} })); } } };
  runInNewContext(readFileSync(new URL("../client.js", import.meta.url), "utf8"), { window });
  const { dockState, zh: dict } = mod.__test;
  const t = (key) => dict[key] ?? key;
  const now = 1_000_000;
  const plain = { line: "Strata · 本会话已省约 120K（3 次整理）", hover: ["最近：…", "现在：…", "下次：…"] };
  const data = { takeover: "active", now, usage: { totalTokens: 1, window: 10 }, plain };
  const idle = dockState(t, { data, misses: 0, play: null, now });
  assert.equal(JSON.stringify([idle.state, idle.label, idle.hover]), JSON.stringify(["idle", plain.line, plain.hover]));
  const success = dockState(t, { data, misses: 0, play: { event: { layer: "L2", tier: 1, reclaimed: 38500, auto: true }, until: now + 1 }, now });
  assert.deepEqual([success.state, success.label], ["success", "自动折叠 T1 −38.5K"]);
  const red = dockState(t, { data: { ...data, error: { layer: "L2", at: now - 1000 } }, misses: 0, play: null, now });
  assert.deepEqual([red.state, red.label, red.hover[0]], ["error", "折叠失败", dict.errorTitle]);
  const grey = dockState(t, { data, misses: 2, play: null, now });
  assert.equal(JSON.stringify([grey.state, grey.label, grey.hover]), JSON.stringify(["unavailable", "状态暂不可用", [dict.unavailableTitle]]));
  const off = dockState(t, { data: { ...data, takeover: "stock" }, misses: 0, play: null, now });
  assert.equal(JSON.stringify([off.state, off.label, off.hover]), JSON.stringify(["off", "Strata 未接管", []]));
  // An older server without `plain` keeps the old short label.
  assert.equal(dockState(t, { data: { takeover: "active", usage: { totalTokens: 39, window: 1000 } }, misses: 0, play: null, now }).label, "Strata 3.9%");
});
