// Settings page: Config parsing, precedence (env > page > default), mode
// values, small-window clamp, and /strata outcome localization.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { readSettings, setPageConfig, pageConfig, liveSettings, foldLines, officialLine, PRESETS, PAGE_DEFAULTS } = await import("../lib/settings.js");
const { Config } = await import("../lib/config.js");
const { localizeOutcome, translator } = await import("../lib/command.js");
const { endedArchives, purgeSessions, archiveRootFor, archiveTotals } = await import("../lib/archive.js");
const { archiveUpkeep } = await import("../gate.js");

test("Config: defaults, the three modes, unknown mode refused, zh / en descriptions", () => {
  const value = (input) => {
    const parsed = Config(input);
    return parsed && typeof parsed.get === "function" ? parsed.get() : parsed;
  };
  const defaults = value({});
  for (const [key, expected] of Object.entries(PAGE_DEFAULTS)) assert.deepEqual(defaults[key], expected, key);
  assert.equal(defaults.nudge, true, "nudges on by default");
  assert.equal(defaults.archiveKeepDays, 0, "automatic cleanup off by default");
  for (const mode of ["cost", "quality", "custom"]) assert.equal(value({ mode }).mode, mode);
  assert.throws(() => Config({ mode: "turbo" }));
  for (const key of Object.keys(PAGE_DEFAULTS)) {
    const description = Config.dict[key].meta.description;
    assert.ok(description.zh && description.en, `${key} has zh and en`);
    assert.match(description.zh, /立即生效|对新会话生效/, `${key} says when it applies (zh)`);
    assert.match(description.en, /Applies immediately|Applies to new sessions/, `${key} says when it applies (en)`);
  }
});

test("modes: cost and quality values as approved; custom takes the page fields", () => {
  const cost = readSettings({}, {});
  assert.deepEqual([cost.mode, cost.autoFoldPct, cost.autoFoldAfterNudges, cost.autoFoldForcePct, cost.autoFoldTargetPct, cost.protectedTailPct, cost.midTurnFold], ["cost", 0.5, 2, 0.6, 0.3, 0.1, false]);
  const quality = readSettings({}, { mode: "quality" });
  assert.deepEqual([quality.autoFoldPct, quality.autoFoldForcePct, quality.autoFoldTargetPct, quality.protectedTailPct, quality.midTurnFold], [0.25, 0.35, 0.15, 0.1, true]);
  assert.equal(quality.midTurnCurrent, PRESETS.quality.midTurnCurrent);
  const custom = readSettings({}, { mode: "custom", autoFoldPct: 40, autoFoldForcePct: 45, autoFoldTargetPct: 20, protectedTailPct: 0, midTurnFold: true, midTurnCurrent: true });
  assert.deepEqual([custom.autoFoldPct, custom.autoFoldForcePct, custom.autoFoldTargetPct, custom.protectedTailPct, custom.midTurnFold, custom.midTurnCurrent], [0.4, 0.45, 0.2, 0, true, true]);
  // Advanced fields are ignored outside custom.
  const ignored = readSettings({}, { mode: "cost", autoFoldPct: 10, midTurnFold: true });
  assert.deepEqual([ignored.autoFoldPct, ignored.midTurnFold], [0.5, false]);
  // Custom without fields starts from cost.
  const blank = readSettings({}, { mode: "custom" });
  assert.deepEqual([blank.autoFoldPct, blank.autoFoldForcePct, blank.autoFoldTargetPct, blank.protectedTailPct], [0.5, 0.6, 0.3, 0.1]);
});

