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
const { plainPct, plainStatus, plainTokens } = await import("../lib/plain.js");
const { ackIntro, introMarker, introPending, profileName, resetIntroMemory, stateDir } = await import("../lib/state.js");
const { statSync, readdirSync } = await import("node:fs");
const { GUI_INTRO_ACK_PATH, registerGuiRoutes, statusPayload } = await import("../lib/gui-routes.js");
const { listSessionArchives } = await import("../lib/archive.js");
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
  const waiting = plainStatus(id, zh, { settings });
  assert.deepEqual([waiting.kind, waiting.short, waiting.line], ["waiting", "待命", "Strata 待命"]);
  assert.equal(plainStatus(id, en, { settings }).short, "Ready");
  recordUsage(id, { totalTokens: 39_000, window: 1_000_000, requests: 3, route: { maxTokens: 16_000 } });
  const idle = plainStatus(id, zh, { settings });
  assert.deepEqual([idle.kind, idle.short, idle.line], ["idle", "上下文 3.9%", "上下文 3.9%，还没整理过"]);
  assert.deepEqual(idle.hover, [
    "最近：还没有整理过。",
    "现在：上下文用了约 3.9%（39.0K / 1.0M）",
    "下次：涨到约 50% 时先提醒模型折叠；提醒 2 次没回应，或涨到 60%，就在轮末自动整理",
  ]);
  assert.deepEqual([idle.last, idle.details, idle.rejection, idle.error], [idle.hover[0], idle.hover.slice(1), null, null], "hover split for the card");
  // A fold lands at request 3: 52.5K re-billed, 38.5K reclaimed (the Mac run's numbers).
  recordActivity(id, { layer: "L2", id: "f3,f2,f1", reclaimed: 38_500, tier: 1, auto: true });
  recordLedger(id, { layer: "L2", id: "f3,f2,f1", tokensFromStart: 52_500, reclaimed: 38_500, remainingRequests: 4 }, 3);
  const early = plainStatus(id, zh, { settings });
  assert.deepEqual([early.kind, early.short, early.line], ["early", "已整理 1 次", "已整理 1 次，约 4 次请求后开始省"]);
  assert.match(early.hover[0], /^最近：\d\d:\d\d 自动把较早的内容折成了摘要，腾出约 38\.5K$/);
  assert.equal(early.hover[3], "累计腾出约 38.5K；「已省」按缓存价格折算，扣掉了重新计费（细节见 /strata detail）");
  assert.deepEqual([plainStatus(id, en, { settings }).short, plainStatus(id, en, { settings }).line], ["Tidied 1×", "Tidied 1×, saving starts in ~4 requests"]);
  // 40 requests later the saving is well past the re-billing.
  recordUsage(id, { totalTokens: 120_000, window: 1_000_000, requests: 43, route: { maxTokens: 16_000 } });
  const saved = plainStatus(id, zh, { settings });
  // net = 38.5K × 40 × 0.1 − 14K × 0.9 = 154K − 12.6K
  assert.deepEqual([saved.kind, saved.short, saved.line], ["saved", "已省 141.4K", "本会话已省约 141.4K（1 次整理）"]);
  assert.deepEqual([plainStatus(id, en, { settings }).short, plainStatus(id, en, { settings }).line], ["Saved 141.4K", "~141.4K saved this session (tidied 1×)"]);
  assert.equal(plainPct(0.184), "18.4%", "same one-decimal rounding as /strata detail");
  // After a restart the ledger is empty but the conversation still holds folds.
  recordUsage("plain-restart", { totalTokens: 38_300, window: 1_000_000, requests: 1, tiers: [1, 1, 0], cards: 0 });
  const restarted = plainStatus("plain-restart", zh, { settings });
  assert.deepEqual([restarted.short, restarted.line], ["上下文 3.8%", "上下文 3.8%，本次启动后还没整理"]);
  assert.equal(restarted.hover[0], "最近：本次启动后还没有整理；对话里已有 2 个折叠、0 张卡片。");
});

