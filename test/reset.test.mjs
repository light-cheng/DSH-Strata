// Settings reset by DSH's startup-failure dialog (lib/reset.js): fingerprint,
// the three conditions, hint once in the dock, /strata detail, clear on save,
// no profile folder. Temp DSH_HOME and a temp profile folder with .bak files.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { addToolRound, addUser, fakeAgent, fakeContext, FakeSession, filler } from "./helpers/fake-dsh.mjs";

const root = mkdtempSync(join(tmpdir(), "strata-reset-"));
process.env.DSH_HOME = join(root, "home");
process.env.STRATA_SHADOW_DIR = join(root, "archive");
delete process.env.DSH_PROFILE_DIR;

const { checkSettingsReset, ackResetHint, isDefaultValue, nonDefaultFields, profileDirOf, resetHint, resetResetMemory, resetStateFile } = await import("../lib/reset.js");
const { PAGE_DEFAULTS, setPageConfig } = await import("../lib/settings.js");
const { plainStatus } = await import("../lib/plain.js");
const { runCommand, translator } = await import("../lib/command.js");
const { stateDir } = await import("../lib/state.js");
const { GUI_RESET_ACK_PATH, registerGuiRoutes, statusPayload } = await import("../lib/gui-routes.js");
const { setTakeover } = await import("../lib/takeover.js");
const { default: Gate } = await import("../gate.js");
const { default: Engine } = await import("../index.js");

after(() => rmSync(root, { recursive: true, force: true }));

const zh = translator("zh");
const en = translator("en");
const profileDir = join(root, "profiles", "desk");
const PATCH = "cordis.patch.yml";
const T0 = Date.parse("2026-11-01T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function fresh() {
  rmSync(stateDir(), { recursive: true, force: true });
  rmSync(profileDir, { recursive: true, force: true });
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, PATCH), "[]\n");
  resetResetMemory();
}

// A rename keeps the patch's mtime, so a real backup's mtime is older than the record.
const OLD = T0 - 30 * DAY;

/** A backup named for time `at` (DSH's Date.now() at the rename), mtime `mtime`; the content is never read by Strata. */
function backup(at, name = `${PATCH}.bak-${at}`, mtime = OLD) {
  const path = join(profileDir, name);
  writeFileSync(path, "- {id: strata-gate, config: {mode: quality}}\n");
  utimesSync(path, new Date(mtime), new Date(mtime));
  return path;
}

const page = (values = {}) => ({ ...PAGE_DEFAULTS, ...values });
const check = (values, now, options = {}) => checkSettingsReset({ page: page(values), profileDir, profile: "desk", now, ...options });
const stored = () => JSON.parse(readFileSync(resetStateFile("desk"), "utf8"));

beforeEach(fresh);

test("defaults: missing, null and equal values count as default; only names are kept", () => {
  assert.equal(isDefaultValue("mode", "cost"), true);
  assert.equal(isDefaultValue("mode", undefined), true);
  assert.equal(isDefaultValue("archiveDir", "  "), true);
  assert.equal(isDefaultValue("autoFoldPct", "50"), true);
  assert.equal(isDefaultValue("autoFoldPct", 45), false);
  assert.equal(isDefaultValue("nudge", false), false);
  assert.deepEqual(nonDefaultFields(page()), []);
  assert.deepEqual(nonDefaultFields(page({ dockDetails: true, mode: "quality" })), ["mode", "dockDetails"], "PAGE_DEFAULTS order");
  assert.deepEqual(nonDefaultFields(null), []);
});

