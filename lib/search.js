// search_context: a small pure-JS BM25 index over the session archive
// (design §5). Documents are split into passages so hits come with a short,
// relevant snippet. Latin text is split into words; CJK text into overlapping
// bigrams (plus single characters for one-character queries).

const PASSAGE_CHARS = 1200;
const PASSAGE_OVERLAP = 200;
const K1 = 1.2;
const B = 0.75;
const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯]/;

/** @param {string} text */
export function tokenize(text) {
  const tokens = [];
  const lower = String(text || "").toLowerCase();
  const pattern = /[a-z0-9_][a-z0-9_.\-/]*[a-z0-9_]|[a-z0-9_]|[぀-ヿ㐀-䶿一-鿿가-힯]+/g;
  for (const match of lower.matchAll(pattern)) {
    const word = match[0];
    if (CJK.test(word[0])) {
      if (word.length === 1) tokens.push(word);
      for (let index = 0; index + 1 < word.length; index += 1) tokens.push(word.slice(index, index + 2));
      continue;
    }
    tokens.push(word);
    // Also index the parts of dotted / slashed / dashed identifiers.
    if (/[.\-/]/.test(word)) for (const part of word.split(/[.\-/]+/)) if (part.length > 1) tokens.push(part);
  }
  return tokens;
}

function passages(text) {
  const body = String(text || "");
  if (body.length <= PASSAGE_CHARS) return [{ start: 0, text: body }];
  const out = [];
  for (let start = 0; start < body.length; start += PASSAGE_CHARS - PASSAGE_OVERLAP) {
    out.push({ start, text: body.slice(start, start + PASSAGE_CHARS) });
    if (start + PASSAGE_CHARS >= body.length) break;
  }
  return out;
}

/**
 * @param {{ id: string, kind: string, text: string, label?: string }[]} docs
 */
export function buildIndex(docs) {
  const entries = [];
  const df = new Map();
  let totalLength = 0;
  for (const doc of docs) {
    for (const passage of passages(doc.text)) {
      const terms = tokenize(`${doc.label || ""}\n${passage.text}`);
      const tf = new Map();
      for (const term of terms) tf.set(term, (tf.get(term) || 0) + 1);
      for (const term of tf.keys()) df.set(term, (df.get(term) || 0) + 1);
      entries.push({ doc, passage, tf, length: terms.length });
      totalLength += terms.length;
    }
  }
  return { entries, df, avgLength: entries.length ? totalLength / entries.length : 0 };
}

function snippet(text, terms, width = 320) {
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  const start = Math.max(0, (at < 0 ? 0 : at) - Math.floor(width / 3));
  const piece = text.slice(start, start + width).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${piece}${start + width < text.length ? "…" : ""}`;
}

/**
 * Rank documents for a query. One hit per document (its best passage).
 * @param {ReturnType<typeof buildIndex>} index
 * @param {string} query
 * @param {number} [limit]
 */
export function searchIndex(index, query, limit = 8) {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0 || index.entries.length === 0) return [];
  const n = index.entries.length;
  const best = new Map();
  for (const entry of index.entries) {
    let score = 0;
    for (const term of terms) {
      const freq = entry.tf.get(term);
      if (!freq) continue;
      const docFreq = index.df.get(term) || 0;
      const idf = Math.log(1 + (n - docFreq + 0.5) / (docFreq + 0.5));
      score += idf * ((freq * (K1 + 1)) / (freq + K1 * (1 - B + (B * entry.length) / (index.avgLength || 1))));
    }
    if (score <= 0) continue;
    const key = `${entry.doc.kind}:${entry.doc.id}`;
    const previous = best.get(key);
    if (!previous || previous.score < score) best.set(key, { score, entry });
  }
  return [...best.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, limit))
    .map(({ score, entry }) => ({
      id: entry.doc.id,
      kind: entry.doc.kind,
      label: entry.doc.label || "",
      score: Math.round(score * 100) / 100,
      snippet: snippet(entry.passage.text, terms),
    }));
}
