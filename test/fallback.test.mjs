import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fakeAgent, fakeContext, FakeSession } from "./helpers/fake-dsh.mjs";

const root = mkdtempSync(join(tmpdir(), "strata-fallback-"));
process.env.STRATA_SHADOW_DIR = root;
const { default: Entry } = await import("../shell.js");
const { default: Engine } = await import("../index.js");
const { BasicCompactionEngine } = await import("@deepseek-ai/dsh-compaction-basic");
const { configConflicts, installedConflicts } = await import("../lib/conflicts.js");
const { takeover } = await import("../lib/takeover.js");
const tools = await import("../tools-plugin.js");
const { default: Gate } = await import("../gate.js");
after(() => rmSync(root, { recursive: true, force: true }));

test("takes over when nothing conflicts", () => {
  const engine = new Entry(fakeContext(), {});
  assert.ok(engine instanceof Engine);
  assert.equal(takeover().mode, "active");
});

test("falls back to stock compaction when a conflicting plugin is installed", () => {
  process.env.STRATA_FAKE_CONFLICT = "dsh-live-compact";
  try {
    const ctx = fakeContext();
    const engine = new Entry(ctx, {});
    assert.ok(engine instanceof BasicCompactionEngine);
    assert.equal(engine instanceof Engine, false);
    assert.equal(takeover().mode, "stock");
    assert.ok(ctx.logs.some((line) => line.includes("dsh-live-compact")));
  } finally {
    delete process.env.STRATA_FAKE_CONFLICT;
  }
});

test("yields without providing when another plugin already owns ctx.compaction", () => {
  const ctx = fakeContext();
  ctx.reflect.store = { [Symbol("compaction")]: { name: "compaction", fiber: { name: "billion-context" } } };
  const engine = new Entry(ctx, {});
  assert.equal(engine.strataPassive, true);
  assert.equal(takeover().mode, "yielded");
  assert.ok(Object.keys(ctx.reflect.store).length === 0 && Object.getOwnPropertySymbols(ctx.reflect.store).length === 1, "the other provider is untouched");
});

test("a sibling preset's isolated stock engine does not make Strata yield (Web/Desktop presets)", () => {
  // Cordis keeps all services in one store; each preset isolates `compaction`
  // under its own key. Only this context's key may count as an owner.
  const ctx = fakeContext();
  const mine = Symbol("compaction");
  const sibling = Symbol("compaction");
  ctx[Symbol.for("cordis.isolate")] = { compaction: mine };
  ctx.reflect.store = { [sibling]: { name: "compaction", fiber: { name: "@deepseek-ai/dsh-compaction-basic" } } };
  const engine = new Entry(ctx, {});
  assert.ok(engine instanceof Engine, "takes over its own preset");
  assert.equal(takeover().mode, "active");
  assert.ok(ctx.reflect.store[sibling], "the sibling preset's engine is untouched");
});

test("yields when this preset's own scope already has another compaction owner", () => {
  const ctx = fakeContext();
  const mine = Symbol("compaction");
  ctx[Symbol.for("cordis.isolate")] = { compaction: mine };
  ctx.reflect.store = { [mine]: { name: "compaction", fiber: { name: "billion-context" } } };
  const engine = new Entry(ctx, {});
  assert.equal(engine.strataPassive, true);
  assert.equal(takeover().mode, "yielded");
});

test("engine constructor failure: /compact fails fast instead of hanging", () => {
  process.env.STRATA_ENGINE_FAIL = "construct";
  try {
    const engine = new Entry(fakeContext(), {});
    assert.equal(takeover().mode, "unavailable");
    return assert.rejects(engine.compactNow(fakeAgent(new FakeSession()), new AbortController().signal), /未接管/);
  } finally {
    delete process.env.STRATA_ENGINE_FAIL;
  }
});

test("conflict detection helpers", () => {
  assert.deepEqual(installedConflicts({ resolve() { throw new Error("nope"); }, env: {} }), []);
  assert.deepEqual(installedConflicts({ resolve() { return "/x"; }, env: {} }).map((item) => item.name), ["dsh-live-compact", "billion-context", "@light-cheng/dsh-strata"]);
  assert.deepEqual(installedConflicts({ resolve() { return "/x"; }, env: { STRATA_IGNORE_CONFLICTS: "1" } }), []);
  const preset = { id: "standard", plugins: [{ name: "@deepseek-ai/dsh-compaction-basic" }, { name: "billion-context/native" }, { name: "dsh-live-compact", disabled: true }] };
  assert.deepEqual(configConflicts(preset), ["billion-context"]);
});

test("gate leaves presets alone when a conflicting row is enabled", () => {
  const ctx = fakeContext();
  new Gate(ctx);
  const [hook] = ctx.handlers.get("internal/config");
  const preset = { id: "standard", plugins: [{ name: "@deepseek-ai/dsh-compaction-basic" }, { name: "dsh-live-compact/gate" }] };
  assert.equal(hook(null, () => preset), preset);
  assert.ok(ctx.logs.some((line) => line.includes("dsh-live-compact")));
});

test("tools row registers nothing but /strata when Strata is not in control", () => {
  const registered = [];
  const commands = [];
  const ctx = fakeContext({ services: {
    compaction: {},
    tools: { register(tool) { registered.push(tool.name); return () => {}; } },
    commands: { register(command) { commands.push(command); return () => {}; } },
    systemPrompt: { section() { throw new Error("should not register guidance"); } },
  } });
  tools.apply(ctx);
  assert.deepEqual(registered, []);
  assert.equal(commands[0].name, "strata");
  const reply = commands[0].handler({ rawInput: "", agent: fakeAgent(new FakeSession()) });
  assert.equal(reply.kind, "success");
  assert.match(reply.text, /did not take over|has not started/);
});

test("tools row with the Strata engine: tools, guidance, /strata, nudge on pre-step", async () => {
  const registered = [];
  const commands = [];
  const sections = [];
  const base = fakeContext();
  const engine = new Engine(base, {});
  const ctx = fakeContext({ services: {
    compaction: engine,
    tools: { register(tool) { registered.push(tool.name); return () => {}; } },
    commands: { register(command) { commands.push(command); return () => {}; } },
    systemPrompt: { section(section) { sections.push(section); return () => {}; } },
  } });
  tools.apply(ctx);
  assert.deepEqual(registered.sort(), ["compress", "decompress", "search_context", "strata_status"]);
  assert.equal(sections[0].interpolate, false);
  assert.equal(sections[0].text, tools.STRATA_GUIDANCE, "guidance is a fixed constant (stable prefix)");
  const agent = fakeAgent(new FakeSession({ id: "s-cmd" }));
  assert.match(commands[0].handler({ rawInput: "", agent }).text, /Strata Context: active/);
  assert.equal(commands[0].handler({ rawInput: "bogus", agent }).kind, "error");
  assert.match(commands[0].handler({ rawInput: "search anything", agent }).text, /No archived context/);
  assert.match(commands[0].handler({ rawInput: "purge", agent }).text, /Deleted 0 archive files/);
  const [preStep] = ctx.handlers.get("agent/pre-step");
  const decision = { kind: "enter", messages: [{ role: "user", content: [] }] };
  const out = await preStep({ agent, signal: new AbortController().signal }, async () => decision);
  assert.equal(out, decision, "no nudge on an empty session");
});
