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
import { abortable } from "../lib/host/abort.js";

const until = async (predicate, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() >= deadline) { throw new Error("禁言集成状态等待超时"); }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};

test("完整 Bot 接收禁言与解禁、取消群任务、共享缓存并在 WS 重连后重新查询", { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "synapse-mute-integration-"));
  const paths = { home: root, profile: root, data: path.join(root, "data", "dsh-synapse"), skills: path.join(root, "skills") };
  await mkdir(paths.data, { recursive: true });
  const c = defaultsFor(template.fields);
  c.enabled = true;
  Object.assign(c.memory, { enabled: false, learnMemory: false, learnSkills: false });
  Object.assign(c.modules.chat, { groups: [123, 456], requireMention: false, replyPerSentence: false });
  Object.assign(c.modules.presentation, { reactionEnabled: false, progressAsImage: false });
  const member = { role: "member", shut_up_timestamp: 0 }, group = { group_name: "禁言测试群", group_all_shut: 0 };
  const requests = [], executions = [], errors = [];
  let socket, messageId = 100, connections = 0, aborted = false;
  const http = createServer(async (req, res) => {
    let bytes = ""; for await (const part of req) { bytes += part; }
    const body = bytes ? JSON.parse(bytes) : {};
    requests.push({ action: req.url, body });
    const data = req.url === "/get_login_info" ? { user_id: 42, nickname: "testbot" }
      : req.url === "/get_group_info" ? group
      : req.url === "/get_group_member_info" ? member : { message_id: ++messageId };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status: "ok", retcode: 0, data }));
  });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  c.connection.httpUrl = `http://127.0.0.1:${http.address().port}`;
  const ws = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(ws, "listening");
  ws.on("connection", value => { socket = value; connections++; });
  c.connection.wsUrl = `ws://127.0.0.1:${ws.address().port}`;
  const host = hostFixture(async ({ message, signal }) => {
    const input = JSON.stringify(message.content);
    executions.push(input);
    if (input.includes("等待中的回复")) {
      await new Promise((resolve, reject) => {
        const stop = () => { aborted = true; reject(signal.reason); };
        if (signal.aborted) { stop(); } else { signal.addEventListener("abort", stop, { once: true }); }
      });
    }
    return input.includes("另一个群") ? "其他群回复" : "新消息回复";
  });
  const agent = new Agent({ loader: host.loader, config: () => c, paths, memory: {}, skills: { retrieve: async () => [] }, mcp: { available: async () => [] }, checkGroupSend: (id, signal) => bot.canSendGroup(id, signal) });
  const state = new ChatState(path.join(paths.data, "chat-state.sqlite"));
  const activity = new ChatActivity({ state, config: () => c, images: new ChatImages(paths, state, () => c), cloud: new AsyncWordCloud(path.join(paths.data, "chat-state.sqlite")) });
  await activity.recover((...args) => agent.harness.hasInput(...args));
  const gateway = new Gateway(agent, () => c, error => errors.push(error.message), activity);
  await gateway.start();
  const bot = new Bot(paths, () => c, gateway, error => errors.push(error.message));
  t.after(async () => {
    await bot.stop(); await gateway.close(); await agent.close(); await activity.close(); state.close();
    for (const client of ws.clients) { client.terminate(); }
    await new Promise(resolve => ws.close(resolve));
    http.closeAllConnections(); await new Promise(resolve => http.close(resolve));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("synapse-mute-integration-"));
    await rm(root, { recursive: true, force: true });
  });
  await bot.start(); await until(() => bot.state === "running" && socket);
  const send = (text, groupId = 123) => socket.send(JSON.stringify({
    post_type: "message", message_type: "group", group_id: groupId, self_id: 42, user_id: 7,
    message_id: ++messageId, time: Math.floor(Date.now() / 1000), sender: { nickname: "用户", user_id: 7 },
    message: [{ type: "text", data: { text } }], raw_message: text,
  }));
  const notice = (user_id, sub_type, duration = 0, notice_type = "group_ban") => socket.send(JSON.stringify({
    post_type: "notice", notice_type, group_id: 123, self_id: 42, user_id, operator_id: 9,
    sub_type, duration, time: Math.floor(Date.now() / 1000),
  }));
  const check = () => bot.canSendGroup("123", new AbortController().signal);
  const checks = () => requests.filter(item => item.action === "/get_group_member_info" && item.body.group_id === 123).length;
  send("等待中的回复"); await until(() => executions.length === 1);
  send("排队中的旧回复");
  await until(() => [...gateway.runs.values()].filter(run => run.groupId === "123").length === 2);
  send("另一个群", 456);
  notice(42, "ban", 60);
  await until(() => aborted && !agent.busy("chat:group:123") && !state.busy("123"));
  assert.equal(await check(), false);
  await until(() => requests.some(item => item.action.startsWith("/send_group") && Number(item.body.group_id) === 456));
  assert.equal(executions.length, 2);
  assert.ok(!requests.some(item => item.action.startsWith("/send_group") && Number(item.body.group_id) === 123));
  send("禁言期间不要执行");
  await until(() => state.logs({ groupId: "123", type: "failure" }).some(item => /未能提交/.test(item.reason)));
  assert.equal(executions.length, 2);
  notice(42, "lift_ban");
  await until(check);
  send("解禁后的新消息");
  await until(() => requests.some(item => item.action.startsWith("/send_group") && Number(item.body.group_id) === 123));
  await until(() => !state.busy("123"));
  assert.equal(checks(), 1);
  assert.equal(executions.length, 3);
  assert.equal(host.created.length, 2);
  notice(0, "ban", -1); await until(async () => !await check());
  notice(42, "set", 0, "group_admin"); await until(check);
  notice(7, "ban", 60); assert.equal(await check(), true);
  assert.equal(checks(), 1);
  member.shut_up_timestamp = Math.floor(Date.now() / 1000) + 60;
  socket.close();
  await until(() => connections === 2);
  assert.equal(await check(), false);
  assert.equal(checks(), 2);
  notice(42, "lift_ban"); await until(check);
  assert.equal(checks(), 2);
  assert.deepEqual(errors, []);
});

