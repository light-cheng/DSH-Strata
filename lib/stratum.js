// Stratum tags and the no-double-compression rules (design §2.1).
//
// Every checkpoint this plugin writes starts with one fixed tag line:
//   [strata:card id=cut-…]   L1 deterministic card
//   [strata:fold:t2 id=f3 …] L2 model-written fold, tier t1–t3
//   [strata:full id=official-…]  L∞ official summary (archived first)
//   [strata:dropped kind=runtime-context]  a superseded runtime-context snapshot
// A compaction checkpoint without a tag is treated as `full` (it came from the
// stock engine or another plugin). A DSH runtime-context snapshot is `context`
// (docs/interop-dsh-mem0.md §1). Everything else on the surface is `raw`.

/** @typedef {"raw" | "card" | "fold" | "full" | "context" | "dropped"} Stratum */

export const STRATA = /** @type {const} */ (["raw", "card", "fold", "full", "context", "dropped"]);
const TAG = /(?:^|\n)\[strata:(card|fold(?::t[1-9])?|full|dropped)((?:[ \t]+[a-z]+=[^\s\]]+)*)\]/;

/**
 * DSH folds every plugin's `contexts` into one runtime-context snapshot, a
 * user message that "supersedes earlier runtime-context snapshots". Only the
 * newest one on the surface is live; older ones are stale for every plugin.
 * @param {any} event
 */
export function isRuntimeSnapshot(event) {
  if (event?.type !== "user/message") return false;
  const source = event.data?.source;
  return source?.kind === "runtime-context" && source?.form === "snapshot";
}
export const MAX_TIER = 3;
const LEGACY_CARD = "Strata card.";

/**
 * Build the fixed tag line for a checkpoint. Folds carry their tier: "fold:t2".
 * @param {"card" | "fold" | "full" | "dropped" | "fold:t1" | "fold:t2" | "fold:t3"} kind
 * @param {Record<string, string | number>} attrs
 */
export function stratumTag(kind, attrs = {}) {
  const parts = Object.entries(attrs)
    .filter(([, value]) => value !== undefined && value !== null && String(value).length > 0)
    .map(([key, value]) => `${key}=${String(value).replace(/[\s\]]+/g, "_")}`);
  return `[strata:${kind}${parts.length ? ` ${parts.join(" ")}` : ""}]`;
}

/**
 * Parse a tag from the start of a checkpoint text.
 * @param {string} text
 * @returns {{ kind: "card" | "fold" | "full", attrs: Record<string, string> } | null}
 */
export function parseStratumTag(text) {
  const match = TAG.exec(String(text || ""));
  if (!match) return null;
  const attrs = {};
  for (const pair of (match[2] || "").trim().split(/\s+/).filter(Boolean)) {
    const at = pair.indexOf("=");
    attrs[pair.slice(0, at)] = pair.slice(at + 1);
  }
  const [kind, tierPart] = match[1].split(":");
  const tier = kind === "fold" ? Number((tierPart || "t1").slice(1)) : 0;
  return { kind: /** @type {"card"|"fold"|"full"} */ (kind), tier, attrs };
}

// The tag is in the first text block for card/fold; for an official summary the
// stock engine puts its own preamble first, so look at the first few blocks.
function firstText(content) {
  if (typeof content === "string") return content.slice(0, 4000);
  if (!Array.isArray(content)) return "";
  return content.slice(0, 4).map((block) => (block && typeof block.text === "string" ? block.text : "")).join("\n").slice(0, 4000);
}

/**
 * Classify one session event on the surface.
 * @param {any} event
 * @returns {{ stratum: Stratum, tier: number, id: string, attrs: Record<string, string> }}
 */
export function stratumOf(event) {
  const data = event?.data;
  if (isRuntimeSnapshot(event)) return { stratum: "context", tier: 0, id: "", attrs: {} };
  const checkpoint = data?.source?.kind === "compact-checkpoint" || data?.message?.source?.kind === "compact-checkpoint";
  // Tags are trusted only on checkpoint messages, so a tool result or user
  // message that happens to contain "[strata:fold …]" stays raw.
  if (!checkpoint) return { stratum: "raw", tier: 0, id: "", attrs: {} };
  const content = data?.content ?? data?.message?.content;
  const text = firstText(content);
  const tag = parseStratumTag(text);
  if (tag) return { stratum: tag.kind, tier: tag.tier, id: tag.attrs.id || "", attrs: tag.attrs };
  if (text.includes(LEGACY_CARD)) return { stratum: "card", tier: 0, id: "", attrs: {} };
  return { stratum: "full", tier: 0, id: "", attrs: {} };
}

/** L1 rule: only `raw` nodes may be cut. */
export function l1MayCut(stratum) {
  return stratum === "raw";
}

/**
 * L2 rule (§2.1 items 2–3, multi-level distillation):
 * - a range of only raw/card nodes becomes a T1 fold;
 * - a range that contains at least one fold becomes T(n+1), n = the highest
 *   tier inside. Fold nodes are single surface nodes, so a range either holds
 *   a lower fold whole or not at all (it can never split one);
 * - tiers stop at MAX_TIER (T3); full (official) summaries are never refolded.
 * @param {{ stratum: Stratum, tier?: number }[] | Stratum[]} nodes
 * @returns {{ ok: true, tier: number, upgrade: boolean } | { ok: false, reason: string }}
 */
export function l2MayFold(nodes) {
  if (nodes.length === 0) return { ok: false, reason: "the range is empty" };
  const items = nodes.map((node) => (typeof node === "string" ? { stratum: node, tier: node === "fold" ? 1 : 0 } : node));
  if (items.some((item) => item.stratum === "full")) {
    return { ok: false, reason: "the range contains an official summary (full); those are not folded again" };
  }
  const top = Math.max(0, ...items.filter((item) => item.stratum === "fold").map((item) => item.tier || 1));
  if (top >= MAX_TIER) return { ok: false, reason: `the range contains a T${top} fold; T${MAX_TIER} is the highest tier` };
  return { ok: true, tier: top + 1, upgrade: top > 0 };
}

/** Short reference id for a surface event seq (design §5: s01234). */
export function seqRef(seq) {
  return `s${String(seq).padStart(5, "0")}`;
}

/** Parse `s01234`, `01234` or `1234` into a seq number; NaN when invalid. */
export function parseSeqRef(ref) {
  const match = /^s?(\d{1,9})$/i.exec(String(ref || "").trim());
  return match ? Number(match[1]) : Number.NaN;
}
