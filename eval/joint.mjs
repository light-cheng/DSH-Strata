#!/usr/bin/env node
// Joint test: dsh-strata × DSH-Mem0 (docs/interop-dsh-mem0.md §5).
//
// Both plugins are packed from local checkouts and installed into throwaway
// DSH_HOMEs under eval/.work/joint-<time>/. DSH-Mem0 talks to its in-memory
// mock server (DSH-Mem0/scripts/mock-mem0-server.mjs), so no real memory store
// is touched. The model goes through whatever DEEPSEEK_BASE_URL / DSH_EVAL_PATCH
// point at (magpie in our runs).
//
//   MEM0_DIR=../DSH-Mem0 DSH_BIN=… DSH_EVAL_PATCH=magpie.patch.yml \
//   DEEPSEEK_BASE_URL=http://127.0.0.1:3425/v1 DEEPSEEK_API_KEY=local \
//   node eval/joint.mjs
//
// Runs
//   both   Strata + Mem0, six turns           → J1 (snapshots), J3 (capture), J4 (cache)
//   mem0   Mem0 only, the same six turns      → J4 baseline
//   fold   Strata + Mem0, four turns + a fold → J2 (fold archive), sweep on a broken prefix
//   small  Strata + Mem0, small window, one long turn that triggers the official summary mid-turn → J3 under L∞

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const MEM0_DIR = resolve(process.env.MEM0_DIR || join(repo, "..", "DSH-Mem0"));
const DSH = process.env.DSH_BIN || "dsh";
const BASE_PATCH = process.env.DSH_EVAL_PATCH ? readFileSync(resolve(process.env.DSH_EVAL_PATCH), "utf8") : "";
const PORT = Number(process.env.MOCK_MEM0_PORT || 18891);
const USER = "dsh-mem0-test-user";
const RUNS = (process.env.JOINT_RUNS || "both,mem0,fold,sweep,small,small-mem0").split(",");
// Strata economics tuned so a short session's fold / stale sweep pays off; the
// defaults (min benefit max(5K, 1% of 1M), 8K stale) never trigger in 6 turns.
const PAYS = { STRATA_MIN_BENEFIT_TOKENS: "500", STRATA_MIN_BENEFIT_RATIO: "0.0001", STRATA_EXPECTED_REQUESTS: "200" };
const RUN_ENV = { fold: PAYS, sweep: { ...PAYS, STRATA_STALE_SWEEP_TOKENS: "1000" } };
const work = join(here, ".work", `joint-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(work, { recursive: true });

function sh(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  return result;
}

function pack(dir) {
  const out = sh("npm", ["pack", "--pack-destination", work, "--json", "--ignore-scripts"], { cwd: dir });
  const parsed = JSON.parse(out.stdout);
  return join(work, (Array.isArray(parsed) ? parsed : Object.values(parsed))[0].filename);
}

const mem0Patch = (topK = 4) => `
- id: dsh-mem0
  config:
    backend: server
    baseUrl: http://127.0.0.1:${PORT}
    authType: none
    userId: ${USER}
    recallTopK: ${topK}
    translateMemories: false
    hygieneEnabled: false
`;
// Each request reserves the adapter's maxTokens (256K default) of output; stock
// pressure compaction needs window − maxTokens − headroom > 0, otherwise it
// warns once per target and never compacts (run 2 hit this on a 60K window).
// The cap lives on llm-deepseek, not agent-default-model.
const smallPatch = `
- id: llm-deepseek
  config:
    defaultContextWindow: 60000
    maxTokens: 8192
- id: compaction-strata
  config:
    thresholdRatio: 0.5
    headroomTokens: 4096
`;

// J5 (budget tiers): summary cap maxTokens 8192 (it defaults to headroomTokens;
// 1024 truncated every official summary, so L∞ never landed). 40K window, stock L∞ only near the hard edge (~87%), L1
// keeps many rounds so pressure climbs through 65% and 75%, and Mem0 recalls
// up to 20 long memories so the block can fill its 2.2K budget.
const budgetPatch = `
- id: llm-deepseek
  config:
    defaultContextWindow: 40000
    maxTokens: 4096
- id: compaction-strata
  config:
    thresholdRatio: 0.95
    headroomTokens: 1024
    maxTokens: 8192
`;
const budgetMem0 = `    memoryBudgetTokens: 2200
    captureStrataFolds: true
`;
const BUDGET_TRACE = join(work, "budget-trace.jsonl");
RUN_ENV.budget = { ...PAYS, STRATA_CONTEXT_WINDOW: "40000", STRATA_KEEP_ROUNDS: "40", STRATA_BUDGET_TRACE: BUDGET_TRACE };
const BUDGET_TURNS = [
  "Read notes/n0.txt, notes/n1.txt and notes/n2.txt in full with the read tool and tell me line 5 of each. Which package manager do I use for notes like these?",
  "Call compress on the range of your previous turn (the three note reads) with a one-line summary, then read notes/n3.txt in full and tell me line 7. What tea do I like while reading notes?",
  "Read notes/n4.txt, notes/n5.txt and notes/n6.txt in full and tell me line 9 of each. Which time zone do I read notes in?",
  "Read notes/n7.txt, notes/n8.txt and notes/n9.txt in full and tell me line 11 of each. Where does my local Qdrant for notes run?",
  "Read notes/n10.txt, notes/n11.txt and notes/n12.txt in full and tell me line 13 of each. In which languages do I write release notes?",
  "Read notes/n13.txt, notes/n14.txt and notes/n15.txt in full and tell me line 15 of each. How do I authenticate npm publishing of notes?",
  "Read notes/n16.txt, notes/n17.txt and notes/n18.txt in full and tell me line 17 of each. Which notes tooling do I prefer?",
  "Call mem0_status and paste its recall budget line verbatim, then call strata_status and paste its first line verbatim.",
];

// Long seed memories that share words with the questions, so recall fills
// the budget instead of returning a few one-liners.
async function seedLongMemories() {
  const topics = ["package manager pnpm Node notes", "oolong tea reading notes", "time zone UTC+8 notes", "local Qdrant notes 6333", "release notes languages English Chinese", "npm publishing passkey notes", "notes tooling preference read files"];
  for (let i = 0; i < 24; i += 1) {
    const topic = topics[i % topics.length];
    const content = `Long memory ${i} about ${topic}: ` + Array.from({ length: 12 }, (_, j) => `detail ${j} of ${topic} for the notes folder`).join("; ");
    await mock("/memories", "POST", { user_id: USER, agent_id: "dsh", messages: [{ role: "user", content }], metadata: { source: "dsh", seed: true } });
  }
}

// J4 under L∞: the same small window with Mem0 only, so DSH's stock engine
// (compaction-basic) runs the official summary with the same thresholds.
const smallStockPatch = `
- id: llm-deepseek
  config:
    defaultContextWindow: 60000
    maxTokens: 8192
- id: compaction-basic
  config:
    thresholdRatio: 0.5
    headroomTokens: 4096
`;

function home(name, packages, extraPatch = "", extraEnv = {}, mem0Extra = "") {
  const dir = join(work, name);
  const cwd = join(dir, "ws");
  mkdirSync(cwd, { recursive: true });
  const env = { ...process.env, ...extraEnv, DSH_HOME: join(dir, "home") };
  for (const pkg of packages) {
    const added = sh(DSH, ["plugin", "--profile", "headless", "add", pkg], { env });
    if (added.status !== 0) throw new Error(`install ${pkg} failed: ${added.stderr.slice(-400)}`);
  }
  const patch = join(dir, "patch.yml");
  writeFileSync(patch, `${BASE_PATCH}\n${mem0Patch(mem0Extra ? 20 : 4)}${mem0Extra}\n${extraPatch}`);
  // A few small files so each turn makes a tool call.
  mkdirSync(join(cwd, "notes"), { recursive: true });
  for (let i = 0; i < 24; i += 1) writeFileSync(join(cwd, "notes", `n${i}.txt`), Array.from({ length: 160 }, (_, j) => `note ${i} line ${j} value=${(i * 7919 + j * 104729) % 1000003}`).join("\n"));
  return { name, dir, cwd, env, patch, sessionId: "" };
}

function turn(h, prompt) {
  const args = ["--profile", "headless", "--patch", h.patch, "--json"];
  if (h.sessionId) args.push("--session-id", h.sessionId);
  args.push(prompt);
  const result = sh(DSH, args, { env: h.env, cwd: h.cwd });
  const events = result.stdout.split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  h.sessionId ||= events.find((event) => event.sessionId)?.sessionId || "";
  const usage = events.map((event) => event.usage).filter(Boolean);
  const final = events.filter((event) => event.type === "final").at(-1)?.text || "";
  return { status: result.status, usage, final, warnings: [...(result.stderr.match(/[^\n]*(compaction failed|strata:|reading 'prepare')[^\n]*/g) || []).slice(0, 5), ...(result.status ? [result.stderr.trim().split("\n").slice(0, 3).join(" | ").slice(0, 300)] : [])], stderr: result.stderr, tools: events.filter((event) => event.type === "tool_call").map((event) => event.tool) };
}

function hitRate(turns) {
  const hit = turns.flatMap((t) => t.usage).reduce((sum, u) => sum + (u.cacheReadTokens || 0), 0);
  const miss = turns.flatMap((t) => t.usage).reduce((sum, u) => sum + (u.inputTokens || 0), 0);
  return { hit, miss, rate: hit + miss ? Math.round((hit / (hit + miss)) * 1000) / 10 : null };
}

function archiveFiles(h) {
  const root = join(h.env.DSH_HOME, "strata");
  if (!existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(path);
    }
  };
  walk(root);
  return out;
}

function sessionEvents(h) {
  const sessions = join(h.env.DSH_HOME, "sessions");
  const found = sh("sh", ["-c", `find "${sessions}" -path "*${h.sessionId}*" -name "*.zstd" | head -1`]).stdout.trim();
  if (!found) return [];
  return sh("zstd", ["-dc", found]).stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

// Plain http with a fresh socket per call: fetch's keep-alive socket outlives
// the mock's 5 s idle timeout during a long turn and the next call dies with
// ECONNRESET.
function mock(path, method = "GET", body) {
  return new Promise((resolveBody, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {};
    const req = request({ host: "127.0.0.1", port: PORT, path, method, agent: false, headers }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        try {
          resolveBody(JSON.parse(raw));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

// Mem0 captures asynchronously after turn/end; headless may exit first. Count
// POST /memories after each turn so a lost capture shows up per turn.
async function memoryPosts() {
  const { log } = await mock("/__log");
  return log.filter((line) => line === "POST /memories").length;
}

// Surface view of runtime-context snapshots: which are still raw, which a
// strata-dropped-context stub replaced, which an L1 card / L2 fold covered.
function snapshotSurface(events) {
  const snapshots = events.filter((e) => e.type === "user/message" && e.data?.source?.kind === "runtime-context").map((e) => e.seq);
  const by = new Map();
  for (const e of events.filter((x) => x.type === "compaction/summary")) {
    for (const seq of e.data?.shadowedSeqs || []) by.set(seq, e.data?.model || e.data?.provider || "?");
  }
  const raw = snapshots.filter((seq) => !by.has(seq));
  return {
    seqs: snapshots,
    raw,
    newestIsRaw: snapshots.length > 0 && raw.includes(snapshots.at(-1)),
    dropped: snapshots.filter((seq) => /dropped/.test(by.get(seq) || "")),
    coveredByCardOrFold: snapshots.filter((seq) => by.has(seq) && !/dropped/.test(by.get(seq))).map((seq) => `${seq}:${by.get(seq)}`),
    breaks: events.filter((x) => x.type === "compaction/summary" && !/dropped/.test(x.data?.model || "")).map((x) => `${x.data?.model}@${x.data?.shadowedRange?.start}`),
  };
}

// J5: per runtime-context snapshot, the recall block size next to the context
// pressure of the request just before it (input + cache read over the window).
function recallVsPressure(events, window) {
  let lastTokens = 0;
  let turnNo = 0;
  const rows = [];
  for (const e of events) {
    if (e.type === "turn/start") turnNo = e.data?.turn;
    if (e.type === "assistant/message") {
      const u = JSON.stringify(e.data || {});
      const input = Number((u.match(/"inputTokens":(\d+)/) || [])[1] || 0);
      const read = Number((u.match(/"cacheReadTokens":(\d+)/) || [])[1] || 0);
      if (input + read) lastTokens = input + read;
    }
    if (e.type === "user/message" && e.data?.source?.kind === "runtime-context") {
      const text = (e.data.content || []).map((b) => b.text || "").join("\n");
      const block = (text.match(/<mem0-relevant-memories>[\s\S]*?<\/mem0-relevant-memories>/) || [""])[0];
      rows.push({ seq: e.seq, turn: turnNo, pressurePct: Math.round((lastTokens / window) * 1000) / 10, pressureAtPct: 0, recallChars: block.length, recallTokensApprox: Math.round(block.length / 3.6) });
    }
  }
  // Context size at the request that carried each snapshot.
  for (const row of rows) {
    const next = events.find((e) => e.seq > row.seq && e.type === "assistant/message" && (usageOf(e).input + usageOf(e).read) > 0);
    if (next) row.pressureAtPct = Math.round(((usageOf(next).input + usageOf(next).read) / window) * 1000) / 10;
  }
  return rows;
}

// J4: every model request with its cache hit/miss, tagged by the last prefix
// change before it (official summary, a Strata layer, or nothing).
function usageOf(e) {
  const u = JSON.stringify(e.data || {});
  return { input: Number((u.match(/"inputTokens":(\d+)/) || [])[1] || 0), read: Number((u.match(/"cacheReadTokens":(\d+)/) || [])[1] || 0) };
}
function cacheTimeline(events) {
  const requests = [];
  let pending = "";
  for (const e of events) {
    if (e.type === "compaction/summary") {
      const model = String(e.data?.model || "");
      pending = /^strata-/.test(model) ? model : e.data?.provider === "local" ? model || "local" : "official";
    }
    if (e.type === "assistant/message") {
      const { input, read } = usageOf(e);
      if (!input && !read) continue;
      requests.push({ seq: e.seq, input, read, after: pending || "steady" });
      pending = "";
    }
  }
  const group = (pick) => {
    const rows = requests.filter(pick);
    const hit = rows.reduce((sum, r) => sum + r.read, 0);
    const miss = rows.reduce((sum, r) => sum + r.input, 0);
    return { requests: rows.length, hit, miss, rate: hit + miss ? Math.round((hit / (hit + miss)) * 1000) / 10 : null };
  };
  return {
    all: group(() => true),
    steady: group((r) => r.after === "steady"),
    afterOfficial: group((r) => r.after === "official"),
    afterStrata: group((r) => /^strata-/.test(r.after)),
    officialSummaries: requests.filter((r) => r.after === "official").length,
    rows: requests.map((r) => `${r.seq}:${r.after === "steady" ? "" : r.after + " "}${r.read}/${r.input}`),
  };
}

// J5 verdict per tier. Stage from the request that carried the snapshot
// (input + cache read over the window); expected recall: normal = baseline,
// tight ≤ half of the normal baseline, critical ≤ 512 tokens. Token counts are
// chars / 3.6, so bounds get 10% slack.
// J5 from Strata's own view: each recall snapshot paired with the last
// strataBudget allowance call for mem0:recall before it (STRATA_BUDGET_TRACE).
function tracedTiers(events, traceFile) {
  if (!existsSync(traceFile)) return null;
  const calls = readFileSync(traceFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((c) => c.name === "mem0:recall");
  const expected = (stage, wanted) => (stage === "critical" ? Math.min(wanted, 512) : stage === "tight" ? Math.floor(wanted / 2) : wanted);
  const rows = [];
  for (const e of events) {
    if (!(e.type === "user/message" && e.data?.source?.kind === "runtime-context")) continue;
    const call = calls.filter((c) => c.at <= e.time).at(-1);
    if (!call) continue;
    const text = (e.data.content || []).map((b) => b.text || "").join("\n");
    const block = (text.match(/<mem0-relevant-memories>[\s\S]*?<\/mem0-relevant-memories>/) || [""])[0];
    const tokens = Math.round(block.length / 3.6);
    rows.push({ seq: e.seq, pct: Math.round(call.ratio * 1000) / 10, stage: call.stage, allowance: call.allowance, ruleOk: call.allowance === expected(call.stage, call.wanted), recallChars: block.length, recallTokensApprox: tokens, fits: tokens <= Math.ceil(call.allowance * 1.1) });
  }
  const tier = (stage) => {
    const sample = rows.filter((r) => r.stage === stage && r.recallChars > 0);
    return { samples: sample.map((r) => `${r.pct}%: allowance ${r.allowance}, recall ~${r.recallTokensApprox} tok (${r.recallChars} ch)`), pass: sample.length > 0 && sample.every((r) => r.ruleOk && r.fits) };
  };
  return { calls: calls.length, normal: tier("normal"), tight: tier("tight"), critical: tier("critical"), rows };
}

function budgetTiers(rows) {
  const tier = (pct) => (pct >= 75 ? "critical" : pct >= 65 ? "tight" : "normal");
  const withBlock = rows.filter((r) => r.pressureAtPct > 0 && r.recallChars > 0);
  const normal = withBlock.filter((r) => tier(r.pressureAtPct) === "normal").map((r) => r.recallTokensApprox);
  const baseline = normal.length ? Math.max(...normal) : 0;
  const verdict = (name, limit) => {
    const sample = withBlock.filter((r) => tier(r.pressureAtPct) === name);
    const worst = sample.length ? Math.max(...sample.map((r) => r.recallTokensApprox)) : null;
    return { samples: sample.map((r) => `${r.pressureAtPct}%→${r.recallTokensApprox}`), worst, limit, pass: sample.length > 0 && worst <= limit };
  };
  return {
    baselineNormal: baseline,
    normal: { ...verdict("normal", Math.round(2200 * 1.1)) },
    tight: verdict("tight", Math.round((baseline / 2) * 1.1)),
    critical: verdict("critical", Math.round(512 * 1.1)),
  };
}

const MODEL = (BASE_PATCH.match(/model:\s*["']?([^\s"']+)/) || [])[1] || "(from profile)";

const QUESTIONS = [
  "Which package manager and Node version do I use? Also list the notes folder with your tools.",
  "What tea do I like? Read notes/n1.txt and tell me its line count.",
  "Which time zone am I in? Read notes/n2.txt and give me line 10.",
  "Where does my local Qdrant run? Read notes/n3.txt and give me line 20.",
  "In which languages do I write release notes? Read notes/n4.txt and give me line 30.",
  "How do I authenticate npm publishing? Read notes/n5.txt and give me line 40.",
];

const results = {};
console.log(`work dir ${work}`);
const strataTgz = pack(repo);
const mem0Tgz = pack(MEM0_DIR);
const server = spawn(process.execPath, [join(MEM0_DIR, "scripts", "mock-mem0-server.mjs")], { env: { ...process.env, MOCK_MEM0_PORT: String(PORT), MOCK_MEM0_USER: USER }, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));

try {
  for (const name of RUNS) {
    await mock("/__reset", "POST");
    const mem0Only = name === "mem0" || name === "small-mem0";
    const packages = mem0Only ? [mem0Tgz] : [strataTgz, mem0Tgz];
    const extraPatch = name === "small" ? smallPatch : name === "small-mem0" ? smallStockPatch : name === "budget" ? budgetPatch : "";
    const h = home(name, packages, extraPatch, RUN_ENV[name] || {}, name === "budget" ? budgetMem0 : "");
    if (name === "budget") await seedLongMemories();
    const seededPosts = name === "budget" ? await memoryPosts() : 0;
    const turns = [];
    if (name === "both" || name === "mem0" || name === "sweep") {
      for (const q of QUESTIONS) {
        turns.push(turn(h, q));
        await new Promise((r) => setTimeout(r, 1500));
        turns.at(-1).posts = await memoryPosts();
      }
    } else if (name === "fold") {
      for (const q of QUESTIONS.slice(0, 4)) turns.push(turn(h, q));
      turns.push(turn(h, "Call strata_status with detail, then compress the oldest foldable range (the first two answered questions) into a one-line summary. Reply with the first line compress returned."));
      turns.push(turn(h, QUESTIONS[4]));
    } else if (name === "budget") {
      for (const q of BUDGET_TURNS) turns.push(turn(h, q));
    } else if (name === "small" || name === "small-mem0") {
      turns.push(turn(h, "Remember that the project codename is HALCYON. Reply OK."));
      turns.push(turn(h, "Read every file notes/n0.txt through notes/n23.txt in full with the read tool, one per step, then tell me line 77 of notes/n23.txt and remind me of the project codename."));
    }
    const status = mem0Only || name === "budget" ? null : turn(h, "Call strata_status and paste its 'Runtime context:' line and its first line verbatim. Nothing else.");
    const files = archiveFiles(h);
    // A recall block, not Mem0's system-prompt guidance that names the tag.
    const leaked = files.filter((file) => /<mem0-relevant-memories>\s*\n|Relevant long-term memories for this user/.test(readFileSync(file, "utf8")));
    const profileInArchive = files.filter((file) => readFileSync(file, "utf8").includes("<mem0-user-profile>")).length;
    const events = sessionEvents(h);
    const userOriginals = events.filter((e) => e.type === "user/message" && e.data?.source?.kind === "user").map((e) => (e.data.content || []).map((b) => b.text || "").join("\n").trim());
    const snapshots = events.filter((e) => e.type === "user/message" && e.data?.source?.kind === "runtime-context");
    await new Promise((r) => setTimeout(r, 2000));
    const captures = ((await mock("/__captures")).captures || []).map((c) => c.body || c);
    // Auto-capture (turn end) carries session_id and no via; mem0_add tool
    // calls by the model and fold captures are counted separately.
    const autoCaptures = captures.filter((c) => c.metadata?.session_id && !c.metadata?.via);
    const toolCaptures = captures.filter((c) => !c.metadata?.session_id);
    const capturedUser = autoCaptures.flatMap((c) => (c.messages || []).filter((m) => m.role === "user").map((m) => String(m.content).trim()));
    const capturedAssistant = autoCaptures.flatMap((c) => (c.messages || []).filter((m) => m.role === "assistant").map((m) => String(m.content).trim()));
    const finals = [...turns, ...(status ? [status] : [])].map((t) => t.final.trim()).filter(Boolean);
    results[name] = {
      exits: turns.map((t) => t.status),
      warnings: [...new Set(turns.flatMap((t) => t.warnings))],
      peakRequestTokens: Math.max(0, ...turns.flatMap((t) => t.usage).map((u) => (u.inputTokens || 0) + (u.cacheReadTokens || 0))),
      cache: hitRate(turns),
      model: MODEL,
      postsAfterEachTurn: turns.map((t) => t.posts).filter((n) => n !== undefined),
      snapshotsAppended: snapshots.length,
      snapshotSurface: snapshotSurface(events),
      snapshotsWithRecall: snapshots.filter((e) => JSON.stringify(e.data.source.sections || []).includes("mem0:recall")).length,
      runtimeLine: status ? (status.final.match(/Runtime context:[^\n]*/) || [""])[0] : "",
      statusFirstLine: status ? (status.final.split("\n").find((line) => line.trim() && !line.startsWith("```")) || "").slice(0, 160) : "",
      archiveFiles: files.length,
      archiveFilesWithRecallText: leaked.map((file) => file.split("/strata/")[1]),
      archiveFilesWithProfile: profileInArchive,
      captures: captures.length,
      autoCaptures: autoCaptures.length,
      toolCaptures: toolCaptures.map((c) => ({ infer: c.infer, metadata: c.metadata, text: String(c.messages?.[0]?.content || "").slice(0, 160) })),
      userCapturedNotVerbatim: capturedUser.filter((text) => !userOriginals.includes(text)).map((t) => t.slice(0, 120)),
      userCapturedVerbatim: capturedUser.filter((text) => userOriginals.includes(text)).length + "/" + capturedUser.length,
      assistantCapturedIsAFinalReply: capturedAssistant.filter((text) => finals.some((f) => f.startsWith(text.slice(0, 200)) || text.startsWith(f.slice(0, 200)))).length + "/" + capturedAssistant.length,
      officialSummaries: events.filter((e) => e.type === "compaction/summary" && !/^strata-/.test(e.data?.model || "") && e.data?.provider !== "local").length,
      folds: files.filter((file) => /fold-f\d+\.json$/.test(file)).map((file) => {
        const fold = JSON.parse(readFileSync(file, "utf8"));
        const snaps = new Set(snapshots.map((e) => e.seq));
        return {
          id: fold.id,
          seqs: fold.seqs,
          dropped: fold.dropped,
          staleSnapshotsInRange: (fold.seqs || []).filter((seq) => snaps.has(seq)),
          childSnapshotsWithText: (fold.children || []).filter((child) => snaps.has(child.seq) && child.text).map((child) => child.seq),
          summaryHasRecall: /mem0-relevant-memories|Relevant long-term memories|Current runtime context/.test(`${fold.summary} ${JSON.stringify(fold.nodes || [])}`),
        };
      }),
      capturesDetail: captures.map((c) => ({ infer: c.infer, metadata: c.metadata, messages: (c.messages || []).map((m) => ({ role: m.role, content: String(m.content).slice(0, 300) })) })),
      finals: finals.map((f) => f.slice(0, 300)),
      recallVsPressure: name === "budget" ? recallVsPressure(events, 40000) : undefined,
      budgetTiers: name === "budget" ? budgetTiers(recallVsPressure(events, 40000)) : undefined,
      budgetTraced: name === "budget" ? tracedTiers(events, BUDGET_TRACE) : undefined,
      cacheTimeline: cacheTimeline(events),
      foldCaptures: captures.filter((c) => c.metadata?.via === "dsh-strata").map((c) => ({ metadata: c.metadata, infer: c.infer, hasAbsolutePath: /\/(Users|home|private|tmp)\//.test(JSON.stringify(c)), text: String(c.messages?.[0]?.content || "").slice(0, 200) })),
      seededPosts: seededPosts || undefined,
      budgetStatusReply: name === "budget" ? turns.at(-1)?.final.slice(0, 400) : undefined,
      foldTurnReply: name === "fold" ? turns[4]?.final.slice(0, 200) : undefined,
      sessionId: h.sessionId,
    };
    console.log(name, JSON.stringify(results[name]));
  }
} finally {
  server.kill();
}
writeFileSync(join(work, "results.json"), JSON.stringify(results, null, 2));
console.log(`Saved ${join(work, "results.json")}`);
