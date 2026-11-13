#!/usr/bin/env node
// Offline eval of the minimum-gain gate for single landings (L1 cards, one
// fold). No model, no DSH: it replays candidate landings through each gate
// policy and scores what they really cost against a session length that the
// gate does not know.
//
//   node eval/landing-gate.mjs [--n 200000] [--seed 7] [--hmin 20 --hmax 400]
//
// Candidates (shapes from the user's 0.4.1 Windows run and the L1 code):
//   span c       log-uniform 1K–32K local tokens (CHUNK_MIN … RAIL_TOKENS)
//   card         c × U(0.05, 1.2): excerpt cards are usually small, but short
//                spans of dense lines can come out nearly as big (906 / 1125)
//                or bigger (1350 / 1125)
//   after        kept rounds U(2K, 32K) + tail beyond them U(0, 2.2K)
//   requests n   uniform 5–300 made so far
//   ratio        provider/local ×U(1, 3) (the user's sessions ran ×1.96–×3.03)
// Truth the gate does not see:
//   session length N, Pareto α = 2 given N ≥ n (the Lindy assumption behind
//     expectedRemainingRequests: E[remaining | n] = n), capped at 2000;
//   the real reclaim differs from the estimate by N(0, 0.06·c) (meter error,
//     the excerpt's backup-claim rewrite), clipped at 0;
//   a saving lasts until the range is folded or summarized: H ~ U(20, 400)
//     requests after landing.
// Score, in cache-miss-priced tokens (hit = 0.1 × miss):
//   net = real reclaim × 0.1 × min(remaining, H) − (c + after − real reclaim) × 0.9

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? Number(args[at + 1]) : fallback;
};
const N = opt("n", 200_000);
let state = opt("seed", 7) >>> 0;
const rand = () => {
  state = (state * 1664525 + 1013904223) >>> 0;
  return state / 4294967296;
};
const uniform = (a, b) => a + (b - a) * rand();
const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
const HMIN = opt("hmin", 20);
const HMAX = opt("hmax", 400);
const HIT = 0.1;
const MISS = 1;

const remainingGuess = (n) => Math.min(200, Math.max(4, n));

function candidate() {
  const c = Math.exp(uniform(Math.log(1000), Math.log(32000)));
  const card = c * uniform(0.05, 1.2);
  const after = uniform(2000, 32000) + uniform(0, 2200);
  const n = Math.floor(uniform(5, 300));
  const ratio = uniform(1, 3);
  const total = Math.min(2000, n / Math.sqrt(1 - rand()));
  const remaining = Math.max(0, total - n);
  const horizon = uniform(HMIN, HMAX);
  const estimate = c - card;
  const real = Math.max(0, estimate + gauss() * 0.06 * c);
  return { c, card, after, n, ratio, remaining, horizon, estimate, real };
}

/** What the gate sees: payback in requests on the estimate. */
function payback(x) {
  if (x.estimate <= 0) return Number.POSITIVE_INFINITY;
  return ((x.c + x.after - x.estimate) * (MISS - HIT)) / (x.estimate * HIT);
}

const POLICIES = {
  "0.4.1 (card < span only)": (x) => x.estimate > 0,
  "floor 1K only": (x) => x.estimate * x.ratio >= 1000,
  "cost check only": (x) => x.estimate > 0 && payback(x) <= remainingGuess(x.n),
  "floor 500 + cost": (x) => x.estimate * x.ratio >= 500 && payback(x) <= remainingGuess(x.n),
  "floor 1K + cost": (x) => x.estimate * x.ratio >= 1000 && payback(x) <= remainingGuess(x.n),
  "floor 2K + cost": (x) => x.estimate * x.ratio >= 2000 && payback(x) <= remainingGuess(x.n),
  "floor 3K + cost": (x) => x.estimate * x.ratio >= 3000 && payback(x) <= remainingGuess(x.n),
  "floor 5K + cost": (x) => x.estimate * x.ratio >= 5000 && payback(x) <= remainingGuess(x.n),
  "floor 1K + cost + payback ≤ 50": (x) => x.estimate * x.ratio >= 1000 && payback(x) <= Math.min(50, remainingGuess(x.n)),
  "floor 1K + cost + payback ≤ 100": (x) => x.estimate * x.ratio >= 1000 && payback(x) <= Math.min(100, remainingGuess(x.n)),
  "floor 2K + cost + payback ≤ 50": (x) => x.estimate * x.ratio >= 2000 && payback(x) <= Math.min(50, remainingGuess(x.n)),
  "floor 2K + cost + payback ≤ 100": (x) => x.estimate * x.ratio >= 2000 && payback(x) <= Math.min(100, remainingGuess(x.n)),
  "floor 1K + cost, guess ≥ 20": (x) => x.estimate * x.ratio >= 1000 && payback(x) <= Math.min(200, Math.max(20, x.n)),
};

const pool = Array.from({ length: N }, candidate);
const value = (x) => x.real * x.ratio * HIT * Math.min(x.remaining, x.horizon) - (x.c + x.after - x.real) * x.ratio * (MISS - HIT);
const oracle = pool.reduce((sum, x) => sum + Math.max(0, value(x)), 0);

const rows = [];
for (const [name, accept] of Object.entries(POLICIES)) {
  let landed = 0;
  let net = 0;
  let losing = 0;
  let small = 0;
  let lost = 0;
  for (const x of pool) {
    if (!accept(x)) continue;
    landed += 1;
    const v = value(x);
    net += v;
    if (v < 0) {
      losing += 1;
      lost += v;
    }
    if (x.estimate * x.ratio < 1000) small += 1;
  }
  rows.push({ name, landed, net, losing, small, lost });
}
const k = (v) => `${(v / 1e6).toFixed(1)}M`;
console.log(`${N} candidate landings; oracle (land exactly the winners) ${k(oracle)} miss-priced tokens saved\n`);
console.log(["policy".padEnd(34), "landed".padStart(8), "net".padStart(9), "% oracle".padStart(9), "losing".padStart(8), "lost".padStart(9), "<1K".padStart(7)].join(" "));
for (const row of rows) {
  console.log([
    row.name.padEnd(34),
    String(row.landed).padStart(8),
    k(row.net).padStart(9),
    `${((row.net / oracle) * 100).toFixed(0)}%`.padStart(9),
    `${((row.losing / Math.max(1, row.landed)) * 100).toFixed(0)}%`.padStart(8),
    k(row.lost).padStart(9),
    String(row.small).padStart(7),
  ].join(" "));
}
