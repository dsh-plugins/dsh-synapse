// Use an installed DSH package.json to exercise the real scoped Agent lifecycle.
// No provider credentials or network requests are needed: only LLM output is stubbed.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import { defaultsFor } from "@dsh-plugin/dsh-loader/config";
import { template } from "../lib/host/config.js";
import { Harness } from "../lib/host/harness.js";
if (!process.argv[2])
  throw new Error(
    "Usage: node scripts/host-smoke.mjs <installed DSH package.json>",
  );
const require = createRequire(path.resolve(process.argv[2]));
const load = async (name) =>
  import(pathToFileURL(require.resolve("@deepseek-ai/" + name)).href);
const { Context, Service } = await load("cordis");
const llm = await load("dsh-llm");
const ctx = new Context();
const data = await mkdtemp(path.join(os.tmpdir(), "synapse-native-"));
const requests = [];
let callTool = false;
let blockNext = false,
  blocked;
class FixtureLlm extends Service {
  constructor(ctx) {
    super(ctx, "llm");
  }
  async prepareCall(config) {
    return { config, stream: (request) => this.stream(request) };
  }
  async *stream(request) {
    requests.push(request);
    if (blockNext) {
      blockNext = false;
      blocked();
      await new Promise((resolve) =>
        request.signal.addEventListener("abort", resolve, { once: true }),
      );
      request.signal.throwIfAborted();
    }
    if (callTool) {
      callTool = false;
      assert(request.tools.some((t) => t.name === "mcp_fixture_read"));
      assert(!request.tools.some((t) => t.name === "global_tool"));
      yield {
        type: "tool-call-delta",
        index: 0,
        id: "fixture-call",
        name: "mcp_fixture_read",
        argumentsDelta: '{"query":"hello"}',
      };
      yield { type: "finish", reason: { kind: "tool-calls" } };
      return;
    }
    yield { type: "text-delta", index: 0, text: "native DSH response" };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}
await ctx.plugin(FixtureLlm);
for (const name of [
  "dsh-session-projection",
  "dsh-session",
  "dsh-agent",
  "dsh-system-prompt",
  "dsh-tools",
  "dsh-tool-executor-native",
  "dsh-agent-loop",
]) {
  if (name === "dsh-tool-executor-native") {
    try {
      require.resolve("@deepseek-ai/" + name);
    } catch (error) {
      if (error.code === "MODULE_NOT_FOUND") continue;
      throw error;
    }
  }
  const plugin = await load(name);
  await ctx.plugin(
    plugin.default ?? plugin,
    name === "dsh-agent-loop" ? { agents: [], maxParallelToolCalls: 1 } : {},
  );
}
await ctx.plugin((await load("dsh-agent-default-model")).default, {
  provider: "host-provider",
  model: "host-model",
});
const config = defaultsFor(template.fields);
const persistencePlugin = await load("dsh-session-persistence-jsonl");
await ctx.plugin(persistencePlugin.default ?? persistencePlugin, {
  root: path.join(data, "native-history"),
});
let calls = 0;
ctx.tools.register({
  name: "global_tool",
  description: "must be hidden",
  parameters: { type: "object" },
  output: { schema: { type: "object" }, render: () => [] },
  execute: async () => {
    throw new Error("global tool must not run");
  },
});
const makeHarness = () =>
  new Harness(
    { services: { get: (name) => ctx.get(name) }, llm },
    () => config,
    { data },
    {
      call: async (_tool, args, signal) => {
        signal.throwIfAborted();
        assert.equal(args.query, "hello");
        calls++;
        return { content: [{ type: "text", text: "tool result" }] };
      },
    },
  );
let harness = makeHarness();
const residentRun = (system, input, tools = [], signal) =>
  harness.run(
    system,
    input,
    [],
    tools,
    signal,
    undefined,
    undefined,
    "chat:group:123",
  );
try {
  assert.equal(
    await residentRun("Shared SOUL {{literal}}", "first resident message"),
    "native DSH response",
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].provider, "host-provider");
  assert.equal(requests[0].model, "host-model");
  assert.match(JSON.stringify(requests[0]), /Shared SOUL \{\{literal\}\}/);
  callTool = true;
  await residentRun("Shared SOUL", "read docs", [
    {
      name: "mcp_fixture_read",
      server: "fixture",
      rawName: "read",
      description: "Read docs",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  ]);
  assert.equal(calls, 1);
  assert.equal(requests.length, 3);
  assert.match(JSON.stringify(requests[1]), /first resident message/);
  await harness.close();
  harness = makeHarness();
  await residentRun("Updated persona", "after plugin reload");
  assert.match(JSON.stringify(requests.at(-1)), /first resident message/);
  assert.match(JSON.stringify(requests.at(-1)), /Updated persona/);
  assert.equal((await ctx.sessionPersistence.list()).length, 1);
  const controller = new AbortController();
  const waiting = new Promise((resolve) => {
    blocked = resolve;
  });
  blockNext = true;
  const cancelled = assert.rejects(
    residentRun("Updated persona", "cancel this turn", [], controller.signal),
    /abort/i,
  );
  await waiting;
  controller.abort();
  await cancelled;
  await residentRun("Updated persona", "continue after cancellation");
  assert.equal(requests.at(-1).sessionId, requests[0].sessionId);
  config.maxToolRounds = 1;
  callTool = true;
  await assert.rejects(
    residentRun("Updated persona", "step limit", [
      {
        name: "mcp_fixture_read",
        server: "fixture",
        rawName: "read",
        description: "docs",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
    ]),
    /步骤上限/,
  );
  config.maxToolRounds = 6;
  await residentRun("Updated persona", "continue after failed turn");
  assert.equal(requests.at(-1).sessionId, requests[0].sessionId);
  await harness.reset("chat:group:123");
  await residentRun("Fresh persona", "after explicit reset");
  assert(!JSON.stringify(requests.at(-1)).includes("first resident message"));
  assert.equal((await ctx.sessionPersistence.list()).length, 2);
  console.log(
    "Real DSH resident Agent: follow-ups, tools, JSONL resume, cancellation/error recovery and reset passed.",
  );
} finally {
  await harness.close();
  await ctx.fiber.dispose();
}
