// Deterministic fixtures for eval/run.mjs. A fixed seed keeps every arm and
// every rerun on identical inputs.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function logFile(random, index, lines) {
  const levels = ["INFO", "INFO", "INFO", "DEBUG", "WARN"];
  const out = [];
  for (let line = 0; line < lines; line += 1) {
    const level = levels[Math.floor(random() * levels.length)];
    out.push(`2026-11-04T10:${String(index).padStart(2, "0")}:${String(line % 60).padStart(2, "0")}Z ${level} worker-${index} job=${Math.floor(random() * 1e6)} step ${line} ok latency=${Math.floor(random() * 900)}ms`);
  }
  return out.join("\n");
}

export function buildFixtures(seed = 20261104) {
  const random = rng(seed);
  const fillFiles = 24;
  const fillLines = 500;
  const logs = Array.from({ length: fillFiles }, (_, index) => logFile(random, index, fillLines));
  // One real anomaly per run, so the fill task has something to find.
  logs[17] = logs[17].replace(/step 412 ok/, "step 412 ERROR checksum mismatch code=E-7731");
  const recallFacts = ["RIVET-4471", "port 47821", "sha256:9f2c41ab", "owner=ines.kowalski"];
  const recallLog = [
    logFile(random, 90, 600),
    `deploy note: rollout token ${recallFacts[0]} bound on ${recallFacts[1]}`,
    logFile(random, 91, 600),
    `artifact digest ${recallFacts[2]} signed by ${recallFacts[3]}`,
    logFile(random, 92, 600),
  ].join("\n");
  const tierFacts = [
    { file: "billing.log", fact: "invoice batch INV-58213 failed on shard 6" },
    { file: "auth.log", fact: "token issuer rotated to kid=ed25519-7c41" },
    { file: "search.log", fact: "reindex finished in 4217 seconds" },
    { file: "storage.log", fact: "bucket quota raised to 9.5 TiB" },
  ];
  const tierLogs = tierFacts.map((item, index) => [logFile(random, 60 + index, 400), item.fact, logFile(random, 70 + index, 400)].join("\n"));
  return {
    tiers: {
      // Four short tasks; each is folded to T1, pairs to T2, everything to T3.
      tasks: tierFacts.map((item) => `Read ./tiers/${item.file} completely with your file tools and tell me in one sentence what unusual line it contains.`),
      foldT1: "Use strata_status and compress the range covering the most recent finished log task into a one-line summary (no identifiers). Reply OK.",
      foldT2: "Use strata_status. Compress each pair of adjacent T1 folds into one T2 fold with a one-line summary (no identifiers). Reply OK.",
      foldT3: "Use strata_status. Compress the adjacent T2 folds into one T3 fold with a one-line summary (no identifiers). Reply OK.",
      question: "For each of billing.log, auth.log, search.log and storage.log, quote the unusual line exactly. Use decompress (one tier at a time or full:true) or search_context to recover it; do not guess.",
      expected: ["INV-58213", "ed25519-7c41", "4217 seconds", "9.5 TiB"],
    },
    fill: {
      files: fillFiles,
      chars: logs.reduce((sum, text) => sum + text.length, 0),
      prompt: `There are ${fillFiles} log files in ./logs (worker-00.log … worker-${fillFiles - 1}.log). Read every file one by one with your file tools (no grep, no scripts) and report each line whose level is ERROR, with its file name. Then say DONE.`,
    },
    amnesia: {
      plant: "Remember these for later in this session: the release codename is KESTREL-19, the database replica is db-replica-7, and the on-call engineer is Amara Okafor. Reply only with OK.",
      question: "What are the release codename, the database replica and the on-call engineer I told you at the start? Answer from memory or use your context tools; do not guess.",
      expected: ["KESTREL-19", "db-replica-7", "Amara Okafor"],
    },
    recall: {
      read: "Read ./recall/deploy.log completely with your file tools and tell me only how many lines it has.",
      fold: "That log is done. Use strata_status, then compress the range that contains the deploy.log reading into a short summary (do not copy identifiers into the summary). Reply OK when done.",
      question: "From deploy.log: what was the rollout token, which port was it bound on, what was the artifact digest and who signed it? Use decompress or search_context if the details are not in front of you.",
      expected: recallFacts,
    },
    writeFill(dir) {
      mkdirSync(join(dir, "logs"), { recursive: true });
      logs.forEach((text, index) => writeFileSync(join(dir, "logs", `worker-${String(index).padStart(2, "0")}.log`), text));
    },
    writeTiers(dir) {
      mkdirSync(join(dir, "tiers"), { recursive: true });
      tierFacts.forEach((item, index) => writeFileSync(join(dir, "tiers", item.file), tierLogs[index]));
    },
    writeRecall(dir) {
      mkdirSync(join(dir, "recall"), { recursive: true });
      writeFileSync(join(dir, "recall", "deploy.log"), recallLog);
    },
  };
}
