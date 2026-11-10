// Use an installed DSH package.json to exercise the real scoped Agent lifecycle.
// No provider credentials or network requests are needed: only LLM output is stubbed.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, stat as fsStat } from "node:fs/promises";
import os from "node:os";
import { defaultsFor } from "@dsh-plugin/dsh-loader/config";
import { template } from "../lib/host/config.js";
import { Harness } from "../lib/host/harness.js";
import { learningTools } from "../lib/host/native-tools.js";
import { learningDelegations } from "../lib/host/learning.js";
import { Memory } from "../lib/host/memory.js";
import { SkillStore } from "../lib/host/files.js";
import { chatTools } from "../lib/host/chat-tools.js";
import { Inference } from "../lib/host/runtime.js";
import { SessionBindings } from "../lib/host/session-bindings.js";
import { ChatState } from "../lib/host/chat-state.js";
import { ChatImages } from "../lib/host/chat-images.js";
import { ChatActivity } from "../lib/host/chat-activity.js";
if (!process.argv[2])
  throw new Error(
    "Usage: node scripts/host-smoke.mjs <installed DSH package.json>",
  );
const require = createRequire(path.resolve(process.argv[2]));
const load = async (name) =>
  import(pathToFileURL(require.resolve("@deepseek-ai/" + name)).href);
const { Context, Service } = await load("cordis");
const llm = await load("dsh-llm");
const nativeInstructions = await load("dsh-agent-instructions");
const data = await mkdtemp(path.join(os.tmpdir(), "synapse-native-"));
const originalDshHome = process.env.DSH_HOME;
process.env.DSH_HOME = data;
await writeFile(path.join(data, "AGENTS.md"), "宿主原生 AGENTS 规则");
let hasPresets = true;
try {
  require.resolve("@deepseek-ai/dsh-agent-preset-registry");
} catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") { throw error; }
  hasPresets = false;
}
let ctx;
if (hasPresets) {
  const configPath = path.join(data, "cordis.yml");
  await writeFile(configPath, '- id: skills\n  name: "@deepseek-ai/dsh-skill"\n');
  const { boot, loadOverlayPatches } = await load("dsh-app-boot");
  const patches = loadOverlayPatches("synapse-native", fileURLToPath(new URL("../cordis.patch.yml", import.meta.url)));
  const provider = patches.flatMap(patch => patch.insert ?? []).find(row => row.id === "dsh-synapse-profile-skills");
  assert(provider);
  ctx = await boot("synapse-native", configPath, [{ insert: [provider] }], root => {
    root.provide("profileContext", { dir: data, cwd: data, home: data });
  }, pathToFileURL(path.resolve(process.argv[2])).href);
} else {
  ctx = new Context();
}
const requests = [];
const routes = [];
const nativeCalls = [];
let callTool = false;
let blockNext = false,
  blocked;
