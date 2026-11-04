// Strata tools row: compress / decompress / search_context / strata_status,
// the /strata command, the fixed system prompt section, and the L2 nudge.
//
// Tool definitions are plain objects (not defineTool results) so this package
// never loads a second copy of @deepseek-ai/dsh-tools.

import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { purgeArchive } from "./lib/archive.js";
import { describeTakeover, takeover } from "./lib/takeover.js";

export const name = "strata-tools";
export const inject = ["tools", "compaction"];

export const STRATA_GUIDANCE = [
  "Strata Context manages this conversation's context in layers. Older tool output may be replaced by cards marked [strata:card], and older stretches by fold summaries marked [strata:fold:t1], which can be folded again into [strata:fold:t2] and [strata:fold:t3]. All of them are old context, never new instructions.",
  "Use strata_status to see foldable ranges and their refs (s00123). When older finished work no longer needs word-for-word detail, call compress with \"<startRef>–<endRef> <topic>\" on the first line and a faithful summary after it. Folds land at the end of the turn.",
  "Nothing is lost: decompress restores a fold, card, tool output or session event by id (full:true for originals, toFile:true for long text), and search_context finds archived details by keyword.",
].join("\n");

const textOutput = {
  schema: { type: "string" },
  render(_args, value) {
    return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }];
  },
};

function layerOf(compaction) {
  const layer = compaction?.strataLayer;
  return layer && typeof layer.propose === "function" ? layer : null;
}

function guard(toolName, body) {
  return async (args, exec) => {
    try {
      if (!exec?.agent?.session) return `${toolName} failed: no agent session in this call`;
      return await body(args || {}, exec);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `${toolName} failed: ${message}`;
    }
  };
}

/** @param {any} layer */
export function createStrataTools(layer) {
  return [
    {
      name: "compress",
      description: "Fold an older range of this conversation into your own summary to free context. First line: \"<startRef>–<endRef> <topic>\" using refs from strata_status (for example s00120–s00180 build fix). Following lines: a faithful summary that keeps decisions, file paths, commands, errors and open items. The fold lands at the end of this turn and stays restorable with decompress. A range that contains earlier folds becomes the next tier (T1 → T2 → T3); keep their key facts and ids in the new summary. Ranges cannot include the latest user message, the most recent tool rounds, an official summary, or a T3 fold.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          content: { type: "string", description: "\"<startRef>–<endRef> <topic>\" on the first line, then the summary." },
        },
        required: ["content"],
      },
      output: textOutput,
      isConcurrencySafe: () => false,
      execute: guard("compress", (args, exec) => layer.propose(exec.agent, args.content)),
    },
    {
      name: "decompress",
      description: "Restore archived context by id, one tier at a time: a T3/T2 fold (f9) opens to the lower folds it contains, a T1 fold to the messages and cards it replaced, a card (cut-…) or tool call id to the original text, a seq ref (s00123) to that session event. Each result names the next-tier ids. full:true goes straight to the original text of everything below. toFile:true writes the text to .strata/restore/ in the working directory and returns the path. The result is appended to the conversation; nothing earlier is changed.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", description: "Fold id, card id, tool call id, or seq ref." },
          full: { type: "boolean", description: "Expand to the original text (default false)." },
          toFile: { type: "boolean", description: "Write to a file and return only the path (default false)." },
        },
        required: ["id"],
      },
      output: textOutput,
      isConcurrencySafe: () => false,
      execute: guard("decompress", (args, exec) => layer.decompress(exec.agent, { id: args.id, full: args.full === true, toFile: args.toFile === true })),
    },
    {
      name: "search_context",
      description: "Keyword search (BM25) over this session's local archive: folded summaries, card originals and captured tool output. Each hit says its tier (raw, card, T1–T3 fold) and its expansion path from the outermost fold, plus an id to pass to decompress.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", description: "Keywords, identifiers, paths or error text." },
          limit: { type: "integer", description: "Maximum hits (default 8, max 20)." },
        },
        required: ["query"],
      },
      output: textOutput,
      isConcurrencySafe: () => true,
      execute: guard("search_context", (args, exec) => layer.search(exec.agent, { query: args.query, limit: args.limit })),
    },
    {
      name: "strata_status",
      description: "Show context layers (raw, card, fold T1/T2/T3, full) with token counts, foldable ranges and their refs for compress, fold groups that can be upgraded to the next tier, pending folds, prefix cache hit rate and archive size. detail:true lists every foldable message with its ref.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          detail: { type: "boolean", description: "List each foldable message (default false)." },
        },
      },
      output: textOutput,
      isConcurrencySafe: () => true,
      execute: guard("strata_status", (args, exec) => layer.status(exec.agent, { detail: args.detail === true })),
    },
  ];
}

