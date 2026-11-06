#!/usr/bin/env node
// Strata effectiveness vs billion-context on a long task of short tool outputs
// (the "JIMA" shape: many read / write / shell / edit steps, little output each).
//
// Every arm gets its own DSH_HOME (and, for billion-context, its own HOME and
// config file with auto-update off) under eval/.work/effect-<time>/. The model
// goes through DEEPSEEK_BASE_URL / DSH_EVAL_PATCH (magpie in our runs).
//
//   EFFECT_ARMS=strata,bili DSH_BIN=… DSH_EVAL_PATCH=magpie.patch.yml \
//   BILI_TGZ=billion-context-0.1.212.tgz DEEPSEEK_BASE_URL=http://127.0.0.1:3425/v1 \
//   DEEPSEEK_API_KEY=local node eval/effect.mjs
//
// The real session ran on a 1M window. To keep the run affordable the window is
// EFFECT_WINDOW (default 128K) and every window-relative knob is scaled by
// window / 1M: adapter maxTokens, stock headroom, Strata's nudge step, minimum
// benefit, stale sweep, L1 floor and kept-round budget, and billion-context's
// nudge step. Ratios (L1 stop 65%, force 75%, stock threshold 80%) stay as is.
// Strata's fixed constants (32K chunk cap, 48K urgent, 2.2K tail) do not scale,
// which favours Strata's L1 at this size.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const DSH = process.env.DSH_BIN || "dsh";
const BASE_PATCH = process.env.DSH_EVAL_PATCH ? readFileSync(resolve(process.env.DSH_EVAL_PATCH), "utf8") : "";
const ARMS = (process.env.EFFECT_ARMS || "strata,bili").split(",");
const WINDOW = Number(process.env.EFFECT_WINDOW || 128000);
const SCALE = WINDOW / 1_000_000;
const TURNS = Number(process.env.EFFECT_TURNS || 6);
const FILES_PER_TURN = Number(process.env.EFFECT_FILES || 6);
const FUNCS = Number(process.env.EFFECT_FUNCS || 22);
const work = process.env.EFFECT_WORK || join(here, ".work", `effect-${new Date().toISOString().replace(/[:.]/g, "-")}`);
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

const s = (n) => String(Math.max(1, Math.round(n * SCALE)));
const adapterPatch = `
- id: llm-deepseek
  config:
    defaultContextWindow: ${WINDOW}
    maxTokens: ${s(256000)}
`;
const strataPatch = `
- id: compaction-strata
  config:
    auto: true
    thresholdRatio: 0.8
    headroomTokens: ${s(65536)}
    retainTokens: 8192
    compactionRetries: 0
    maxTokens: 8192
`;
const STRATA_ENV = {
  STRATA_CONTEXT_WINDOW: String(WINDOW),
  STRATA_NUDGE_GROWTH_TOKENS: s(50000),
  STRATA_MIN_BENEFIT_TOKENS: s(5000),
  STRATA_STALE_SWEEP_TOKENS: s(8000),
  STRATA_MIN_TOKENS: s(20000),
  STRATA_KEEP_ROUND_TOKENS: s(32000),
};

// Source files: ~8 lines per function (22 functions ≈ 180 lines ≈ 2K tokens) of Python-ish code each, a TODO line to fix.
function workspace(cwd) {
  mkdirSync(join(cwd, "src"), { recursive: true });
  mkdirSync(join(cwd, "out"), { recursive: true });
  for (let i = 0; i < TURNS * FILES_PER_TURN; i += 1) {
    const lines = [`# module m${i}: sensor channel ${i}`, "import math", ""];
    for (let f = 0; f < FUNCS; f += 1) {
      lines.push(`def calc_${i}_${f}(x, y):`, `    """Channel ${i} step ${f}."""`, `    a = x * ${(i * 31 + f * 7) % 97} + y`, `    b = math.sqrt(abs(a)) + ${f}`, `    if b > ${100 + i}:`, `        return b - ${i + f}`, "    return a + b", "");
    }
    lines.push(`# TODO(m${i}): threshold should be ${200 + i}, not ${100 + i}`);
    writeFileSync(join(cwd, "src", `m${i}.py`), `${lines.join("\n")}\n`);
  }
}

