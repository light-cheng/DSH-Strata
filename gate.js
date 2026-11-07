import { createRequire } from "node:module";
import { configConflicts, conflictMessage, installedConflicts } from "./lib/conflicts.js";
import { registerGuiRoutes } from "./lib/gui-routes.js";
import { createBudget } from "./lib/budget.js";
import { setPageConfig, readSettings } from "./lib/settings.js";
import { archiveRootFor, archiveTotals, endedArchives, purgeSessions } from "./lib/archive.js";

// The settings page's Config. Loaded apart so a schemastery failure leaves
// the gate (and every preset's engine) working with built-in defaults.
let PageConfig;
try {
  PageConfig = (await import("./lib/config.js")).Config;
} catch {}

const STOCK = "@deepseek-ai/dsh-compaction-basic";
const OURS = "@lightcheng/dsh-strata";
const PRESET_IDS = new Set(["standard", "ptc", "minimal", "cordis", "preset-standard", "preset-ptc", "preset-minimal", "preset-cordis"]);
export const GATE_SERVICE = "strataPresetGate";
export const PRESET_ENGINE_CONFIG = {
  auto: true,
  thresholdRatio: 0.8,
  headroomTokens: 65536,
  retainTokens: 8192,
  compactionRetries: 0,
};

const require = createRequire(import.meta.url);

export function packageLoadable(load = (name) => require(name)) {
  try {
    load(OURS);
    return true;
  } catch (error) {
    // The shell uses top-level await so a failed engine does not fail this package.
    // require() refuses that shape even when import() can load it.
    if (error?.code !== "ERR_REQUIRE_ASYNC_MODULE" && error?.code !== "ERR_REQUIRE_ESM") return false;
    try {
      require.resolve(OURS);
      return true;
    } catch {
      return false;
    }
  }
}

function isPreset(node) {
  if (!node || typeof node !== "object") return false;
  if (PRESET_IDS.has(node.id)) return true;
  return Boolean(node.config && typeof node.config === "object" && !Array.isArray(node.config) && PRESET_IDS.has(node.config.id));
}

function withEngineConfig(entry) {
  const previous = entry.config && typeof entry.config === "object" && !Array.isArray(entry.config) ? entry.config : {};
  return { ...PRESET_ENGINE_CONFIG, ...previous };
}

function rewriteEntry(entry, loadable) {
  if (!entry || typeof entry !== "object") return entry;
  const next = { ...entry };
  if (entry.name === STOCK) {
    if (!loadable) return entry;
    next.name = OURS;
    next.config = withEngineConfig(entry);
    return next;
  }
  if (Array.isArray(entry.config)) next.config = entry.config.map((item) => rewriteEntry(item, loadable));
  else if (entry.config && typeof entry.config === "object") next.config = rewriteNode(entry.config, loadable);
  return next;
}

function rewriteNode(node, loadable) {
  if (Array.isArray(node)) return node.map((item) => rewriteEntry(item, loadable));
  if (!node || typeof node !== "object") return node;
  const next = { ...node };
  if (Array.isArray(node.plugins)) next.plugins = node.plugins.map((item) => rewriteEntry(item, loadable));
  if (Array.isArray(node.config)) next.config = node.config.map((item) => rewriteEntry(item, loadable));
  else if (node.config && typeof node.config === "object") next.config = rewriteNode(node.config, loadable);
  return next;
}

export function rewritePresetConfig(config, loadable = packageLoadable()) {
  if (!isPreset(config)) return config;
  return rewriteNode(config, loadable);
}

function engineEntry(node) {
  if (!node || typeof node !== "object") return null;
  if (node.name === OURS) return node;
  const nested = [];
  if (Array.isArray(node.plugins)) nested.push(...node.plugins);
  if (Array.isArray(node.config)) nested.push(...node.config);
  else if (node.config && typeof node.config === "object") nested.push(node.config);
  for (const item of nested) {
    const found = engineEntry(item);
    if (found) return found;
  }
  return null;
}

const DAY = 24 * 60 * 60 * 1000;
/** Archive upkeep runs at most this often per process. */
const UPKEEP_MS = 6 * 60 * 60 * 1000;

/**
 * Archive upkeep: warn above the size cap (never deletes for it), and with
 * archiveKeepDays > 0 (off by default) delete archives of ended sessions
 * untouched for that many days.
 */