test("plain numbers: at most one decimal, M from a million; short texts stay within 12 CJK characters", () => {
  assert.deepEqual(
    [0, 999, 1000, 20_000, 31_540, 999_949, 999_950, 1_000_000, 1_393_000, 12_345_678, -1500, Infinity].map(plainTokens),
    ["0", "999", "1.0K", "20.0K", "31.5K", "999.9K", "1.0M", "1.0M", "1.4M", "12.3M", "-1.5K", "∞"],
  );
  resetActivity();
  resetLedger();
  const settings = readSettings({}, {});
  const id = "plain-big";
  recordUsage(id, { totalTokens: 230_000, window: 1_000_000, requests: 3 });
  recordActivity(id, { layer: "L2", id: "f1", reclaimed: 700_000, tier: 1, auto: true });
  recordLedger(id, { layer: "L2", id: "f1", tokensFromStart: 100_000, reclaimed: 700_000, remainingRequests: 40 }, 3);
  recordUsage(id, { totalTokens: 230_000, window: 1_000_000, requests: 40 });
  const big = plainStatus(id, zh, { settings });
  assert.equal(big.kind, "saved");
  assert.match(big.short, /^已省 \d+\.\dM$/);
  assert.match(big.line, /^本会话已省约 \d+\.\dM（1 次整理）$/);
  assert.doesNotMatch(big.line, /\d{4}\.\dK/, "no 1393.0K");
  const cjk = (text) => [...text].filter((ch) => /[\u3000-\u9fff\uff00-\uffef]/.test(ch)).length;
  for (const text of [big.short, "已整理 1 次", "上下文 23.4%", "待命"]) assert.ok(cjk(text) <= 12, text);
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
  recordActivityError(id, "L2", "Error: ENOSPC write failed", { id: "f1" });
  const failed = plainStatus(id, zh, { settings: cost }).hover.at(-1);
  assert.match(failed, /^\d\d:\d\d 折叠失败（原因见 \/strata detail）$/);
  assert.doesNotMatch(failed, /ENOSPC/, "no raw English error in the hover");
  recordActivityError(id, "L1", "timeout", { timeout: true });
  assert.match(plainStatus(id, zh, { settings: cost }).hover.at(-1), /^\d\d:\d\d 切卡片超时没完成/);

  const next = (settings, total = 300_000, extra = {}) => {
    recordUsage(id, { totalTokens: total, window: 1_000_000, requests: 5, route: { maxTokens: 16_000 }, ...extra });
    return plainStatus(id, zh, { settings }).hover[2];
  };
  // Cost mode at 55%: past the 50% line but reminders are on and none went unanswered yet.
  assert.equal(next(cost, 550_000), "下次：已过 50%，再有 2 次提醒没回应，或涨到 60%，就在轮末整理");
  assert.equal(next(cost, 550_000, { unanswered: 1 }), "下次：已过 50%，再有 1 次提醒没回应，或涨到 60%，就在轮末整理");
  assert.equal(next(cost, 550_000, { unanswered: 2 }), "下次：已过整理线 50%，这一轮结束时会按需整理");
  assert.equal(next(cost, 620_000), "下次：已过整理线 50%，这一轮结束时会按需整理", "above the force line no reminders are needed");
  // After a digest that folded all it could, the next waits for 50K more foldable work (or 75%).
  assert.equal(next(cost, 620_000, { autoExhausted: true, autoFoldedAt: 100_000, foldable: 120_000, scale: 1 }), "下次：刚整理过，要等新内容再积累约 50.0K（目前约 20.0K），或占用涨到 75%（兜底线），才会在轮末再整理");
  // Both sides by the provider's count: l2.js compares local growth with 50K / scale; 20K local × 1.2 = 24K.
  assert.equal(next(cost, 620_000, { autoExhausted: true, autoFoldedAt: 100_000, foldable: 120_000, scale: 1.2 }), "下次：刚整理过，要等新内容再积累约 50.0K（目前约 24.0K），或占用涨到 75%（兜底线），才会在轮末再整理");
  assert.equal(next(cost, 620_000, { autoExhausted: true, autoFoldedAt: 100_000, foldable: 142_000, scale: 1.2 }), "下次：已过整理线 50%，这一轮结束时会按需整理", "42K local × 1.2 = 50.4K: past the step");
  recordUsage(id, { totalTokens: 620_000, window: 1_000_000, requests: 5, route: { maxTokens: 16_000 }, autoExhausted: true, autoFoldedAt: 100_000, foldable: 120_000, scale: 1 });
  assert.equal(plainStatus(id, en, { settings: cost }).hover[2], "Next: just tidied; it tidies again at turn end once about 50.0K of new content builds up (about 20.0K so far), or usage reaches 75% (the fallback line)");
  assert.equal(next(cost, 620_000, { autoExhausted: true, autoFoldedAt: 100_000, foldable: 160_000, scale: 1 }), "下次：已过整理线 50%，这一轮结束时会按需整理");
  assert.match(plainStatus(id, en, { settings: cost }).hover[2], /^Next: past the 50% line/);
  assert.equal(next(cost, 550_000, { unanswered: 0 }).length > 0, true);
  assert.equal(next(readSettings({}, { nudge: false })), "下次：涨到约 50% 时，会在这一轮结束时整理");
  assert.equal(next(readSettings({}, { autoFold: false })), "下次：自动整理已关，只靠模型自己折叠和 DSH 官方摘要");
  assert.equal(next(readSettings({}, { mode: "quality" })), "下次：已过 25%，再有 2 次提醒没回应，或涨到 35%，就在轮末整理；一轮中途超过 35% 也会先整理");
  assert.equal(next(readSettings({}, { mode: "quality", nudge: false })), "下次：已过整理线 25%，这一轮结束时会按需整理；一轮中途超过 35% 也会先整理");
  // DeepSeek V4 (384K output reservation): both lines lowered to 50%, one line, no nudge stage.
  recordUsage(id, { totalTokens: 100_000, window: 1_000_000, requests: 5, route: { maxTokens: 384_000 } });
  assert.equal(plainStatus(id, zh, { settings: cost }).hover[2], "下次：涨到约 50% 时，会在这一轮结束时整理");
});