test("precedence: environment > settings page > built-in default", () => {
  assert.equal(readSettings({}, null).modeSource, "default");
  assert.equal(readSettings({}, { mode: "quality" }).modeSource, "page");
  assert.equal(readSettings({}, { mode: "cost" }).modeSource, "default", "the page's default mode reads as default");
  const env = readSettings({ STRATA_PRESET: "cost" }, { mode: "quality" });
  assert.deepEqual([env.mode, env.modeSource, env.autoFoldPct], ["cost", "env", 0.5]);
  // Switches.
  assert.equal(readSettings({}, { nudge: false }).nudge, false);
  assert.equal(readSettings({ STRATA_NUDGE: "off" }, { nudge: true }).nudge, false, "STRATA_NUDGE=off keeps working");
  assert.equal(readSettings({ STRATA_NUDGE: "on" }, { nudge: false }).nudge, true);
  assert.equal(readSettings({}, { autoFold: false }).autoFold, false);
  assert.equal(readSettings({ STRATA_AUTO_FOLD: "on" }, { autoFold: false }).autoFold, true);
  // A single line from the environment over the page's mode.
  assert.equal(readSettings({ STRATA_AUTO_FOLD_PCT: "0.33" }, { mode: "quality" }).autoFoldPct, 0.33);
  // Archive.
  assert.equal(readSettings({}, { archiveDir: "/x/y" }).archiveDir, "/x/y");
  assert.equal(readSettings({ STRATA_SHADOW_DIR: "/env/dir" }, { archiveDir: "/x/y" }).archiveDir, "/env/dir");
  assert.equal(readSettings({}, {}).archiveMaxMB, 1024);
  assert.equal(readSettings({}, { archiveMaxMB: 0 }).archiveMaxMB, 0);
  assert.equal(readSettings({ STRATA_ARCHIVE_KEEP_DAYS: "7" }, { archiveKeepDays: 0 }).archiveKeepDays, 7);
  // Internal knobs stay env-only: a page value is ignored.
  assert.equal(readSettings({}, { priceHit: 0.5 }).priceHit, 0.1);
});

test("live settings follow the page store; each holder keeps its own object", () => {
  const before = pageConfig();
  try {
    setPageConfig({ get: () => ({ mode: "quality" }) });
    const holder = {};
    assert.equal(liveSettings(holder).mode, "quality");
    const first = liveSettings(holder);
    assert.equal(liveSettings(holder), first, "cached while the page is unchanged");
    setPageConfig({ mode: "cost", nudge: false });
    assert.equal(liveSettings(holder).mode, "cost");
    assert.equal(liveSettings(holder).nudge, false);
    assert.notEqual(liveSettings({}), liveSettings(holder));
  } finally {
    setPageConfig(before);
  }
});

const route = (window, maxTokens = 16384) => ({ window, maxTokens, headroomTokens: 65536, thresholdRatio: 0.8 });

test("clamp: 200K lowers the force line below DSH's summary line; target unchanged", () => {
  assert.equal(officialLine(route(200_000)), 118_080);
  const cost = foldLines(readSettings({}, {}), route(200_000));
  assert.equal(Math.round(cost.officialPct * 100), 59);
  assert.equal(cost.autoFoldPct, 0.5, "50% is already below 54%");
  assert.ok(Math.abs(cost.autoFoldForcePct - (118_080 / 200_000 - 0.05)) < 1e-9);
  assert.equal(Math.round(cost.autoFoldForcePct * 100), 54);
  assert.equal(cost.clamped, true);
  const quality = foldLines(readSettings({}, { mode: "quality" }), route(200_000));
  assert.deepEqual([quality.autoFoldPct, quality.autoFoldForcePct, quality.clamped], [0.25, 0.35, false]);
});

test("clamp: 128K lowers both cost lines; custom is clamped too", () => {
  const official = officialLine(route(128_000));
  assert.equal(official, 46_080);
  const limit = official / 128_000 - 0.05;
  const cost = foldLines(readSettings({}, {}), route(128_000));
  assert.ok(Math.abs(cost.autoFoldPct - limit) < 1e-9 && Math.abs(cost.autoFoldForcePct - limit) < 1e-9);
  assert.equal(Math.round(limit * 100), 31);
  const custom = foldLines(readSettings({}, { mode: "custom", autoFoldPct: 33, autoFoldForcePct: 40 }), route(128_000));
  assert.ok(Math.abs(custom.autoFoldPct - limit) < 1e-9 && Math.abs(custom.autoFoldForcePct - limit) < 1e-9);
  const quality = foldLines(readSettings({}, { mode: "quality" }), route(128_000));
  assert.equal(quality.autoFoldPct, 0.25);
  assert.ok(Math.abs(quality.autoFoldForcePct - limit) < 1e-9);
});

