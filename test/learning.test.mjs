import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { defaultsFor } from "@dsh-plugin/dsh-loader/config";
import { template } from "../lib/host/config.js";
import { Agent } from "../lib/host/agent.js";
import { Memory } from "../lib/host/memory.js";
import { SkillStore } from "../lib/host/files.js";
import { hostFixture } from "./fixtures/host.mjs";
import { learningTools } from "../lib/host/native-tools.js";

for (const legacySubagents of [false, true]) {
  test(`主模型并行委派原生子代理总结记忆和 Skill，保留父子关系与模型路由（旧 API：${legacySubagents}）`, async (t) => {
    const home = await mkdtemp(path.join(os.tmpdir(), "synapse-learning-"));
    const paths = { home, profile: home, data: path.join(home, "data"), skills: path.join(home, "skills") };
    await mkdir(paths.data);
    const c = { ...defaultsFor(template.fields), memoryPrompt: "记住长期偏好", skillPrompt: "总结验证过的步骤" };
    const memory = new Memory(":memory:", { embed: async () => [1, ...Array(511).fill(0)] }, () => c);
    const skills = new SkillStore(paths);
    const prompts = [], events = [];
    const host = hostFixture(async ({ options, tools, variables, signal, selected }) => {
      const call = (name, args) => tools.find((tool) => tool.name === name).execute(args, { signal });
      if (options.meta?.origin === "subagent") {
        assert.deepEqual(selected.at(-1), c.chatModel);
        const policy = variables.get("synapse_learning")();
        if (tools.some((tool) => tool.name === "synapse_memory_save")) {
          assert.match(policy, /记住长期偏好/);
          assert(tools.every((tool) => tool.name.startsWith("synapse_memory_")));
          assert.equal((await call("synapse_memory_save", { text: "用户偏好简体中文" })).inserted, 1);
          assert.equal((await call("synapse_memory_search", { query: "偏好" })).items[0].text, "用户偏好简体中文");
        } else {
          assert.match(policy, /总结验证过的步骤/);
          assert(tools.every((tool) => tool.name.startsWith("synapse_skill_")));
          const saved = await call("synapse_skill_save", { name: "auto-chat-example", content: "# 步骤\n运行并确认测试通过。" });
          assert.equal((await call("synapse_skill_read", { name: saved.name })).revision, saved.revision);
          await assert.rejects(call("synapse_skill_save", { name: saved.name, content: "覆盖" }), /已变更/);
          await call("synapse_skill_save", { name: saved.name, content: "# 更新步骤", revision: saved.revision });
          await assert.rejects(call("synapse_skill_save", { name: "auto-review-example", content: "越界" }), /当前通道/);
        }
        return "子代理已确认保存";
      }
      prompts.push(variables.get("synapse_context")());
      assert(!tools.some((tool) => tool.name.endsWith("_save")));
      const results = await Promise.all([
        call("synapse_memory_summarize", { evidence: "用户明确要求使用简体中文" }),
        call("synapse_skill_summarize", { evidence: "执行测试并确认通过，可复用验证步骤" }),
      ]);
      assert(results.every((result) => result.summary === "子代理已确认保存"));
      return "已经保存偏好与步骤";
    }, { legacySubagents });
    c.chatModel = { provider: "chat", model: "selected", reasoningEffort: "high" };
    const agent = new Agent({ loader: host.loader, config: () => c, paths, memory, skills, mcp: { available: async () => [] } });
    t.after(async () => { await agent.close(); memory.close(); await rm(home, { recursive: true, force: true }); });
    assert.equal(await agent.run("请记住我的偏好", "chat", [], undefined, (event) => events.push(event), "", undefined, "chat:example"), "已经保存偏好与步骤");
    assert.match(prompts[0], /记住长期偏好/);
    assert.match(prompts[0], /总结验证过的步骤/);
    assert.equal((await skills.list())[0].content, "# 更新步骤");
    assert.equal(memory.list("chat").length, 1);
    assert.equal(memory.list("review").length, 0);
    const roots = host.created.filter((item) => !item.options.meta?.parentSession);
    const children = host.created.filter((item) => item.options.meta?.parentSession);
    assert.equal(roots.length, 1);
    assert.equal(children.length, 2);
    assert(children.every((child) => child.options.meta.parentSession === roots[0].agent.id));
    assert(children.every((child) => host.disposed.includes(child.agent.id)));
    assert(children.every((child) => child.tools.length === 0 && child.sections.length === 0 && child.variables.size === 0 && child.listeners.size === 0));
    assert.equal(host.listenerCount("agent/created"), 0);
    assert.equal(host.listenerCount("subagent/end"), 0);
    assert(events.includes("tool.completed"));
    c.memoryPrompt = "更新后的记忆要求";
    c.skillPrompt = "更新后的 Skill 要求";
    const context = await agent.context("example", "chat");
    assert.match(context, /更新后的记忆要求/);
    assert.match(context, /更新后的 Skill 要求/);
  });
}

