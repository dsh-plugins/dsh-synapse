import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultsFor } from "@dsh-plugin/dsh-loader/config";
import { ConfigStore } from "../node_modules/@dsh-plugin/dsh-loader/dist/services/config.js";
import { template, validateConfig } from "../lib/host/config.js";
import { Agent } from "../lib/host/agent.js";
import { Harness } from "../lib/host/harness.js";
import { hostFixture } from "./fixtures/host.mjs";

async function fixture(t, execute) {
  const profile = await mkdtemp(path.join(os.tmpdir(), "synapse-run-limits-"));
  const paths = { home: profile, profile, data: path.join(profile, "data") };
  const config = defaultsFor(template.fields);
  const host = hostFixture(execute);
  const harness = new Harness(host.loader, () => config, paths, {});
  t.after(async () => {
    try {
      await harness.close();
    } finally {
      const target = path.resolve(profile);
      if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith("synapse-run-limits-")) {
        throw new Error("临时测试目录不在预期范围内");
      }
      await rm(target, { recursive: true, force: true });
    }
  });
  return { paths, config, host, harness };
}

test("配置可保存并恢复无限制，越界保存失败时快照和修订号保持不变", async t => {
  const f = await fixture(t);
  const store = new ConfigStore(f.paths.profile);
  const handle = await store.register(null, template);
  try {
    await handle.update({ limits: { ...handle.get().value.limits, timeoutSec: -1, maxToolRounds: -1 } });
    const saved = JSON.parse(await readFile(path.join(f.paths.profile, "config/dsh-synapse/config.json"), "utf8"));
    const restored = validateConfig(saved.value);
    assert.equal(restored.limits.timeoutSec, -1);
    assert.equal(restored.limits.maxToolRounds, -1);
    const snapshot = handle.get();
    for (const [key, value] of [["timeoutSec", -2], ["timeoutSec", 601], ["maxToolRounds", -2], ["maxToolRounds", 21]]) {
      await assert.rejects(handle.update({ limits: { ...snapshot.value.limits, [key]: value } }), { code: "validation" });
      assert.deepEqual(handle.get(), snapshot);
    }
    await handle.update({ limits: { ...handle.get().value.limits, timeoutSec: 0, maxToolRounds: 0 } });
    assert.doesNotThrow(() => validateConfig(handle.get().value));
    assert.doesNotThrow(() => validateConfig({ ...restored, limits: { ...restored.limits, timeoutSec: 4, maxToolRounds: 1 } }));
    assert.doesNotThrow(() => validateConfig({ ...restored, limits: { ...restored.limits, timeoutSec: 5, maxToolRounds: 1 } }));
  } finally {
    handle.dispose();
    store.dispose();
  }
});

for (const channel of ["chat", "review"]) {
  test(`${channel} 可超过有限步骤上限，并可恢复有限步骤控制`, async t => {
    const f = await fixture(t, async ({ message, options }) => {
      const record = f.host.created.find(item => item.agent.id === options.sessionId);
      for (let step = 1; step < Number(message.content[0].text); step++) {
        await record.listeners.get("agent/pre-step")({ agent: record.agent }, async () => ({ kind: "enter" }));
      }
      return "任务完成";
    });
    const run = steps => f.harness.run("规则", String(steps), [], [], undefined, undefined, undefined, undefined, channel);
    f.config.limits.maxToolRounds = 0;
    await assert.rejects(run(1), /已达到任务步骤上限/);
    f.config.limits.maxToolRounds = 2;
    assert.equal(await run(2), "任务完成");
    await assert.rejects(run(3), /已达到任务步骤上限/);
    f.config.limits.maxToolRounds = -1;
    assert.equal(await run(25), "任务完成");
    f.config.limits.maxToolRounds = 2;
    await assert.rejects(run(3), /已达到任务步骤上限/);
  });
}

test("零秒时限阻止已有驻留会话继续执行模型和工具", async t => {
  let executions = 0;
  const f = await fixture(t, async () => {
    executions++;
    return "任务完成";
  });
  const run = () => f.harness.run("规则", "消息", [], [], undefined, undefined, undefined, "chat:example");
  assert.equal(await run(), "任务完成");
  f.config.limits.timeoutSec = 0;
  await assert.rejects(run(), { name: "TimeoutError" });
  assert.equal(executions, 1);
});

