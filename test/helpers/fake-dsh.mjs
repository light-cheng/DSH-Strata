// Minimal stand-ins for the DSH session, token meter and plugin context.
// Only the members the engine and the Strata layer touch are modelled.

const SURFACE_TYPES = new Set(["system/message", "user/message", "assistant/message", "tool/result"]);

function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (typeof block?.text === "string" ? block.text : block?.type === "tool-call" ? JSON.stringify(block.arguments || {}) : "")).join("\n");
}

export function eventChars(event) {
  if (!event) return 0;
  if (event.type === "user/message") return textOfContent(event.data?.content).length;
  if (event.type === "assistant/message") return textOfContent(event.data?.message?.content).length;
  return textOfContent(event.data?.message?.content ?? event.data?.content).length;
}

export class FakeSession {
  constructor({ id = "session-test", cwd = process.cwd(), provider = "deepseek", model = "deepseek-test" } = {}) {
    this.id = id;
    this.header = { cwd };
    this.events = [];
    this.surface = { nodes: [], replaceGeneration: 0 };
    this.route = { provider, model };
    this.listeners = [];
  }

  append(type, data, options = {}) {
    // DSH rejects (as a corrupt log on reload) compaction events whose turn is not the open one.
    if (type === "compaction/start" || type === "compaction/end") {
      let open = null;
      for (let at = this.events.length - 1; at >= 0; at -= 1) {
        if (this.events[at].type === "turn/start") {
          open = this.events[at].data?.turn ?? null;
          break;
        }
        if (this.events[at].type === "turn/end") break;
      }
      if ((data?.turn ?? null) !== open) throw new Error(`fake session: ${type} does not match the open turn (${data?.turn ?? null} vs ${open})`);
    }
    const event = { seq: this.events.length + 1, type, data };
    this.events.push(event);
    const op = options.surfaceOp;
    if (op && typeof op === "object" && op.op === "replace") {
      const from = this.surface.nodes.indexOf(op.startSeq);
      const to = this.surface.nodes.indexOf(op.endSeq);
      if (from < 0 || to < from) throw new Error(`fake session: bad replace ${op.startSeq}-${op.endSeq}`);
      this.surface.nodes.splice(from, to - from + 1, event.seq);
      this.surface.replaceGeneration += 1;
    } else if (SURFACE_TYPES.has(type)) {
      this.surface.nodes.push(event.seq);
    }
    for (const listener of this.listeners) listener(this, event);
    return event;
  }

  eventAt(seq) {
    return this.events[seq - 1];
  }

  snapshotEvents() {
    return [...this.events];
  }

  deriveMessages() {
    return this.surface.nodes.map((seq) => this.eventAt(seq).data);
  }

  requestHeader() {
    return { config: this.route };
  }
}

export const tokensOfChars = (chars) => Math.ceil(chars / 4) + 4;

export const tokenMeter = {
  measure(session) {
    const nodes = session.surface.nodes.map((seq) => ({ seq, tokens: tokensOfChars(eventChars(session.eventAt(seq))) }));
    return { nodes, totalTokens: nodes.reduce((sum, node) => sum + node.tokens, 0) };
  },
  estimateMessage(message) {
    return tokensOfChars(textOfContent(message?.content).length);
  },
  estimateText(text) {
    return tokensOfChars(String(text).length);
  },
};

export function fakeContext({ contextWindow = 1_000_000, services = {} } = {}) {
  const handlers = new Map();
  const logs = [];
  const log = (level) => (line) => logs.push(`${level} ${line}`);
  const ctx = {
    handlers,
    logs,
    reflect: { provide() {}, store: {} },
    fiber: { store: {} },
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
      return () => {};
    },
    effect(fn) {
      const out = fn();
      if (out && typeof out[Symbol.iterator] === "function" && typeof out.next === "function") for (const _ of out) {}
      return () => {};
    },
    inject(names, fn) {
      fn(ctx);
    },
    logger: { info: log("info"), warn: log("warn"), debug: log("debug"), error: log("error") },
    get(name) {
      return services[name];
    },
    provide() {},
    tokenMeter,
    sessions: { async flush() {} },
    llm: {
      async resolveModelInfo() {
        return { context: { contextWindow } };
      },
    },
    ...services,
  };
  return ctx;
}

export function fakeAgent(session) {
  return {
    session,
    options: {},
    async runMaintenance(fn) {
      return fn(new AbortController().signal);
    },
  };
}

// ---- message builders -------------------------------------------------------

let callCounter = 0;

export function userMessage(text) {
  return { role: "user", content: [{ type: "text", text }], source: { kind: "user" } };
}

export function addUser(session, text) {
  return session.append("user/message", userMessage(text));
}

export function addAssistantText(session, text, usage) {
  return session.append("assistant/message", {
    message: { role: "assistant", content: [{ type: "text", text }] },
    ...(usage ? { usage } : {}),
  });
}

/** One tool round: assistant tool-call + tool/result. Returns the call id. */
export function addToolRound(session, { name = "bash", command = "ls", output = "ok", turn = 1, usage } = {}) {
  callCounter += 1;
  const id = `call-${callCounter}`;
  session.append("assistant/message", {
    turn,
    message: { role: "assistant", content: [{ type: "tool-call", id, name, arguments: { command } }] },
    ...(usage ? { usage } : {}),
  });
  session.append("tool/result", { turn, message: { role: "tool", toolCallId: id, content: [{ type: "text", text: output }] } });
  return id;
}

export function filler(label, chars) {
  const line = `${label} line with some content 0123456789 abcdefghij\n`;
  return line.repeat(Math.ceil(chars / line.length)).slice(0, chars);
}
