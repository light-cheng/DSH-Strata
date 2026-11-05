// Takeover detection (design §6). dsh-live-compact and billion-context both
// disable or replace the same compaction rows this plugin owns, so Strata
// refuses to take over when either is present.

import { createRequire } from "node:module";

// "@light-cheng/dsh-strata" is this plugin's pre-0.3 name (GitHub releases only).
export const CONFLICTING_PACKAGES = ["dsh-live-compact", "billion-context", "@light-cheng/dsh-strata"];
const OURS = "@lightcheng/dsh-strata";

const require = createRequire(import.meta.url);

function defaultResolve(name) {
  return require.resolve(`${name}/package.json`);
}

/**
 * Packages that are installed next to this one (same node_modules tree).
 * @param {{ resolve?: (name: string) => string, env?: Record<string, string | undefined> }} [options]
 * @returns {{ name: string, how: string }[]}
 */
export function installedConflicts({ resolve = defaultResolve, env = process.env } = {}) {
  if (env.STRATA_IGNORE_CONFLICTS === "1") return [];
  const found = [];
  for (const name of CONFLICTING_PACKAGES) {
    try {
      resolve(name);
      found.push({ name, how: "installed" });
    } catch {}
  }
  if (env.STRATA_FAKE_CONFLICT) found.push({ name: env.STRATA_FAKE_CONFLICT, how: "env" });
  return found;
}

function entryName(name) {
  const text = String(name || "");
  return CONFLICTING_PACKAGES.find((pkg) => text === pkg || text.startsWith(`${pkg}/`)) || "";
}

/**
 * Enabled plugin rows of conflicting packages inside a resolved config tree.
 * @param {any} node
 * @returns {string[]}
 */
export function configConflicts(node, seen = new Set()) {
  if (!node || typeof node !== "object" || seen.has(node)) return [];
  seen.add(node);
  const found = new Set();
  if (!node.disabled) {
    const hit = entryName(node.name);
    if (hit) found.add(hit);
  }
  const children = [];
  if (Array.isArray(node)) children.push(...node);
  if (Array.isArray(node.plugins)) children.push(...node.plugins);
  if (Array.isArray(node.config)) children.push(...node.config);
  else if (node.config && typeof node.config === "object") children.push(node.config);
  for (const child of children) for (const hit of configConflicts(child, seen)) found.add(hit);
  return [...found];
}

/**
 * Another plugin already provides `ctx.compaction` in this context.
 * @param {any} ctx
 * @returns {string} the owning fiber name, or "" when free.
 */
const ISOLATE = Symbol.for("cordis.isolate");

/**
 * Store keys that can hold *this context's* `compaction` service.
 *
 * Cordis keeps every service in one global store, keyed per isolation scope.
 * Web / Desktop agent presets each isolate `compaction`, so the store also
 * holds other presets' engines. Only the key this context resolves counts;
 * scanning the whole store made Strata yield inside a preset because a
 * sibling preset ran stock compaction, leaving that preset with none
 * ("command-compact: waiting for compaction").
 * @param {any} ctx
 * @returns {(string | symbol)[]}
 */
export function scopedCompactionKeys(ctx) {
  const store = ctx?.reflect?.store;
  if (!store) return [];
  const isolation = ctx?.[ISOLATE];
  if (isolation && typeof isolation === "object") {
    const key = isolation.compaction;
    return key && store[key] ? [key] : [];
  }
  // Test doubles without an isolation map: the whole store is one scope.
  return [...Object.getOwnPropertySymbols(store), ...Object.keys(store)];
}

export function foreignCompactionOwner(ctx) {
  const store = ctx?.reflect?.store;
  if (!store) return "";
  for (const key of scopedCompactionKeys(ctx)) {
    const impl = store[key];
    if (impl?.name !== "compaction") continue;
    const owner = String(impl?.fiber?.name || "unknown");
    // Cordis names a fiber after the plugin class, not the package.
    if (owner.includes(OURS) || owner.includes("StrataEntry")) return "";
    return owner;
  }
  return "";
}

export function conflictMessage(found) {
  const names = found.map((item) => (typeof item === "string" ? item : item.name));
  return `检测到 ${names.join(", ")}，Strata 不接管压缩，以免两边同时改同一行。请先卸载其中一个。 Strata detected ${names.join(", ")} and will not take over compaction; uninstall one of them.`;
}
