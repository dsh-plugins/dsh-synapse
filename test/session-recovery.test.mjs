import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
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
  const run = (signal, onEvent, input = "hello") => harness.run("example", input, [{ role: "user", content: "旧通道上下文" }], [], signal, onEvent, undefined, key);
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

test("群聊和私聊保留由宿主打开的会话，句柄释放后恢复原上下文", async (t) => {
  for (const key of ["chat:group:123", "chat:user:456"]) {
    await t.test(key, async (t) => {
      const f = await fixture(t, { key });
      const owner = await f.agents.resume({ resumeSessionId: f.oldId });
      const events = [];
      try {
        await assert.rejects(f.run(undefined, (type) => events.push(type), "被占用时的输入"), /会话正被其他写入句柄占用/);
        assert.equal(f.agents.get(f.oldId), owner.agent);
        assert.equal((await f.binding()).id, f.oldId);
        assert.equal(f.host.created.length, 1);
        assert.equal(f.host.resumed.length, 1);
        assert(!events.includes("session.replaced"));
      } finally {
        await owner.dispose();
      }
      assert.equal(await f.run(undefined, undefined, "释放后的输入"), "done");
      const restored = f.host.resumed.at(-1);
      assert.equal(restored.agent.id, f.oldId);
      assert(restored.conversation.some(message => message.content?.[0]?.text === "hello"));
      assert(!restored.conversation.some(message => message.content?.[0]?.text === "被占用时的输入"));
      assert.equal(f.host.created.length, 1);
    });
  }
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