test("fingerprint: names and time recorded, no values; an all-default page never overwrites it", () => {
  check({ mode: "quality", archiveDir: "/secret/place" }, T0);
  const first = stored();
  assert.deepEqual(first, { fields: ["mode", "archiveDir"], recordedAt: T0, hint: null });
  assert.equal(readFileSync(resetStateFile("desk"), "utf8").includes("/secret/place"), false, "no values on disk");
  assert.equal(readFileSync(resetStateFile("desk"), "utf8").includes("quality"), false);
  // All default (no backup): the record stays as it was.
  check({}, T0 + DAY);
  assert.deepEqual(stored(), first);
  // A later save with other values replaces it.
  check({ nudge: false }, T0 + 2 * DAY);
  assert.deepEqual(stored(), { fields: ["nudge"], recordedAt: T0 + 2 * DAY, hint: null });
  assert.deepEqual(readdirSync(stateDir()), ["settings-desk.json"]);
});

test("condition 1 unmet: no earlier record, so a backup alone raises nothing", () => {
  backup(T0 + DAY);
  assert.equal(check({}, T0 + 2 * DAY).hint, null);
  assert.equal(resetHint(), null);
  assert.equal(existsSync(resetStateFile("desk")), false, "nothing to record");
});

test("condition 2 unmet: a listed field still differs from its default", () => {
  check({ mode: "quality", nudge: false }, T0);
  backup(T0 + DAY);
  assert.equal(check({ mode: "quality" }, T0 + 2 * DAY).hint, null, "mode still set");
  assert.equal(resetHint(), null);
});

test("condition 3 unmet: no backup, a backup older than the record, or another file name", () => {
  check({ mode: "quality" }, T0);
  assert.equal(check({}, T0 + DAY).hint, null, "no backup");
  backup(T0 - DAY);
  assert.equal(check({}, T0 + DAY).hint, null, "backup older than the record");
  backup(T0 + DAY, `${PATCH}.backup-${T0 + DAY}`);
  backup(T0 + DAY, `other.yml.bak-${T0 + DAY}`);
  assert.equal(check({}, T0 + 2 * DAY).hint, null, "only cordis.patch.yml.bak-* counts");
  assert.equal(resetHint(), null);
});

test("backup time from the name: the real case (mtime before the record, name after) is detected", () => {
  check({ mode: "quality" }, T0);
  const bak = backup(T0 + DAY, undefined, T0 - DAY);
  const state = check({}, T0 + 2 * DAY);
  assert.equal(state.hint.bak, bak);
  assert.equal(state.hint.bakStamp, T0 + DAY, "the time in the name, not the mtime");
  assert.equal("bakMtime" in state.hint, false);
});

test("backup time from the name: a name before the record raises nothing, even with a later mtime", () => {
  check({ mode: "quality" }, T0);
  backup(T0 - DAY, undefined, T0 + DAY);
  assert.equal(check({}, T0 + 2 * DAY).hint, null);
  assert.equal(resetHint(), null);
});

test("backup names that do not match are skipped, whatever their mtime", () => {
  check({ mode: "quality" }, T0);
  const later = T0 + DAY;
  backup(later, `${PATCH}.bak-abc`, later);
  backup(later, `${PATCH}.bak-123`, later);
  backup(later, `${PATCH}.bak-${later}.old`, later);
  backup(later, `${PATCH}.bak-${later}0000`, later);
  backup(later, `${PATCH}.bak-`, later);
  mkdirSync(join(profileDir, `${PATCH}.bak-${later}x`));
  mkdirSync(join(profileDir, `${PATCH}.bak-${later + 1}`), { recursive: true });
  assert.equal(check({}, T0 + 2 * DAY).hint, null, "bad names and a folder with a good name");
  assert.equal(resetHint(), null);
});

test("backup names with a number that is not a plausible Date.now() fall back to the mtime (as DSH-Mem0)", () => {
  check({ mode: "quality" }, T0);
  const seconds = String(Math.floor((T0 + DAY) / 1000));
  assert.equal(seconds.length, 10);
  backup(0, `${PATCH}.bak-${seconds}`, T0 - DAY);
  assert.equal(check({}, T0 + 2 * DAY).hint, null, "10 digits, mtime before the record");
  const bak = backup(0, `${PATCH}.bak-${seconds}0`, T0 + DAY);
  const state = check({}, T0 + 2 * DAY);
  assert.equal(state.hint.bak, bak, "11 digits, mtime after the record");
  assert.equal(state.hint.bakStamp, T0 + DAY);
});

