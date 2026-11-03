import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { defaultsFor } from "@dsh-plugin/dsh-loader/config";
import { template } from "../lib/host/config.js";
import { Harness } from "../lib/host/harness.js";
import { hostFixture } from "./fixtures/host.mjs";
import { chatRunContext } from "../lib/host/session-bindings.js";

test("可读标题写入原生会话，恢复后更新标题并保留会话记录", async (t) => {
  const data = await mkdtemp(path.join(os.tmpdir(), "synapse-titles-"));
  const host = hostFixture();
  const config = defaultsFor(template.fields);
  const create = () => new Harness(host.loader, () => config, { data, profile: data }, {});
  let harness = create();
  t.after(async () => { await harness.close(); await rm(data, { recursive: true, force: true }); });
  const run = (title) => harness.run("example", "hello", [], [], undefined, undefined, undefined, "chat:group:659356928", "chat", title);
  const title = "【群聊】铁砧工艺交流反馈☕（659356928）";
  await run(title);
  const id = host.created[0].agent.id;
  assert.equal(host.loader.services.get("sessionTitle").get(host.created[0].agent.session).title, title);
  await run(title);
  assert.equal(host.created[0].agent.session.events.filter(event => event.type === "session/title").length, 1);
  await harness.close();
  harness = create();
  const renamed = "【群聊】新群名（659356928）";
  await run(renamed);
  assert.equal(host.resumed[0].agent.id, id);
  assert.equal(host.loader.services.get("sessionTitle").get(host.resumed[0].agent.session).title, renamed);
});

test("群与私聊来源信息必须匹配当前会话，Discord 按桥接群显示标题", () => {
  assert.throws(() => chatRunContext("chat:group:123", { type: "group", groupId: "456", userId: "1" }), /不匹配/);
  assert.throws(() => chatRunContext("chat:user:1", { type: "user", userId: "2" }), /不匹配/);
  const context = chatRunContext("chat:group:123", { type: "discord", groupId: "123", userId: "dc:456", name: "铁砧工艺交流反馈☕", admin: true });
  assert.equal(context.title, "【群聊】铁砧工艺交流反馈☕（123）");
  assert.equal(context.route.userId, "dc:456");
});
