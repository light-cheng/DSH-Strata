#!/usr/bin/env node
// Real-model evaluation for Strata Context (design §7 item 8).
//
// NOT run in CI and not run by the MVP session: it calls DeepSeek and costs
// money. It never touches your real DSH profiles: every run gets its own
// DSH_HOME under eval/.work/, and the plugin is installed there from a local
// `npm pack` tarball.
//
//   node eval/run.mjs                       # dry run: print the plan only
//   node eval/run.mjs --run --suite all     # really run (needs DEEPSEEK_API_KEY)
//   node eval/run.mjs --run --suite recall --arms strata
//
// Suites
//   fill    long log-filling task (live-compact's "长填日志" shape): many large
//           tool outputs; checks the task finishes, counts L1 cuts / L2 folds /
//           official summaries, total tokens and cache hit rate.
//   amnesia facts planted early, then a long fill, then questions about the
//           facts (live-compact's "失忆对比" shape). Scores exact recall.
//   recall  facts planted inside tool output, the model is asked to fold that
//           range, then asked for details that are only in the folded
//           originals. Scores whether decompress / search_context recover them.
//   tiers   four short log tasks, each folded to T1, pairs folded to T2, all
//           folded to T3; then the exact lines are asked for. Scores recovery
//           through tier-by-tier decompress / full:true / search_context and
//           reports the tier counts reached (strata arm only).
// Arms
//   strata  this plugin
//   stock   same profile with Strata forced to fall back (STRATA_FAKE_CONFLICT)

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFixtures } from "./fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};

const RUN = flag("run");
const SUITES = option("suite", "all") === "all" ? ["fill", "amnesia", "recall", "tiers"] : option("suite", "all").split(",");
const ARMS = option("arms", "strata,stock").split(",");
const DSH = process.env.DSH_BIN || "dsh";
// Optional extra patch layer (e.g. route the model through a local gateway).
// Launcher flags must come before app flags such as --json.
const PATCH = process.env.DSH_EVAL_PATCH ? ["--patch", resolve(process.env.DSH_EVAL_PATCH)] : [];
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const work = join(here, ".work", stamp);

function sh(command, commandArgs, options = {}) {
  const shown = `${command} ${commandArgs.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ")}`;
  if (!RUN) {
    console.log(`  $ ${shown}`);
    return { status: 0, stdout: "", stderr: "" };
  }
  const result = spawnSync(command, commandArgs, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  return result;
}

function pack() {
  console.log("Pack the plugin:");
  const out = sh("npm", ["pack", "--pack-destination", work, "--json"], { cwd: repo });
  if (!RUN) return join(work, "light-cheng-dsh-strata-<version>.tgz");
  const packed = JSON.parse(out.stdout);
  // npm ≤11 prints an array; npm 12 prints an object keyed by package name.
  return join(work, (Array.isArray(packed) ? packed : Object.values(packed))[0].filename);
}

function prepareHome(arm, tarball) {
  const home = join(work, arm, "dsh-home");
  const cwd = join(work, arm, "workspace");
  if (RUN) {
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });
  }
  console.log(`Arm ${arm}: isolated DSH_HOME ${home}`);
  const env = { ...process.env, DSH_HOME: home };
  sh(DSH, ["plugin", "--profile", "headless", "add", tarball], { env });
  if (arm === "stock") env.STRATA_FAKE_CONFLICT = "eval-stock-arm";
  // The recall/tiers suites test fold + recovery mechanics, not the landing
  // economics: short eval sessions would otherwise defer every small fold
  // (design §4). Override with your own env to test the defaults.
  env.STRATA_EXPECTED_REQUESTS ??= "50";
  env.STRATA_MIN_BENEFIT_TOKENS ??= "1000";
  env.STRATA_MIN_BENEFIT_RATIO ??= "0";
  return { home, cwd, env };
}

/** Run one headless task with --json and collect the event stream. */
function task(arm, setup, sessionId, prompt) {
  const commandArgs = ["--profile", "headless", ...PATCH, "--json"];
  if (sessionId) commandArgs.push("--session-id", sessionId);
  commandArgs.push(prompt);
  const started = Date.now();
  const result = sh(DSH, commandArgs, { env: setup.env, cwd: setup.cwd });
  const events = (result.stdout || "").split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  return { arm, ms: Date.now() - started, status: result.status, events, stderr: result.stderr || "" };
}

function sessionIdOf(run) {
  for (const event of run.events) {
    const id = event.sessionId || event.session?.id || event.data?.sessionId;
    if (typeof id === "string") return id;
  }
  return "";
}

function finalText(run) {
  const texts = run.events.filter((event) => event.type === "final" || event.type === "assistant/message" || event.kind === "final")
    .map((event) => event.text || event.data?.text || JSON.stringify(event.data?.message?.content || ""));
  return texts.at(-1) || "";
}

