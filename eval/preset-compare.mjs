#!/usr/bin/env node
// Preset comparison (cost first vs quality first) on the user's work shape.
//
// One session per arm, 1M window:
//   3 planting turns (the 12 recall facts of eval/recall-auto.mjs);
//   PRESET_TURNS turns that each read 5 dense ~13K-local logs in parallel (one round);
//   1 heavy turn: PRESET_HEAVY_STEPS sequential shell steps of ~25K provider each
//     (the user's long pwsh / read_image turns, 100–450K per turn);
//   then the workspace is deleted and the 12 questions are asked closed-book (on a
//   copy of the DSH home) and open-book (decompress / search_context allowed).
//
// After the asks, a reload check: every compaction event carries the turn that
// was open when it was written, and a new dsh process restores a digest that
// landed inside the heavy turn with decompress.
//
// Recorded: every request's prompt size and cache split (from dsh --json usage),
// Strata's turn-end / after-flush / mid-turn trace, folds, recall.
//
//   PRESET_ARM=cost|quality|quality-nonudge|quality-nomid|quality-current PRESET_REP=1 \
//   DSH_BIN=… DSH_EVAL_PATCH=magpie.patch.yml DEEPSEEK_BASE_URL=http://127.0.0.1:3425/v1 \
//   DEEPSEEK_API_KEY=local node eval/preset-compare.mjs

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const DSH = process.env.DSH_BIN || "dsh";
const ARM = process.env.PRESET_ARM || "cost";
const REP = process.env.PRESET_REP || "1";
const TURNS = Number(process.env.PRESET_TURNS ?? 10);
const HEAVY = Number(process.env.PRESET_HEAVY_STEPS || 18);
// Number of heavy turns (each HEAVY sequential steps of ~20–25K provider: +370–415K per turn).
const HEAVY_TURNS = Number(process.env.PRESET_HEAVY_TURNS || 1);
const WINDOW = 1_000_000;
const work = resolve(process.env.PRESET_WORK || join(here, ".work", "preset"));
const dir = join(work, `${ARM}-${REP}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(join(dir, "ws"), { recursive: true });

const ARMS = {
  cost: { STRATA_PRESET: "cost" },
  quality: { STRATA_PRESET: "quality" },
  "quality-nonudge": { STRATA_PRESET: "quality", STRATA_NUDGE: "off" },
  "quality-nomid": { STRATA_PRESET: "quality", STRATA_MID_TURN_FOLD: "off" },
  "quality-current": { STRATA_PRESET: "quality", STRATA_MID_TURN_CURRENT: "on" },
  // Mid-turn digests of earlier turns only (the current turn's rounds stay whole).
  "quality-nocurrent": { STRATA_PRESET: "quality", STRATA_MID_TURN_CURRENT: "off" },
};
// Extra STRATA_* overrides for tuning runs: PRESET_ENV="STRATA_AUTO_FOLD_PCT=0.3,STRATA_AUTO_FOLD_TARGET_PCT=0.2".
const extra = Object.fromEntries(String(process.env.PRESET_ENV || "").split(",").filter(Boolean).map((pair) => pair.split("=")));

const sh = (command, args, options = {}) => spawnSync(command, args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024, ...options });

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

// Dense log lines (hashes, ids, numbers) tokenize well above chars/4, as the user's logs did.
function denseLog(day, lines = Number(process.env.PRESET_LOG_LINES || 600)) {
  const random = rng(1000 + day);
  const hex = (n) => Array.from({ length: n }, () => Math.floor(random() * 16).toString(16)).join("");
  const out = [];
  for (let i = 0; i < lines; i += 1) {
    const status = i === 200 ? 500 : 200;
    out.push(`2026-11-${String((day % 28) + 1).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")}Z w${i % 8} req=${hex(12)} trace=${hex(16)} span=${hex(8)} lat=${Math.floor(random() * 997)} b=${Math.floor(random() * 65536)} s=${status}${status === 500 ? ` E${4100 + day}` : ""}`);
  }
  return `${out.join("\n")}\n`;
}

