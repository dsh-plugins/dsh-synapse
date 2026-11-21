import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { defaultsFor } from "@dsh-plugin/dsh-loader/config";
import { template } from "../lib/host/config.js";
import { Harness } from "../lib/host/harness.js";
import { SessionBindings } from "../lib/host/session-bindings.js";
import { hostFixture } from "./fixtures/host.mjs";

async function fixture(t, { live = false, workspaces = false, key = "chat:group:123" } = {}) {
  const data = await mkdtemp(path.join(os.tmpdir(), "synapse-recovery-"));
  const host = hostFixture(undefined, { workspaces });
  const config = defaultsFor(template.fields);
  const create = () => new Harness(host.loader, () => config, { data, profile: data }, {});
  let harness = create();
  const run = (signal, onEvent, input = "hello") => harness.run("example", input, [{ role: "user", content: "旧通道上下文" }], [], signal, onEvent, undefined, key, key.startsWith("review:") ? "review" : "chat");
  t.after(async () => { await harness.close(); await rm(data, { recursive: true, force: true }); });
  await run();
  const oldId = host.created[0].agent.id;
  const reload = async () => { await harness.close(); harness = create(); };
  if (!live) { await reload(); }
  const agents = host.loader.services.get("agents");
  const failHistory = error => {
    const get = host.loader.services.get;
    const persistence = get("sessionPersistence");
    agents.resume = async () => { throw error; };
    host.loader.services.get = name => name === "sessionPersistence" ? {
      ...persistence,
      async open(id, ...args) {
        if (id === oldId) { throw error; }
        return persistence.open(id, ...args);
      },
    } : get(name);
  };
  return { host, oldId, run, reload, agents, failHistory, binding: () => new SessionBindings(data).get(key) };
}

async function occupiedFixture(t, options = {}, afterFork) {
  const f = await fixture(t, { ...options, workspaces: true });
  const owner = await f.agents.resume({ resumeSessionId: f.oldId });
  t.after(() => owner.dispose());
  // 模拟在插件启动前就已打开的网页句柄，当前实例没有其释放能力。
  await f.reload();
  const forks = [];
  const get = f.host.loader.services.get;
  const controller = {
    async fork({ sessionId }) {
      assert.equal(sessionId, f.oldId);
      const id = `session-${randomUUID()}`;
      f.host.stored.set(id, structuredClone(f.host.stored.get(sessionId)));
      const child = await f.agents.create({
        sessionId: id,
        seed: owner.agent.session.events,
        meta: { cwd: owner.agent.session.header.cwd, agentPreset: "standard", isSeeded: true },
      });
      forks.push(child);
      await afterFork?.(child);
      return { sessionId: id };
    },
  };
  f.host.loader.services.get = name => name === "sessionController" ? controller : get(name);
  return { ...f, forks, owner, controller };
}

test("归档会话在驻留和重载后均更换绑定，保留归档历史并登记新工作区", async (t) => {
  for (const live of [true, false]) {
    await t.test(live ? "驻留会话" : "重载恢复", async (t) => {
      const f = await fixture(t, { live, workspaces: true });
      const registry = f.host.workspaceRegistry;
      await registry.archiveSession(f.oldId);
      const oldHistory = structuredClone(f.host.stored.get(f.oldId));
      const events = [];
      assert.equal(await f.run(undefined, (type, value) => events.push({ type, value })), "done");
      const next = f.host.created.at(-1);
      assert.notEqual(next.agent.id, f.oldId);
      assert.equal(next.injected.length, 0);
      assert.deepEqual(f.host.stored.get(f.oldId), oldHistory);
      assert(registry.archivedSessionIds.includes(f.oldId));
      assert(!registry.archivedSessionIds.includes(next.agent.id));
      assert.equal(events.find(event => event.type === "session.replaced").value.reason, "SessionArchivedError");
      assert(registry.list().find(workspace => workspace.path === next.agent.session.header.cwd).sessionIds.includes(next.agent.id));
      await f.run();
      assert.equal(f.host.created.length, 2);
      await f.reload();
      await f.run();
      assert.equal(f.host.resumed.at(-1).agent.id, next.agent.id);
    });
  }
});