test("有限超时仍会取消正在执行的任务", { timeout: 15000 }, async t => {
  const f = await fixture(t, async ({ signal }) => {
    await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    signal.throwIfAborted();
  });
  f.config.limits.timeoutSec = 5;
  await assert.rejects(f.harness.run("规则", "等待取消"), { name: "TimeoutError" });
});

test("私聊图片仍交给宿主，记忆与 Skill 只检索用户文字", async t => {
  const f = await fixture(t);
  const queries = [];
  const agent = new Agent({ loader: f.host.loader, config: () => f.config, paths: f.paths,
    memory: { search: async query => { queries.push(["memory", query]); return []; } },
    skills: { retrieve: async query => { queries.push(["skill", query]); return []; } },
    mcp: { available: async () => [] },
  });
  t.after(() => agent.close());
  const image = { type: "image_url", image_url: { url: "data:image/png;base64,YWJj" } };
  const run = input => agent.run(input, "chat", [], undefined, undefined, "", undefined, "chat:user:1");
  assert.equal(await run([
    { role: "assistant", content: "历史回复" },
    { role: "user", content: [{ type: "text", text: "请保存参考图" }, image, { type: "text", text: "再整理成 Skill" }] },
  ]), "done");
  assert.equal(await run([image]), "done");
  assert.deepEqual(queries, [["memory", "请保存参考图\n再整理成 Skill"], ["skill", "请保存参考图\n再整理成 Skill"]]);
  assert.deepEqual(f.host.attachments.map(({ data }) => data.toString()), ["abc", "abc"]);
});

test("单轮超时取消记忆检索并让同一私聊继续执行", { timeout: 8000 }, async t => {
  const f = await fixture(t);
  f.config.limits.timeoutSec = 1;
  const agent = new Agent({ loader: f.host.loader, config: () => f.config, paths: f.paths,
    memory: { search: async (query, _channel, signal) => {
      if (query === "等待检索") {
        await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
        signal.throwIfAborted();
      }
      return [];
    } },
    skills: { retrieve: async () => [] }, mcp: { available: async () => [] },
  });
  t.after(() => agent.close());
  const run = input => agent.run(input, "chat", [], undefined, undefined, "", undefined, "chat:user:1");
  await assert.rejects(run("等待检索"), { name: "TimeoutError" });
  assert.equal(f.host.created.length, 0);
  assert.equal(await run("下一条消息"), "done");
});

test("取消时无需等待私聊图片写入即可处理下一条消息", { timeout: 8000 }, async t => {
  const f = await fixture(t);
  const entered = Promise.withResolvers();
  const saved = Promise.withResolvers();
  const get = f.host.loader.services.get;
  t.mock.method(f.host.loader.services, "get", name => name === "attachments"
    ? { saveImage: async () => { entered.resolve(); return saved.promise; } }
    : get(name));
  const agent = new Agent({ loader: f.host.loader, config: () => f.config, paths: f.paths,
    memory: { search: async () => [] }, skills: { retrieve: async () => [] }, mcp: { available: async () => [] },
  });
  t.after(async () => { saved.resolve({ attachmentId: "image" }); await agent.close(); });
  const controller = new AbortController();
  const run = (input, signal) => agent.run(input, "chat", [], signal, undefined, "", undefined, "chat:user:1");
  const pending = run([{ type: "image_url", image_url: { url: "data:image/png;base64,YWJj" } }], controller.signal);
  await Promise.race([entered.promise, pending]);
  controller.abort(new Error("用户取消"));
  await assert.rejects(pending, /用户取消/);
  assert.equal(f.host.created.length, 0);
  assert.equal(await run("下一条消息"), "done");
});

for (const cancellation of ["caller", "shutdown"]) {
  test(`无限制任务仍响应 ${cancellation} 取消并释放会话`, { timeout: 10000 }, async t => {
    let started;
    const entered = new Promise(resolve => { started = resolve; });
    const f = await fixture(t, async ({ signal }) => {
      started();
      await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
      signal.throwIfAborted();
    });
    f.config.limits.timeoutSec = -1;
    f.config.limits.maxToolRounds = -1;
    const controller = new AbortController();
    const task = f.harness.run("规则", "等待取消", [], [], controller.signal);
    await Promise.race([entered, task]);
    const rejected = assert.rejects(task, /abort|用户取消/i);
    if (cancellation === "caller") {
      controller.abort(new Error("用户取消"));
    } else {
      await f.harness.close();
    }
    await rejected;
    assert.equal(f.host.disposed.length, f.host.created.length);
  });
}