// Recall facts: the planting workspace and questions of eval/recall-auto.mjs.
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
  put("tools/check_db.py", ["import sys", 'print("connecting to db-edge-3:5432 ...")', 'print("ERROR 1045 (28000): Access denied for user \'svc_orchid\'@\'10.4.2.9\' (using password: YES)", file=sys.stderr)', "sys.exit(1)", ""].join("\n"));
  put("tools/verify.py", ["def check(block):", "    raise ValueError('checksum mismatch for block 0x3fa2')", 'print("verifying 64 blocks")', "check(0x3fa2)", ""].join("\n"));
  put("tools/profile.py", ['print("profiling 3 workers for 30s")', "for i in range(3):", '    print(f"worker-{i} cpu_pct {41 + i * 7}")', 'print("peak_rss_kb 482113")', 'print("gc_pauses 12")', ""].join("\n"));
  for (const p of ["build/cache.lock", "app/deps.lock", "vendor/kestrel/pins.lock", "tests/fixtures/seed.lock"]) put(p, "lock\n");
  for (let d = 0; d < TURNS * 5; d += 1) put(`logs/day${String(d).padStart(2, "0")}.log`, denseLog(d));
  // The heavy turn's steps: each prints one dense block (~25K provider).
  put("tools/dump.py", ["import sys, random", "n = int(sys.argv[1])", "random.seed(n)", "for i in range(380):", "    print(f'{n:02d}.{i:03d} ' + ' '.join('%08x' % random.getrandbits(32) for _ in range(9)) + (f' FAULT F{7700 + n}' if i == 250 else ''))", ""].join("\n"));
}

const PLANT = [
  "We're auditing the orchid service in this workspace. Two notes for later: the backup copy lives at /srv/backups/heron-2026-03.tar, and our request budget is 3750 requests per hour. Work step by step, one tool call per step, no parallel calls: read config/deploy.yaml, read docs/adr-012.md, run `python3 tools/check_db.py`, then run `find . -name '*.lock'`. Then summarize what you saw in two sentences.",
  "We decided to use SQLite instead of Postgres for the edge nodes because of the 40 MB memory cap. Next, one tool call per step: run `python3 tools/verify.py`, read logs/worker.log, run `python3 tools/profile.py`. Summarize in two sentences.",
  "Decision for later: rename the queue from 'ingest' to 'intake'. Reply with OK.",
];
const QUESTIONS = [
  { id: "P1", q: "What cache_path does config/deploy.yaml set?", keys: ["/opt/quill/cache/shard-42"] },
  { id: "P2", q: "Which .lock file did find report under vendor/?", keys: ["vendor/kestrel/pins.lock"] },
  { id: "P3", q: "Where does the backup copy live?", keys: ["/srv/backups/heron-2026-03.tar"] },
  { id: "N1", q: "What is max_retries in config/deploy.yaml?", keys: ["173"] },
  { id: "N2", q: "What peak RSS in kB did tools/profile.py report?", keys: ["482113"] },
  { id: "N3", q: "What is our request budget per hour?", keys: [/3[,.]?750/] },
  { id: "E1", q: "What exact error did tools/verify.py raise?", keys: ["checksum mismatch", "0x3fa2"] },
  { id: "E2", q: "What exact error did tools/check_db.py print (user and host)?", keys: ["Access denied", "svc_orchid", "10.4.2.9"] },
  { id: "E3", q: "What warning did logs/worker.log record about a lease (shard and job count)?", keys: ["lease expired", "19", "311"] },
  { id: "D1", q: "Which database did we choose for the edge nodes, and why?", keys: ["SQLite", "40"] },
  { id: "D2", q: "What does ADR-012 decide, and from which date?", keys: ["v1", "2026-12-01"] },
  { id: "D3", q: "What should the queue be renamed to?", keys: ["intake"] },
];
const ASK = {
  closed: "Answer these questions from what is in this conversation only. Do not call any tools. If you do not know, write UNKNOWN. Answer as numbered lines 1-12, one line each.",
  open: "Answer these questions. The workspace files are gone, so do not read files or run commands; if a detail was folded away you may use decompress or search_context to restore it. If you still do not know, write UNKNOWN. Answer as numbered lines 1-12, one line each.",
};
const matches = (text, key) => (key instanceof RegExp ? key.test(text) : text.toLowerCase().includes(key.toLowerCase()));
function score(final) {
  const lines = final.split("\n");
  return QUESTIONS.map((q, i) => {
    const line = lines.find((l) => new RegExp(`^\\s*(?:\\*\\*)?${i + 1}[.):]`).test(l)) || "";
    return { id: q.id, ok: q.keys.every((k) => matches(line, k)), line: line.slice(0, 200) };
  });
}