function prompts() {
  const out = [];
  for (let t = 0; t < TURNS; t += 1) {
    const ids = Array.from({ length: FILES_PER_TURN }, (_, k) => t * FILES_PER_TURN + k);
    out.push([
      `Batch ${t + 1}: process src/m${ids[0]}.py through src/m${ids.at(-1)}.py, one file at a time, one tool call per step (no parallel calls, no scripts that touch several files).`,
      "For each file: (1) read it with the read tool; (2) write out/<same name> with the write tool: the full file, every function renamed from calc_ to compute_, and a one-line docstring at the top naming the module;",
      "(3) run a shell command that prints the line count and the compute_ count of the new file (for example `wc -l out/mN.py && grep -c compute_ out/mN.py`); (4) use the edit tool on out/<name> to apply its TODO (replace the threshold in the `if b >` line and delete the TODO line).",
      "When the batch is done, reply with one line per file: name, line count, compute_ count.",
    ].join(" "));
  }
  return out;
}

function turn(h, prompt) {
  const args = ["--profile", "headless", "--patch", h.patch, "--json"];
  if (h.sessionId) args.push("--session-id", h.sessionId);
  args.push(prompt);
  const started = Date.now();
  const result = sh(DSH, args, { env: h.env, cwd: h.cwd, timeout: 60 * 60 * 1000 });
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
    stderrTail: result.stderr.split("\n").filter((line) => /strata|bili|compaction|acp|error/i.test(line) && !/trust settings/.test(line)).slice(-20),
  };
}

