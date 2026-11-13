// Rejections are not failures (A), the minimum-gain gate (B), the version line.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { addAssistantText, addToolRound, addUser, fakeAgent, fakeContext, FakeSession, filler } from "./helpers/fake-dsh.mjs";

const root = mkdtempSync(join(tmpdir(), "strata-gate-"));
process.env.STRATA_SHADOW_DIR = join(root, "archive");
process.env.STRATA_MIN_BENEFIT_TOKENS = "500";
process.env.STRATA_MIN_BENEFIT_RATIO = "0.000001";
process.env.STRATA_EXPECTED_REQUESTS = "200";
const { default: Engine } = await import("../index.js");
const { estimateFold, isRejection, landingGate, paysBack, StrataRejection } = await import("../lib/economics.js");
const { lastActivityError, lastActivityRejection, readActivity } = await import("../lib/activity.js");
const { runCommand, translator, versionText } = await import("../lib/command.js");
const { buildInfo, codeHash, gitHead, lockSource } = await import("../lib/version.js");
const { readSettings } = await import("../lib/settings.js");
after(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function setup() {
  const ctx = fakeContext();
  const engine = new Engine(ctx, {});
  const session = new FakeSession({ id: `gate-${(n += 1)}`, cwd: join(root, "work") });
  return { ctx, engine, session, agent: fakeAgent(session), layer: engine.strataLayer };
}

function longTask(session, rounds = 8) {
  addUser(session, "Run the test suite and fix failures.");
  for (let i = 0; i < rounds; i += 1) addToolRound(session, { command: `npm test -- shard ${i}`, output: `${filler(`shard-${i} PASS`, 12000)}\n[exit code: 0]` });
  addAssistantText(session, "All shards pass.");
}

const cards = (layer, session) => layer.layout(session).rows.filter((row) => row.stratum === "card").length;

// ------------------------------------------------------------ units

test("gate: defaults, floor in provider tokens, payback limit, forced skips only the cost check", () => {
  const settings = readSettings({});
  assert.equal(settings.minLandingTokens, 2000);
  assert.equal(settings.maxPaybackRequests, 100);
  assert.equal(settings.landingGate, true);
  assert.equal(readSettings({ STRATA_LANDING_GATE: "off" }).landingGate, false);
  // The user's card cut-1794197378160-1650f5c5: ~1.1K span, 219 reclaimed, ~31.5K re-billed, ~150 requests in.
  const user = estimateFold({ tokensFromStart: 31_500, reclaimed: 219, remainingRequests: 150, priceMiss: 1, priceHit: 0.1 });
  assert.equal(user.paybackRequests, 1286);
  const refused = landingGate({ estimate: user, minTokens: 100, remainingRequests: 150, maxPayback: 100 });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "payback");
  assert.match(refused.reason, /pays back after ~1286 requests, more than the ~100 allowed \(payback limit\)/);
  // Floor counts provider tokens: 1.2K local × 2 = 2.4K passes, × 1 fails.
  const mid = estimateFold({ tokensFromStart: 5_000, reclaimed: 1_200, remainingRequests: 200, priceMiss: 1, priceHit: 0.1 });
  assert.equal(landingGate({ estimate: mid, scale: 1, minTokens: 2000, maxPayback: 100 }).code, "small");
  assert.equal(landingGate({ estimate: mid, scale: 2, minTokens: 2000, maxPayback: 100 }).ok, true);
  assert.equal(landingGate({ estimate: user, scale: 20, minTokens: 2000, maxPayback: 100, forced: true }).ok, true, "forced: the floor only");
  // The payback limit: worth it over 200 requests, but only after 120.
  const slow = estimateFold({ tokensFromStart: 140_000, reclaimed: 10_000, remainingRequests: 200, priceMiss: 1, priceHit: 0.1 });
  assert.equal(slow.worthIt, true);
  assert.equal(paysBack(slow), true);
  assert.equal(paysBack(slow, 100), false);
  assert.equal(isRejection(new StrataRejection("x")), true);
  assert.equal(isRejection(new Error("x")), false);
});

// ------------------------------------------------------------ L1

test("L1: a card that is not smaller than its span is a rejection: no failure, no red dock, its own detail line", async () => {
  const { engine, session, agent, layer } = setup();
  longTask(session);
  engine.cardFramedTokens = () => 1e9;
  await engine.finishTurn(agent);
  assert.equal(cards(layer, session), 0);
  assert.equal(lastActivityError(session.id), null);
  assert.equal(readActivity(session.id).error, null, "the dock stays as it is");
  const rejection = lastActivityRejection(session.id);
  assert.equal(rejection.layer, "L1");
  assert.match(rejection.message, /not smaller than the span/);
  const zh = runCommand(layer, agent, "detail", { language: "zh" }).text;
  assert.match(zh, /上次失败\s+本进程内没有/);
  assert.match(zh, /上次拒收\s+\d\d:\d\d:\d\d  L1 切卡片 cut-\S+：the card .* not smaller than the span .*（校验没通过，不算失败，图标不变色）/);
  const en = runCommand(layer, agent, "detail", { language: "en" }).text;
  assert.match(en, /Last rejection\s+\d\d:\d\d:\d\d  L1 card cut-\S+: .*not a failure/);
  assert.match(layer.status(agent), /Last rejected landing \(a check refused it; not a failure, nothing changed\): card cut-/);
});

