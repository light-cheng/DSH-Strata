#!/usr/bin/env node
// Recall after folding: can the model still answer questions about facts that
// were folded away (a path, a number, an error message, a decision)?
//
// Three arms share the same three planting turns (Strata L1 off, no folds):
//   unfolded  nothing is folded;
//   model     the model folds the earlier work itself with compress;
//   auto      Strata's automatic extractive digest folds it (forced by env).
// Then the workspace is deleted (so files cannot simply be re-read) and the
// DSH home is copied. Each copy gets one question turn:
//   closed    "answer from the conversation only, no tools";
//   open      "you may use decompress / search_context".
//
// Every arm has its own DSH_HOME under eval/.work/recall-<time>/<arm>. The model
// goes through DEEPSEEK_BASE_URL / DSH_EVAL_PATCH (magpie in our runs).
//
//   RECALL_ARMS=auto RECALL_REP=1 DSH_BIN=… DSH_EVAL_PATCH=magpie.patch.yml \
//   DEEPSEEK_BASE_URL=http://127.0.0.1:3425/v1 DEEPSEEK_API_KEY=local node eval/recall-auto.mjs

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const DSH = process.env.DSH_BIN || "dsh";
const BASE_PATCH = process.env.DSH_EVAL_PATCH ? readFileSync(resolve(process.env.DSH_EVAL_PATCH), "utf8") : "";
const ARMS = (process.env.RECALL_ARMS || "unfolded,model,auto").split(",");
const REP = process.env.RECALL_REP || "1";
const WINDOW = 128000;
const work = process.env.RECALL_WORK || join(here, ".work", `recall-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(work, { recursive: true });

function sh(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  return result;
}

function pack(dir) {
  const out = sh("npm", ["pack", "--pack-destination", work, "--json", "--ignore-scripts"], { cwd: dir });
  const parsed = JSON.parse(out.stdout);
  return join(work, (Array.isArray(parsed) ? parsed : Object.values(parsed))[0].filename);
}

const PATCH = `
- id: llm-deepseek
  config:
    defaultContextWindow: ${WINDOW}
    maxTokens: 8192
- id: compaction-strata
  config:
    auto: true
    thresholdRatio: 0.8
    headroomTokens: 8192
    retainTokens: 8192
    compactionRetries: 0
    maxTokens: 8192
`;

// Planting and question turns: no automatic folds, L1 effectively off.
const BASE_ENV = {
  STRATA_CONTEXT_WINDOW: String(WINDOW),
  STRATA_L1_STOP_RATIO: "0.0001",
  STRATA_AUTO_FOLD: "off",
};
// The fold turn: everything outside the protected rows may fold, and the batch lands regardless of cost.
const FOLD_ENV = {
  STRATA_FORCE_PCT: "0.02",
  STRATA_KEEP_ROUNDS: "1",
  STRATA_MIN_BENEFIT_TOKENS: "1",
  STRATA_MIN_BENEFIT_RATIO: "0.000001",
};

function filler(name, n) {
  const lines = [`# ${name}: signal helpers`, "import math", ""];
  for (let f = 0; f < n; f += 1) lines.push(`def ${name}_step_${f}(x, y):`, `    """Step ${f}."""`, `    a = x * ${(f * 13) % 89} + y`, `    b = math.sqrt(abs(a)) + ${f}`, `    return a - b if b > ${50 + f} else a + b`, "");
  return `${lines.join("\n")}\n`;
}