// A model flake (e.g. malformed tool-call JSON) fails a turn before any request lands; retry it once.
function turn(h, prompt, label) {
  const first = turnOnce(h, prompt, label);
  if (first.status === 0 || first.usage.length > 0) return first;
  return { ...turnOnce(h, prompt, `${label} (retry)`), label, retried: true };
}

function turnOnce(h, prompt, label) {
  const args = ["--profile", "headless", "--patch", h.patch, "--json"];
  if (h.sessionId) args.push("--session-id", h.sessionId);
  args.push(prompt);
  const started = Date.now();
  const result = sh(DSH, args, { env: h.env, cwd: h.cwd, timeout: 40 * 60 * 1000 });
  const events = result.stdout.split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  h.sessionId ||= events.find((event) => event.sessionId)?.sessionId || "";
  const usage = events.map((event) => event.usage).filter(Boolean).map((u) => ({ input: u.inputTokens || 0, cacheRead: u.cacheReadTokens || 0, cacheWrite: u.cacheWriteTokens || 0, output: u.outputTokens || 0 }));
  const out = {
    label,
    status: result.status,
    seconds: Math.round((Date.now() - started) / 1000),
    usage,
    tools: events.filter((event) => event.type === "tool_call").map((event) => event.tool),
    final: events.filter((event) => event.type === "final").at(-1)?.text || "",
    stderr: result.stderr.split("\n").filter((line) => /strata|compaction/i.test(line) && !/trust settings/.test(line)).slice(-20),
  };
  const prompts = usage.map((u) => u.input + u.cacheRead);
  console.log(`${ARM}-${REP} ${label}: exit ${out.status} ${out.seconds}s, ${usage.length} req, prompt ${prompts.map((p) => `${Math.round(p / 1000)}K`).join(" ")}, tools ${out.tools.length}`);
  return out;
}

