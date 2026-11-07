#!/usr/bin/env node
// Summarize eval/preset-compare.mjs results: occupancy per turn, cache cost,
// re-billed and reclaimed tokens, folds, recall.
//   node eval/preset-report.mjs eval/.work/preset/results-*.json
import { readFileSync } from "node:fs";

const HIT = 0.1;
const k = (n) => `${Math.round(n / 1000)}K`;
const pct = (n) => `${(n * 100).toFixed(1)}%`;

export function summarize(r) {
  const work = r.turns.filter((t) => !t.label.startsWith("ask"));
  const requests = work.flatMap((t) => t.usage.map((u) => ({ ...u, turn: t.label, prompt: u.input + u.cacheRead })));
  let rebilled = 0;
  let previous = 0;
  for (const req of requests) {
    // New content is what the prompt grew by; any miss beyond it was billed again.
    const fresh = Math.max(0, req.prompt - previous);
    rebilled += Math.max(0, req.input - fresh);
    previous = req.prompt;
  }
  // Landings inside a turn: a request whose miss is well above what the prompt
  // grew by. Its extra cost is 0.9 × re-billed (miss instead of hit); each later
  // request saves 0.1 × reclaimed. Payback = 9 × re-billed / reclaimed requests.
  const landings = [];
  for (const t of work) {
    const prompts = t.usage.map((u) => u.input + u.cacheRead);
    const steps = prompts.slice(1).map((p, i) => p - prompts[i]).filter((d) => d > 0).sort((a, b) => a - b);
    const step = steps[Math.floor(steps.length / 2)] || 0;
    for (let i = 1; i < t.usage.length; i += 1) {
      const fresh = Math.max(0, prompts[i] - prompts[i - 1]);
      const re = t.usage[i].input - fresh;
      if (re < 20_000) continue;
      const reclaimed = Math.max(0, prompts[i - 1] + step - prompts[i]);
      landings.push({ turn: t.label, request: i + 1, of: prompts.length, before: prompts[i - 1], after: prompts[i], rebilled: re, reclaimed, payback: reclaimed > 0 ? (9 * re) / reclaimed : Infinity, left: prompts.length - i - 1 });
    }
  }
  const miss = requests.reduce((s, u) => s + u.input, 0);
  const hit = requests.reduce((s, u) => s + u.cacheRead, 0);
  const cost = miss + HIT * hit;
  const perTurn = work.map((t) => {
    const prompts = t.usage.map((u) => u.input + u.cacheRead);
    return { label: t.label, first: prompts[0] || 0, peak: Math.max(0, ...prompts), last: prompts.at(-1) || 0, requests: prompts.length, growth: (prompts.at(-1) || 0) - (prompts[0] || 0) };
  });
  const scale = r.trace.length ? r.trace.reduce((s, x) => s + x.scale, 0) / r.trace.length : 1;
  const reclaimed = r.compactions.reduce((s, c) => s + Math.max(0, (c.shadowed || 0) - (c.chars || 0) / 4), 0) * scale;
  const midTurn = r.trace.filter((x) => x.label === "mid-turn").length;
  const peaks = perTurn.map((t) => t.peak / r.window);
  return {
    arm: r.arm,
    env: r.env,
    requests: requests.length,
    miss,
    hit,
    output: requests.reduce((s, u) => s + u.output, 0),
    cost,
    costPerRequest: cost / requests.length,
    hitRate: hit / (hit + miss),
    rebilled,
    reclaimed: Math.max(0, reclaimed),
    folds: Object.fromEntries(["auto", "model", "card", "official"].map((kind) => [kind, r.compactions.filter((c) => (c.kind || (c.model === "strata-card" ? "card" : c.provider === "local" ? "model" : "official")) === kind).length])),
    midTurn,
    meanPeak: peaks.reduce((s, x) => s + x, 0) / peaks.length,
    maxPeak: Math.max(...peaks),
    perTurn,
    landings,
    // Heavy turns: how many of the turn's FAULT codes its own final answer lists (in-turn recall
    // after its early rounds were digested), and how many tool calls it took for 18 commands.
    heavy: work.filter((t) => /^heavy\d*$/.test(t.label)).map((t) => {
      const h = t.label === "heavy" ? 0 : Number(t.label.slice(5)) - 1;
      const n = 18;
      const codes = Array.from({ length: n }, (_, i) => `F${7700 + i + h * n}`);
      return { label: t.label, codes: codes.filter((c) => (t.final || "").includes(c)).length, of: n, calls: t.tools.length, requests: t.usage.length };
    }),
    safety: r.safety || null,
    restore: r.asked.restore || null,
    closed: r.asked.closed.correct,
    open: r.asked.open.correct,
    openTools: r.asked.open.tools,
    heavyFaults: r.heavyFaults ?? null,
    heavySteps: r.heavySteps ?? null,
    reload: r.reload ? { tagErrors: r.reload.turnTagErrors.length, heavyDigests: r.reload.heavyDigests.length, decompress: r.reload.decompress ? `${r.reload.decompress.found.length}/${r.reload.decompress.expected.length}` : "-" } : null,
    missed: { closed: r.asked.closed.score.filter((s) => !s.ok).map((s) => s.id), open: r.asked.open.score.filter((s) => !s.ok).map((s) => s.id) },
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const rows = process.argv.slice(2).map((file) => ({ file, s: summarize(JSON.parse(readFileSync(file, "utf8"))) }));
  console.log("| arm | requests | mean peak | max peak | miss | hit | cost (miss+0.1·hit) | cost/request | output | re-billed | reclaimed | folds auto/model/card/L∞ | mid-turn | closed | open | heavy FAULTs |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const { s } of rows) console.log(`| ${s.arm} | ${s.requests} | ${pct(s.meanPeak)} | ${pct(s.maxPeak)} | ${k(s.miss)} | ${k(s.hit)} | ${k(s.cost)} | ${k(s.costPerRequest)} | ${k(s.output)} | ${k(s.rebilled)} | ${k(s.reclaimed)} | ${s.folds.auto}/${s.folds.model}/${s.folds.card}/${s.folds.official} | ${s.midTurn} | ${s.closed}/12 | ${s.open}/12 | ${s.heavyFaults ?? "-"}/${s.heavySteps ?? "-"} |`);
  for (const { s } of rows) {
    console.log(`\n${s.arm}: occupancy per turn (first → peak → last, provider)`);
    console.log(s.perTurn.map((t) => `${t.label} ${pct(t.first / 1e6)}→${pct(t.peak / 1e6)}→${pct(t.last / 1e6)} (+${k(t.growth)}, ${t.requests} req)`).join("\n"));
    if (s.reload) console.log(`reload: compaction turn-tag errors ${s.reload.tagErrors}; heavy-turn digests ${s.reload.heavyDigests}; decompress after reload ${s.reload.decompress}`);
    for (const l of s.landings) console.log(`landing in ${l.turn} before request ${l.request}/${l.of}: ${k(l.before)} → ${k(l.after)}, re-billed ${k(l.rebilled)}, reclaimed ~${k(l.reclaimed)}, pays back after ~${Number.isFinite(l.payback) ? l.payback.toFixed(1) : "∞"} requests (${l.left} left in the turn)`);
    if (s.heavy?.length) console.log(`in-turn answers: ${s.heavy.map((h) => `${h.label} ${h.codes}/${h.of} codes, ${h.calls} calls`).join("; ")}`);
    if (s.safety) console.log(`safety: ${s.safety.mismatched.length} mismatched compaction events; ${s.safety.inOpenTurn.length} landings in an open turn, ${s.safety.currentTurn.length} over the open turn's own rows`);
    if (s.restore) console.log(`restore after reload: ${s.restore.correct}/${s.restore.of} (${s.restore.tools.join(" ") || "no tools"})`);
    console.log(`missed closed ${s.missed.closed.join(",") || "-"}; open ${s.missed.open.join(",") || "-"}; open tools ${s.openTools.join(" ") || "none"}`);
  }
}