function workspace(cwd) {
  const put = (path, text) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  };
  const deploy = ["# orchid deploy configuration", "service: orchid", "region: eu-west-2", "replicas: 4"];
  for (let i = 0; i < 30; i += 1) deploy.push(`feature_${i}: ${i % 3 === 0 ? "on" : "off"}`);
  deploy.splice(18, 0, "cache_path: /opt/quill/cache/shard-42");
  deploy.splice(27, 0, "max_retries: 173");
  put("config/deploy.yaml", `${deploy.join("\n")}\n`);
  const adr = ["# ADR-012: webhook endpoints", "", "Status: accepted", "", "## Context", ""];
  for (let i = 0; i < 12; i += 1) adr.push(`Partner ${i} still calls the v1 endpoint about ${(i * 37) % 400} times a day; migration notes are in the wiki.`);
  adr.push("", "## Decision", "", "Retire the v1 webhook endpoint on 2026-12-01; partners move to v2 signed callbacks.", "", "## Consequences", "");
  for (let i = 0; i < 8; i += 1) adr.push(`- Consequence ${i}: dashboards and alerts for partner ${i} need a new filter.`);
  put("docs/adr-012.md", `${adr.join("\n")}\n`);
  const log = [];
  for (let i = 0; i < 40; i += 1) log.push(`2026-11-0${1 + (i % 5)}T0${i % 10}:1${i % 6}:00Z INFO worker-${i % 4} heartbeat ok, queue depth ${(i * 17) % 90}`);
  log.splice(23, 0, "2026-11-03T04:12:09Z WARN worker-2 lease expired for shard 19, requeueing 311 jobs");
  put("logs/worker.log", `${log.join("\n")}\n`);
  put("tools/check_db.py", [
    "import sys",
    'print("connecting to db-edge-3:5432 ...")',
    'print("ERROR 1045 (28000): Access denied for user \'svc_orchid\'@\'10.4.2.9\' (using password: YES)", file=sys.stderr)',
    "sys.exit(1)",
    "",
  ].join("\n"));
  put("tools/verify.py", [
    "def check(block):",
    "    raise ValueError('checksum mismatch for block 0x3fa2')",
    'print("verifying 64 blocks")',
    "check(0x3fa2)",
    "",
  ].join("\n"));
  put("tools/profile.py", [
    'print("profiling 3 workers for 30s")',
    "for i in range(3):",
    '    print(f"worker-{i} cpu_pct {41 + i * 7}")',
    'print("peak_rss_kb 482113")',
    'print("gc_pauses 12")',
    "",
  ].join("\n"));
  for (const p of ["build/cache.lock", "app/deps.lock", "vendor/kestrel/pins.lock", "tests/fixtures/seed.lock"]) put(p, "lock\n");
  for (const name of ["big_a", "big_b", "big_c", "big_d"]) put(`src/${name}.py`, filler(name, 70));
}

const PLANT = [
  "We're auditing the orchid service in this workspace. Two notes for later: the backup copy lives at /srv/backups/heron-2026-03.tar, and our request budget is 3750 requests per hour. Work step by step, one tool call per step, no parallel calls: read config/deploy.yaml, read docs/adr-012.md, run `python3 tools/check_db.py`, then run `find . -name '*.lock'`. Then summarize what you saw in two sentences.",
  "We decided to use SQLite instead of Postgres for the edge nodes because of the 40 MB memory cap. Next, one tool call per step: run `python3 tools/verify.py`, read logs/worker.log, run `python3 tools/profile.py`, read src/big_a.py, read src/big_b.py. Summarize in two sentences.",
  "Decision for later: rename the queue from 'ingest' to 'intake'. Now read src/big_c.py and src/big_d.py (one tool call each) and reply with how many functions each has.",
];
const FOLD_PROMPT = {
  unfolded: "Reply with OK.",
  auto: "Reply with OK.",
  model: "Context housekeeping: call strata_status with detail true, then fold all of the earlier work (everything before the last batch) with the compress tool, writing the summaries yourself so that the facts we may need later survive. Then reply with OK.",
};