function sessionEvents(h) {
  const found = sh("sh", ["-c", `find "${join(h.env.DSH_HOME, "sessions")}" -path "*${h.sessionId}*" -name "*.zstd" | head -1`]).stdout.trim();
  if (!found) return [];
  return sh("zstd", ["-dc", found]).stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function home(arm, packages, patch, env) {
  const dir = join(work, arm);
  const cwd = join(dir, "ws");
  mkdirSync(cwd, { recursive: true });
  const fullEnv = { ...process.env, ...env, DSH_HOME: join(dir, "home") };
  for (const pkg of packages) {
    const added = sh(DSH, ["plugin", "--profile", "headless", "add", pkg], { env: fullEnv });
    if (added.status !== 0) throw new Error(`install ${pkg} failed: ${added.stderr.slice(-600)}`);
  }
  const patchFile = join(dir, "patch.yml");
  writeFileSync(patchFile, `${BASE_PATCH}\n${adapterPatch}${patch}`);
  workspace(cwd);
  return { arm, dir, cwd, env: fullEnv, patch: patchFile, sessionId: "" };
}

function biliEnv(dir) {
  const fake = join(dir, "bili-home");
  mkdirSync(join(fake, ".config"), { recursive: true });
  const config = join(fake, "billion-context.json");
  writeFileSync(config, JSON.stringify({ autoUpdate: false, autoRestartOnUpdate: false, compress: { modelContextLimit: WINDOW, nudgeGrowthTokens: Math.round(50000 * SCALE) } }, null, 2));
  return {
    HOME: fake,
    XDG_CONFIG_HOME: join(fake, ".config"),
    XDG_STATE_HOME: join(fake, ".state"),
    XDG_CACHE_HOME: join(fake, ".cache"),
    XDG_DATA_HOME: join(fake, ".data"),
    BILI_CONFIG_FILE: config,
    BILI_SESSIONS_DIR: join(fake, "sessions"),
    ACP_AUTO_UPDATE: "0",
    ACP_AUTO_RESTART_ON_UPDATE: "0",
    ACP_PORT: String(18900 + Math.floor(Math.random() * 90)),
    BILI_ZONE_PORT: String(19000 + Math.floor(Math.random() * 90) * 10),
  };
}

// Context size per request = prompt tokens (cache hit + miss).
function curve(turns) {
  const rows = [];
  for (const [t, item] of turns.entries()) {
    for (const u of item.usage) {
      const hit = u.cacheReadTokens || 0;
      const miss = u.inputTokens || 0;
      rows.push({ turn: t + 1, context: hit + miss, hit, miss, out: u.outputTokens || 0 });
    }
  }
  let peak = 0;
  let reclaimed = 0;
  const drops = [];
  for (let i = 1; i < rows.length; i += 1) {
    const d = rows[i - 1].context - rows[i].context;
    if (d > 500) {
      reclaimed += d;
      drops.push({ step: i, from: rows[i - 1].context, to: rows[i].context });
    }
  }
  for (const r of rows) peak = Math.max(peak, r.context);
  const hit = rows.reduce((n, r) => n + r.hit, 0);
  const miss = rows.reduce((n, r) => n + r.miss, 0);
  return { steps: rows.length, peak, peakPct: Math.round((peak / WINDOW) * 1000) / 10, final: rows.at(-1)?.context || 0, reclaimed, drops, hitRate: Math.round((hit / Math.max(1, hit + miss)) * 1000) / 10, inputTotal: hit + miss, missTotal: miss, outputTotal: rows.reduce((n, r) => n + r.out, 0), contexts: rows.map((r) => r.context) };
}

function layers(events) {
  const out = { officialSummaries: 0, strataFolds: 0, strataCuts: 0, droppedSnapshots: 0, failedSummaries: 0, compressCalls: 0, nudges: 0, otherCompactions: 0 };
  for (const e of events) {
    if (e.type === "compaction/summary") {
      const text = (e.data?.summary || []).map((b) => b.text || "").join("\n");
      if (/\[strata:fold/.test(text)) out.strataFolds += 1;
      else if (/\[strata:dropped/.test(text)) out.droppedSnapshots += 1;
      else if (/Strata card\./.test(text) || /\[strata:card/.test(text)) out.strataCuts += 1;
      else if (/\[strata:full/.test(text) || e.data?.turn !== null) out.officialSummaries += 1;
      else out.otherCompactions += 1;
    }
    if (e.type === "compaction/end" && e.data?.error) out.failedSummaries += 1;
    if (e.type === "assistant/message") {
      for (const block of e.data?.message?.content || []) if (block.type === "tool-call" && /^(compress|acp_compress)$/.test(block.name || block.toolName || "")) out.compressCalls += 1;
    }
    if (e.type === "user/message" && /^(strata|bili|acp)/.test(e.data?.source?.kind || "")) out.nudges += 1;
  }
  return out;
}

const results = {};
const strataTgz = ARMS.some((a) => a.startsWith("strata")) ? pack(repo) : "";
const biliTgz = process.env.BILI_TGZ ? resolve(process.env.BILI_TGZ) : "";
console.log(`work dir ${work}; window ${WINDOW}; arms ${ARMS.join(",")}`);
for (const arm of ARMS) {
  let h;
  if (arm.startsWith("strata")) h = home(arm, [process.env[`TGZ_${arm.toUpperCase().replace(/-/g, "_")}`] || strataTgz], strataPatch, STRATA_ENV);
  else if (arm === "bili") {
    if (!biliTgz || !existsSync(biliTgz)) throw new Error("BILI_TGZ missing");
    const dir = join(work, arm);
    mkdirSync(dir, { recursive: true });
    h = home(arm, [biliTgz], "", biliEnv(dir));
  } else if (arm === "stock") h = home(arm, [], `
- id: compaction-basic
  config:
    thresholdRatio: 0.8
    headroomTokens: ${s(65536)}
    maxTokens: 8192
`, {});
  else throw new Error(`unknown arm ${arm}`);
  const turns = [];
  for (const prompt of prompts()) {
    turns.push(turn(h, prompt));
    const c = curve(turns);
    console.log(`${arm} turn ${turns.length}: exit ${turns.at(-1).status}, ${turns.at(-1).usage.length} requests, ${turns.at(-1).seconds}s, context ${c.final} (peak ${c.peak}), hit ${c.hitRate}%`);
  }
  const events = sessionEvents(h);
  results[arm] = { curve: curve(turns), layers: layers(events), exits: turns.map((t) => t.status), tools: turns.flatMap((t) => t.tools).reduce((m, t) => ({ ...m, [t]: (m[t] || 0) + 1 }), {}), finals: turns.map((t) => t.final.slice(0, 400)), stderr: turns.map((t) => t.stderrTail), sessionId: h.sessionId, home: h.dir };
  writeFileSync(join(work, "results.json"), JSON.stringify(results, null, 2));
}
for (const [arm, r] of Object.entries(results)) console.log(arm, JSON.stringify({ ...r.curve, contexts: undefined, drops: r.curve.drops.length }), JSON.stringify(r.layers));