test("L1: the check at commit time (meter disagrees after the backup) is a rejection too; a real error is still a failure", async () => {
  const { engine, session, agent, ctx } = setup();
  longTask(session);
  engine.cardFramedTokens = () => undefined;
  const estimate = ctx.tokenMeter.estimateMessage;
  ctx.tokenMeter.estimateMessage = () => 1e9;
  await engine.finishTurn(agent);
  ctx.tokenMeter.estimateMessage = estimate;
  assert.equal(lastActivityError(session.id), null);
  assert.match(lastActivityRejection(session.id).message, /summary is not smaller than the shadowed content/);

  const other = setup();
  longTask(other.session);
  other.engine.summarize = async () => {
    throw new Error("EPERM: operation not permitted");
  };
  await other.engine.finishTurn(other.agent);
  assert.equal(lastActivityError(other.session.id).layer, "L1");
  assert.ok(readActivity(other.session.id).error, "a real failure turns the dock red");
});

test("L1: a small reclaim and a slow payback are refused by the gate; off restores 0.4.1", async () => {
  const small = setup();
  longTask(small.session);
  small.layer.settings.minLandingTokens = 1e9;
  await small.engine.finishTurn(small.agent);
  assert.equal(cards(small.layer, small.session), 0);
  assert.match(lastActivityRejection(small.session.id).message, /reclaims only .* below the .* minimum per landing/);
  assert.equal(lastActivityError(small.session.id), null);

  const slow = setup();
  longTask(slow.session);
  slow.layer.settings.minLandingTokens = 50;
  slow.layer.settings.maxPaybackRequests = 1;
  await slow.engine.finishTurn(slow.agent);
  assert.equal(cards(slow.layer, slow.session), 0);
  assert.match(lastActivityRejection(slow.session.id).message, /pays back after ~\d+ requests, more than the ~1 allowed \(payback limit\)/);

  const off = setup();
  longTask(off.session);
  off.layer.settings.minLandingTokens = 1e9;
  off.layer.settings.landingGate = false;
  await off.engine.finishTurn(off.agent);
  assert.equal(cards(off.layer, off.session), 1);
});

// ------------------------------------------------------------ L2

function foldable(session) {
  for (let t = 0; t < 3; t += 1) {
    addUser(session, `task ${t}`);
    for (let i = 0; i < 6; i += 1) addToolRound(session, { command: `step ${t}.${i}`, output: filler(`t${t}-${i}`, 4000) });
    addAssistantText(session, `done ${t}`);
  }
  addUser(session, "now");
  addToolRound(session, { command: "ls", output: "ok" });
}

test("L2: compress of a range that reclaims too little is rejected in the tool result, not recorded as a failure", () => {
  const { session, agent, layer } = setup();
  foldable(session);
  const run = layer.snapshot(agent).runs[0];
  // The first whole round with real content (~1K local): bigger than its summary, below the 2K floor.
  let sum = 0;
  const one = run.rows.find((row) => (sum += row.tokens) > 600 && row.closeOk);
  const reply = layer.propose(agent, `${run.startRef}–${one.ref} tiny\na faithful summary of one step.`);
  assert.match(reply, /^compress rejected: this fold reclaims only ~[\d.]+K? tokens, below the 2\.0K minimum per landing; pick a larger range/);
  assert.equal(layer.state(agent).pending.length, 0);
  assert.equal(lastActivityError(session.id), null);
  // The fold id was not used up.
  const wide = run.rows.filter((row) => row.closeOk).at(-1);
  assert.match(layer.propose(agent, `${run.startRef}–${wide.ref} task 0\nall of task 0.`), /fold f1/);
});

test("L2: a landing-time 'not smaller' check is a rejection; the next real failure still records", async () => {
  const { session, agent, layer, ctx } = setup();
  foldable(session);
  const run = layer.snapshot(agent).runs[0];
  const end = run.rows.filter((row) => row.closeOk).at(-1);
  assert.match(layer.propose(agent, `${run.startRef}–${end.ref} early\nearly work.`), /fold f1/);
  const estimate = ctx.tokenMeter.estimateMessage;
  ctx.tokenMeter.estimateMessage = () => 1e9;
  const result = await layer.flush(agent, new AbortController().signal, { force: true });
  ctx.tokenMeter.estimateMessage = estimate;
  assert.deepEqual(result.landed, []);
  assert.deepEqual(result.dropped, ["f1"]);
  assert.equal(lastActivityError(session.id), null);
  assert.equal(readActivity(session.id).error, null);
  assert.equal(lastActivityRejection(session.id).id, "f1");
  assert.match(lastActivityRejection(session.id).message, /fold is not smaller than its range/);
});

