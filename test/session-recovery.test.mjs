import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { defaultsFor } from "@dsh-plugin/dsh-loader/config";
import { template } from "../lib/host/config.js";
import { Harness } from "../lib/host/harness.js";
import { hostFixture } from "./fixtures/host.mjs";

async function fixture(t) {
  const data = await mkdtemp(path.join(os.tmpdir(), "synapse-recovery-"));
  const host = hostFixture();
  const config = defaultsFor(template.fields);
  const create = () => new Harness(host.loader, () => config, { data }, {});
  let harness = create();
  const run = (signal, onEvent) => harness.run("example", "hello", [{ role: "user", content: "旧通道上下文" }], [], signal, onEvent, undefined, "chat:group:123");
  t.after(async () => { await harness.close(); await rm(data, { recursive: true, force: true }); });
  await run();
  const oldId = host.created[0].agent.id;
  const reload = async () => { await harness.close(); harness = create(); };
  await reload();
  return { host, oldId, run, reload, agents: host.loader.services.get("agents") };
}

test("被占用的会话自动更换绑定，后续消息与重载继续使用新会话", async (t) => {
  const f = await fixture(t);
  const resume = f.agents.resume;
  f.agents.resume = async (options) => {
    if (options.resumeSessionId === f.oldId) {
      throw Object.assign(new Error(`session "${f.oldId}" is already owned by an active write handle`), { name: "SessionAlreadyOwnedError", sessionId: f.oldId });
    }
    return resume(options);
  };
  const events = [];
  assert.equal(await f.run(undefined, (type, value) => events.push({ type, value })), "done");
  const next = f.host.created[1];
  assert.notEqual(next.agent.id, f.oldId);
  assert.equal(next.injected.length, 0);
  assert.equal(events.find((event) => event.type === "session.replaced").value.previousSession, f.oldId);
  await f.run();
  assert.equal(f.host.created.length, 2);
  await f.reload();
  await f.run();
  assert.equal(f.host.resumed.at(-1).agent.id, next.agent.id);
});

test("损坏、已丢失和不可访问的会话可以新建，取消请求不触发替换", async (t) => {
  for (const error of [
    Object.assign(new Error("历史损坏"), { name: "SessionPersistenceCorruptionError" }),
    Object.assign(new Error("历史已丢失"), { name: "SessionPersistenceNotFoundError" }),
    Object.assign(new Error("历史不可访问"), { code: "EACCES" }),
  ]) {
    await t.test(error.message, async (t) => {
      const f = await fixture(t);
      f.agents.resume = async () => { throw error; };
      assert.equal(await f.run(), "done");
      assert.notEqual(f.host.created[1].agent.id, f.oldId);
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
  });
});

test("新会话创建失败时直接返回错误，不循环创建或重试其他执行错误", async (t) => {
  const f = await fixture(t);
  f.agents.resume = async () => { throw Object.assign(new Error("被占用"), { name: "SessionAlreadyOwnedError" }); };
  let attempts = 0;
  f.agents.create = async () => { attempts++; throw new Error("新会话存储不可用"); };
  await assert.rejects(f.run(), /新会话存储不可用/);
  assert.equal(attempts, 1);
});

test("会话替换通知失败时新句柄仍受托管，后续消息和关闭可以正常处理", async (t) => {
  const f = await fixture(t);
  f.agents.resume = async () => { throw Object.assign(new Error("被占用"), { name: "SessionAlreadyOwnedError" }); };
  await assert.rejects(f.run(undefined, () => { throw new Error("通知发送失败"); }), /通知发送失败/);
  const replacement = f.host.created[1];
  assert.equal(await f.run(), "done");
  assert.equal(f.host.created.length, 2);
  await f.reload();
  assert(f.host.disposed.includes(replacement.agent.id));
});