class FixtureLlm extends Service {
  constructor(ctx) {
    super(ctx, "llm");
  }
  async prepareCall(config) {
    return { config, stream: (request) => {
      routes.push({ sessionId: request.sessionId, provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort });
      return this.stream(request);
    } };
  }
  async resolveModelInfo() { return { inputModalities: ["text", "image"] }; }
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
      assert(request.tools.some((t) => t.name === "global_tool"));
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
      assert(request.tools.some((tool) => tool.name === name), `当前回合缺少 ${name}：${JSON.stringify(request.messages.slice(-2))}`);
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
class FixtureFs extends Service {
  constructor(ctx) { super(ctx, "fs"); }
  async resolve(input, { cwd = data, signal } = {}) {
    signal?.throwIfAborted();
    const absolute = path.resolve(cwd, input);
    return { displayPath: absolute };
  }
  async stat(target, signal) {
    signal?.throwIfAborted();
    try {
      const info = await fsStat(target.displayPath ?? target);
      return { type: info.isDirectory() ? "directory" : "file", size: info.size, version: `${info.mtimeMs}:${info.size}` };
    } catch (error) {
      if (error.code === "ENOENT") { return undefined; }
      throw error;
    }
  }
  processPath(target) { return target.displayPath ?? target; }
  async listDir(target) {
    const entries = await readdir(target.displayPath, { withFileTypes: true });
    return entries.map(entry => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
      target: { displayPath: path.join(target.displayPath, entry.name) },
    }));
  }
  readText(target, signal) { return readFile(target.displayPath, { encoding: "utf8", signal }); }
  async *streamText(target, signal) {
    signal?.throwIfAborted();
    yield await readFile(target.displayPath ?? target, "utf8");
  }
  async readBytes(target, signal, limit) {
    const bytes = await readFile(target.displayPath ?? target, { signal });
    if (bytes.length > limit) { throw new Error("读图超过字节限制"); }
    return bytes;
  }
}
await ctx.plugin(FixtureFs);
class FixtureWorkingDirectory extends Service {
  constructor(ctx) {
    super(ctx, "workingDirectory");
  }
  directories = new Map();
  get(session) {
    return this.directories.get(session.id) ?? session.header.cwd ?? data;
  }
  async ensure(agent) {
    return this.get(agent.session);
  }
  async set(agent, cwd) {
    this.directories.set(agent.id, cwd);
    return cwd;
  }
}
for (const name of [
  "dsh-session-projection",
  "dsh-session",
  "dsh-session-title",
  "dsh-agent",
  "dsh-working-directory",
  "dsh-system-prompt",
  "dsh-tools",
  ...(hasPresets ? [] : ["dsh-skill", "dsh-tool-skill"]),
  "dsh-tool-executor-native",
  "dsh-agent-loop",
  "dsh-user-approval",
]) {
  if (name === "dsh-working-directory") {
    try {
      require.resolve("@deepseek-ai/" + name);
    } catch (error) {
      if (error.code !== "MODULE_NOT_FOUND") {
        throw error;
      }
      await ctx.plugin(FixtureWorkingDirectory);
      continue;
    }
  }
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
      : name === "dsh-working-directory" ? { defaultDirectory: data }
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
let hasWorkspaceRegistry = true;
try {
  require.resolve("@deepseek-ai/dsh-workspace");
} catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") { throw error; }
  hasWorkspaceRegistry = false;
}
if (hasWorkspaceRegistry) {
  for (const [name, settings] of [
    ["dsh-storage", {}],
    ["dsh-storage-json", { root: path.join(data, "storage") }],
    ["dsh-storage-domain", { backend: "json" }],
    ["dsh-workspace", {}],
  ]) {
    const plugin = await load(name);
    await ctx.plugin(plugin.default ?? plugin, settings);
  }
}
if (hasPresets) {
  const entry = name => pathToFileURL(require.resolve("@deepseek-ai/" + name)).href;
  await ctx.loader.create({ name: entry("dsh-agent-preset-registry"), config: { default: "standard" } });
  await ctx.loader.await();
  await ctx.loader.create({ name: entry("dsh-agent-preset"), config: { id: "standard", plugins: [
    { id: "persona", name: entry("dsh-persona"), config: { prefix: "标准预设系统提示词 {{model}}" } },
    { id: "instructions", name: entry("dsh-agent-instructions"), config: { maxBytes: 65536 } },
    { id: "tool-skill", name: entry("dsh-tool-skill") },
  ] } });
  await ctx.loader.await();
}
await ctx.plugin((await load("dsh-subagent")).default, { maxActiveSubagents: 8, maxDepth: 1 });
await ctx.plugin(await load("dsh-subagent-spawn-in-process"), { providerName: "spawn" });
let calls = 0, inheritedCalls = 0;
ctx.tools.register({
  name: "global_tool",
  description: "宿主已有工具应由 Synapse 继承",
  parameters: { type: "object" },
  output: { schema: { type: "object" }, render: () => [] },
  execute: async () => {
    inheritedCalls++;
    return { result: "宿主继承工具执行成功" };
  },
});
const makeHarness = () =>
  new Harness(
    { services: { get: (name) => ctx.get(name) }, llm, dsh: { agentInstructions: { renderAgentInstructions: nativeInstructions.renderAgentInstructions ?? nativeInstructions.renderWorkspaceContext } } },
    () => config,
    { data, profile: data },
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
  {
    const file = { absolutePath: path.join(data, "SOUL.md"), displayPath: "$DSH_HOME/SOUL.md", content: "聊天人设补充规则" };
    await harness.run("Synapse 独立补充上下文", "标准预设验证", [], [], undefined, undefined, undefined, "chat:group:123", "chat", undefined, [file]);
    const messages = requests.at(-1).messages;
    const text = message => message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
    if (hasPresets) {
      assert(messages.some(message => message.role === "system" && text(message).includes("标准预设系统提示词")));
      assert(messages.some(message => message.role === "user" && message.source.kind === "agent-instructions" && text(message).includes("宿主原生 AGENTS 规则")));
    }
    assert(messages.some(message => message.role === "user" && text(message).includes(file.displayPath) && text(message).includes(file.content)));
    assert(!messages.some(message => message.role === "system" && text(message).includes(file.content)));
    nativeCalls.push({ name: "global_tool", args: {} });
    await residentRun("标准预设工具验证", "调用继承工具");
    assert.equal(inheritedCalls, 1);
    requests.length = 0;
    routes.length = 0;
  }
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
  const repositories = config.github.repositories;
  try {
    config.github.repositories = [{ repository: "foo/bar", reviewPr: false, triageIssues: false, sendCards: true }];
    let queries = 0;
    globalThis.fetch = async (input, init) => {
      init.signal.throwIfAborted();
      assert(!new Headers(init.headers).has("Authorization"));
      queries++;
      const url = new URL(input);
      if (url.hostname === "ghapi.anvilcraft.dev") {
        return Response.json({ title: "宿主查询验证 Issue", body: "真实工具返回", html_url: "https://github.com/foo/bar/issues/114", state: "open" });
      }
      if (url.hostname === "127.0.0.1") {
        const params = JSON.parse(init.body);
        if (url.pathname === "/get_group_msg_history") { assert.equal(params.group_id, 123); }
        return Response.json({ status: "ok", retcode: 0, data: { messages: [{ raw_message: "OneBot 原生回执验证" }] }, echo: "receipt-echo" });
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
    nativeCalls.push(
      { name: "synapse_get_group_msg_history", args: { count: 2 } },
      { name: "synapse_onebot_api", args: { path: "/get_status", params: {} } },
    );
    await residentRun("读取当前群历史和通用接口", "调用 OneBot 工具", chatTools(() => config, paths, { type: "group", groupId: "123", userId: "1", name: "example", admin: false }));
    assert.match(JSON.stringify(requests.at(-1)), /OneBot 原生回执验证/);
    assert.match(JSON.stringify(requests.at(-1)), /receipt-echo/);
  } finally {
    globalThis.fetch = originalFetch;
    config.github.repositories = repositories;
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
  config.limits.sessionPermission = "danger-full-access";
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
  config.limits.maxToolRounds = 1;
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
  config.limits.maxToolRounds = 6;
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
  config.limits.sessionPermission = "workspace-write";
  await harness.run("context", "new workspace session");
  assert.equal(
    await permissionOf(requests.at(-1).sessionId),
    "workspace-write",
  );
  config.limits.sessionPermission = "auto";
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
  config.limits.sessionPermission = "read-only";
  await harness.close();
  const binding = await new SessionBindings(data).get("chat:group:123");
  const occupied = await ctx.sessionPersistence.open(binding.id, "write");
  harness = makeHarness();
  try {
    const count = (await ctx.sessionPersistence.list()).length;
    await assert.rejects(residentRun("恢复聊天", "会话被占用时的输入"), /会话正被其他写入句柄占用/);
    assert.equal((await new SessionBindings(data).get("chat:group:123")).id, binding.id);
    assert.equal((await ctx.sessionPersistence.list()).length, count);
    assert((await occupied.read()).events.length > 0);
  } finally {
    await occupied.close();
  }
  await residentRun("恢复聊天", "会话释放后继续");
  assert.equal(requests.at(-1).sessionId, binding.id);
  assert.match(JSON.stringify(requests.at(-1).messages), /after explicit reset/);
  await harness.releaseChatSessions();
  assert.equal(ctx.agents.get(binding.id), undefined);
  const closingWriter = await ctx.sessionPersistence.open(binding.id, "write");
  const releaseWriter = new Promise(resolve => setTimeout(resolve, 250)).then(() => closingWriter.close());
  await Promise.all([residentRun("恢复聊天", "等待旧写入句柄关闭"), releaseWriter]);
  assert.equal(requests.at(-1).sessionId, binding.id);
  assert.match(JSON.stringify(requests.at(-1).messages), /会话释放后继续/);
  const removeLearningSkill = ctx.skills.register({
    name: "fixture-learning",
    description: "验证总结子代理先阅读 SKILL",
    source: "runtime",
    content: "只总结已经核实的事实和步骤。",
  });
  const delegated = [];
  const delegationLimit = config.limits.maxToolRounds;
  const offDelegated = ctx.on("subagent/start", (info) => {
    const child = ctx.agents.get(info.id);
    assert.equal(child.session.header.parentSession, requests.at(-1).sessionId);
    assert.equal(child.session.header.origin, "subagent");
    delegated.push(info.id);
  });
  try {
    config.limits.maxToolRounds = -1;
    for (const [kind, args] of [
      ["memory", { text: "原生子代理保存的重要事项" }],
      ["skill", { name: "auto-chat-delegated", content: "# 原生子代理流程\n已验证的复用步骤。" }],
    ]) {
      nativeCalls.push(
        { name: `synapse_${kind}_summarize`, args: { evidence: "已经核实的事实与成功步骤" } },
        { name: "skill", args: { name: "fixture-learning" } },
        { name: `synapse_${kind}_save`, args },
      );
      const start = requests.length;
      await residentRun("主动委派子代理总结", "总结本次任务", learningDelegations({ services: { get: name => ctx.get(name) } }, () => config, memory, skills, "chat"));
      const childRequests = requests.slice(start).filter(request => delegated.includes(request.sessionId));
      assert(childRequests.length > 0);
      assert(childRequests.every(request => request.tools.some(tool => tool.name === "skill")));
      assert(childRequests.every(request => request.tools.every(tool => tool.name === "skill" || tool.name.startsWith(`synapse_${kind}_`))));
      assert(childRequests.some(request => JSON.stringify(request.messages).includes("只总结已经核实的事实和步骤。")));
      const parentRoute = routes[start];
      assert.equal(parentRoute.provider, "host-provider");
      assert.equal(parentRoute.model, "host-model");
      assert(routes.slice(start).filter(route => delegated.includes(route.sessionId)).every(route => route.provider === parentRoute.provider && route.model === parentRoute.model && route.reasoningEffort === parentRoute.reasoningEffort));
    }
    assert(memory.list("chat").some(item => item.text === "原生子代理保存的重要事项"));
    assert((await skills.list()).some(item => item.name === "auto-chat-delegated"));
    assert.equal(delegated.length, 2);
    assert(delegated.every(id => !ctx.agents.get(id)));
  } finally {
    config.limits.maxToolRounds = delegationLimit;
    offDelegated();
    removeLearningSkill();
  }
  const parent = ctx.agents.get(requests.at(-1).sessionId);
  assert.equal(ctx.workingDirectory.get(parent.session), path.join(data, "workspace", "chat"));
  await harness.run("审查规则", "工作区验证", [], [], undefined, undefined, undefined, "review:foo/bar", "review");
  assert.equal(ctx.workingDirectory.get(ctx.agents.get(requests.at(-1).sessionId).session), path.join(data, "workspace", "review"));
  if (hasPresets) {
    assert(JSON.stringify(requests.at(-1).messages).includes("标准预设系统提示词"));
    assert(requests.at(-1).tools.some(tool => tool.name === "global_tool"));
  }
  if (hasWorkspaceRegistry) {
    const readHistory = async (id) => {
      const reader = await ctx.sessionPersistence.open(id, "read");
      try {
        const stored = await reader.read();
        return stored.events ?? stored;
      } finally {
        await reader.close();
      }
    };
    for (const live of [true, false]) {
      const old = await new SessionBindings(data).get("chat:group:123");
      await ctx.workspaceRegistry.archiveSession(old.id);
      await ctx.sessionPersistence.flush();
      const before = await readHistory(old.id);
      assert(before.length > 0);
      if (!live) { await harness.close(); harness = makeHarness(); }
      await residentRun("恢复聊天", "归档后继续");
      const current = await new SessionBindings(data).get("chat:group:123");
      assert.notEqual(current.id, old.id);
      assert.equal(requests.at(-1).sessionId, current.id);
      assert(ctx.workspaceRegistry.archivedSessionIds.includes(old.id));
      assert.deepEqual(await readHistory(old.id), before);
      const workspace = await ctx.workspaceRegistry.resolveByPath(path.join(data, "workspace", "chat"));
      assert(workspace.sessionIds.includes(current.id));
    }
    const review = await new SessionBindings(data).get("review:foo/bar");
    const workspace = await ctx.workspaceRegistry.resolveByPath(path.join(data, "workspace", "review"));
    assert(workspace.sessionIds.includes(review.id));
  }
  {
    const key = "chat:user:456";
    const privateRun = (input) => harness.run("恢复私聊", input, [], [], undefined, undefined, undefined, key);
    await privateRun("检查损坏日志恢复");
    const bindings = new SessionBindings(data);
    const old = await bindings.get(key);
    await harness.close();
    harness = makeHarness();
    const artifact = (await ctx.sessionPersistence.stat(old.id))?.location;
    if (artifact?.kind === "jsonl") {
      assert(path.resolve(artifact.path).startsWith(path.join(data, "native-history") + path.sep));
      await writeFile(artifact.path, "invalid session header\n");
      await privateRun("原生确认历史损坏后继续");
      const current = await bindings.get(key);
      assert.notEqual(current.id, old.id);
      assert.equal(requests.at(-1).sessionId, current.id);
      assert.equal(await readFile(artifact.path, "utf8"), "invalid session header\n");
    }
  }
  {
    await ctx.plugin(await load("dsh-tool-fs"), { read: false, write: false, edit: false, readImage: true });
    const imagePaths = { ...paths, data: path.join(data, "data", "dsh-synapse") };
    await mkdir(imagePaths.data, { recursive: true });
    const state = new ChatState(path.join(imagePaths.data, "chat-state.sqlite"));
    const activityConfig = { ...config, enabled: true, modules: { ...config.modules, chat: { ...config.modules.chat, groups: [987] } } };
    const activity = new ChatActivity({ state, images: new ChatImages(imagePaths, state, () => activityConfig), config: () => activityConfig,
      cloud: { message: async () => ({ boost: 0, words: [] }), removeUsers: async () => {}, close: async () => {} } });
    try {
      await activity.recover((...args) => harness.hasInput(...args)); activity.identity("42");
      const original = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
      const event = { groupId: "987", messageId: "1", userId: "1", selfId: "42", name: "读图验证", time: Date.now(), mentioned: false, message: [{ type: "text", data: { text: "此前普通聊天背景" } }] };
      await activity.observe(event);
      const observed = await activity.observe({ ...event, messageId: "2", mentioned: true, message: [{ type: "image", data: { file: "base64://" + original.toString("base64") } }] });
      const input = await activity.submission("987", observed.seq);
      const file = state.message(observed.seq).attachments[0].path;
      assert.match(file, /[a-f0-9]{64}\.png$/);
      const start = requests.length;
      nativeCalls.push({ name: "read_image", args: { file_path: file } });
      await harness.run("按需使用标准读图工具", input.input, [], [], undefined, undefined, undefined, "chat:group:987", "chat", undefined, [], input.submission);
      assert.equal(state.messages("987").length, 0);
      const batch = state.batch(input.submission.batchId);
      assert.equal(await harness.hasInput(batch.sessionId, batch.messageId, batch.id), true);
      const imageRequests = requests.slice(start);
      assert(!imageRequests[0].messages.flatMap(message => message.content).some(part => part.type === "image"));
      const toolImage = imageRequests.at(-1).messages.flatMap(message => message.content).find(part => part.type === "image");
      assert(toolImage, JSON.stringify(imageRequests.at(-1).messages.slice(-3)));
      assert.equal(toolImage.attachment.width, 1); assert.equal(toolImage.attachment.height, 1);
      assert((await ctx.attachments.readImage(toolImage.attachment)).data.length > 0);
      await activity.finished("native-smoke", batch.id);
    } finally { await activity.close(); }
  }
  if (hasPresets) {
    await skills.save("fixture-profile", "---\nname: fixture-profile\ndescription: 验证 profile 技能发现。\n---\n原生工具读取当前 profile 的技能。");
    await skills.save("fixture-profile-plain", "# 纯 Markdown 正文");
    const deadline = Date.now() + 5000;
    while (!(await ctx.skills.list()).some(skill => skill.name === "fixture-profile")) {
      assert(Date.now() < deadline, "新增 profile 技能未进入宿主目录");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const start = requests.length;
    nativeCalls.push({ name: "skill", args: { name: "fixture-profile" } });
    await residentRun("技能验证", "读取 profile 技能");
    assert(requests.slice(start).some(request => JSON.stringify(request.messages).includes("原生工具读取当前 profile 的技能。")),
      JSON.stringify(requests.at(-1).messages.slice(-2)));
    const scoped = await ctx.skills.list({ scope: ctx.agents.get(requests.at(-1).sessionId) });
    assert(scoped.some(skill => skill.name === "fixture-profile" && skill.invocation.userInvocable));
    assert(!scoped.some(skill => skill.name === "fixture-profile-plain"));
  }
  console.log(
    "真实 DSH 验证通过：标准预设与宿主工具、规则文件注入、通道工作区、图片附件、会话标题、权限、原生 RAG/Skill 子代理与查询工具、JSONL 恢复、取消与重置、群聊批次持久化确认与缓存图片按需 read_image" + (hasWorkspaceRegistry ? "、归档后新建与工作区列表登记。" : "。"),
  );
} finally {
  await harness.close();
  await inference.close();
  memory.close();
  await ctx.fiber.dispose();
  if (originalDshHome === undefined) { delete process.env.DSH_HOME; }
  else { process.env.DSH_HOME = originalDshHome; }
  assert(path.resolve(data).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await rm(data, { recursive: true, force: true });
}
