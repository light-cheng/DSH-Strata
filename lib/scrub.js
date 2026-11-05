// One-time scrub of runtime-context text left in archives by 0.3.0 (joint
// test J1, docs/interop-dsh-mem0.md §1). 0.3.0 archived runtime-context
// snapshots like any other message, so card shadows (cut-*.txt), official
// summary spans (official-*.txt) and fold records (fold-f*.json) next to
// dsh-mem0 can hold <mem0-relevant-memories> blocks. On the first engine start
// per archive root this walks every session directory once and replaces each
// snapshot / recall block with the dropped stub. Everything else stays
// byte-identical; files that need no change are not rewritten.

import { chmodSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DROPPED_CONTEXT_TEXT } from "./l2.js";

/** Present in the archive root once the scrub has walked it. */
export const SCRUB_MARKER = ".scrub-runtime-context-v1";

const SNAPSHOT_HEAD = "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.";
// The next message section in a shadow body (plan.js shadowSections).
const NEXT_SECTION = /\n\n\[(?:user|assistant|tool|system|other)(?::reasoning)?\]\n/g;
// A recall block as Mem0 builds it: the tag on its own line. Mem0's system
// prompt guidance names the tag inline ("a <mem0-relevant-memories> block;")
// and must not match.
const RECALL_BLOCK = /<mem0-relevant-memories>\n[\s\S]*?<\/mem0-relevant-memories>/g;
const ARCHIVE_FILE = /^(?:(?:cut|official|shadow)-\d+-[0-9a-f]{8}\.txt|raw-[0-9a-f]{16}\.txt|fold-f\d+\.json)$/;

/**
 * @param {string} input
 * @returns {{ text: string, count: number }}
 */
export function scrubText(input) {
  let text = String(input);
  let count = 0;
  let from = 0;
  for (;;) {
    const start = text.indexOf(SNAPSHOT_HEAD, from);
    if (start < 0) break;
    NEXT_SECTION.lastIndex = start;
    const next = NEXT_SECTION.exec(text);
    const end = next ? next.index : text.length;
    text = text.slice(0, start) + DROPPED_CONTEXT_TEXT + text.slice(end);
    from = start + DROPPED_CONTEXT_TEXT.length;
    count += 1;
  }
  text = text.replace(RECALL_BLOCK, () => {
    count += 1;
    return DROPPED_CONTEXT_TEXT;
  });
  return { text, count };
}

function scrubJson(value) {
  let count = 0;
  const walk = (node) => {
    if (typeof node === "string") {
      const result = scrubText(node);
      count += result.count;
      return result.text;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, walk(item)]));
    return node;
  };
  return { value: walk(value), count };
}

function rewrite(file, body) {
  const tmp = `${file}.scrub-${process.pid}`;
  writeFileSync(tmp, body, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

function scrubFile(file) {
  const before = readFileSync(file, "utf8");
  if (!before.includes(SNAPSHOT_HEAD) && !before.includes("<mem0-relevant-memories>")) return 0;
  if (file.endsWith(".json")) {
    let parsed;
    try {
      parsed = JSON.parse(before);
    } catch {
      return 0;
    }
    const { value, count } = scrubJson(parsed);
    if (count > 0) rewrite(file, JSON.stringify(value, null, 2));
    return count;
  }
  const { text, count } = scrubText(before);
  if (count > 0 && text !== before) rewrite(file, text);
  return count;
}

/**
 * Walk the archive root once. A missing root is left alone (nothing to scrub,
 * nothing created); the marker is written only after a complete walk.
 * @param {string} root
 * @returns {{ files: number, blocks: number, skipped: boolean }}
 */
export function scrubArchive(root) {
  const result = { files: 0, blocks: 0, skipped: false };
  if (!existsSync(root)) return result;
  const marker = join(root, SCRUB_MARKER);
  if (existsSync(marker)) return { ...result, skipped: true };
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    let entries = [];
    try {
      if (!statSync(dir).isDirectory()) continue;
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!ARCHIVE_FILE.test(entry)) continue;
      try {
        const count = scrubFile(join(dir, entry));
        if (count > 0) {
          result.files += 1;
          result.blocks += count;
        }
      } catch {}
    }
  }
  writeFileSync(marker, `${new Date().toISOString()} files=${result.files} blocks=${result.blocks}\n`, { mode: 0o600 });
  chmodSync(marker, 0o600);
  return result;
}

const started = new Set();

/**
 * Run the scrub once per archive root per process, off the constructor's
 * stack. Never throws.
 * @param {string} root
 * @param {{ info?: (line: string) => void, warn?: (line: string) => void } | undefined} logger
 */
export function scheduleScrub(root, logger) {
  if (started.has(root)) return;
  started.add(root);
  const timer = setImmediate(() => {
    try {
      const result = scrubArchive(root);
      if (!result.skipped && result.blocks > 0) {
        logger?.info?.(`strata: scrubbed ${result.blocks} runtime-context block(s) in ${result.files} archive file(s)`);
      }
    } catch (error) {
      logger?.warn?.(`strata: archive scrub failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  timer.unref?.();
}