test("first-run note: offered until acknowledged; one marker per profile under <DSH_HOME>/strata/.state, 0700, ignored by the archive list", () => {
  resetIntroMemory();
  const dir = stateDir();
  assert.equal(dir, join(root, "home", "strata", ".state"));
  assert.equal(profileName({}, ["node", "dsh", "--profile", "web"]), "web");
  assert.equal(profileName({}, ["node", "dsh", "--profile=desktop"]), "desktop");
  assert.equal(profileName({ DSH_PROFILE: "x" }, []), "x");
  assert.equal(profileName({ DSH_PROFILE_DIR: "/h/profiles/desk" }, []), "desk");
  assert.equal(profileName({}, []), "default");
  assert.equal(profileName({ DSH_PROFILE: "x" }, ["--profile", "web"], { name: "desktop", dir: "/h/profiles/desktop" }), "desktop", "DSH's profileContext wins");
  assert.equal(profileName({}, [], { dir: "/h/profiles/desk/" }), "desk");
  assert.equal(introPending({ profile: "web" }), true);
  assert.equal(introPending({ profile: "web" }), true, "offering writes nothing");
  assert.equal(existsSync(dir), false);
  assert.deepEqual(ackIntro({ profile: "web" }), { ok: true });
  assert.equal(introPending({ profile: "web" }), false, "same process");
  resetIntroMemory();
  assert.equal(introPending({ profile: "web" }), false, "after a restart");
  assert.equal(introPending({ profile: "desktop" }), true, "another profile gets its own");
  assert.deepEqual(ackIntro({ profile: "web" }), { ok: true }, "a second ack (another tab) is fine");
  if (process.platform !== "win32") assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.match(introMarker("a:b*?", dir), /intro-a%3Ab%2A%3F$/, "safe file names on Windows");
  assert.deepEqual(readdirSync(dir), ["intro-web"], "one marker, no temp files");
  assert.deepEqual(listSessionArchives(join(root, "home", "strata")), [], "not taken for a session archive");
  rmSync(introMarker("web", dir));
  resetIntroMemory();
  assert.equal(introPending({ profile: "web" }), true, "deleting the marker resets it");
  // Unwritable: reported, and not offered again in this process.
  resetIntroMemory();
  const blocked = join(root, "blocked");
  writeFileSync(blocked, "a file where the folder should be");
  assert.equal(ackIntro({ profile: "web", dir: blocked }).ok, false);
  assert.equal(introPending({ profile: "web", dir: blocked }), false);
});