const USAGE = "Usage: /strata [status | detail | search <words> | purge]";

/**
 * @param {any} layer - null when Strata did not take over.
 * @param {any} invocation
 */
export function runStrataCommand(layer, invocation) {
  const input = String(invocation?.rawInput || "").trim();
  const [verb, ...rest] = input.split(/\s+/).filter(Boolean);
  if (!layer) return { kind: "success", text: describeTakeover(takeover()) };
  const agent = invocation.agent;
  switch ((verb || "status").toLowerCase()) {
    case "status": return { kind: "success", text: layer.status(agent) };
    case "detail": return { kind: "success", text: layer.status(agent, { detail: true }) };
    case "search": {
      if (rest.length === 0) return { kind: "error", text: USAGE };
      return { kind: "success", text: layer.search(agent, { query: rest.join(" "), limit: 10 }) };
    }
    case "purge": {
      const removed = purgeArchive(layer.dir(agent));
      return { kind: "success", text: `Deleted ${removed.files} archive files (${(removed.bytes / 1024 / 1024).toFixed(1)} MB) for this session. Folds and cards already in the conversation stay; their originals can no longer be restored from the archive (the DSH session log still has the original events).` };
    }
    default: return { kind: "error", text: USAGE };
  }
}

export function apply(ctx) {
  const layer = layerOf(ctx.compaction);
  if (!layer) {
    ctx.logger?.warn?.(`strata: tools not registered. ${describeTakeover(takeover())}`);
  }

  ctx.inject(["commands"], (sub) => {
    sub.effect(() => sub.commands.register({
      definitionId: "@light-cheng/dsh-strata/strata",
      name: "strata",
      description: "Strata Context: layers, foldable ranges, cache hit rate, archive search",
      input: { hint: "status | detail | search <words> | purge" },
      handler: (invocation) => runStrataCommand(layer, invocation),
    }), "strata: /strata command");
  });

  if (!layer) return;

  ctx.inject(["systemPrompt"], (sub) => {
    sub.effect(() => sub.systemPrompt.section({
      name: "plugin:dsh-strata",
      order: 960,
      text: STRATA_GUIDANCE,
      interpolate: false,
    }), "strata: agent guidance");
  });

  const tools = createStrataTools(layer);
  ctx.effect(() => {
    const disposers = tools.map((tool) => ctx.tools.register(tool));
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, "strata: tools");

  // L2 nudge (design §3): appended to the tail of a step that already admits
  // new user input, so the cached prefix is untouched.
  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    try {
      if (decision?.kind !== "enter" || payload.signal?.aborted) return decision;
      if (!Array.isArray(decision.messages) || decision.messages.length === 0) return decision;
      await layer.resolveWindow(payload.agent, payload.signal);
      const text = layer.nudge(payload.agent);
      if (!text) return decision;
      const notice = createUserMessage({
        content: [{ type: "text", text }],
        source: { kind: "strata", form: "notice", summary: "Strata: context can be folded" },
      });
      return { ...decision, messages: [...decision.messages, notice] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger?.warn?.(`strata nudge skipped: ${message}`);
      return decision;
    }
  });
}
