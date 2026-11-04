// Stratum tags and the no-double-compression rules (design §2.1).
//
// Every checkpoint this plugin writes starts with one fixed tag line:
//   [strata:card id=cut-…]   L1 deterministic card
//   [strata:fold id=f3 …]    L2 model-written fold
//   [strata:full id=official-…]  L∞ official summary (archived first)
// A compaction checkpoint without a tag is treated as `full` (it came from the
// stock engine or another plugin). Everything else on the surface is `raw`.

/** @typedef {"raw" | "card" | "fold" | "full"} Stratum */

export const STRATA = /** @type {const} */ (["raw", "card", "fold", "full"]);
const TAG = /(?:^|\n)\[strata:(card|fold|full)((?:[ \t]+[a-z]+=[^\s\]]+)*)\]/;
const LEGACY_CARD = "Strata card.";

/**
 * Build the fixed tag line for a checkpoint.
 * @param {"card" | "fold" | "full"} kind
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
  return { kind: /** @type {"card"|"fold"|"full"} */ (match[1]), attrs };
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
 * @returns {{ stratum: Stratum, id: string, attrs: Record<string, string> }}
 */
export function stratumOf(event) {
  const data = event?.data;
  const checkpoint = data?.source?.kind === "compact-checkpoint" || data?.message?.source?.kind === "compact-checkpoint";
  // Tags are trusted only on checkpoint messages, so a tool result or user
  // message that happens to contain "[strata:fold …]" stays raw.
  if (!checkpoint) return { stratum: "raw", id: "", attrs: {} };
  const content = data?.content ?? data?.message?.content;
  const text = firstText(content);
  const tag = parseStratumTag(text);
  if (tag) return { stratum: tag.kind, id: tag.attrs.id || "", attrs: tag.attrs };
  if (text.includes(LEGACY_CARD)) return { stratum: "card", id: "", attrs: {} };
  return { stratum: "full", id: "", attrs: {} };
}

/** L1 rule: only `raw` nodes may be cut. */
export function l1MayCut(stratum) {
  return stratum === "raw";
}

/**
 * L2 rule: a fold may cover raw and card nodes. It may not include an
 * existing fold or full summary (that would be a T2 fold, not in the MVP),
 * and it may not overlap a fold that is still pending.
 * @param {Stratum[]} strata - strata of the nodes in the proposed range.
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function l2MayFold(strata) {
  if (strata.length === 0) return { ok: false, reason: "the range is empty" };
  const bad = strata.find((stratum) => stratum === "fold" || stratum === "full");
  if (bad) {
    return { ok: false, reason: `the range contains an existing ${bad} node; folding a fold again (T2) is not supported in this version` };
  }
  return { ok: true };
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
