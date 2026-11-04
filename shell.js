// Thin entry. This file must evaluate even when the engine cannot load.
// A throw here leaves stock disabled and /compact waiting.

import { conflictMessage, foreignCompactionOwner, installedConflicts } from "./lib/conflicts.js";
import { setTakeover } from "./lib/takeover.js";

let Engine = null;
let Stock = null;
let CompactionEngine = null;
let ManualCompactionError = null;
let loadError = null;

if (process.env.STRATA_ENGINE_FAIL === "import") {
  loadError = new Error("strata: engine import refused");
} else {
  try {
    const engine = await import("./index.js");
    Engine = engine.default;
  } catch (error) {
    loadError = error instanceof Error ? error : new Error(String(error));
  }
}

try {
  const compaction = await import("@deepseek-ai/dsh-compaction");
  CompactionEngine = compaction.CompactionEngine;
  ManualCompactionError = compaction.ManualCompactionError;
} catch (error) {
  loadError ??= error instanceof Error ? error : new Error(String(error));
}

try {
  const stock = await import("@deepseek-ai/dsh-compaction-basic");
  Stock = stock.BasicCompactionEngine;
} catch (error) {
  if (!loadError) loadError = error instanceof Error ? error : new Error(String(error));
}

function reasonText(error) {
  return error instanceof Error ? error.message : String(error);
}

export function preflightConfig(config = {}) {
  if (!config || typeof config !== "object") return;
  const threshold = config.thresholdRatio;
  if (typeof threshold !== "number") return;
  if (config.retainTokens !== undefined) return;
  const ratio = config.retainRatio ?? 0.16;
  if (ratio >= threshold) {
    throw new Error(`BasicCompactionConfig: retainRatio (${ratio}) must be less than the resolved thresholdRatio (${threshold})`);
  }
}

function releaseCompaction(ctx) {
  const store = ctx?.reflect?.store;
  if (!store) return false;
  const keys = [...Object.getOwnPropertySymbols(store), ...Object.keys(store)];
  for (const key of keys) {
    if (store[key]?.name !== "compaction") continue;
    delete store[key];
    if (ctx.fiber?.store) delete ctx.fiber.store.compaction;
    return true;
  }
  return false;
}

function visibleTakeover(ctx, reason) {
  const line = `strata: ${MARK}。${reason}`;
  console.error(line);
  ctx?.logger?.warn?.(line);
}

const MARK = "本会话未接管";

const UnavailableCompaction = CompactionEngine
  ? class extends CompactionEngine {
    constructor(ctx, reason) {
      super(ctx);
      this.reason = reason;
      ctx.logger?.warn?.(`strata: ${MARK}。压缩没有装上，这一刀没有执行。${reason}`);
    }

    compactIfNeeded() {
      return Promise.reject(new Error(`strata: ${MARK}。压缩没有装上，这一刀没有执行。${this.reason}`));
    }

    compactNow() {
      const message = `strata: ${MARK}。压缩没有装上，这一刀没有执行。${this.reason}`;
      if (ManualCompactionError) return Promise.reject(new ManualCompactionError("summary", message));
      return Promise.reject(new Error(message));
    }
  }
  : null;

export default class StrataEntry {
  static inject = ["llm", "tokenMeter", "sessions"];
  static Config = Stock?.Config || Engine?.Config;

  constructor(ctx, config) {
    // Another plugin already provides ctx.compaction: do not provide a second
    // one (cordis would throw) and do not release theirs. Yield quietly-but-loudly.
    const foreign = foreignCompactionOwner(ctx);
    if (foreign) {
      const reason = `另一个插件 <${foreign}> 已经提供压缩。 Another plugin <${foreign}> already provides compaction.`;
      visibleTakeover(ctx, reason);
      setTakeover("yielded", reason);
      return /** @type {any} */ ({ strataPassive: true, reason });
    }
    let cause = loadError;
    let skipStock = process.env.STRATA_ENGINE_FAIL === "construct";
    if (skipStock) cause = new Error("strata: constructor refused");
    const conflicts = installedConflicts();
    let conflicted = false;
    if (conflicts.length > 0 && !cause) {
      cause = new Error(conflictMessage(conflicts));
      conflicted = true;
    }
    if (!loadError && !skipStock && !conflicted) {
      try {
        preflightConfig(config);
      } catch (error) {
        cause = error instanceof Error ? error : new Error(String(error));
        skipStock = true;
      }
    }
    if (!loadError && !skipStock && !conflicted && Engine) {
      try {
        const engine = new Engine(ctx, config);
        setTakeover("active");
        return engine;
      } catch (error) {
        cause = error instanceof Error ? error : new Error(String(error));
        releaseCompaction(ctx);
        skipStock = true;
      }
    }
    cause ??= new Error("strata: engine missing");
    if (!skipStock && process.env.STRATA_STOCK_FAIL !== "1" && Stock) {
      try {
        visibleTakeover(ctx, `这一轮用原版压缩。${reasonText(cause)}`);
        const stock = new Stock(ctx, config);
        setTakeover("stock", reasonText(cause));
        return stock;
      } catch (error) {
        cause = error instanceof Error ? error : new Error(String(error));
        releaseCompaction(ctx);
      }
    }
    visibleTakeover(ctx, reasonText(cause));
    setTakeover("unavailable", reasonText(cause));
    if (!UnavailableCompaction) throw new Error(`strata: ${MARK}。压缩接口没有装上。${reasonText(cause)}`);
    return new UnavailableCompaction(ctx, reasonText(cause));
  }
}