function metrics(run, setup) {
  const usage = run.events.map((event) => event.data?.usage || event.usage).filter(Boolean);
  const hit = usage.reduce((sum, item) => sum + (item.cacheReadTokens || 0), 0);
  const miss = usage.reduce((sum, item) => sum + (item.inputTokens || 0), 0);
  const tools = run.events.filter((event) => event.type === "tool_call").map((event) => event.tool);
  let archive = { cuts: 0, folds: 0, official: 0 };
  if (RUN && existsSync(join(setup.home, "strata"))) {
    const count = (re) => Number(spawnSync("sh", ["-c", `ls -1R "${join(setup.home, "strata")}" | grep -cE '${re}' || true`], { encoding: "utf8" }).stdout.trim() || 0);
    archive = { cuts: count("^cut-"), folds: count("^fold-f"), official: count("^official-") };
  }
  return {
    ms: run.ms,
    exit: run.status,
    requests: usage.length,
    inputTokens: hit + miss,
    hitRate: hit + miss ? Math.round((hit / (hit + miss)) * 1000) / 10 : null,
    tools: tools.join(","),
    compress: tools.filter((name) => name === "compress").length,
    decompress: tools.filter((name) => name === "decompress").length,
    search: tools.filter((name) => name === "search_context").length,
    ...archive,
  };
}

function score(answer, expected) {
  const found = expected.filter((fact) => answer.includes(fact));
  return { found: found.length, total: expected.length, missing: expected.filter((fact) => !found.includes(fact)) };
}

const fixtures = buildFixtures();

const SUITE_RUNNERS = {
  fill(arm, setup) {
    if (RUN) fixtures.writeFill(setup.cwd);
    const run = task(arm, setup, "", fixtures.fill.prompt);
    return { metrics: metrics(run, setup), finished: run.status === 0, found: score(finalText(run), fixtures.fill.expected) };
  },
  amnesia(arm, setup) {
    const plant = task(arm, setup, "", fixtures.amnesia.plant);
    const id = sessionIdOf(plant);
    if (RUN) fixtures.writeFill(setup.cwd);
    const fill = task(arm, setup, id, fixtures.fill.prompt);
    const ask = task(arm, setup, id, fixtures.amnesia.question);
    return { metrics: metrics(fill, setup), fillFound: score(finalText(fill), fixtures.fill.expected), recall: score(finalText(ask), fixtures.amnesia.expected) };
  },
  recall(arm, setup) {
    if (RUN) fixtures.writeRecall(setup.cwd);
    const read = task(arm, setup, "", fixtures.recall.read);
    const id = sessionIdOf(read);
    const fold = task(arm, setup, id, fixtures.recall.fold);
    if (RUN) fixtures.removeSources(setup.cwd, "recall");
    const ask = task(arm, setup, id, fixtures.recall.question);
    return { metrics: metrics(ask, setup), foldCalls: metrics(fold, setup).compress, foldReply: finalText(fold).slice(0, 300), recall: score(finalText(ask), fixtures.recall.expected) };
  },
  tiers(arm, setup) {
    if (arm !== "strata") return { skipped: "tiers needs the Strata tools" };
    if (RUN) fixtures.writeTiers(setup.cwd);
    // Isolate L2. With L1 on, each finished read is cut into a ~500-token card
    // at turn end, so the per-task folds this suite asks for reclaim almost
    // nothing and upgrades never pay (seen in the 2026-11-05 run, design
    // §11.10). In real sessions T1 folds cover many cards; here we test the
    // T1 → T2 → T3 mechanics directly. (0 is ignored by readSettings, hence a
    // tiny ratio: L1 stops above ~100 tokens, i.e. never cuts.) Small folds
    // near the tail also fail the cache-cost check, so a tiny force ratio
    // makes every valid fold land (it also nudges every turn).
    setup = { ...setup, env: { ...setup.env, STRATA_L1_STOP_RATIO: "0.0001", STRATA_FORCE_PCT: "0.0001" } };
    let id = "";
    const steps = [];
    for (const prompt of fixtures.tiers.tasks) {
      const run = task(arm, setup, id, prompt);
      id ||= sessionIdOf(run);
      steps.push(task(arm, setup, id, fixtures.tiers.foldT1));
    }
    steps.push(task(arm, setup, id, fixtures.tiers.foldT2));
    steps.push(task(arm, setup, id, fixtures.tiers.foldT3));
    if (RUN) fixtures.removeSources(setup.cwd, "tiers");
    const status = task(arm, setup, id, "Call strata_status and paste its 'Folds by tier' line verbatim.");
    const ask = task(arm, setup, id, fixtures.tiers.question);
    return {
      metrics: metrics(ask, setup),
      compressCalls: steps.reduce((sum, run) => sum + metrics(run, setup).compress, 0),
      foldReplies: steps.map((run) => finalText(run).slice(0, 200)),
      tierLine: (finalText(status).match(/Folds by tier:[^\n]*/) || [""])[0],
      recall: score(finalText(ask), fixtures.tiers.expected),
    };
  },
};

console.log(RUN ? `Running suites ${SUITES.join(", ")} × arms ${ARMS.join(", ")} in ${work}` : "Dry run (add --run to execute). Plan:");
if (RUN) mkdirSync(work, { recursive: true });
const tarball = pack();
const results = {};
for (const arm of ARMS) {
  const setup = prepareHome(arm, tarball);
  for (const suite of SUITES) {
    console.log(`Suite ${suite} / ${arm}`);
    results[`${suite}/${arm}`] = SUITE_RUNNERS[suite](arm, setup);
  }
}
if (RUN) {
  const file = join(work, "results.json");
  writeFileSync(file, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  console.log(`Saved ${file}`);
} else {
  console.log(`Fixtures: fill ${fixtures.fill.files} files (~${fixtures.fill.chars} chars), recall facts ${fixtures.recall.expected.length}.`);
}
