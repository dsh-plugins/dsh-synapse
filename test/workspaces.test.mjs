import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { defaultsFor } from "@dsh-plugin/dsh-loader/config";
import { Harness } from "../lib/host/harness.js";
import { template } from "../lib/host/config.js";
import { SessionBindings } from "../lib/host/session-bindings.js";
import { hostFixture } from "./fixtures/host.mjs";

test("聊天与审查使用各自 profile 工作区，恢复的旧会话切换目录并保留历史和权限", async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "synapse-workspaces-"));
  const paths = { profile, data: path.join(profile, "data") };
  const host = hostFixture();
  const agents = host.loader.services.get("agents"), directory = host.loader.services.get("workingDirectory");
  const binding = await new SessionBindings(paths.data).get("chat:example");
  const old = await agents.create({ sessionId: binding.id, meta: { cwd: paths.data } });
  host.permissions.set(old.agent.session, "read-only");
  old.agent.inject({ role: "user", content: "保留原来的历史" });
  await old.dispose();
  const config = defaultsFor(template.fields);
  const harness = new Harness(host.loader, () => config, paths, {});
  t.after(async () => { await harness.close(); await rm(profile, { recursive: true, force: true }); });
  for (const channel of ["chat", "review"]) {
    await harness.run("规则", "消息", [], [], undefined, undefined, undefined, `${channel}:example`, channel);
    const record = channel === "chat" ? host.resumed.at(-1) : host.created.at(-1);
    const expected = path.join(profile, "workspace", channel);
    assert.equal(directory.get(record.agent.session), expected);
    await access(expected);
  }
  assert.equal(host.resumed[0].agent.id, binding.id);
  assert(host.resumed[0].conversation.some(message => message.content === "保留原来的历史"));
  assert.equal(host.permissionWrites.filter(write => write.sessionId === binding.id).length, 1);
});

test("缺少目录切换能力的旧宿主仍用原目录恢复聊天会话", async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "synapse-workspaces-"));
  const paths = { profile, data: path.join(profile, "data") };
  const host = hostFixture();
  const get = host.loader.services.get;
  const binding = await new SessionBindings(paths.data).get("chat:example");
  const old = await get("agents").create({ sessionId: binding.id, meta: { cwd: paths.data } });
  await old.dispose();
  host.loader.services.get = name => name === "workingDirectory" ? undefined : get(name);
  const config = defaultsFor(template.fields), harness = new Harness(host.loader, () => config, paths, {});
  t.after(async () => { await harness.close(); await rm(profile, { recursive: true, force: true }); });
  await harness.run("规则", "消息", [], [], undefined, undefined, undefined, "chat:example");
  assert.equal(host.created.length, 1);
  assert.equal(host.resumed[0].agent.id, binding.id);
  assert.equal(host.resumed[0].agent.session.header.cwd, paths.data);
});

test("工作区注册表按原始目录验证成员，聊天与审查均登记为可见会话", async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "synapse-workspaces-"));
  const paths = { profile, data: path.join(profile, "data") };
  const host = hostFixture(undefined, { workspaces: true });
  const agents = host.loader.services.get("agents");
  const binding = await new SessionBindings(paths.data).get("chat:example");
  const old = await agents.create({ sessionId: binding.id, meta: { cwd: paths.data } });
  old.agent.inject({ role: "user", content: "原始会话历史" });
  const originalWorkspace = await host.workspaceRegistry.create(paths.data);
  await originalWorkspace.attachSession(binding.id);
  await old.dispose();
  const config = defaultsFor(template.fields), harness = new Harness(host.loader, () => config, paths, {});
  t.after(async () => { await harness.close(); await rm(profile, { recursive: true, force: true }); });
  await harness.run("规则", "消息", [], [], undefined, undefined, undefined, "chat:example");
  const restored = host.resumed[0];
  assert.equal(restored.agent.id, binding.id);
  assert.equal(restored.agent.session.header.cwd, paths.data);
  assert.equal(host.loader.services.get("workingDirectory").get(restored.agent.session), path.join(profile, "workspace", "chat"));
  assert(originalWorkspace.sessionIds.includes(binding.id));
  assert(restored.conversation.some(message => message.content === "原始会话历史"));
  for (const channel of ["chat", "review"]) {
    await harness.run("规则", "消息", [], [], undefined, undefined, undefined, `${channel}:new`, channel);
    const session = host.created.at(-1).agent.session;
    const workspace = host.workspaceRegistry.list().find(entry => entry.path === path.join(profile, "workspace", channel));
    assert(workspace.sessionIds.includes(session.id));
    assert.notEqual(session.id, binding.id);
  }
});

test("工作区登记失败时释放已创建的会话句柄，修复后可以恢复", async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "synapse-workspaces-"));
  const paths = { profile, data: path.join(profile, "data") }, host = hostFixture(undefined, { workspaces: true });
  const config = defaultsFor(template.fields), harness = new Harness(host.loader, () => config, paths, {});
  t.after(async () => { await harness.close(); await rm(profile, { recursive: true, force: true }); });
  const create = host.workspaceRegistry.create;
  host.workspaceRegistry.create = async () => { throw new Error("工作区存储不可用"); };
  const run = () => harness.run("规则", "消息", [], [], undefined, undefined, undefined, "chat:example");
  await assert.rejects(run(), /工作区存储不可用/);
  assert.deepEqual(host.disposed, [host.created[0].agent.id]);
  host.workspaceRegistry.create = create;
  assert.equal(await run(), "done");
  assert.equal(host.resumed[0].agent.id, host.created[0].agent.id);
  assert(host.workspaceRegistry.list()[0].sessionIds.includes(host.resumed[0].agent.id));
});
