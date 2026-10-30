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
const requests = [];
let callTool = false;
class FixtureLlm extends Service {
  constructor(ctx) {
    super(ctx, "llm");
  }
  async prepareCall(config) {
    return { config, stream: (request) => this.stream(request) };
  }
  async *stream(request) {
    requests.push(request);
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
const harness = new Harness(
  { services: { get: (name) => ctx.get(name) }, llm },
  () => config,
  { data: await mkdtemp(path.join(os.tmpdir(), "synapse-native-")) },
  {
    call: async (_tool, args, signal) => {
      signal.throwIfAborted();
      assert.equal(args.query, "hello");
      calls++;
      return { content: [{ type: "text", text: "tool result" }] };
    },
  },
);
try {
  assert.equal(
    await harness.run("Shared SOUL {{literal}}", "hello"),
    "native DSH response",
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].provider, "host-provider");
  assert.equal(requests[0].model, "host-model");
  assert.match(JSON.stringify(requests[0]), /Shared SOUL \{\{literal\}\}/);
  callTool = true;
  await harness.run(
    "Shared SOUL",
    "read docs",
    [],
    [
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
    ],
  );
  assert.equal(calls, 1);
  assert.equal(requests.length, 3);
  console.log(
    "Real DSH Agent, default model, scoped prompt/tools, tool execution, stream and disposal passed.",
  );
} finally {
  await harness.close();
  await ctx.fiber.dispose();
}
