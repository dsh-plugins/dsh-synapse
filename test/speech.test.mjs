import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultsFor } from "@dsh-plugin/dsh-loader/config";
import { template, validateConfig } from "../lib/host/config.js";
import { synthesizeSpeech, speechTools } from "../lib/host/speech.js";
import { deliverVoice } from "../lib/host/bot-speech.js";
import { Agent } from "../lib/host/agent.js";
import { chatRunContext } from "../lib/host/session-bindings.js";
import { hostFixture } from "./fixtures/host.mjs";
import { REST } from "discord.js";
import { sendDiscordVoice } from "../lib/host/bot-speech.js";

const audio = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(128)]);
const route = { type: "group", userId: "1", groupId: "123", name: "example", admin: false };
async function fixture(t, handler) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) { body += part; }
    calls.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    if (handler) { return handler(req, res); }
    res.writeHead(200, { "Content-Type": "audio/mpeg" }); res.end(audio);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const c = defaultsFor(template.fields);
  Object.assign(c.speech, { enabled: true, baseUrl: `http://127.0.0.1:${server.address().port}/prefix/v1/`, apiKey: "example-secret", voiceId: "voc_example" });
  return { c, calls };
}

test("语音默认关闭，启用前校验凭据、音色及参数范围", () => {
  const c = defaultsFor(template.fields);
  assert.doesNotThrow(() => validateConfig(c));
  assert.equal(speechTools(() => c, route, async () => assert.fail("不应发送")).length, 0);
  c.speech.enabled = true;
  assert.throws(() => validateConfig(c), /API Key.*音色/);
  Object.assign(c.speech, { apiKey: "example-key", voiceId: "voc_example" });
  assert.doesNotThrow(() => validateConfig(c));
  for (const [key, value] of [["baseUrl", "https://example:secret@example.com/v1"], ["baseUrl", "https://example.com/v1?key=secret"], ["voiceId", "../foo"], ["languageCode", "zh-CN"], ["maxCharacters", 2001], ["timeoutSec", 0]]) {
    const previous = c.speech[key]; c.speech[key] = value;
    assert.throws(() => validateConfig(c)); c.speech[key] = previous;
  }
});

test("Discord 通过现有 REST 连接上传 MP3，检查频道绑定且支持取消", async t => {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) { body += chunk; }
    calls.push({ url: req.url, body, headers: req.headers });
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ id: "9876" }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const rest = new REST({ api: `http://127.0.0.1:${server.address().port}`, version: "10", retries: 0 }).setToken("example-discord-key");
  const client = { isReady: () => true, channels: { cache: new Map([["5678", { guildId: "12", name: "example" }]]) }, rest };
  const target = { ...route, type: "discord", channelId: "5678" };
  assert.deepEqual(await sendDiscordVoice(client, target, audio, new AbortController().signal, (guildId, name) => {
    assert.equal(guildId, "12"); assert.equal(name, "example"); return "123";
  }), { platform: "discord", messageId: "9876" });
  assert.equal(calls[0].url, "/v10/channels/5678/messages");
  assert.equal(calls[0].headers.authorization, "Bot example-discord-key");
  assert.match(calls[0].body, /filename="voice.mp3"/);
  assert.match(calls[0].body, /"allowed_mentions":\{"parse":\[\]\}/);
  await assert.rejects(sendDiscordVoice(client, target, audio, new AbortController().signal, () => "999"), /绑定不匹配/);
  await assert.rejects(sendDiscordVoice(client, target, audio, AbortSignal.abort(), () => "123"), /abort/i);
  assert.equal(calls.length, 1);
});