test("归档会话遇到已取消请求时不创建新绑定", async (t) => {
  const f = await fixture(t, { live: true, workspaces: true });
  await f.host.workspaceRegistry.archiveSession(f.oldId);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.run(controller.signal), /abort/i);
  assert.equal(f.host.created.length, 1);
  assert.equal(f.host.disposed.length, 0);
});

test("消息提交期间发生归档时说明停止原因，不重放本轮且下一条消息新建会话", async (t) => {
  const f = await fixture(t, { live: true, workspaces: true });
  const agent = f.host.created[0].agent, followup = agent.followup;
  agent.followup = message => {
    void f.host.workspaceRegistry.archiveSession(f.oldId);
    followup(message);
  };
  await assert.rejects(f.run(), /会话已归档.*下一条消息将自动新建会话/);
  assert.equal(f.host.created.length, 1);
  assert.equal(await f.run(), "done");
  assert.equal(f.host.created.length, 2);
});

test("群聊和私聊接管由宿主打开的句柄，保留原会话与上下文", async (t) => {
  for (const key of ["chat:group:123", "chat:user:456"]) {
    await t.test(key, async (t) => {
      const f = await fixture(t, { key });
      const owner = await f.agents.resume({ resumeSessionId: f.oldId });
      const events = [];
      try {
        assert.equal(await f.run(undefined, (type) => events.push(type), "接管后的输入"), "done");
        assert.notEqual(f.agents.get(f.oldId), owner.agent);
        assert(f.host.disposed.includes(f.oldId));
        assert.equal((await f.binding()).id, f.oldId);
        assert.equal(f.host.created.length, 1);
        assert.equal(f.host.resumed.length, 2);
        assert(!events.includes("session.replaced"));
      } finally {
        await owner.dispose();
      }
      assert.equal(await f.run(undefined, undefined, "下一条输入"), "done");
      const restored = f.host.resumed.at(-1);
      assert.equal(restored.agent.id, f.oldId);
      assert(restored.conversation.some(message => message.content?.[0]?.text === "hello"));
      assert.equal(restored.conversation.filter(message => message.content?.[0]?.text === "接管后的输入").length, 1);
      assert.equal(f.host.created.length, 1);
      assert.equal(f.host.permissionWrites.length, 1);
    });
  }
});

test("重启后第一条聊天消息等待旧写入权释放，并且只提交一次到原会话", async (t) => {
  const f = await fixture(t);
  const resume = f.agents.resume;
  let attempts = 0;
  f.agents.resume = async options => {
    if (++attempts === 1) {
      throw Object.assign(new Error("上一实例正在关闭"), { name: "SessionAlreadyOwnedError", sessionId: f.oldId });
    }
    return resume(options);
  };
  const events = [];
  assert.equal(await f.run(undefined, type => events.push(type), "重启后的输入"), "done");
  assert.equal(attempts, 2);
  assert.equal((await f.binding()).id, f.oldId);
  assert(!events.includes("session.replaced"));
  assert.equal(f.host.stored.get(f.oldId).filter(message => message.content?.[0]?.text === "重启后的输入").length, 1);
});

