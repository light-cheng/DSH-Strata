#!/usr/bin/env node
// Repro for "fixed overhead keeps growing": each turn reads five ~11K-token
// log files in full; STRATA_MEASURE_TRACE records DSH's totalTokens,
// surfaceTokens, the row sum and Strata's fixed / scale at every turn end.
//   DSH_BIN=… DSH_EVAL_PATCH=magpie.patch.yml DEEPSEEK_BASE_URL=… DEEPSEEK_API_KEY=local node eval/measure-repro.mjs
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const DSH = process.env.DSH_BIN || "dsh";
const TURNS = Number(process.env.REPRO_TURNS || 4);
const work = process.env.REPRO_WORK || join(here, ".work", `measure-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(join(work, "ws", "logs"), { recursive: true });
const sh = (c, a, o = {}) => spawnSync(c, a, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...o });
const packed = JSON.parse(sh("npm", ["pack", "--pack-destination", work, "--json", "--ignore-scripts"], { cwd: repo }).stdout);
const tgz = join(work, (Array.isArray(packed) ? packed : Object.values(packed))[0].filename);
const trace = join(work, "measure-trace.jsonl");
const env = { ...process.env, DSH_HOME: join(work, "home"), STRATA_MEASURE_TRACE: trace };
const added = sh(DSH, ["plugin", "--profile", "headless", "add", tgz], { env });
if (added.status !== 0) throw new Error(added.stderr.slice(-500));
const patch = join(work, "patch.yml");
writeFileSync(patch, `${process.env.DSH_EVAL_PATCH ? readFileSync(resolve(process.env.DSH_EVAL_PATCH), "utf8") : ""}\n- id: compaction-strata\n  config:\n    auto: true\n    maxTokens: 8192\n`);
for (let d = 0; d < TURNS * 5; d += 1) {
  const lines = [];
  for (let i = 0; i < 520; i += 1) lines.push(`2026-11-${String((d % 28) + 1).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")}.${String(i * 13 % 1000).padStart(3, "0")}Z worker-${i % 8} req=${100000 + d * 1000 + i} lat_ms=${(i * 37) % 997} bytes=${(i * 7919) % 65536} status=${i === 300 ? 500 : 200}${i === 300 ? ` E0${3700 + d}` : ""}`);
  writeFileSync(join(work, "ws", "logs", `day${String(d).padStart(2, "0")}.log`), `${lines.join("\n")}\n`);
}
let sessionId = "";
for (let t = 0; t < TURNS; t += 1) {
  const files = Array.from({ length: 5 }, (_, k) => `logs/day${String(t * 5 + k).padStart(2, "0")}.log`);
  const args = ["--profile", "headless", "--patch", patch, "--json"];
  if (sessionId) args.push("--session-id", sessionId);
  args.push(`Read ${files.join(", ")} in full with the read tool, one file per step (no parallel calls, no shell). Then reply with one line per file: its name and the error code on the status=500 line.`);
  const r = sh(DSH, args, { env, cwd: join(work, "ws"), timeout: 30 * 60 * 1000 });
  const events = r.stdout.split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  sessionId ||= events.find((e) => e.sessionId)?.sessionId || "";
  const usage = events.map((e) => e.usage).filter(Boolean).at(-1) || {};
  console.log(`turn ${t + 1}: exit ${r.status}; last request prompt ${(usage.inputTokens || 0) + (usage.cacheReadTokens || 0)}`);
}
if (existsSync(trace)) for (const line of readFileSync(trace, "utf8").trim().split("\n")) {
  const r = JSON.parse(line);
  console.log(r.label, { total: r.total, surface: r.surface, rowSum: r.rowSum, gap: r.gap, tools: r.tools, system: r.system, scale: r.scale, fixed: r.fixed, breakdown: r.breakdown, raw: r.raw, foldable: r.foldable });
}