test("status payload and ack route: the note is offered after a turn end with Strata in charge, recorded only on the dock's POST", () => {
  resetActivity();
  resetLedger();
  resetIntroMemory();
  rmSync(stateDir(), { recursive: true, force: true });
  setTakeover("active");
  const id = "plain-c";
  const first = statusPayload(id, "1", { language: "zh" });
  assert.equal(first.plain.line, "Strata 待命");
  assert.equal(first.intro, undefined, "no turn end yet");
  recordUsage(id, { totalTokens: 20_000, window: 1_000_000, requests: 1 });
  const shown = statusPayload(id, "1", { language: "zh" });
  assert.equal(shown.intro.text, "Strata 已在工作：当前是成本优先。可以在 插件 → Strata 分层上下文 → Strata 设置 里调整。");
  assert.equal(shown.intro.close, "知道了");
  assert.ok(statusPayload(id, "1", { language: "zh" }).intro, "still offered: a dropped response or an unmounted dock does not lose it");
  assert.equal(existsSync(stateDir()), false, "nothing written before the ack");
  assert.match(statusPayload(id, "1", { language: "en" }).intro.text, /^Strata is working: mode Cost first\. Change it in Plugins → Strata Context → Strata settings\.$/);

  const routes = [];
  const warnings = [];
  const child = {
    webServer: { register(route) { routes.push(route); return () => {}; } },
    get(name) { return name === "connection" ? { requestRejection: (req) => (req.headers?.bad ? 403 : undefined) } : undefined; },
    effect(fn) { fn(); },
    logger: { warn: (text) => warnings.push(text) },
  };
  registerGuiRoutes({ inject(_names, fn) { fn(child); } }, "1");
  const ack = routes.find((route) => route.path === GUI_INTRO_ACK_PATH);
  const call = (method, headers = {}) => {
    const res = { headers: {}, statusCode: 0, body: "", setHeader(k, v) { this.headers[k] = v; }, end(b = "") { this.body = b; } };
    ack.handler({ url: GUI_INTRO_ACK_PATH, method, headers, resume() {} }, res);
    return res;
  };
  assert.equal(call("GET").statusCode, 405);
  assert.equal(call("POST", { bad: 1 }).statusCode, 403, "behind the same request fence");
  assert.equal(existsSync(stateDir()), false);
  const ok = call("POST");
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(JSON.parse(ok.body), { ok: true });
  assert.equal(statusPayload(id, "1", { language: "zh" }).intro, undefined, "acknowledged");
  resetIntroMemory();
  assert.equal(statusPayload("plain-d", "1", { language: "en" }).intro, undefined, "not again after a restart or in a new session");
  rmSync(stateDir(), { recursive: true, force: true });
  resetIntroMemory();
  setTakeover("stock", "test");
  assert.equal(statusPayload(id, "1", { language: "en" }).intro, undefined, "not when Strata is not in charge");
  setTakeover("active");
  assert.deepEqual(warnings, []);
});

test("intro ack: the profile comes from DSH's profileContext, not the environment", () => {
  resetIntroMemory();
  rmSync(stateDir(), { recursive: true, force: true });
  const routes = [];
  const child = {
    webServer: { register(route) { routes.push(route); return () => {}; } },
    get(name) { return name === "profileContext" ? { name: "desk-x", dir: "/h/profiles/desk-x" } : undefined; },
    effect(fn) { fn(); },
  };
  registerGuiRoutes({ inject(_names, fn) { fn(child); } }, "1");
  const ack = routes.find((route) => route.path === GUI_INTRO_ACK_PATH);
  const res = { headers: {}, statusCode: 0, body: "", setHeader(k, v) { this.headers[k] = v; }, end(b = "") { this.body = b; } };
  ack.handler({ url: GUI_INTRO_ACK_PATH, method: "POST", headers: {}, resume() {} }, res);
  assert.equal(res.statusCode, 200);
  assert.ok(existsSync(introMarker("desk-x")), "marker named after profileContext.name");
  assert.deepEqual(readdirSync(stateDir()), ["intro-desk-x"]);
  rmSync(stateDir(), { recursive: true, force: true });
  resetIntroMemory();
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
  // With nudges on, the same state waits for them, and the dock's hover says so (same conditions).
  layer.state(agent).pending = [];
  layer.settings = { ...base, nudge: true, autoFoldPct: 0.005, autoFoldForcePct: 0.9, autoFoldTargetPct: 0.002 };
  const hoverNext = async () => {
    await engine.publishUsage(agent);
    return plainStatus(session.id, zh, { settings: layer.settings }).hover[2];
  };
  assert.match(await hoverNext(), /^下次：已过 0\.5%，再有 2 次提醒没回应，或涨到 75%，就在轮末整理$/);
  assert.deepEqual(layer.autoFold(agent), []);
  assert.match(layer.state(agent).lastAutoFold.outcome, /0 of 2 unanswered nudges/);
  layer.state(agent).unanswered = 2;
  assert.match(await hoverNext(), /^下次：已过整理线 0\.5%，这一轮结束时会按需整理$/);
  assert.ok(layer.autoFold(agent).length > 0, "and the engine folds");
  layer.settings = base;
});

