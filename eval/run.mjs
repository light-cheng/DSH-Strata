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
const SUITES = option("suite", "all") === "all" ? ["fill", "amnesia", "recall"] : option("suite", "all").split(",");
const ARMS = option("arms", "strata,stock").split(",");
const DSH = process.env.DSH_BIN || "dsh";
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
  return join(work, JSON.parse(out.stdout)[0].filename);
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
  return { home, cwd, env };
}

/** Run one headless task with --json and collect the event stream. */
function task(arm, setup, sessionId, prompt) {
  const commandArgs = ["--profile", "headless", "--json"];
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
  const tools = run.events.filter((event) => event.type === "tool/call" || event.data?.type === "tool/call").map((event) => event.data?.name || event.name);
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
    return { metrics: metrics(run, setup), finished: run.status === 0 };
  },
  amnesia(arm, setup) {
    const plant = task(arm, setup, "", fixtures.amnesia.plant);
    const id = sessionIdOf(plant);
    if (RUN) fixtures.writeFill(setup.cwd);
    const fill = task(arm, setup, id, fixtures.fill.prompt);
    const ask = task(arm, setup, id, fixtures.amnesia.question);
    return { metrics: metrics(fill, setup), recall: score(finalText(ask), fixtures.amnesia.expected) };
  },
  recall(arm, setup) {
    if (RUN) fixtures.writeRecall(setup.cwd);
    const read = task(arm, setup, "", fixtures.recall.read);
    const id = sessionIdOf(read);
    const fold = task(arm, setup, id, fixtures.recall.fold);
    const ask = task(arm, setup, id, fixtures.recall.question);
    return { metrics: metrics(ask, setup), foldCalls: metrics(fold, setup).compress, recall: score(finalText(ask), fixtures.recall.expected) };
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