test("L2: above the automatic-fold line a lone small model fold no longer lands by itself (minimum batch still applies)", async () => {
  const { session, agent, layer } = setup();
  foldable(session);
  const run = layer.snapshot(agent).runs[0];
  const end = run.rows.filter((row) => row.closeOk).at(-1);
  layer.settings.minLandingTokens = 50;
  assert.match(layer.propose(agent, `${run.startRef}–${end.ref} early\nearly work.`), /fold f1/);
  layer.settings.minBenefitTokens = 1e9;
  layer.state(agent).autoDue = true;
  const held = await layer.flush(agent, new AbortController().signal);
  assert.deepEqual(held.landed, [], "pressure skips the cost check, not the minimum batch");
  layer.settings.minBenefitTokens = 500;
  layer.state(agent).autoDue = true;
  const landed = await layer.flush(agent, new AbortController().signal);
  assert.deepEqual(landed.landed, ["f1"]);
});

// ------------------------------------------------------------ version

test("version: git checkout (worktree gitdir file, packed refs), pnpm GitHub lock, npm lock, unknown", () => {
  const sha = "1133203abcdef0123456789abcdef0123456789a";
  // A worktree: .git is a file pointing at <common>/worktrees/x, HEAD is a ref packed in the common dir.
  const common = join(root, "repo.git");
  mkdirSync(join(common, "worktrees", "x"), { recursive: true });
  writeFileSync(join(common, "worktrees", "x", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(common, "worktrees", "x", "commondir"), "../..\n");
  writeFileSync(join(common, "packed-refs"), `# pack-refs with: peeled\n${sha} refs/heads/main\n`);
  const checkout = join(root, "checkout");
  mkdirSync(checkout, { recursive: true });
  writeFileSync(join(checkout, ".git"), `gitdir: ${join(common, "worktrees", "x")}\n`);
  writeFileSync(join(checkout, "package.json"), JSON.stringify({ version: "0.4.1" }));
  assert.equal(gitHead(checkout), sha);
  assert.deepEqual({ ...buildInfo(checkout), code: "" }, { version: "0.4.1", commit: sha, source: "git", code: "" });

  // dsh plugin add github:… → pnpm, codeload tarball in the profile's lock.
  const profile = join(root, "profile");
  const pkg = join(profile, "node_modules", "@lightcheng", "dsh-strata");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ version: "0.4.1" }));
  writeFileSync(join(pkg, "index.js"), "export {};\r\n");
  writeFileSync(join(profile, "pnpm-lock.yaml"), `packages:\n  '@lightcheng/dsh-strata@https://codeload.github.com/light-cheng/DSH-Strata/tar.gz/${sha}':\n    resolution: {tarball: x}\n`);
  assert.deepEqual(lockSource(pkg), { source: "github", commit: sha });
  const t = translator("zh");
  const github = versionText(t, buildInfo(pkg));
  assert.match(github, /^0\.4\.1  ·  提交 1133203（GitHub 安装）  ·  代码 [0-9a-f]{8}$/);
  assert.match(versionText(translator("en"), buildInfo(pkg)), /^0\.4\.1  ·  commit 1133203 \(GitHub install\)  ·  code [0-9a-f]{8}$/);
  // CRLF checkouts hash like LF ones.
  const lf = join(root, "lf");
  mkdirSync(lf, { recursive: true });
  writeFileSync(join(lf, "index.js"), "export {};\n");
  assert.equal(codeHash(pkg), codeHash(lf));

  // npm registry.
  writeFileSync(join(profile, "pnpm-lock.yaml"), "packages:\n  '@lightcheng/dsh-strata@0.4.1':\n    resolution: {integrity: sha512-x}\n");
  assert.deepEqual(lockSource(pkg), { source: "npm", commit: "" });
  assert.match(versionText(t, buildInfo(pkg)), /^0\.4\.1  ·  无提交号（npm 发布版）  ·  代码 [0-9a-f]{8}$/);
  assert.match(versionText(translator("en"), buildInfo(pkg)), /no commit \(npm release\)/);

  // This repository: a git checkout, so detail names its commit.
  const own = buildInfo();
  assert.equal(own.version, "0.4.1");
  assert.match(own.code, /^[0-9a-f]{8}$/);
  const { agent, layer } = setup();
  const zh = runCommand(layer, agent, "detail", { language: "zh" }).text;
  const overview = zh.split("\n").slice(0, 6).join("\n");
  assert.match(overview, /版本\s+0\.4\.1  ·  /);
  assert.match(runCommand(layer, agent, "detail", { language: "en" }).text, /Version\s+0\.4\.1  ·  /);
});