function loadClient() {
  let mod;
  const window = { __ModuleLoader__: { load: ({ factory }) => { mod = factory(() => ({ createElement() {}, useEffect() {}, useLayoutEffect() {}, useRef() {}, useState() {} })); } } };
  runInNewContext(readFileSync(new URL("../client.js", import.meta.url), "utf8"), { window });
  return mod.__test;
}

test("dock client: short status by default, full sentence with details on; red failure, grey unavailable and not-active win", () => {
  const { dockState, zh: dict } = loadClient();
  const t = (key) => dict[key] ?? key;
  const now = 1_000_000;
  const plain = { kind: "saved", short: "已省 120.0K", line: "本会话已省约 120.0K（3 次整理）", hover: ["最近：…", "现在：…", "下次：…"], last: "最近：…", details: ["现在：…", "下次：…"] };
  const data = { takeover: "active", now, usage: { totalTokens: 1, window: 10 }, plain };
  const idle = dockState(t, { data, misses: 0, play: null, now });
  assert.equal(JSON.stringify([idle.state, idle.label, idle.full, idle.last, idle.hover]), JSON.stringify(["idle", "已省 120.0K", plain.line, "最近：…", plain.details]));
  const on = dockState(t, { data: { ...data, dockDetails: true }, misses: 0, play: null, now });
  assert.deepEqual([on.label, on.full, on.details], [plain.line, plain.line, true], "details on: the full sentence all the time");
  const success = dockState(t, { data, misses: 0, play: { event: { layer: "L2", tier: 1, reclaimed: 38500, auto: true }, until: now + 1 }, now });
  assert.deepEqual([success.state, success.label], ["success", "已省 120.0K"], "blue after a landing; the text is the notice's job");
  const red = dockState(t, { data: { ...data, error: { layer: "L2", at: now - 1000 }, plain: { ...plain, error: { at: now - 1000, text: "14:31 折叠失败（原因见 /strata detail）" } } }, misses: 0, play: null, now });
  assert.deepEqual([red.state, red.label, red.full, red.hover[0]], ["error", "折叠失败", "14:31 折叠失败（原因见 /strata detail）", dict.errorTitle]);
  const grey = dockState(t, { data, misses: 2, play: null, now });
  assert.equal(JSON.stringify([grey.state, grey.label, grey.hover]), JSON.stringify(["unavailable", "状态暂不可用", [dict.unavailableTitle]]));
  const off = dockState(t, { data: { ...data, takeover: "stock" }, misses: 0, play: null, now });
  assert.equal(JSON.stringify([off.state, off.label, off.full, off.hover]), JSON.stringify(["off", "未接管", "Strata 未接管这个会话", []]));
  assert.equal(dockState(t, { data: { takeover: "active" }, misses: 0, play: null, now }).label, "待命");
  // An older server without `plain` gets a short label without the product name.
  assert.equal(dockState(t, { data: { takeover: "active", usage: { totalTokens: 39, window: 1000 } }, misses: 0, play: null, now }).label, "上下文 3.9%");
  for (const key of ["waiting", "notActive", "errorFold", "errorCard", "unavailable"]) assert.ok([...dict[key]].length <= 12, key);
});