test("无法接管时 fork 历史及权限，保存新绑定后归档原会话", async (t) => {
  for (const key of ["chat:group:123", "review:foo/bar"]) {
    await t.test(key, async (t) => {
      const f = await occupiedFixture(t, { key });
      const previous = structuredClone(f.host.stored.get(f.oldId));
      const events = [];
      const archive = f.host.workspaceRegistry.archiveSession;
      f.host.workspaceRegistry.archiveSession = async id => {
        assert.notEqual((await f.binding()).id, id);
        assert(f.agents.get((await f.binding()).id));
        await archive(id);
      };
      assert.equal(await f.run(undefined, (type, value) => events.push({ type, value }), "分叉后输入"), "done");
      const child = f.forks[0];
      const binding = await f.binding();
      assert.deepEqual(binding, { id: child.agent.id, bootstrap: false });
      assert.notEqual(f.agents.get(binding.id), child.agent);
      assert(f.host.disposed.includes(child.agent.id));
      assert.deepEqual(f.host.stored.get(f.oldId), previous);
      assert(f.host.workspaceRegistry.archivedSessionIds.includes(f.oldId));
      assert.equal(f.host.permissionWrites.length, 1);
      const resumed = f.host.resumed.at(-1);
      assert(resumed.agent.session.events.some(e => e.type === "permission/preset" && e.data.preset === "read-only"));
      assert(resumed.conversation.some(message => message.content?.[0]?.text === "hello"));
      assert.equal(resumed.conversation.filter(message => message.content?.[0]?.text === "分叉后输入").length, 1);
      assert.equal(resumed.conversation.filter(message => message.content === "旧通道上下文").length,
        previous.filter(message => message.content === "旧通道上下文").length);
      assert.equal(events.find(e => e.type === "session.replaced").value.forked, true);
      await f.reload();
      assert.equal(await f.run(), "done");
      assert.equal(f.host.resumed.at(-1).agent.id, child.agent.id);
      assert.equal(f.forks.length, 1);
    });
  }
});

test("fork 或新会话恢复失败时保留原绑定，不归档原会话", async (t) => {
  for (const failure of ["fork", "resume", "workspace"]) {
    await t.test(failure, async (t) => {
      const f = await occupiedFixture(t);
      if (failure === "fork") {
        f.controller.fork = async () => { throw new Error("fork 失败"); };
      } else if (failure === "resume") {
        f.agents.resume = async () => { throw new Error("resume 失败"); };
      } else {
        f.host.workspaceRegistry.create = async () => { throw new Error("workspace 失败"); };
      }
      await assert.rejects(f.run(), new RegExp(`${failure} 失败`));
      assert.equal((await f.binding()).id, f.oldId);
      assert(!f.host.workspaceRegistry.archivedSessionIds.includes(f.oldId));
      assert(f.forks.every(child => !f.agents.get(child.agent.id)));
    });
  }
});

test("已捕获的句柄释放失败时仍通过 fork 接续，不吞掉本条消息", async (t) => {
  const f = await occupiedFixture(t);
  await f.owner.dispose();
  const owner = await f.agents.resume({ resumeSessionId: f.oldId });
  const dispose = owner.dispose;
  owner.dispose = async () => { throw new Error("原句柄拒绝释放"); };
  t.after(dispose);
  const events = [];
  assert.equal(await f.run(undefined, type => events.push(type), "接管失败后的输入"), "done");
  assert(events.includes("session.takeover_failed"));
  assert.equal(f.forks.length, 1);
  assert(f.host.workspaceRegistry.archivedSessionIds.includes(f.oldId));
  assert.equal(f.host.stored.get((await f.binding()).id).filter(message => message.content?.[0]?.text === "接管失败后的输入").length, 1);
});

test("fork 返回时取消请求仍释放新句柄，保留原绑定和未归档状态", async (t) => {
  const controller = new AbortController();
  const f = await occupiedFixture(t, {}, () => controller.abort());
  await assert.rejects(f.run(controller.signal), /abort/i);
  assert.equal(f.forks.length, 1);
  assert(!f.agents.get(f.forks[0].agent.id));
  assert.equal((await f.binding()).id, f.oldId);
  assert(!f.host.workspaceRegistry.archivedSessionIds.includes(f.oldId));
});

