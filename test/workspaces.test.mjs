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

test("缺少目录切换能力的旧宿主新建正确工作区的会话，并保留旧记录", async (t) => {
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
  assert.notEqual(host.created.at(-1).agent.id, binding.id);
  assert.equal(host.created.at(-1).agent.session.header.cwd, path.join(profile, "workspace/chat"));
  assert(host.stored.has(binding.id));
});
