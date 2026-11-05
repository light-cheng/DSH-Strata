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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const MEM0_DIR = resolve(process.env.MEM0_DIR || join(repo, "..", "DSH-Mem0"));
const DSH = process.env.DSH_BIN || "dsh";
const BASE_PATCH = process.env.DSH_EVAL_PATCH ? readFileSync(resolve(process.env.DSH_EVAL_PATCH), "utf8") : "";
const PORT = Number(process.env.MOCK_MEM0_PORT || 18891);
const USER = "dsh-mem0-test-user";
const RUNS = (process.env.JOINT_RUNS || "both,mem0,fold,small").split(",");
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

const mem0Patch = `
- id: dsh-mem0
  config:
    backend: server
    baseUrl: http://127.0.0.1:${PORT}
    authType: none
    userId: ${USER}
    recallTopK: 4
    translateMemories: false
    hygieneEnabled: false
`;
const smallPatch = `
- id: llm-deepseek
  config:
    defaultContextWindow: 60000
- id: compaction-strata
  config:
    thresholdRatio: 0.5
    headroomTokens: 4096
`;

function home(name, packages, extraPatch = "") {
  const dir = join(work, name);
  const cwd = join(dir, "ws");
  mkdirSync(cwd, { recursive: true });
  const env = { ...process.env, DSH_HOME: join(dir, "home") };
  for (const pkg of packages) {
    const added = sh(DSH, ["plugin", "--profile", "headless", "add", pkg], { env });
    if (added.status !== 0) throw new Error(`install ${pkg} failed: ${added.stderr.slice(-400)}`);
  }
  const patch = join(dir, "patch.yml");
  writeFileSync(patch, `${BASE_PATCH}\n${mem0Patch}\n${extraPatch}`);
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
  return { status: result.status, usage, final, stderr: result.stderr, tools: events.filter((event) => event.type === "tool_call").map((event) => event.tool) };
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

async function mock(path, method = "GET") {
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, { method });
  return response.json();
}

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
    const packages = name === "mem0" ? [mem0Tgz] : [strataTgz, mem0Tgz];
    const h = home(name, packages, name === "small" ? smallPatch : "");
    const turns = [];
    if (name === "both" || name === "mem0") {
      for (const q of QUESTIONS) turns.push(turn(h, q));
    } else if (name === "fold") {
      for (const q of QUESTIONS.slice(0, 4)) turns.push(turn(h, q));
      turns.push(turn(h, "Call strata_status with detail, then compress the oldest foldable range (the first two answered questions) into a one-line summary. Reply with the first line compress returned."));
      turns.push(turn(h, QUESTIONS[4]));
    } else if (name === "small") {
      turns.push(turn(h, "Remember that the project codename is HALCYON. Reply OK."));
      turns.push(turn(h, "Read every file notes/n0.txt through notes/n23.txt in full with the read tool, one per step, then tell me line 77 of notes/n23.txt and remind me of the project codename."));
    }
    const status = name === "mem0" ? null : turn(h, "Call strata_status and paste its 'Runtime context:' line and its first line verbatim. Nothing else.");
    const files = archiveFiles(h);
    const leaked = files.filter((file) => readFileSync(file, "utf8").includes("<mem0-relevant-memories>"));
    const events = sessionEvents(h);
    const userOriginals = events.filter((e) => e.type === "user/message" && e.data?.source?.kind === "user").map((e) => (e.data.content || []).map((b) => b.text || "").join("\n").trim());
    const snapshots = events.filter((e) => e.type === "user/message" && e.data?.source?.kind === "runtime-context");
    const captures = (await mock("/__captures")).captures || [];
    const capturedUser = captures.flatMap((c) => (c.messages || []).filter((m) => m.role === "user").map((m) => String(m.content).trim()));
    const capturedAssistant = captures.flatMap((c) => (c.messages || []).filter((m) => m.role === "assistant").map((m) => String(m.content).trim()));
    const finals = turns.map((t) => t.final.trim()).filter(Boolean);
    results[name] = {
      exits: turns.map((t) => t.status),
      cache: hitRate(turns),
      snapshotsAppended: snapshots.length,
      snapshotsWithRecall: snapshots.filter((e) => JSON.stringify(e.data.source.sections || []).includes("mem0:recall")).length,
      runtimeLine: status ? (status.final.match(/Runtime context:[^\n]*/) || [""])[0] : "",
      statusFirstLine: status ? status.final.split("\n")[0].slice(0, 160) : "",
      archiveFiles: files.length,
      archiveFilesWithRecallText: leaked.map((file) => file.split("/strata/")[1]),
      captures: captures.length,
      userCapturedVerbatim: capturedUser.filter((text) => userOriginals.includes(text)).length + "/" + capturedUser.length,
      assistantCapturedIsAFinalReply: capturedAssistant.filter((text) => finals.some((f) => f.startsWith(text.slice(0, 200)) || text.startsWith(f.slice(0, 200)))).length + "/" + capturedAssistant.length,
      officialSummaries: events.filter((e) => e.type === "compaction/summary" && !/^strata-/.test(e.data?.model || "") && e.data?.provider !== "local").length,
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
