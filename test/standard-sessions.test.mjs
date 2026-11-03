import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, unlink, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { defaultsFor } from "@dsh-plugin/dsh-loader/config";
import { Agent } from "../lib/host/agent.js";
import { template } from "../lib/host/config.js";
import { hostFixture } from "./fixtures/host.mjs";
import { SessionBindings } from "../lib/host/session-bindings.js";

async function fixture(t, execute = async () => "done") {
  const home = await mkdtemp(path.join(os.tmpdir(), "synapse-standard-"));
  const profile = path.join(home, "profiles", "example");
  await mkdir(profile, { recursive: true });
  const paths = { home, profile, data: path.join(profile, "data"), skills: path.join(profile, "skills") };
  const host = hostFixture(execute), config = { ...defaultsFor(template.fields), ragEnabled: false, learnMemory: false, learnSkills: false };
  const create = () => new Agent({ loader: host.loader, paths, config: () => config, memory: {}, skills: { retrieve: async () => [] }, mcp: { available: async () => [] } });
  let agent = create();
  t.after(async () => { await agent.close(); await rm(home, { recursive: true, force: true }); });
  return { host, paths, run: (channel = "chat") => agent.run("消息", channel, [], undefined, undefined, "", undefined, `${channel}:example`), reload: async () => { await agent.close(); agent = create(); } };
}

test("聊天与审查挂载标准预设，继承系统提示词及可执行工具，通道文件作为用户规则注入", async t => {
  const observed = [];
  const f = await fixture(t, async ({ sections, tools, variables, conversation, restrictions }) => {
    assert(sections.some(section => section.name === "deployment:persona-prefix" && section.text === "宿主标准系统提示词"));
    assert(sections.some(section => section.name === "dsh-synapse:context"));
    assert.deepEqual(restrictions, []);
    assert.deepEqual(await tools.find(tool => tool.name === "standard_read").execute(), { content: "宿主标准工具结果" });
    const rules = conversation.findLast(message => message.source?.kind === "runtime-context");
    assert.equal(rules.role, "user");
    assert(!variables.get("synapse_context")().includes("通道专属规则"));
    observed.push(rules.content[0].text);
    return "done";
  });
  await writeFile(path.join(f.paths.home, "SOUL.md"), "聊天通道专属规则");
  await writeFile(path.join(f.paths.profile, "AGENTS.md"), "审查通道专属规则");
  await f.run("chat");
  await f.run("review");
  assert(observed[0].includes("$DSH_HOME/SOUL.md"));
  assert(observed[0].includes("聊天通道专属规则"));
  assert(!observed[0].includes("审查通道专属规则"));
  assert(observed[1].includes("<profile>/AGENTS.md"));
  assert(observed[1].includes("审查通道专属规则"));
  assert(f.host.created.every(record => f.host.loader.services.get("agentPresets").presetForSession(record.agent.session) === "standard"));
});

test("补充规则只在变化时注入，恢复不重复，文件删除时撤销旧补充规则", async t => {
  const f = await fixture(t);
  const file = path.join(f.paths.profile, "SOUL.md");
  const rules = () => [...f.host.stored.values()].flat().filter(message => message.source?.kind === "runtime-context");
  await writeFile(file, "原规则");
  await f.run();
  await f.run();
  assert.equal(rules().length, 1);
  await f.reload();
  await f.run();
  assert.equal(rules().length, 1);
  await writeFile(file, "更新规则");
  await f.run();
  assert.equal(rules().length, 2);
  assert(rules().at(-1).content[0].text.includes("更新规则"));
  await unlink(file);
  await f.run();
  assert.equal(rules().length, 3);
  assert(!rules().at(-1).content[0].text.includes("更新规则"));
  await f.run();
  assert.equal(rules().length, 3);
});

test("标准预设无法挂载时返回明确错误", async t => {
  const f = await fixture(t);
  const get = f.host.loader.services.get;
  f.host.loader.services.get = name => name === "agentPresets" ? { mount: async () => { throw new Error("standard 预设尚未启用"); } } : get(name);
  await assert.rejects(f.run(), /standard 预设尚未启用/);
});

test("仅支持创建时记录预设的宿主迁移旧绑定，保留旧记录并恢复新预设", async t => {
  const f = await fixture(t);
  const get = f.host.loader.services.get, standard = get("agentPresets");
  f.host.loader.services.get = name => name === "agentPresets" ? { mount: standard.mount } : get(name);
  const binding = await new SessionBindings(f.paths.data).get("chat:example");
  const old = await get("agents").create({ sessionId: binding.id, meta: { cwd: path.join(f.paths.profile, "workspace", "chat") } });
  old.agent.inject({ role: "user", content: "旧会话历史" });
  await old.dispose();
  assert.equal(await f.run(), "done");
  const current = f.host.created.at(-1).agent;
  assert.notEqual(current.id, binding.id);
  assert.equal(current.session.header.agentPreset, "standard");
  assert(f.host.stored.get(binding.id).some(message => message.content === "旧会话历史"));
  await f.reload();
  assert.equal(await f.run(), "done");
  assert.equal(f.host.resumed.at(-1).agent.id, current.id);
});