test("dock client: a new notice stays 8 s, a newer one replaces it, hover pauses, a failure stays red", () => {
  const { dockState, startDwell, pauseDwell, resumeDwell, dwellActive, SHOW_MS, zh: dict } = loadClient();
  assert.equal(SHOW_MS, 8000);
  const t = (key) => dict[key] ?? key;
  const now = 5_000_000;
  const plain = { kind: "saved", short: "已省 1.4M", line: "本会话已省约 1.4M（3 次整理）", details: [] };
  const data = { takeover: "active", now, plain };
  const notice = { kind: "landing", at: now, text: plain.line, entry: "…" };
  let dwell = startDwell(notice, now);
  assert.equal(dockState(t, { data, misses: 0, play: null, now: now + 7999, dwell }).label, plain.line, "on show for 8 s");
  assert.equal(dockState(t, { data, misses: 0, play: null, now: now + 8000, dwell }).label, "已省 1.4M", "then back to the short status");
  // A newer notice replaces it and starts the 8 s again.
  const newer = { kind: "rejection", at: now + 5000, text: "14:32 有一次折叠没做：…", entry: "…" };
  dwell = startDwell(newer, now + 5000);
  assert.equal(dockState(t, { data, misses: 0, play: null, now: now + 12_000, dwell }).label, newer.text);
  assert.equal(dockState(t, { data, misses: 0, play: null, now: now + 13_000, dwell }).label, "已省 1.4M");
  // Hover / focus pauses the countdown; leaving resumes it with the time left.
  dwell = startDwell(notice, now);
  dwell = pauseDwell(dwell, now + 3000);
  assert.equal(dwell.left, 5000);
  assert.ok(dwellActive(dwell, now + 60_000), "paused: still on show however long");
  dwell = resumeDwell(dwell, now + 60_000);
  assert.ok(dwellActive(dwell, now + 64_999));
  assert.ok(!dwellActive(dwell, now + 65_000));
  assert.equal(pauseDwell(startDwell(notice, now), now + 9000), null, "pausing a notice already over clears it");
  const pausedStart = startDwell(notice, now, true);
  assert.ok(dwellActive(pausedStart, now + 30_000), "a notice arriving while hovered waits for the pointer to leave");
  // Details on: no notice on show, the full sentence anyway.
  const on = dockState(t, { data: { ...data, dockDetails: true }, misses: 0, play: null, now: now + 1, dwell: startDwell(newer, now) });
  assert.deepEqual([on.label, on.dwelling], [plain.line, false]);
  // A failure: its full sentence for 8 s, then the short red text, not the steady status, until it ages out.
  const error = { layer: "L2", at: now };
  const failed = { ...data, error, plain: { ...plain, error: { at: now, text: "14:31 折叠失败（原因见 /strata detail）" } } };
  dwell = startDwell({ kind: "error", at: now, text: failed.plain.error.text, entry: "…" }, now);
  assert.deepEqual(Object.values((({ state, label }) => ({ state, label }))(dockState(t, { data: failed, misses: 0, play: null, now: now + 1000, dwell }))), ["error", failed.plain.error.text]);
  const later = dockState(t, { data: { ...failed, now: now + 9 * 60_000 }, misses: 0, play: null, now: now + 9 * 60_000, dwell });
  assert.deepEqual([later.state, later.label, later.full], ["error", "折叠失败", failed.plain.error.text], "still red after the notice");
  const aged = dockState(t, { data: { ...failed, now: now + 10 * 60_000 }, misses: 0, play: null, now: now + 10 * 60_000, dwell });
  assert.deepEqual([aged.state, aged.label], ["idle", "已省 1.4M"], "10 minutes later the red goes");
});