function sessionEvents(h) {
  const found = sh("sh", ["-c", `find "${join(h.env.DSH_HOME, "sessions")}" -path "*${h.sessionId}*" -name "*.zstd" | head -1`]).stdout.trim();
  if (!found) return [];
  return sh("zstd", ["-dc", found]).stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const packed = process.env.PRESET_TGZ ? resolve(process.env.PRESET_TGZ) : (() => {
  const out = JSON.parse(sh("npm", ["pack", "--pack-destination", dir, "--json", "--ignore-scripts"], { cwd: repo }).stdout);
  return join(dir, (Array.isArray(out) ? out : Object.values(out))[0].filename);
})();
const trace = join(dir, "trace.jsonl");
const env = { ...process.env, DSH_HOME: join(dir, "home"), STRATA_CONTEXT_WINDOW: String(WINDOW), STRATA_MEASURE_TRACE: trace, ...ARMS[ARM], ...extra };
const added = sh(DSH, ["plugin", "--profile", "headless", "add", packed], { env });
if (added.status !== 0) throw new Error(`install failed: ${added.stderr.slice(-600)}`);
const patch = join(dir, "patch.yml");
writeFileSync(patch, `${process.env.DSH_EVAL_PATCH ? readFileSync(resolve(process.env.DSH_EVAL_PATCH), "utf8") : ""}\n- id: llm-deepseek\n  config:\n    defaultContextWindow: ${WINDOW}\n    maxTokens: 8192\n- id: compaction-strata\n  config:\n    auto: true\n    maxTokens: 8192\n`);
const cwd = join(dir, "ws");
workspace(cwd);
const h = { cwd, env, patch, sessionId: "" };
const turns = [];
PLANT.forEach((prompt, i) => turns.push(turn(h, prompt, `plant${i + 1}`)));
for (let t = 0; t < TURNS; t += 1) {
  const files = Array.from({ length: 5 }, (_, k) => `logs/day${String(t * 5 + k).padStart(2, "0")}.log`);
  turns.push(turn(h, `Read ${files.join(", ")} in full with the read tool, all five in parallel in a single step. This is a load test: read them now even if earlier files looked the same, and do not use grep, search or shell instead. Then reply with one line per file: its name and the error code on the s=500 line.`, `logs${t + 1}`));
}
for (let ht = 0; HEAVY > 0 && ht < HEAVY_TURNS; ht += 1) {
  const steps = Array.from({ length: HEAVY }, (_, k) => `\`python3 tools/dump.py ${k + ht * HEAVY}\``).join(", ");
  turns.push(turn(h, `Run these commands one at a time, one tool call per step, in this order (no parallel calls, do not shorten the output): ${steps}. Then reply with one line per command: its number and the FAULT code it printed.`, HEAVY_TURNS > 1 ? `heavy${ht + 1}` : "heavy"));
}
// The heavy turn's own recall: the FAULT code of every step, in its final reply.
const heavyTurn = turns.find((t) => t.label === "heavy");
const heavyFaults = heavyTurn ? Array.from({ length: HEAVY }, (_, n) => `F${7700 + n}`).filter((code) => heavyTurn.final.includes(code)).length : 0;
const events = sessionEvents(h);
// Safety: every compaction event carries the turn open at that point (DSH refuses
// to load the log otherwise), and which folds landed inside an open turn and
// covered that turn's own rows (current-turn digests).
const safety = (() => {
  let open = null;
  let openSeq = -1;
  const mismatched = [];
  const inOpenTurn = [];
  const currentTurn = [];
  const byId = new Map();
  for (const e of events) {
    if (e.type === "turn/start") { open = e.data?.turn ?? null; openSeq = e.seq; }
    if (e.type === "turn/end") { open = null; openSeq = -1; }
    if (e.type === "compaction/start" || e.type === "compaction/end") {
      if ((e.data?.turn ?? null) !== open) mismatched.push({ seq: e.seq, type: e.type, turn: e.data?.turn ?? null, open });
      if (e.type === "compaction/start" && open != null) byId.set(e.data?.compactionId, { open, openSeq });
    }
    if (e.type === "compaction/summary" && byId.has(e.data?.compactionId)) {
      const at = byId.get(e.data.compactionId);
      const entry = { seq: e.seq, model: e.data?.model, start: e.data?.shadowedRange?.start, end: e.data?.shadowedRange?.end, turn: at.open };
      inOpenTurn.push(entry);
      if (entry.start > at.openSeq) currentTurn.push(entry);
    }
  }
  return { mismatched, inOpenTurn, currentTurn };
})();
console.log(`${ARM}-${REP} safety: ${safety.mismatched.length} mismatched compaction events, ${safety.inOpenTurn.length} landings in an open turn, ${safety.currentTurn.length} inside the open turn's own rows`);
const foldTexts = events.filter((e) => e.type === "compaction/summary").map((e) => (e.data?.summary || []).map((b) => b.text || "").join("\n"));
for (const sub of ["config", "docs", "logs", "tools", "build", "app", "vendor", "tests"]) rmSync(join(cwd, sub), { recursive: true, force: true });
const copy = join(dir, "home-closed");
cpSync(env.DSH_HOME, copy, { recursive: true });
const asked = {};
for (const mode of ["closed", "open"]) {
  const t = turn({ ...h, env: mode === "closed" ? { ...env, DSH_HOME: copy } : env }, `${ASK[mode]}\n${QUESTIONS.map((q, i) => `${i + 1}. ${q.q}`).join("\n")}`, `ask-${mode}`);
  const s = score(t.final);
  asked[mode] = { correct: s.filter((x) => x.ok).length, score: s, tools: t.tools, usage: t.usage };
  console.log(`${ARM}-${REP} ${mode}: ${asked[mode].correct}/12`);
}
// Reload check. Compaction events must carry the turn open when they were written.
function turnTags(list) {
  let open = null;
  const bad = [];
  for (const e of list) {
    if (e.type === "turn/start") open = e.data?.turn ?? e.data?.turnId ?? null;
    else if (e.type === "turn/end") open = null;
    else if (e.type === "compaction/start" || e.type === "compaction/end") {
      const tag = e.data?.turn ?? null;
      if (tag !== open) bad.push({ seq: e.seq, type: e.type, tag, open });
    }
  }
  return bad;
}
// Digests that landed inside the heavy turn over its own rounds (mid-turn, current turn).
function heavyDigests(list) {
  const out = [];
  let inHeavy = false;
  for (const e of list) {
    if (e.type === "user/message" && /tools\/dump\.py/.test(JSON.stringify(e.data?.content || ""))) inHeavy = true;
    else if (e.type === "turn/end") inHeavy = false;
    else if (inHeavy && e.type === "compaction/summary" && e.data?.model === "strata-fold") {
      const text = (e.data?.summary || []).map((b) => b.text || "").join("\n");
      const id = text.match(/\[strata:fold\S* id=(\S+?)[\s\]]/)?.[1];
      const codes = [...new Set(text.match(/dump\.py \d+/g) || [])].map((m) => `F${7700 + Number(m.split(" ")[1])}`);
      if (id && codes.length) out.push({ id, codes });
    }
  }
  return out;
}
const reload = { turnTagErrors: turnTags(events), heavyDigests: heavyDigests(events) };
if (reload.heavyDigests.length) {
  const target = reload.heavyDigests[0];
  const t = turn(h, `Call decompress with id ${target.id} (only that tool, once). Then reply with every FAULT code in the restored text, comma-separated.`, "reload-decompress");
  reload.decompress = { id: target.id, status: t.status, tools: t.tools, expected: target.codes, found: target.codes.filter((code) => t.final.includes(code)) };
  const after = sessionEvents(h);
  reload.loadedEvents = after.length;
  reload.turnTagErrorsAfter = turnTags(after);
}
console.log(`${ARM}-${REP} reload: tag errors ${reload.turnTagErrors.length}, heavy digests ${reload.heavyDigests.length}, decompress ${reload.decompress ? `${reload.decompress.found.length}/${reload.decompress.expected.length}` : "-"}, heavy faults ${heavyFaults}/${HEAVY}`);
// Restore check: the heavy turns' early steps were digested (mid-turn when the
// current turn folds); their FAULT codes come back only through decompress /
// search_context, after a reload of the session.
if (HEAVY > 0) {
  const probe = [2, 5].map((n) => ({ n, code: `F${7700 + n}` }));
  const t = turn(h, `The workspace is gone; do not read files or run commands. Use decompress or search_context to restore the output of \`python3 tools/dump.py ${probe[0].n}\` and \`python3 tools/dump.py ${probe[1].n}\` from the first long command turn, and reply with one line per command: its number and the FAULT code it printed.`, "restore");
  asked.restore = { correct: probe.filter((p) => t.final.includes(p.code)).length, of: probe.length, tools: t.tools, final: t.final.slice(0, 400), status: t.status };
  console.log(`${ARM}-${REP} restore: ${asked.restore.correct}/${probe.length} (${t.tools.join(" ")})`);
}
const traceRows = existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const results = {
  arm: ARM,
  env: { ...ARMS[ARM], ...extra },
  sessionId: h.sessionId,
  window: WINDOW,
  turns,
  trace: traceRows,
  compactions: events.filter((e) => e.type === "compaction/summary").map((e) => {
    const text = (e.data?.summary || []).map((b) => b.text || "").join("\n");
    // strata-fold: L2 (auto=1 when Strata wrote it); strata-card: L1; anything else: DSH's official summary (L∞).
    const kind = e.data?.model === "strata-fold" ? (/auto=1|automatic extractive digest/.test(text) ? "auto" : "model") : e.data?.model === "strata-card" ? "card" : e.data?.model === "strata-dropped-context" ? "dropped" : "official";
    return { seq: e.seq, kind, model: e.data?.model, provider: e.data?.provider, shadowed: e.data?.shadowedTokenCount, chars: text.length, head: text.slice(0, 160) };
  }),
  asked,
  heavyFaults,
  heavySteps: HEAVY,
  reload,
  safety,
};
writeFileSync(join(work, `results-${ARM}-${REP}.json`), JSON.stringify(results, null, 2));
// Temp DSH homes go; the results JSON stays.
if (!process.env.PRESET_KEEP) for (const sub of ["home", "home-closed", "ws"]) rmSync(join(dir, sub), { recursive: true, force: true });
console.log(`${ARM}-${REP}: results-${ARM}-${REP}.json`);