test("BreezeBlue 合成保留服务前缀，使用官方鉴权、同步 MP3 和模型语言风格参数", async t => {
  const f = await fixture(t);
  assert.deepEqual(await synthesizeSpeech(f.c.speech, "你好", "轻快地说", new AbortController().signal), audio);
  assert.equal(f.calls[0].url, "/prefix/v1/text-to-speech/voc_example?output_format=mp3&delivery=sync");
  assert.equal(f.calls[0].headers["xi-api-key"], f.c.speech.apiKey);
  assert.deepEqual(f.calls[0].body, { text: "你好", model_id: "breeze-tts-2", language_code: "zh", instructions: "轻快地说" });
  Object.assign(f.c.speech, { modelId: "", languageCode: "", instructions: "" });
  await synthesizeSpeech(f.c.speech, "hello", undefined, new AbortController().signal);
  assert.deepEqual(f.calls[1].body, { text: "hello" });
});

test("超长、空正文和无效风格在请求前拒绝，字符上限按 Unicode 字符计算", async t => {
  const f = await fixture(t); f.c.speech.maxCharacters = 2;
  const signal = new AbortController().signal;
  for (const [text, instructions] of [["", undefined], ["   ", undefined], ["三个字", undefined], ["你好", 123]]) {
    await assert.rejects(synthesizeSpeech(f.c.speech, text, instructions, signal));
  }
  assert.equal(f.calls.length, 0);
  await synthesizeSpeech(f.c.speech, "😀😀", undefined, signal);
  assert.equal(f.calls.length, 1);
});