test("原会话归档失败时说明已切换，新句柄仍可继续处理并正常关闭", async (t) => {
  const f = await occupiedFixture(t);
  f.host.workspaceRegistry.archiveSession = async () => { throw new Error("归档服务暂不可用"); };
  await assert.rejects(f.run(), /已切换到分叉会话.*原会话归档失败/);
  const id = (await f.binding()).id;
  assert.equal(id, f.forks[0].agent.id);
  assert(f.agents.get(id));
  assert.equal(await f.run(), "done");
  await f.reload();
  assert(!f.agents.get(id));
});

test("缓存代理已释放时，从持久化的同一 ID 恢复", async (t) => {
  const f = await fixture(t, { live: true });
  await f.host.created[0].handle.dispose();
  assert.equal(await f.run(), "done");
  assert.equal(f.host.resumed.at(-1).agent.id, f.oldId);
  assert.equal(f.host.created.length, 1);
});

test("已注销的旧句柄释放失败时，下一条消息仍可恢复同一 ID", async (t) => {
  const f = await fixture(t, { live: true });
  const handle = f.host.created[0].handle;
  const dispose = handle.dispose;
  handle.dispose = async () => { await dispose(); throw new Error("旧句柄释放失败"); };
  await assert.rejects(handle.dispose(), /旧句柄释放失败/);
  await assert.rejects(f.run(), /旧句柄释放失败/);
  assert.equal(await f.run(), "done");
  assert.equal(f.host.resumed.at(-1).agent.id, f.oldId);
});

test("创建期间发现原 ID 已存在时，仍用该 ID 恢复", async (t) => {
  const f = await fixture(t);
  const get = f.host.loader.services.get;
  f.host.loader.services.get = name => name === "sessionPersistence" ? { ...get(name), stat: async () => undefined } : get(name);
  f.agents.create = async ({ sessionId }) => {
    assert.equal(sessionId, f.oldId);
    throw Object.assign(new Error("会话已存在"), { name: "SessionAlreadyExistsError", sessionId });
  };
  assert.equal(await f.run(), "done");
  assert.equal(f.host.resumed.at(-1).agent.id, f.oldId);
  assert.equal(f.host.created.length, 1);
  assert.equal((await f.binding()).id, f.oldId);
  assert.equal(f.host.permissionWrites.length, 1);
});

test("写入锁、并发创建、权限或版本问题保留聊天绑定，错误消失后继续使用同一会话", async (t) => {
  for (const error of [
    Object.assign(new Error("被占用"), { name: "SessionAlreadyOwnedError" }),
    Object.assign(new Error("并发创建"), { name: "SessionAlreadyExistsError" }),
    Object.assign(new Error("写入权丢失"), { name: "SessionOwnershipLostError" }),
    Object.assign(new Error("格式版本暂不支持"), { name: "SessionFormatUnsupportedError" }),
    Object.assign(new Error("目录不可访问"), { code: "EACCES" }),
    Object.assign(new Error("文件路径暂不可访问"), { code: "ENOENT" }),
  ]) {
    await t.test(error.message, async (t) => {
      const f = await fixture(t);
      const resume = f.agents.resume;
      f.agents.resume = async () => { throw error; };
      await assert.rejects(f.run(), actual => actual === error || actual.cause === error);
      assert.equal((await f.binding()).id, f.oldId);
      assert.equal(f.host.created.length, 1);
      f.agents.resume = resume;
      await f.reload();
      assert.equal(await f.run(), "done");
      assert.equal(f.host.resumed.at(-1).agent.id, f.oldId);
    });
  }
});

test("初始化抛出同名错误但原生历史可读时，保留聊天绑定", async (t) => {
  const f = await fixture(t);
  const get = f.host.loader.services.get;
  const error = Object.assign(new Error("扩展初始化失败"), { name: "SessionPersistenceCorruptionError" });
  f.host.loader.services.get = name => name === "agentPresets" ? { ...get(name), mount: async () => { throw error; } } : get(name);
  await assert.rejects(f.run(), actual => actual === error);
  assert.equal((await f.binding()).id, f.oldId);
  assert.equal(f.host.created.length, 1);
  f.host.loader.services.get = get;
  assert.equal(await f.run(), "done");
  assert.equal(f.host.resumed.at(-1).agent.id, f.oldId);
});