test("all three met: the hint names the newest backup, shows once in the dock, stays in /strata detail", () => {
  check({ mode: "quality" }, T0);
  backup(T0 + DAY);
  const bak = backup(T0 + 2 * DAY);
  const state = check({}, T0 + 3 * DAY);
  assert.equal(state.hint.bak, bak);
  assert.equal(state.hint.seen, false);
  assert.deepEqual(stored().fields, ["mode"], "the record is kept");
  const shown = plainStatus("reset-a", zh);
  assert.equal(shown.resetHint, true);
  assert.equal(shown.details.at(-1), `Strata 的设置可能被 DSH 重置了（启动失败对话框选了禁用插件）。备份在 ${bak.replace(/\\/g, "/")}，可以在设置页重新设置，或从备份里把 strata-gate 块拷回去。`);
  assert.match(plainStatus("reset-a", en).details.at(-1), /^Strata's settings may have been reset by DSH .*The backup is .*strata-gate block back from the backup\.$/);
  // The bak file itself is never touched.
  assert.equal(readFileSync(bak, "utf8"), "- {id: strata-gate, config: {mode: quality}}\n");
  assert.equal(readFileSync(join(profileDir, PATCH), "utf8"), "[]\n");

  assert.deepEqual(ackResetHint(), { ok: true });
  const after = plainStatus("reset-a", zh);
  assert.equal(after.resetHint, false);
  assert.equal(after.hover.some((line) => line.includes("strata-gate")), false, "once only");
  assert.equal(stored().hint.seen, true, "seen is on disk");
  // After a restart: still seen, not shown again; the same backup does not raise a new hint.
  resetResetMemory();
  check({}, T0 + 4 * DAY);
  assert.equal(resetHint().seen, true);
  assert.equal(plainStatus("reset-a", zh).resetHint, false);
  assert.deepEqual(ackResetHint(), { ok: true }, "a second ack is fine");
});

test("saving a non-default value again clears the hint and records the new fields", () => {
  check({ mode: "quality" }, T0);
  backup(T0 + DAY);
  assert.ok(check({}, T0 + 2 * DAY).hint);
  const state = check({ mode: "quality" }, T0 + 3 * DAY);
  assert.equal(state.hint, null);
  assert.equal(resetHint(), null);
  assert.deepEqual(stored(), { fields: ["mode"], recordedAt: T0 + 3 * DAY, hint: null });
  assert.equal(plainStatus("reset-b", zh).resetHint, false);
  // The old backup is now older than the record: no hint at the next all-default start.
  assert.equal(check({}, T0 + 4 * DAY).hint, null);
});

test("no profile folder: detection is skipped silently; an unreadable folder too", () => {
  assert.equal(profileDirOf(undefined, {}), "");
  assert.equal(profileDirOf({ name: "desk" }, {}), "", "a name alone is not a folder; no guess");
  assert.equal(profileDirOf({ dir: "/p/desk" }, { DSH_PROFILE_DIR: "/q" }), "/p/desk");
  assert.equal(profileDirOf(undefined, { DSH_PROFILE_DIR: "/q" }), "/q");
  check({ mode: "quality" }, T0);
  backup(T0 + DAY);
  assert.doesNotThrow(() => check({}, T0 + 2 * DAY, { profileDir: "" }));
  assert.equal(resetHint(), null);
  assert.doesNotThrow(() => check({}, T0 + 2 * DAY, { profileDir: join(root, "missing") }));
  assert.equal(resetHint(), null);
  assert.equal(checkSettingsReset({ page: null, profileDir, profile: "desk" }), null, "no page values: nothing");
  // An unwritable state folder does not throw either.
  const blocked = join(root, "blocked");
  writeFileSync(blocked, "a file where the folder should be");
  assert.doesNotThrow(() => checkSettingsReset({ page: page({ mode: "quality" }), profileDir, profile: "desk", dir: blocked }));
});

test("gate: checks at start with DSH's profileContext and after a settings save; dock route and ack; /strata detail section", () => {
  setTakeover("active");
  check({ mode: "quality" }, T0);
  const bak = backup(Date.now() - 1000);
  // Older record so the backup is newer.
  writeFileSync(resetStateFile("desk"), JSON.stringify({ fields: ["mode"], recordedAt: T0, hint: null }));
  resetResetMemory();
  const routes = [];
  const child = {
    webServer: { register(route) { routes.push(route); return () => {}; } },
    get(name) { return name === "connection" ? { requestRejection: () => undefined } : undefined; },
    effect(fn) { fn(); },
    logger: { warn() {} },
  };
  const config = { mode: "cost" };
  const ctx = fakeContext({ services: { profileContext: { name: "desk", dir: profileDir } } });
  ctx.inject = (_names, fn) => fn(child);
  ctx.provide = () => {};
  new Gate(ctx, { get: () => config });
  assert.equal(resetHint()?.bak, bak, "detected at start");

  // Dock: in the details until the hover card acknowledges it.
  const first = statusPayload("reset-g", "1", { language: "zh" });
  assert.equal(first.plain.resetHint, true);
  const ack = routes.find((route) => route.path === GUI_RESET_ACK_PATH);
  const call = (method) => {
    const res = { headers: {}, statusCode: 0, body: "", setHeader(k, v) { this.headers[k] = v; }, end(b = "") { this.body = b; } };
    ack.handler({ url: GUI_RESET_ACK_PATH, method, headers: {}, resume() {} }, res);
    return res;
  };
  assert.equal(call("GET").statusCode, 405);
  assert.deepEqual(JSON.parse(call("POST").body), { ok: true });
  assert.equal(statusPayload("reset-g", "1", { language: "zh" }).plain.resetHint, false);

  // /strata detail keeps the section while the hint stands.
  const engineCtx = fakeContext({ contextWindow: 1_000_000 });
  const engine = new Engine(engineCtx, {});
  const session = new FakeSession({ id: "reset-g", cwd: join(root, "work") });
  const agent = fakeAgent(session);
  addUser(session, "Task.");
  addToolRound(session, { command: "ls", output: filler("ls", 400) });
  const detail = runCommand(engine.strataLayer, agent, "detail", { language: "zh" }).text;
  assert.match(detail, /提醒：设置可能被重置\n {2}Strata 的设置可能被 DSH 重置了/);
  assert.ok(detail.includes(bak.replace(/\\/g, "/")));
  assert.match(runCommand(engine.strataLayer, agent, "detail", { language: "en" }).text, /Notice: settings may have been reset\n {2}Strata's settings may have been reset by DSH/);

  // The user sets a value again on the page: the save clears it.
  config.mode = "quality";
  for (const fn of ctx.handlers.get("loader/volatile-update")) fn();
  assert.equal(resetHint(), null);
  assert.equal(runCommand(engine.strataLayer, agent, "detail", { language: "zh" }).text.includes("提醒：设置可能被重置"), false);
  assert.deepEqual(JSON.parse(readFileSync(resetStateFile("desk"), "utf8")).fields, ["mode"]);
  setPageConfig(null);
});

test("gate without a profile folder: no detection, no error", () => {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(resetStateFile("default"), JSON.stringify({ fields: ["mode"], recordedAt: T0, hint: null }));
  backup(Date.now() - 1000);
  const ctx = fakeContext();
  ctx.provide = () => {};
  assert.doesNotThrow(() => new Gate(ctx, {}));
  assert.equal(resetHint(), null);
  setPageConfig(null);
});