const QUESTIONS = [
  { id: "P1", type: "path", q: "What cache_path does config/deploy.yaml set?", keys: ["/opt/quill/cache/shard-42"] },
  { id: "P2", type: "path", q: "Which .lock file did find report under vendor/?", keys: ["vendor/kestrel/pins.lock"] },
  { id: "P3", type: "path", q: "Where does the backup copy live?", keys: ["/srv/backups/heron-2026-03.tar"] },
  { id: "N1", type: "number", q: "What is max_retries in config/deploy.yaml?", keys: ["173"] },
  { id: "N2", type: "number", q: "What peak RSS in kB did tools/profile.py report?", keys: ["482113"] },
  { id: "N3", type: "number", q: "What is our request budget per hour?", keys: [/3[,.]?750/] },
  { id: "E1", type: "error", q: "What exact error did tools/verify.py raise?", keys: ["checksum mismatch", "0x3fa2"] },
  { id: "E2", type: "error", q: "What exact error did tools/check_db.py print (user and host)?", keys: ["Access denied", "svc_orchid", "10.4.2.9"] },
  { id: "E3", type: "error", q: "What warning did logs/worker.log record about a lease (shard and job count)?", keys: ["lease expired", "19", "311"] },
  { id: "D1", type: "decision", q: "Which database did we choose for the edge nodes, and why?", keys: ["SQLite", "40"] },
  { id: "D2", type: "decision", q: "What does ADR-012 decide, and from which date?", keys: ["v1", "2026-12-01"] },
  { id: "D3", type: "decision", q: "What should the queue be renamed to?", keys: ["intake"] },
];
const ASK = {
  closed: "Answer these questions from what is in this conversation only. Do not call any tools. If you do not know, write UNKNOWN. Answer as numbered lines 1-12, one line each.",
  open: "Answer these questions. The workspace files are gone, so do not read files or run commands; if a detail was folded away you may use decompress or search_context to restore it. If you still do not know, write UNKNOWN. Answer as numbered lines 1-12, one line each.",
};
const questionText = (mode) => `${ASK[mode]}\n${QUESTIONS.map((q, i) => `${i + 1}. ${q.q}`).join("\n")}`;

function turn(h, prompt, env = {}) {
  const args = ["--profile", "headless", "--patch", h.patch, "--json"];
  if (h.sessionId) args.push("--session-id", h.sessionId);
  args.push(prompt);
  const started = Date.now();
  const result = sh(DSH, args, { env: { ...h.env, ...env }, cwd: h.cwd, timeout: 30 * 60 * 1000 });
  const events = result.stdout.split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  h.sessionId ||= events.find((event) => event.sessionId)?.sessionId || "";
  return {
    status: result.status,
    seconds: Math.round((Date.now() - started) / 1000),
    usage: events.map((event) => event.usage).filter(Boolean),
    tools: events.filter((event) => event.type === "tool_call").map((event) => event.tool),
    final: events.filter((event) => event.type === "final").at(-1)?.text || "",
    stderrTail: result.stderr.split("\n").filter((line) => /strata|compaction|error/i.test(line) && !/trust settings/.test(line)).slice(-12),
  };
}