test("clamp: 1M windows are unaffected", () => {
  for (const settings of [readSettings({}, {}), readSettings({}, { mode: "quality" })]) {
    const lines = foldLines(settings, route(1_000_000));
    assert.equal(lines.official, 800_000);
    assert.deepEqual([lines.autoFoldPct, lines.autoFoldForcePct, lines.clamped], [settings.autoFoldPct, settings.autoFoldForcePct, false]);
  }
});

test("turn-end outcomes are localized in /strata; unknown forms stay as written", () => {
  const zh = translator("zh");
  const cases = [
    ["skipped (2.9%: below 50%)", "跳过（2.9%，低于 50%）"],
    ["skipped (52%: below 60% and 1 of 2 unanswered nudges)", "跳过（52%，低于 60%，提醒没有回应 1/2 次）"],
    ["landed f3, f4 (above the automatic-fold line)", "已落地 f3, f4（超过自动折叠线）"],
    ["landed f5 with model fold f2 (forced)", "已落地 f5，连同模型折叠 f2（强制）"],
    ["proposed f6 at 61% (target ~300.0K)", "已提议 f6，此时 61%（目标 约 300.0K）"],
    ["proposed f7, not landed (batch ~2.0K below the 10.0K minimum)", "已提议 f7，未落地（这批约 2.0K，低于最小 10.0K）"],
    ["landed model fold f1; skipped (40%: below 50%)", "已落地模型折叠 f1；跳过（40%，低于 50%）"],
    ["off (STRATA_AUTO_FOLD)", "已关闭（设置页或 STRATA_AUTO_FOLD）"],
    ["error: boom", "出错：boom"],
    ["something new", "something new"],
  ];
  for (const [input, expected] of cases) assert.equal(localizeOutcome(input, zh), expected, input);
  const en = translator("en");
  for (const [input] of cases.slice(0, 7)) assert.equal(localizeOutcome(input, en), input, `en round-trips: ${input}`);
});

test("archive: ended sessions exclude open ones; upkeep deletes only with keep-days on", () => {
  const root = mkdtempSync(join(tmpdir(), "strata-archive-"));
  try {
    const old = Date.now() / 1000 - 10 * 86400;
    for (const key of ["open1", "ended1", "fresh1"]) {
      mkdirSync(join(root, key));
      writeFileSync(join(root, key, "fold-f1.json"), "{}");
      writeFileSync(join(root, key, "cut-1-0123abcd.txt"), "x".repeat(1000));
    }
    for (const key of ["open1", "ended1"]) for (const name of ["fold-f1.json", "cut-1-0123abcd.txt"]) utimesSync(join(root, key, name), old, old);
    assert.equal(archiveTotals(root).sessions, 3);
    assert.deepEqual(endedArchives(root, { open: new Set(["open1"]) }).map((row) => row.key).sort(), ["ended1", "fresh1"]);
    assert.deepEqual(endedArchives(root, { open: new Set(["open1"]), olderThanMs: 86400_000 }).map((row) => row.key), ["ended1"]);
    // Size cap only warns; keep-days 0 deletes nothing.
    const warned = [];
    const quiet = archiveUpkeep(readSettings({ STRATA_SHADOW_DIR: root }, { archiveMaxMB: 0.001, archiveKeepDays: 0 }), { warn: (line) => warned.push(line), info() {} });
    assert.equal(quiet.removed, null);
    assert.equal(quiet.overCap, true);
    assert.equal(warned.length, 1);
    assert.equal(archiveTotals(root).sessions, 3);
    // Keep-days on: the old ones go, the fresh one stays.
    const result = archiveUpkeep(readSettings({ STRATA_SHADOW_DIR: root, STRATA_ARCHIVE_KEEP_DAYS: "3" }, {}), { warn() {}, info() {} });
    assert.equal(result.removed.sessions, 2);
    assert.ok(existsSync(join(root, "fresh1")) && !existsSync(join(root, "ended1")));
    assert.deepEqual(purgeSessions([]), { sessions: 0, files: 0, bytes: 0 });
    assert.equal(archiveRootFor({ archiveDir: root }), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
