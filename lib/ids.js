// Lists of fold / card ids for /strata detail, the dock and strata_status.
//
// A batch landing stores every id it landed ("f180,f179,…,f173"). Shown as
// is, a long list wraps or, cut to a length, ends in half an id. These
// helpers keep the whole list in memory and print a short form instead:
//   one id                 f180
//   consecutive run        f180–f173 (8 folds)
//   anything else          f180, f175 and others (5 folds)
// Ids are never cut: an id is printed whole or not at all.

/** Split a stored id list ("f3,f2" or an array) into whole ids. */
export function splitIds(id) {
  const list = Array.isArray(id) ? id : String(id ?? "").split(",");
  return list.map((item) => String(item).trim()).filter(Boolean);
}

/**
 * A list for storage: whole ids only, at most `max` of them (the first ones),
 * and the real total, so idsText can still say how many there were.
 */
export function storedIds(id, max = 64) {
  const list = splitIds(id);
  return { id: list.slice(0, max).join(","), count: list.length };
}

const EN = {
  "ids.range": "{first}–{last} ({n} folds)",
  "ids.some": "{list} and others ({n} folds)",
  "ids.sep": ", ",
};
const english = (key, params = {}) => EN[key].replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ""));

/** A run like f180, f179, …, f173 (or f1, f2, f3): same prefix, numbers stepping by one in one direction. */
function isRun(list) {
  if (list.length < 3) return false;
  const parts = list.map((item) => /^(.*?)(\d+)$/.exec(item));
  if (parts.some((part) => !part) || parts.some((part) => part[1] !== parts[0][1])) return false;
  const numbers = parts.map((part) => Number(part[2]));
  const step = numbers[1] - numbers[0];
  if (Math.abs(step) !== 1) return false;
  return numbers.every((value, index) => index === 0 || value - numbers[index - 1] === step);
}

/**
 * Short, whole-id form of an id list.
 * @param {string | string[]} id
 * @param {(key: string, params?: object) => string} [t] - the UI translator (English when absent)
 * @param {{ count?: number }} [options] - the real total when the stored list was capped
 */
export function idsText(id, t = english, { count } = {}) {
  const list = splitIds(id);
  const n = Math.max(list.length, Number(count) || 0);
  if (!list.length) return "";
  if (n === 1) return list[0];
  if (n === list.length && isRun(list)) return t("ids.range", { first: list[0], last: list.at(-1), n });
  if (n === 2) return list.join(t("ids.sep"));
  return t("ids.some", { list: list.slice(0, 2).join(t("ids.sep")), n });
}