function sessionEvents(h) {
  const found = sh("sh", ["-c", `find "${join(h.env.DSH_HOME, "sessions")}" -path "*${h.sessionId}*" -name "*.zstd" | head -1`]).stdout.trim();
  if (!found) return [];
  return sh("zstd", ["-dc", found]).stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function folds(events) {
  const out = [];
  for (const e of events) {
    if (e.type !== "compaction/summary") continue;
    const text = (e.data?.summary || []).map((b) => b.text || "").join("\n");
    if (/\[strata:fold/.test(text)) out.push({ auto: /auto=1/.test(text), chars: text.length, text });
  }
  return out;
}

const matches = (text, key) => (key instanceof RegExp ? key.test(text) : text.toLowerCase().includes(key.toLowerCase()));

function score(final) {
  const lines = final.split("\n");
  return QUESTIONS.map((q, i) => {
    const line = lines.find((l) => new RegExp(`^\\s*(?:\\*\\*)?${i + 1}[.):]`).test(l)) || "";
    return { id: q.id, type: q.type, ok: q.keys.every((k) => matches(line, k)), line: line.slice(0, 240) };
  });
}

// Is the fact still visible after the fold (in a fold's text), so it can be answered without tools?
function survives(foldTexts) {
  const all = foldTexts.join("\n");
  return Object.fromEntries(QUESTIONS.map((q) => [q.id, q.keys.every((k) => matches(all, k))]));
}

const tgz = process.env.RECALL_TGZ ? resolve(process.env.RECALL_TGZ) : pack(repo);
const results = {};
console.log(`work dir ${work}; rep ${REP}; arms ${ARMS.join(",")}`);
for (const arm of ARMS) {
  const dir = join(work, `${arm}-${REP}`);
  const cwd = join(dir, "ws");
  mkdirSync(cwd, { recursive: true });
  const env = { ...process.env, ...BASE_ENV, DSH_HOME: join(dir, "home") };
  const added = sh(DSH, ["plugin", "--profile", "headless", "add", tgz], { env });
  if (added.status !== 0) throw new Error(`install failed: ${added.stderr.slice(-600)}`);
  const patch = join(dir, "patch.yml");
  writeFileSync(patch, `${BASE_PATCH}\n${PATCH}`);
  workspace(cwd);
  const h = { dir, cwd, env, patch, sessionId: "" };
  const log = [];
  for (const prompt of PLANT) {
    log.push(turn(h, prompt));
    console.log(`${arm}-${REP} plant ${log.length}: exit ${log.at(-1).status}, ${log.at(-1).usage.length} requests, tools ${log.at(-1).tools.join(" ")}`);
  }
  const foldEnv = arm === "auto" ? { ...FOLD_ENV, STRATA_AUTO_FOLD: "on", STRATA_AUTO_FOLD_FORCE_PCT: "0.01", STRATA_AUTO_FOLD_TARGET_PCT: "0.01" } : arm === "model" ? FOLD_ENV : {};
  log.push(turn(h, FOLD_PROMPT[arm], foldEnv));
  const before = log.at(-2).usage.at(-1);
  const after = log.at(-1).usage.at(-1);
  const landed = folds(sessionEvents(h));
  console.log(`${arm}-${REP} fold turn: tools ${log.at(-1).tools.join(" ")}; folds ${landed.length} (${landed.filter((f) => f.auto).length} auto)`);
  // The files are gone for the questions: answers come from context or the archive.
  for (const sub of ["config", "docs", "logs", "tools", "src", "build", "app", "vendor", "tests"]) rmSync(join(cwd, sub), { recursive: true, force: true });
  const copy = join(dir, "home-closed");
  cpSync(env.DSH_HOME, copy, { recursive: true });
  const asked = {};
  for (const mode of ["closed", "open"]) {
    const hh = { ...h, env: mode === "closed" ? { ...env, DSH_HOME: copy } : env };
    const t = turn(hh, questionText(mode));
    const s = score(t.final);
    asked[mode] = { score: s, correct: s.filter((x) => x.ok).length, tools: t.tools, final: t.final, status: t.status, firstPrompt: t.usage[0] ? (t.usage[0].inputTokens || 0) + (t.usage[0].cacheReadTokens || 0) : 0 };
    console.log(`${arm}-${REP} ${mode}: ${asked[mode].correct}/12, tools ${t.tools.join(" ") || "none"}`);
  }
  results[arm] = {
    sessionId: h.sessionId,
    contextBeforeFold: before ? (before.inputTokens || 0) + (before.cacheReadTokens || 0) : 0,
    contextAfterFold: asked.closed.firstPrompt,
    folds: landed.map((f) => ({ auto: f.auto, chars: f.chars })),
    survives: survives(landed.map((f) => f.text)),
    foldTexts: landed.map((f) => f.text),
    plantExits: log.map((t) => t.status),
    foldTools: log.at(-1).tools,
    stderr: log.map((t) => t.stderrTail),
    asked,
  };
  writeFileSync(join(work, `results-${arm}-${REP}.json`), JSON.stringify(results[arm], null, 2));
}
