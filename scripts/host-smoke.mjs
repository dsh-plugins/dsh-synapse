// Use an installed DSH package.json to exercise the real scoped Agent lifecycle.
// No provider credentials or network requests are needed: only LLM output is stubbed.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { defaultsFor } from "@dsh-plugin/dsh-loader/config";
import { template } from "../lib/host/config.js";
import { Harness } from "../lib/host/harness.js";
import { learningTools } from "../lib/host/native-tools.js";
import { Memory } from "../lib/host/memory.js";
import { SkillStore } from "../lib/host/files.js";
import { chatTools } from "../lib/host/chat-tools.js";
import { Inference } from "../lib/host/runtime.js";
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
const nativeCalls = [];
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
    if (nativeCalls.length) {
      const { name, args } = nativeCalls.shift();
      assert(request.tools.some((tool) => tool.name === name));
      yield { type: "tool-call-delta", index: 0, id: `native-${requests.length}`, name, argumentsDelta: JSON.stringify(args) };
      yield { type: "finish", reason: { kind: "tool-calls" } };
      return;
    }
    yield { type: "text-delta", index: 0, text: "native DSH response" };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}
await ctx.plugin(FixtureLlm);
class FixtureShell extends Service {
  constructor(ctx) {
    super(ctx, "shell");
  }
  sandboxMode = "workspace-write";
}
await ctx.plugin(FixtureShell);
class FixtureWorkingDirectory extends Service {
  constructor(ctx) {
    super(ctx, "workingDirectory");
  }
  async ensure() {
    return data;
  }
}
await ctx.plugin(FixtureWorkingDirectory);
for (const name of [
  "dsh-session-projection",
  "dsh-session",
  "dsh-session-title",
  "dsh-agent",
  "dsh-system-prompt",
  "dsh-tools",
  "dsh-tool-executor-native",
  "dsh-agent-loop",
  "dsh-user-approval",
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
    name === "dsh-agent-loop" ? { agents: [], maxParallelToolCalls: 1 }
      : name === "dsh-session-title" ? { fallbackMaxWords: 12, fallbackMaxBytes: 128, maxTitleBytes: 1024 } : {},
  );
}
const permissionPlugin = await load("dsh-permission-presets");
await ctx.plugin((await load("dsh-attachment-local")).default, { dshHome: data });
await ctx.plugin(permissionPlugin.default ?? permissionPlugin, {
  presets: {
    "read-only": { sandbox: "read-only", approval: "ask" },
    "workspace-write": { sandbox: "workspace-write", approval: "ask" },
    "danger-full-access": { sandbox: "danger-full-access", approval: "never" },
  },
  defaultPreset: "workspace-write",
});
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
const paths = { data, home: data, profile: data, skills: path.join(data, "skills") };
const memory = new Memory(":memory:", { embed: async () => [1, ...Array(511).fill(0)] }, () => config);
const skills = new SkillStore(paths);
const inference = new Inference(path.join(data, "inference"));
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
    "chat",
    "【群聊】铁砧工艺交流反馈☕（123）",
  );