test("按取消截止代次停止图片准备，重复或迟到的禁言通知不影响新任务", async t => {
  const c = defaultsFor(template.fields), finished = [], signals = [], errors = [];
  let preparing = false, release;
  const held = new Promise(resolve => { release = resolve; });
  const activity = {
    async submission(_group, seq, _trigger, signal) {
      if (seq === 1) { preparing = true; await abortable(held, signal); }
      return { input: `消息 ${seq}`, actorId: "7", source: "user", submission: { batchId: `batch-${seq}` } };
    },
    delivery() {}, abandon() {},
    async finished(id) { finished.push(id); },
  };
  const agent = {
    async run(_input, _channel, _history, signal) {
      signals.push(signal);
      await new Promise((resolve, reject) => {
        if (signal.aborted) { reject(signal.reason); }
        else { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); }
      });
    },
    reset() { assert.fail("禁言不能清除会话历史"); },
  };
  const gateway = new Gateway(agent, () => c, error => errors.push(error.message), activity);
  await gateway.start();
  t.after(async () => { release(); await gateway.close(); });
  const post = (seq, muteGeneration) => fetch(`${gateway.url}/v1/runs`, {
    method: "POST", headers: { Authorization: `Bearer ${gateway.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: "group_123", input: "群聊", context: { type: "group", groupId: "123", userId: "7", observationId: seq, muteGeneration } }),
  });
  const old = post(1, 0); await until(() => preparing);
  await gateway.groupMuted("123", 0);
  assert.equal((await old).status, 500);
  assert.equal(signals.length, 0);
  const response = await post(2, 1);
  assert.equal(response.status, 202);
  const runId = (await response.json()).run_id;
  await until(() => signals.length === 1);
  await gateway.groupMuted("123", 0);
  assert.equal(signals[0].aborted, false);
  assert.equal((await post(3, 0)).status, 409);
  await gateway.groupMuted("123", 1);
  assert.equal(signals[0].aborted, true);
  assert.deepEqual(finished, [runId]);
  assert.ok(errors.some(error => /禁言/.test(error)));
});