test("HTTP 错误、非音频、空音频和超大音频均拒绝，服务错误不会泄露密钥", async t => {
  let response = "http";
  const f = await fixture(t, (_req, res) => {
    if (response === "http") { res.writeHead(429, { "Content-Type": "application/json" }); res.end(JSON.stringify({ detail: "example-secret" })); }
    if (response === "json") { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{}'); }
    if (response === "empty") { res.writeHead(200, { "Content-Type": "audio/mpeg" }); res.end(); }
    if (response === "invalid") { res.writeHead(200, { "Content-Type": "audio/mpeg" }); res.end('not audio'); }
    if (response === "large") { res.writeHead(200, { "Content-Type": "audio/mpeg" }); res.end(Buffer.alloc(10 * 1024 * 1024 + 1)); }
  });
  for (const value of ["http", "json", "empty", "invalid", "large"]) {
    response = value;
    await assert.rejects(synthesizeSpeech(f.c.speech, "你好", undefined, new AbortController().signal), error => {
      assert(!error.message.includes("example-secret"));
      assert.match(error.message, /HTTP 429|MP3|10 MB/); return true;
    });
  }
});

test("取消和超时中止合成，取消后的工具不发送音频", async t => {
  let started;
  const entered = () => new Promise(resolve => { started = resolve; });
  const f = await fixture(t, (_req, res) => { res.writeHead(200, { "Content-Type": "audio/mpeg" }); res.write(audio); started(); });
  let ready = entered();
  const controller = new AbortController(); let sends = 0;
  const tool = speechTools(() => f.c, route, async () => { sends++; return { platform: "qq", messageId: 1 }; })[0];
  const task = tool.execute({ text: "你好" }, controller.signal);
  const cancelled = assert.rejects(task, /abort/i);
  await ready; controller.abort(); await cancelled;
  assert.equal(sends, 0);
  f.c.speech.timeoutSec = 1; ready = entered();
  const timedOut = assert.rejects(synthesizeSpeech(f.c.speech, "你好", undefined, new AbortController().signal), /超时/);
  await ready; await timedOut;
});

test("合成期间关闭功能会阻止发送，工具回执只包含当前会话的发送结果", async t => {
  let closeFeature = false;
  const f = await fixture(t, (_req, res) => {
    if (closeFeature) { f.c.speech.enabled = false; }
    res.writeHead(200, { "Content-Type": "audio/mpeg" }); res.end(audio);
  });
  let sent;
  const tool = speechTools(() => f.c, route, async (target, bytes) => { sent = { target, bytes }; return { platform: "qq", messageId: 77 }; })[0];
  assert.deepEqual(await tool.execute({ text: "你好", groupId: "999" }, new AbortController().signal), { sent: true, platform: "qq", messageId: 77, characters: 2, bytes: audio.length });
  assert.deepEqual(sent, { target: route, bytes: audio });
  sent = undefined; closeFeature = true;
  await assert.rejects(tool.execute({ text: "你好" }, new AbortController().signal), /已关闭/);
  assert.equal(sent, undefined);
});

test("QQ 群聊与私聊使用 record 段和当前目标，Discord 发送带频道的音频附件", async () => {
  const calls = [];
  const bot = { sendGroupMsg: async (...args) => { calls.push(args); return 1; }, sendPrivateMsg: async (...args) => { calls.push(args); return 2; } };
  const signal = new AbortController().signal;
  assert.deepEqual(await deliverVoice(bot, route, audio.toString("base64"), signal), { platform: "qq", messageId: 1 });
  assert.deepEqual(await deliverVoice(bot, { ...route, type: "user" }, audio.toString("base64"), signal), { platform: "qq", messageId: 2 });
  assert.deepEqual(calls.map(item => item[0]), [123, 1]);
  assert(calls.every(item => item[1][0].type === "record" && item[1][0].data.file === `base64://${audio.toString("base64")}` && item[2].merge === false && item[2].signal === signal));
  const discord = { ...route, type: "discord", userId: "dc:1234", channelId: "5678" };
  assert.equal((await deliverVoice(bot, discord, audio.toString("base64"), signal, async (target, bytes, passed) => {
    assert.deepEqual(target, discord); assert.deepEqual(bytes, audio); assert.equal(passed, signal);
    return { platform: "discord", messageId: "9999" };
  })).messageId, "9999");
  await assert.rejects(deliverVoice(bot, { ...route, groupId: "invalid" }, audio.toString("base64"), signal), /目标无效/);
  await assert.rejects(deliverVoice(bot, route, "file:///example.mp3", signal), /数据无效/);
  await assert.rejects(deliverVoice({ sendGroupMsg: async () => undefined }, route, audio.toString("base64"), signal), /未确认/);
  const context = chatRunContext("chat:group:123", discord);
  assert.equal(context.route.channelId, "5678");
  assert.throws(() => chatRunContext("chat:group:123", { ...discord, channelId: "../foo" }), /频道/);
});

test("主模型可主动选择仅语音回复，发送失败后仍校验空输出并可改用文字", async t => {
  const f = await fixture(t);
  const home = await mkdtemp(path.join(os.tmpdir(), "synapse-speech-"));
  Object.assign(f.c.memory, { enabled: false, learnMemory: false, learnSkills: false });
  let failure = false, textReply = ""; const events = [], receipts = [];
  const host = hostFixture(async ({ tools, variables, signal }) => {
    assert.match(variables.get("synapse_context")(), /主动调用 synapse_send_voice/);
    const task = tools.find(tool => tool.name === "synapse_send_voice").execute({ text: "你好" }, { signal });
    if (failure) { await assert.rejects(task, /模拟发送失败/); }
    else { assert.equal((await task).sent, true); }
    return textReply;
  });
  const agent = new Agent({ loader: host.loader, config: () => f.c, paths: { home, profile: home, data: path.join(home, "data"), skills: path.join(home, "skills") }, memory: {}, skills: { retrieve: async () => [] }, mcp: { available: async () => [] }, sendVoice: async (target, bytes) => {
    if (failure) { throw new Error("模拟发送失败"); }
    receipts.push({ target, bytes }); return { platform: "qq", messageId: 88 };
  } });
  t.after(async () => {
    await agent.close();
    assert.equal(path.dirname(path.resolve(home)), path.resolve(os.tmpdir()));
    await rm(home, { recursive: true, force: true });
  });
  const run = () => agent.run("请说话", "chat", [], undefined, (event, data) => events.push({ event, data }), "", undefined, "chat:group:123", { route });
  assert.equal(await run(), "");
  assert.deepEqual(receipts, [{ target: route, bytes: audio }]);
  assert(events.some(item => item.event === "voice.sent" && item.data.messageId === 88));
  failure = true;
  await assert.rejects(run(), /未返回文本结果/);
  textReply = "语音失败，改用文字回复";
  assert.equal(await run(), textReply);
});