test("持久化服务暂不可用时保留 ID，服务恢复后继续原会话", async (t) => {
  const f = await fixture(t);
  const get = f.host.loader.services.get;
  f.host.loader.services.get = name => name === "sessionPersistence" ? undefined : get(name);
  await assert.rejects(f.run(), /持久化服务暂不可用/);
  assert.equal(f.host.created.length, 1);
  assert.equal((await f.binding()).id, f.oldId);
  f.host.loader.services.get = get;
  assert.equal(await f.run(), "done");
  assert.equal(f.host.resumed.at(-1).agent.id, f.oldId);
});

test("创建替代会话失败时保留旧绑定，下一条消息可重新恢复", async (t) => {
  const f = await fixture(t);
  f.failHistory(Object.assign(new Error("历史已丢失"), { name: "SessionPersistenceNotFoundError" }));
  const create = f.agents.create;
  let attempts = 0;
  f.agents.create = async () => { attempts++; throw new Error("新会话存储不可用"); };
  await assert.rejects(f.run(), /新会话存储不可用/);
  assert.equal(attempts, 1);
  assert.equal((await f.binding()).id, f.oldId);
  f.agents.create = create;
  assert.equal(await f.run(), "done");
  assert.equal((await f.binding()).id, f.host.created[1].agent.id);
});

test("原生历史确认损坏或丢失时可新建，取消请求保留绑定", async (t) => {
  for (const error of [
    Object.assign(new Error("历史损坏"), { name: "SessionPersistenceCorruptionError" }),
    Object.assign(new Error("历史已丢失"), { name: "SessionPersistenceNotFoundError" }),
  ]) {
    await t.test(error.message, async (t) => {
      const f = await fixture(t);
      f.failHistory(error);
      assert.equal(await f.run(), "done");
      assert.notEqual(f.host.created[1].agent.id, f.oldId);
      assert.equal((await f.binding()).id, f.host.created[1].agent.id);
    });
  }
  await t.test("取消", async (t) => {
    const f = await fixture(t);
    const controller = new AbortController();
    f.agents.resume = async () => {
      controller.abort();
      throw Object.assign(new Error("被占用"), { name: "SessionAlreadyOwnedError" });
    };
    await assert.rejects(f.run(controller.signal), /abort/i);
    assert.equal(f.host.created.length, 1);
    assert.equal((await f.binding()).id, f.oldId);
  });
});

test("替代会话建立后取消任务时释放新句柄，原绑定继续有效", async (t) => {
  const f = await fixture(t, { workspaces: true });
  f.failHistory(Object.assign(new Error("历史已丢失"), { name: "SessionPersistenceNotFoundError" }));
  const controller = new AbortController();
  const create = f.agents.create;
  f.agents.create = async options => {
    const handle = await create(options);
    controller.abort();
    return handle;
  };
  await assert.rejects(f.run(controller.signal), /abort/i);
  assert.equal((await f.binding()).id, f.oldId);
  const cancelledId = f.host.created[1].agent.id;
  assert(f.host.disposed.includes(cancelledId));
  assert(!f.host.workspaceRegistry.list().some(workspace => workspace.sessionIds.includes(cancelledId)));
});

test("会话替换通知失败时新句柄仍受托管，后续消息和关闭可以正常处理", async (t) => {
  const f = await fixture(t);
  f.failHistory(Object.assign(new Error("历史已丢失"), { name: "SessionPersistenceNotFoundError" }));
  await assert.rejects(f.run(undefined, () => { throw new Error("通知发送失败"); }), /通知发送失败/);
  const replacement = f.host.created[1];
  assert.equal(await f.run(), "done");
  assert.equal(f.host.created.length, 2);
  await f.reload();
  assert(f.host.disposed.includes(replacement.agent.id));
});
