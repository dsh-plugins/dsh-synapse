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

test("主模型原生调用记忆和 Skill 工具，提示词编辑在后续请求生效", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "synapse-learning-"));
  const paths = { home, profile: home, data: path.join(home, "data"), skills: path.join(home, "skills") };
  await mkdir(paths.data);
  const c = { ...defaultsFor(template.fields), memoryPrompt: "记住长期偏好", skillPrompt: "总结验证过的步骤" };
  const memory = new Memory(":memory:", { embed: async () => [1, ...Array(511).fill(0)] }, () => c);
  const skills = new SkillStore(paths);
  const prompts = [], errors = [], events = [];
  const host = hostFixture(async ({ message, tools, variables, signal }) => {
    if (message.content[0].text !== "请记住我的偏好") {
      return '{"memories":[],"skill":null}';
    }
    prompts.push(variables.get("synapse_context")());
    const call = (name, args) => tools.find((tool) => tool.name === name).execute(args, { signal });
    assert.equal((await call("synapse_memory_save", { text: "用户偏好简体中文", channel: "review" })).inserted, 1);
    const found = await call("synapse_memory_search", { query: "偏好" });
    assert.equal(found.items[0].text, "用户偏好简体中文");
    assert.equal(memory.list("review").length, 0);
    const saved = await call("synapse_skill_save", { name: "auto-chat-example", content: "# 步骤\n运行并确认测试通过。" });
    assert.equal((await call("synapse_skill_read", { name: saved.name })).content, "# 步骤\n运行并确认测试通过。");
    await assert.rejects(call("synapse_skill_save", { name: saved.name, content: "覆盖" }), /已变更/);
    await call("synapse_skill_save", { name: saved.name, content: "# 更新步骤", revision: saved.revision });
    await assert.rejects(call("synapse_skill_save", { name: "auto-review-example", content: "越界" }), /当前通道/);
    return "已经保存偏好与步骤";
  });
  const agent = new Agent({ loader: host.loader, config: () => c, paths, memory, skills, mcp: { available: async () => [] }, onError: (e) => errors.push(e) });
  t.after(async () => { await agent.close(); memory.close(); await rm(home, { recursive: true, force: true }); });
  assert.equal(await agent.run("请记住我的偏好", "chat", [], undefined, (event) => events.push(event), "", undefined, "chat:example"), "已经保存偏好与步骤");
  assert.match(prompts[0], /记住长期偏好/);
  assert.match(prompts[0], /总结验证过的步骤/);
  assert.equal((await skills.list())[0].content, "# 更新步骤");
  assert(events.includes("tool.completed"));
  c.memoryPrompt = "更新后的记忆要求";
  c.skillPrompt = "更新后的 Skill 要求";
  const context = await agent.context("example", "chat");
  assert.match(context, /更新后的记忆要求/);
  assert.match(context, /更新后的 Skill 要求/);
  assert.deepEqual(errors, []);
});

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

test("自动总结在模型返回后复核开关，并在嵌入期间取消写入", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "synapse-learning-"));
  const paths = { home, profile: home, data: home, skills: path.join(home, "skills") };
  let c = defaultsFor(template.fields);
  let started, release;
  const ready = new Promise((resolve) => { started = resolve; });
  const embedding = new Promise((resolve) => { release = resolve; });
  const memory = new Memory(":memory:", { embed: async () => { started(); return embedding; } }, () => c);
  const skills = new SkillStore(paths);
  let switchOff = true;
  const host = hostFixture(async () => {
    if (switchOff) { c = { ...c, learnMemory: false, learnSkills: false }; }
    return '{"memories":["长期事项"],"skill":{"title":"流程","steps":"验证步骤"}}';
  });
  const agent = new Agent({ loader: host.loader, config: () => c, paths, memory, skills, mcp: {} });
  t.after(async () => { release([1, ...Array(511).fill(0)]); await agent.close(); memory.close(); await rm(home, { recursive: true, force: true }); });
  await agent.learn("example", "done", "review");
  assert.equal(memory.list("review").length, 0);
  assert.equal((await skills.list()).length, 0);
  switchOff = false;
  c = { ...c, learnMemory: true, learnSkills: true };
  const controller = new AbortController();
  const cancelled = assert.rejects(agent.learn("example", "done", "review", controller.signal), /abort/i);
  await ready;
  controller.abort();
  await cancelled;
  assert.equal(memory.list("review").length, 0);
  assert.equal((await skills.list()).length, 0);
});