test("dock client: what counts as a notice; the recent list keeps 5, newest first", () => {
  const { observe, pushRecent, RECENT_MAX, zh: dict } = loadClient();
  const t = (key) => dict[key] ?? key;
  const now = Date.UTC(2026, 10, 23, 6, 31);
  const base = (over = {}) => ({ takeover: "active", now, events: [], error: null, ...over, plain: { kind: "early", line: "已整理 1 次，约 20 次请求后开始省", short: "已整理 1 次", rejection: null, error: null, ...(over.plain || {}) } });
  const first = observe(null, base({ events: [{ layer: "L2", at: now - 5000, reclaimed: 9000 }] }), t, now);
  assert.deepEqual([first.notices.length, first.landing], [0, null], "the first poll only records");
  let memo = first.memo;
  // Work in progress and a number that merely moved are no notice.
  let step = observe(memo, base({ busy: true, plain: { line: "已整理 1 次，约 19 次请求后开始省" } }), t, now);
  assert.equal(step.notices.length, 0);
  memo = step.memo;
  // A landing: the chip shows the full sentence, the list a timed line.
  step = observe(memo, base({ events: [{ layer: "L2", tier: 1, auto: true, reclaimed: 31_540, at: now }] }), t, now);
  assert.equal(step.landing.layer, "L2");
  assert.equal(step.notices.length, 1);
  assert.equal(step.notices[0].text, "已整理 1 次，约 20 次请求后开始省");
  assert.match(step.notices[0].entry, /^\d\d:\d\d 自动折叠 T1，腾出约 31\.5K$/);
  memo = step.memo;
  // The line's kind changed ("early" → "saved").
  step = observe(memo, base({ events: [{ layer: "L2", at: now }], plain: { kind: "saved", line: "本会话已省约 1.4M（3 次整理）", short: "已省 1.4M" } }), t, now);
  assert.deepEqual(JSON.parse(JSON.stringify(step.notices.map((n) => [n.kind, n.text]))), [["line", "本会话已省约 1.4M（3 次整理）"]]);
  memo = step.memo;
  // A new rejection and a new failure in one poll: the failure goes on the chip, both go in the list.
  const rejection = { at: now + 1, text: "14:31 有一次折叠没做：回收太少（校验拦下的，不算失败）" };
  step = observe(memo, base({ error: { layer: "L2", at: now + 2 }, plain: { kind: "saved", rejection, error: { at: now + 2, text: "14:31 折叠失败（原因见 /strata detail）" } } }), t, now);
  assert.equal(step.notices.map((n) => n.kind).join(), "error,rejection");
  memo = step.memo;
  assert.deepEqual(observe(memo, base({ error: { layer: "L2", at: now + 2 }, plain: { kind: "saved", rejection } }), t, now).notices.length, 0, "the same failure and rejection again are not new");
  // The list: newest first, at most 5; a replaced notice stays.
  let list = [];
  for (let i = 0; i < 7; i += 1) list = pushRecent(list, [{ at: i, entry: `n${i}` }]);
  assert.equal(RECENT_MAX, 5);
  assert.equal(list.map((e) => e.text).join(), "n6,n5,n4,n3,n2");
  assert.equal(pushRecent([], [{ at: 2, entry: "error" }, { at: 1, entry: "rejection" }]).map((e) => e.text).join(), "error,rejection");
});

test("dock client: card strings, the settings switch, zh / en parity", () => {
  const { en: dEn, zh: dZh, settingsEn, settingsZh, kTokens, eventLabel, DEFAULTS } = loadClient();
  assert.deepEqual(Object.keys(dZh).sort(), Object.keys(dEn).sort());
  assert.equal(dZh.cardTitle, "Strata · 本会话节省");
  assert.equal(dZh.openSettings, "打开设置");
  assert.equal(dZh.more, "更多：/strata detail");
  assert.equal(settingsZh.dockDetails, "底部栏显示详情");
  assert.equal(settingsEn.dockDetails, "Show details in the status bar");
  assert.equal(settingsZh.dockDetailsHint, "打开后底部栏一直显示完整详情；关闭时只显示简短状态，新提示会先停留 8 秒，再收进悬停时的浮窗。只影响显示。立即生效。");
  assert.match(settingsEn.dockDetailsHint, /Display only\. Applies immediately\.$/);
  assert.equal(DEFAULTS.dockDetails, false);
  assert.deepEqual([kTokens(900), kTokens(31_540), kTokens(1_393_000)], ["900", "31.5K", "1.4M"]);
  assert.equal(eventLabel((key) => dZh[key], { layer: "L2", tier: 1, reclaimed: 1_393_000, auto: true }), "自动折叠 T1 −1.4M");
});

test("status payload: dockDetails follows the page, STRATA_DOCK_DETAILS wins", async () => {
  const { setPageConfig, pageConfig } = await import("../lib/settings.js");
  const before = pageConfig();
  const env = process.env.STRATA_DOCK_DETAILS;
  try {
    delete process.env.STRATA_DOCK_DETAILS;
    setPageConfig(null);
    assert.equal(statusPayload("plain-dd", "1", { language: "zh" }).dockDetails, false, "off by default");
    setPageConfig({ dockDetails: true });
    assert.equal(statusPayload("plain-dd", "1", { language: "zh" }).dockDetails, true);
    process.env.STRATA_DOCK_DETAILS = "off";
    assert.equal(statusPayload("plain-dd", "1", { language: "zh" }).dockDetails, false, "env wins");
  } finally {
    if (env === undefined) delete process.env.STRATA_DOCK_DETAILS;
    else process.env.STRATA_DOCK_DETAILS = env;
    setPageConfig(before);
  }
});
