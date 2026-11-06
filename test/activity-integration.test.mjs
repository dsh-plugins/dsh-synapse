import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { defaultsFor } from "@dsh-plugin/dsh-loader/config";
import { template } from "../lib/host/config.js";
import { ChatState } from "../lib/host/chat-state.js";
import { ChatImages } from "../lib/host/chat-images.js";
import { ChatActivity } from "../lib/host/chat-activity.js";
import { AsyncWordCloud } from "../lib/host/word-cloud.js";
import { Agent } from "../lib/host/agent.js";
import { Gateway } from "../lib/host/gateway.js";
import { Bot } from "../lib/host/bot.js";
import { hostFixture } from "./fixtures/host.mjs";

const until = async (predicate, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() >= deadline) { throw new Error("群聊集成状态等待超时"); }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};

test("真实 Bot/OneBot 验证持久化背景、概率、空闲 IPC、忽略名单命令、热更新与正常重启", { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "synapse-group-integration-"));
  const paths = { home: root, profile: root, data: path.join(root, "data", "dsh-synapse"), skills: path.join(root, "skills") };
  await mkdir(paths.data, { recursive: true });
  const c = defaultsFor(template.fields);
  c.enabled = true; Object.assign(c.memory, { enabled: false, learnMemory: false, learnSkills: false });
  Object.assign(c.modules.chat, { groups: [123], blockedUsers: [1], requireMention: true, replyPerSentence: false });
  Object.assign(c.modules.presentation, { reactionEnabled: false, progressAsImage: false });
  c.modules.management.operators = [9, 42]; c.modules.groupFeatures.command = [123];
  let clock = Date.parse("2026-11-04T04:00:00Z"), socket, number = 100, failSend = false;
  const requests = [], received = [], errors = [];
  const http = createServer(async (req, res) => {
    let bytes = ""; for await (const part of req) { bytes += part; }
    const body = bytes ? JSON.parse(bytes) : {};
    requests.push({ action: req.url, body });
    res.setHeader("Content-Type", "application/json");
    if (failSend && req.url.startsWith("/send_group")) { failSend = false; res.end(JSON.stringify({ retcode: 100, wording: "模拟 OneBot 发送失败" })); return; }
    res.end(JSON.stringify({ retcode: 0, status: "ok", data: req.url === "/get_login_info" ? { user_id: 42, nickname: "testbot" } : req.url === "/get_group_info" ? { group_name: "群聊集成测试", group_all_shut: 0 } : req.url === "/get_group_member_info" ? { role: "member", shut_up_timestamp: 0 } : { message_id: ++number } }));
  }); http.listen(0, "127.0.0.1"); await once(http, "listening"); c.connection.httpUrl = `http://127.0.0.1:${http.address().port}`;
  const ws = new WebSocketServer({ port: 0, host: "127.0.0.1" }); await once(ws, "listening");
  ws.on("connection", value => { socket = value; }); c.connection.wsUrl = `ws://127.0.0.1:${ws.address().port}`;
  let hold = false, entered = false;
  const host = hostFixture(async ({ message, signal }) => {
    received.push(message);
    if (JSON.stringify(message.content).includes("模型自动失败")) { throw new Error("模拟模型失败"); }
    if (hold) {
      entered = true;
      await new Promise((resolve, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
    }
    return "群聊集成回复";
  });
  const agent = new Agent({ loader: host.loader, config: () => c, paths, memory: {}, skills: { retrieve: async () => [] }, mcp: { available: async () => [] } });
  const state = new ChatState(path.join(paths.data, "chat-state.sqlite"));
  const activity = new ChatActivity({ state, config: () => c, images: new ChatImages(paths, state, () => c, () => clock), cloud: new AsyncWordCloud(path.join(paths.data, "chat-state.sqlite")), now: () => clock, random: () => 0, busy: id => agent.busy(`chat:group:${id}`), onError: error => errors.push(error.message) });
  const contexts = [];
  const gateway = new Gateway({ run: (...args) => { contexts.push(args[8]); return agent.run(...args); }, reset: key => agent.reset(key), whenCurrentSettled: key => agent.whenCurrentSettled(key) }, () => c, error => errors.push(error.message), activity);
  await activity.recover((...args) => agent.harness.hasInput(...args)); await gateway.start();
  const bot = new Bot(paths, () => c, gateway, error => errors.push(error.message));
  activity.activate = event => bot.activate(event); activity.available = () => bot.state === "running";
  t.after(async () => {
    await bot.stop(); await gateway.close(); await agent.close(); await activity.close();
    for (const client of ws.clients) { client.terminate(); }
    await new Promise(resolve => ws.close(resolve)); await new Promise(resolve => http.close(resolve));
    const target = path.resolve(root);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert.ok(path.basename(target).startsWith("synapse-group-integration-"));
    await rm(target, { recursive: true, force: true });
  });
  await bot.start(); await until(() => bot.state === "running" && socket);
  let id = 0;
  const send = (text, user = 2, mentioned = false) => {
    const messageId = ++id;
    socket.send(JSON.stringify({ post_type: "message", message_type: "group", group_id: 123, user_id: user, self_id: 42, message_id: messageId, time: Math.floor(clock / 1000), sender: { user_id: user, nickname: `用户${user}`, role: "member" }, message: [...(mentioned ? [{ type: "at", data: { qq: "42" } }] : []), { type: "text", data: { text } }], raw_message: text }));
    return String(messageId);
  };
  const ignored = send("应当完全忽略的 AI 消息", 1);
  const background = send("未触发的群聊背景");
  await until(() => state.messages("123").some(item => item.messageId === background));
  assert.equal(received.length, 0); assert.ok(!state.allMessages().some(item => item.messageId === ignored));
  send("/help", 1);
  await until(() => requests.some(item => item.action.startsWith("/send_group") && /help|mcv/.test(JSON.stringify(item.body))));
  send("请回答当前问题", 2, true);
  await until(() => received.length === 1 && !activity.status()[0].busy);
  assert.match(JSON.stringify(received[0]), /未触发的群聊背景/);
  assert.equal(state.messages("123").length, 0);
  const pid = bot.child.pid;
  const previous = structuredClone(c);
  c.activity.probabilityEnabled = true;
  Object.assign(c.activity.probability, { baseBps: 10000, maxBps: 10000 });
  const { probability, idle, words, blockedWords } = structuredClone(c.activity);
  c.activity.groups = [{ probability, idle, words, blockedWords, groupId: 123, useDefaults: true, probabilityEnabled: true, idleEnabled: false }];
  await activity.configure(previous, "集成热更新", 1); bot.updateActivity();
  assert.equal(bot.child.pid, pid);
  clock += 301000; send("概率回复命中");
  await until(() => received.length === 2 && !activity.status()[0].busy);
  assert.equal(state.count("123", "probability", 0), 1);
  send("冷却中的普通消息"); await until(() => state.logs({ type: "skip" }).some(item => /冷却/.test(item.reason)));
  assert.equal(received.length, 2);
  const beforeIdle = structuredClone(c);
  c.activity.idleEnabled = true; c.activity.groups[0].idleEnabled = true;
  Object.assign(c.activity.idle, { delayMinSec: 0, delayMaxSec: 0 });
  await activity.configure(beforeIdle, "空闲热更新", 2); bot.updateActivity();
  clock += 31 * 60000; await activity.check(); await activity.dispatchDue();
  await until(() => received.length === 3 && !activity.status()[0].busy);
  assert.equal(received[2].source.origin, "system"); assert.equal(contexts[2].route.admin, false); assert.equal(contexts[2].route.userId, "42");
  assert.match(JSON.stringify(received[2]), /好久没在群里说话了，说点什么吧/);
  hold = true; send("重启前正在执行的回复", 2, true); await until(() => entered);
  await bot.restart(); hold = false; await until(() => bot.state === "running");
  assert.notEqual(bot.child.pid, pid); assert.equal(activity.status()[0].busy, false);
  send("重启之后继续", 2, true); await until(() => received.length === 5 && !activity.status()[0].busy);
  assert.ok(!state.messages("123").length);
  const beforeFailure = requests.length;
  clock += 301000; send("模型自动失败");
  await until(() => received.length === 6 && !activity.status()[0].busy);
  assert.ok(state.logs({ type: "failure" }).some(item => item.triggerId && /执行或发送失败/.test(item.reason)));
  assert.ok(!requests.slice(beforeFailure).some(item => item.action.startsWith("/send_group") && /❌/.test(JSON.stringify(item.body))));
  failSend = true; clock += 301000; send("模拟发送失败");
  await until(() => received.length === 7 && !activity.status()[0].busy);
  assert.equal(state.logs({ type: "failure" }).filter(item => item.triggerId && /执行或发送失败/.test(item.reason)).length, 2);
  assert.deepEqual(errors, []);
});