const permissionOf = async (id) => {
  await ctx.sessionPersistence.flush();
  const handle = await ctx.sessionPersistence.open(id, "read");
  try {
    const read = await handle.read();
    const events = read.events ?? read;
    const last = (type) =>
      events.filter((event) => event.type === type).at(-1)?.data;
    const preset = last("permission/preset")?.preset;
    const spec = ctx.permissionPresets.resolve(preset);
    assert.equal(last("sandbox/mode")?.mode, spec.sandbox);
    assert.equal(last("approval/policy")?.policy, spec.approval);
    assert.equal(ctx.permissionPresets.defaultPreset, "workspace-write");
    return preset;
  } finally {
    await handle.close();
  }
};
try {
  assert.equal(
    await residentRun("Shared SOUL {{literal}}", "first resident message"),
    "native DSH response",
  );
  assert.equal(requests.length, 1);
  assert.equal(ctx.sessionTitle.get(ctx.agents.get(requests[0].sessionId)?.session)?.title, "【群聊】铁砧工艺交流反馈☕（123）");
  assert.equal(requests[0].provider, "host-provider");
  assert.equal(requests[0].model, "host-model");
  assert.equal(await permissionOf(requests[0].sessionId), "read-only");
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
  nativeCalls.push(
    { name: "synapse_memory_save", args: { text: "原生回合主动保存的重要事实" } },
    { name: "synapse_memory_search", args: { query: "重要事实" } },
    { name: "synapse_skill_save", args: { name: "auto-chat-example", content: "# 流程\n已验证的步骤" } },
    { name: "synapse_skill_read", args: { name: "auto-chat-example" } },
  );
  await residentRun("主动总结", "保存本次经验", learningTools(() => config, memory, skills, "chat"));
  assert.equal(memory.list("chat")[0].text, "原生回合主动保存的重要事实");
  assert.equal(memory.list("review").length, 0);
  assert.equal((await skills.list())[0].content, "# 流程\n已验证的步骤");
  const originalFetch = globalThis.fetch;
  const repositories = config.repositories;
  try {
    config.repositories = "foo/bar";
    let queries = 0;
    globalThis.fetch = async (input, init) => {
      init.signal.throwIfAborted();
      assert(!new Headers(init.headers).has("Authorization"));
      queries++;
      const url = new URL(input);
      if (url.hostname === "ghapi.anvilcraft.dev") {
        return Response.json({ title: "宿主查询验证 Issue", body: "真实工具返回", html_url: "https://github.com/foo/bar/issues/114", state: "open" });
      }
      assert.equal(url.hostname, "api.bilibili.com");
      return Response.json({ code: 0, data: { bvid: "BV1xx411c7mD", title: "宿主查询验证视频", owner: { name: "foo" } } });
    };
    nativeCalls.push(
      { name: "synapse_github_issue", args: { reference: "foo/bar#114" } },
      { name: "synapse_bilibili_video", args: { video: "BV1xx411c7mD" } },
    );
    await residentRun("使用查询结果回复", "查询项目和视频", chatTools(() => config, paths, { type: "user", userId: "1", name: "example", admin: false }));
    assert.equal(queries, 2);
    assert.match(JSON.stringify(requests.at(-1)), /宿主查询验证 Issue/);
    assert.match(JSON.stringify(requests.at(-1)), /宿主查询验证视频/);
  } finally {
    globalThis.fetch = originalFetch;
    config.repositories = repositories;
  }
  if (process.argv[3]) {
    // 指定旧版 sharp 入口，可在不下载模型权重时验证真实 DLL 的进程隔离。
    const runtime = path.join(data, "inference", "runtime", "node_modules", "@huggingface", "transformers");
    await mkdir(runtime, { recursive: true });
    await writeFile(path.join(runtime, "package.json"), JSON.stringify({ name: "@huggingface/transformers", version: "3.8.1", type: "module", exports: "./index.mjs" }));
    await writeFile(path.join(runtime, "index.mjs"), `import ${JSON.stringify(pathToFileURL(path.resolve(process.argv[3])).href)};\nexport * from ${JSON.stringify(new URL("../test/fixtures/inference-runtime.mjs", import.meta.url).href)};\n`);
    const [pid] = await inference.embed("example");
    assert.notEqual(pid, process.pid);
  }
  await residentRun("识别聊天图片", [
    { type: "text", text: "看看图片" },
    { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" } },
  ]);
  const image = requests.at(-1).messages.flatMap((message) => message.content).find((part) => part.type === "image");
  assert.equal(image.attachment.width, 1);
  assert.equal(image.attachment.height, 1);
  assert((await ctx.attachments.readImage(image.attachment)).data.length > 0);
  await harness.close();
  harness = makeHarness();
  config.sessionPermission = "danger-full-access";
  await residentRun("Updated persona", "after plugin reload");
  assert.equal(await permissionOf(requests[0].sessionId), "read-only");
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
  assert.equal(
    await permissionOf(requests.at(-1).sessionId),
    "danger-full-access",
  );
  assert(!JSON.stringify(requests.at(-1)).includes("first resident message"));
  assert.equal((await ctx.sessionPersistence.list()).length, 2);
  config.sessionPermission = "workspace-write";
  await harness.run("context", "new workspace session");
  assert.equal(
    await permissionOf(requests.at(-1).sessionId),
    "workspace-write",
  );
  config.sessionPermission = "auto";
  await assert.rejects(
    harness.run("context", "unavailable auto"),
    /dsh-experimental-auto-review/,
  );
  // Older DSH builds lack registerAuto; their three standard modes still work.
  if (ctx.permissionPresets.registerAuto) {
    const autoPlugin = await load("dsh-experimental-auto-review");
    await ctx.plugin(autoPlugin.default ?? autoPlugin);
    await harness.run("context", "new auto session");
    assert.equal(await permissionOf(requests.at(-1).sessionId), "auto");
  }
  console.log(
    "真实 DSH 验证通过：图片附件、会话标题、权限、原生 RAG/Skill 与查询工具、JSONL 恢复、取消与重置。",
  );
} finally {
  await harness.close();
  await inference.close();
  memory.close();
  await ctx.fiber.dispose();
  assert(path.resolve(data).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await rm(data, { recursive: true, force: true });
}