export function archiveUpkeep(settings = readSettings(), logger = undefined, now = Date.now()) {
  const root = archiveRootFor(settings);
  const result = { root, removed: null, totals: null, overCap: false };
  if (settings.archiveKeepDays > 0) {
    const rows = endedArchives(root, { olderThanMs: settings.archiveKeepDays * DAY, now });
    if (rows.length) {
      result.removed = purgeSessions(rows);
      logger?.info?.(`strata: 已删除 ${result.removed.sessions} 个超过 ${settings.archiveKeepDays} 天未使用的会话存档（${(result.removed.bytes / 1048576).toFixed(1)} MB）。`);
    }
  }
  result.totals = archiveTotals(root);
  if (settings.archiveMaxMB > 0 && result.totals.bytes > settings.archiveMaxMB * 1048576) {
    result.overCap = true;
    logger?.warn?.(`strata: 存档共 ${(result.totals.bytes / 1048576).toFixed(1)} MB，超过设置的 ${settings.archiveMaxMB} MB（不会自动删除；可用 /strata purge ended 清理已结束会话的存档）。`);
  }
  return result;
}

export default class StrataGate {
  static Config = PageConfig;

  constructor(ctx, config) {
    // Settings page values reach every Strata engine through the shared store
    // (lib/settings.js); the engines of rewritten preset rows never see this row.
    const publish = () => {
      try {
        setPageConfig(config ?? {});
      } catch {}
    };
    publish();
    let lastUpkeep = 0;
    const upkeep = () => {
      if (Date.now() - lastUpkeep < UPKEEP_MS) return;
      lastUpkeep = Date.now();
      try {
        archiveUpkeep(readSettings(), ctx.logger);
      } catch {}
    };
    const timer = setTimeout(upkeep, 30_000);
    timer.unref?.();
    const interval = setInterval(upkeep, UPKEEP_MS);
    interval.unref?.();
    ctx.on?.("loader/volatile-update", () => {
      publish();
      lastUpkeep = 0;
      upkeep();
    });
    ctx.effect?.(() => () => {
      clearTimeout(timer);
      clearInterval(interval);
      setPageConfig(null);
    }, "strata: settings page values");
    const seen = new Set();
    let warned = false;
    ctx.on("internal/config", function (_raw, next) {
      const resolved = next();
      try {
        // §6: with dsh-live-compact or billion-context present, leave presets alone.
        if (isPreset(resolved)) {
          const conflicts = [...installedConflicts().map((item) => item.name), ...configConflicts(resolved)];
          if (conflicts.length > 0) {
            if (!warned) {
              warned = true;
              ctx.logger?.warn?.(`strata: ${conflictMessage([...new Set(conflicts)])}`);
            }
            return resolved;
          }
        }
        const loadable = packageLoadable();
        const rewritten = rewritePresetConfig(resolved, loadable);
        const id = rewritten?.id || rewritten?.config?.id;
        if (isPreset(resolved) && id && !seen.has(String(id))) {
          seen.add(String(id));
          const engine = engineEntry(rewritten);
          if (engine) {
            const config = engine.config || {};
            ctx.logger?.info?.(`strata: 预设 ${id} 已换包 ${engine.name} thresholdRatio=${config.thresholdRatio} headroomTokens=${config.headroomTokens} retainTokens=${config.retainTokens} compactionRetries=${config.compactionRetries}`);
          } else if (!loadable) {
            ctx.logger?.warn?.(`strata: 本会话未接管预设 ${id}，仍用原版压缩。`);
          }
        }
        return rewritten;
      } catch {
        return resolved;
      }
    }, { global: true });
    ctx.provide(GATE_SERVICE, {});
    // Composer dock status (Web / Desktop only; a no-op without a web server).
    let version = "";
    try {
      version = require("./package.json").version;
    } catch {}
    registerGuiRoutes(ctx, version);
    // Shared token budget for context-injecting plugins (interop §2).
    if (typeof ctx.inject === "function") {
      ctx.inject(["tokenMeter"], (child) => {
        if (typeof child?.provide !== "function") return;
        child.provide("strataBudget", createBudget({ tokenMeter: child.get?.("tokenMeter") ?? child.tokenMeter }));
      });
    }
  }
}