test("记忆与 Skill 写入遵守开关、取消和通道隔离", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "synapse-learning-"));
  const paths = { home, profile: home, data: home, skills: path.join(home, "skills") };
  const c = defaultsFor(template.fields);
  const memory = new Memory(":memory:", { embed: async () => [1, ...Array(511).fill(0)] }, () => c);
  const skills = new SkillStore(paths);
  t.after(async () => { memory.close(); await rm(home, { recursive: true, force: true }); });
  const tools = learningTools(() => c, memory, skills, "review");
  const signal = new AbortController().signal;
  const call = (name, args, s = signal) => tools.find((tool) => tool.name === name).execute(args, s);
  await call("synapse_memory_save", { text: "审查中发现的重要规则" });
  assert.equal(memory.list("chat").length, 0);
  assert.equal(memory.list("review").length, 1);
  const aborted = AbortSignal.abort();
  await assert.rejects(call("synapse_memory_save", { text: "取消后不写入" }, aborted), /abort/i);
  await assert.rejects(call("synapse_skill_save", { name: "auto-review-example", content: "取消后不写入" }, aborted), /abort/i);
  assert.equal((await skills.list()).length, 0);
  c.learnMemory = false;
  c.learnSkills = false;
  await assert.rejects(call("synapse_memory_save", { text: "已关闭" }), /已关闭/);
  await assert.rejects(call("synapse_skill_save", { name: "auto-review-example", content: "已关闭" }), /已关闭/);
  const disabled = learningTools(() => c, memory, skills, "review");
  assert(disabled.some((tool) => tool.name === "synapse_memory_search"));
  assert(!disabled.some((tool) => tool.name.endsWith("_save")));
  c.ragEnabled = false;
  assert(!learningTools(() => c, memory, skills, "review").some((tool) => tool.name.startsWith("synapse_memory_")));
});

test("总结子代理在嵌入期间取消时停止写入并释放子会话", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "synapse-learning-"));
  const paths = { home, profile: home, data: home, skills: path.join(home, "skills") };
  const c = defaultsFor(template.fields);
  let started, release;
  const ready = new Promise((resolve) => { started = resolve; });
  const embedding = new Promise((resolve) => { release = resolve; });
  const memory = new Memory(":memory:", { embed: async (text) => {
    if (text === "长期事项") {
      started();
      return embedding;
    }
    return [1, ...Array(511).fill(0)];
  } }, () => c);
  const skills = new SkillStore(paths);
  const host = hostFixture(async ({ options, tools, signal }) => {
    const name = options.meta?.origin === "subagent" ? "synapse_memory_save" : "synapse_memory_summarize";
    return tools.find((tool) => tool.name === name).execute(name.endsWith("_save") ? { text: "长期事项" } : { evidence: "值得保留的长期事项" }, { signal });
  });
  const agent = new Agent({ loader: host.loader, config: () => c, paths, memory, skills, mcp: {} });
  t.after(async () => { release([1, ...Array(511).fill(0)]); await agent.close(); memory.close(); await rm(home, { recursive: true, force: true }); });
  const controller = new AbortController();
  const cancelled = assert.rejects(agent.run("example", "review", [], controller.signal, undefined, "", undefined, "review:cancel"), /abort/i);
  await ready;
  controller.abort();
  await cancelled;
  await agent.close();
  assert.equal(memory.list("review").length, 0);
  assert.equal((await skills.list()).length, 0);
  assert(host.created.filter((item) => item.options.meta?.parentSession).every((item) => host.disposed.includes(item.agent.id)));
  assert(host.created.filter((item) => item.options.meta?.parentSession).every((item) => item.tools.length === 0 && item.variables.size === 0 && item.listeners.size === 0));
  assert.equal(host.listenerCount("agent/created"), 0);
});

test("总结失败、服务不可用与开关变更均返回工具错误，主会话可继续", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "synapse-learning-"));
  const paths = { home, profile: home, data: home, skills: path.join(home, "skills") };
  const c = defaultsFor(template.fields);
  const memory = new Memory(":memory:", { embed: async () => [1, ...Array(511).fill(0)] }, () => c);
  const skills = new SkillStore(paths);
  let scenario = "闲聊";
  const host = hostFixture(async ({ options, tools, signal }) => {
    if (options.meta?.origin === "subagent") {
      throw new Error("子代理模型出错");
    }
    if (scenario !== "闲聊") {
      const tool = tools.find((item) => item.name === "synapse_memory_summarize");
      if (scenario === "关闭功能") {
        c.learnMemory = false;
      }
      await assert.rejects(tool.execute({ evidence: "已核实的重要事项" }, { signal }), /未完成|不可用|已关闭|启动失败/);
    }
    return "主会话继续回复";
  });
  const agent = new Agent({ loader: host.loader, config: () => c, paths, memory, skills, mcp: { available: async () => [] } });
  t.after(async () => { await agent.close(); memory.close(); await rm(home, { recursive: true, force: true }); });
  const run = () => agent.run("消息", "chat", [], undefined, undefined, "", undefined, "chat:errors");
  assert.equal(await run(), "主会话继续回复");
  assert.equal(host.created.length, 1);
  scenario = "子代理失败";
  assert.equal(await run(), "主会话继续回复");
  const child = host.created.find((item) => item.options.meta?.parentSession);
  assert(host.disposed.includes(child.agent.id));
  scenario = "启动失败";
  const subagents = host.loader.services.get("subagents");
  const start = subagents.startActivation;
  subagents.startActivation = async (spec) => {
    const activation = await start(spec);
    await activation.dispose();
    throw new Error("原生子代理启动失败");
  };
  assert.equal(await run(), "主会话继续回复");
  subagents.startActivation = start;
  scenario = "服务不可用";
  host.loader.services.get("subagents").getProvider = () => undefined;
  assert.equal(await run(), "主会话继续回复");
  scenario = "关闭功能";
  assert.equal(await run(), "主会话继续回复");
  assert.equal(host.created.length, 3);
  assert(host.created.filter((item) => item.options.meta?.parentSession).every((item) => item.tools.length === 0 && item.sections.length === 0 && item.variables.size === 0 && item.listeners.size === 0));
  assert.equal(host.listenerCount("agent/created"), 0);
  assert.equal(memory.list("chat").length, 0);
});
