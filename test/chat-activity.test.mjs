import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import path from "node:path";
import os from "node:os";
import { defaultsFor } from "@dsh-plugin/dsh-loader/config";
import { template, validateConfig } from "../lib/host/config.js";
import { ChatState } from "../lib/host/chat-state.js";
import { ChatActivity, finalProbability, quietTime } from "../lib/host/chat-activity.js";
import { ChatImages, groupContent } from "../lib/host/chat-images.js";
import { AsyncWordCloud } from "../lib/host/word-cloud.js";
import { CloudStore, cloudTokens } from "../lib/host/word-cloud-core.js";
import { Agent } from "../lib/host/agent.js";
import { Gateway } from "../lib/host/gateway.js";
import { hostFixture } from "./fixtures/host.mjs";

const epoch = Date.parse("2026-11-04T04:00:00Z");
const event = (id, text = "铁砧工艺讨论", groupId = "123", userId = "1", extra = {}) => ({ groupId, userId, selfId: "42", messageId: String(id), name: `用户${userId}`, time: epoch, mentioned: false, message: [{ type: "text", data: { text } }], ...extra });
const cloneSettings = c => { const { probability, idle, words, blockedWords } = structuredClone(c.activity); return { probability, idle, words, blockedWords }; };
const enable = (c, kind = "probability", groupId = 123) => {
  c.activity[`${kind}Enabled`] = true;
  let group = c.activity.groups.find(item => item.groupId === groupId);
  if (!group) { group = { ...cloneSettings(c), groupId, probabilityEnabled: false, idleEnabled: false, useDefaults: true }; c.activity.groups.push(group); }
  group[`${kind}Enabled`] = true;
};

async function fixture(t, { cloud, images, random } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "synapse-activity-"));
  const data = path.join(root, "data", "dsh-synapse");
  await mkdir(data, { recursive: true });
  const c = defaultsFor(template.fields);
  c.enabled = true; c.ragEnabled = false; c.learnMemory = false; c.learnSkills = false; c.modules.chat.groups = [123, 456];
  let clock = epoch;
  const state = new ChatState(path.join(data, "chat-state.sqlite"));
  const paths = { home: root, profile: root, data, skills: path.join(root, "skills") };
  const cache = images ? new ChatImages(paths, state, () => c, () => clock) : { start: async () => {}, process: async () => {}, collect: async () => {}, close: async () => {} };
  const errors = [];
  let revision = 0;
  const activity = new ChatActivity({ state, images: cache, config: () => c, cloud: cloud ?? { message: async () => ({ boost: 0, words: [] }), removeUsers: async () => {}, close: async () => {} }, now: () => clock, random: random ?? (() => 0.5), onError: error => errors.push(error),
    writer: async (settings, source) => { const before = structuredClone(c); validateConfig({ ...c, activity: settings }); c.activity = settings; await activity.configure(before, source, ++revision); } });
  t.after(async () => {
    await activity.close();
    const resolved = path.resolve(root), relative = path.relative(os.tmpdir(), resolved);
    assert.ok(!relative.startsWith("..") && !path.isAbsolute(relative) && path.basename(resolved).startsWith("synapse-activity-"));
    await rm(resolved, { recursive: true, force: true });
  });
  activity.identity("42");
  return { root, paths, c, state, cache, activity, errors, now: () => clock, advance: ms => { clock += ms; }, setTime: value => { clock = value; } };
}

test("逐条事务持久化、跨群隔离、去重和 100 条窗口在进程突然退出后仍有效", async t => {
  const f = await fixture(t);
  for (let id = 1; id <= 105; id++) { await f.activity.observe(event(id)); }
  assert.equal(f.state.messages("123").length, 100);
  assert.equal(f.state.messages("123")[0].messageId, "6");
  await f.activity.observe(event(1, "另一群", "456"));
  assert.equal((await f.activity.observe(event(105))).duplicate, true);
  const second = new ChatState(path.join(f.paths.data, "chat-state.sqlite"));
  assert.equal(second.messages("123").length, 100); assert.equal(second.messages("456").length, 1); second.close();
  const module = new URL("../lib/host/chat-state.js", import.meta.url).href;
  execFileSync(process.execPath, ["--input-type=module", "-e", `import {ChatState} from ${JSON.stringify(module)}; const s=new ChatState(process.env.SYNAPSE_TEST_DB);s.append(${JSON.stringify(event(999, "崩溃前保存"))},'崩溃前保存','崩溃前保存',[],Date.now());process.exit(0);`], { env: { ...process.env, SYNAPSE_TEST_DB: path.join(f.paths.data, "chat-state.sqlite") } });
  assert.equal(f.state.messages("123").at(-1).messageId, "999");
});

test("背景按批领取，提交期间的新消息保留；确认提交后模型失败也不重投", async t => {
  const f = await fixture(t);
  await f.activity.observe(event(1, "先前背景"));
  const trigger = await f.activity.observe(event(2, "当前问题", "123", "2", { mentioned: true }));
  const run = await f.activity.submission("123", trigger.seq);
  await f.activity.observe(event(3, "执行期间的新背景"));
  assert.match(run.submission.background, /先前背景/); assert.doesNotMatch(run.submission.background, /执行期间/);
  run.submission.prepared("native-1", "message-1"); run.submission.committed();
  f.activity.delivery("run-1", "123");
  await f.activity.finished("run-1", run.submission.batchId, true);
  assert.deepEqual(f.state.messages("123").map(item => item.messageId), ["3"]);
  const next = await f.activity.observe(event(4, "下一条问题", "123", "2", { mentioned: true }));
  const retry = await f.activity.submission("123", next.seq);
  assert.match(retry.submission.background, /执行期间/); assert.doesNotMatch(retry.submission.background, /先前背景/);
  await f.activity.finished("run-2", retry.submission.batchId, true);
  assert.deepEqual(f.state.messages("123").map(item => item.messageId), ["3", "4"]);
});

test("崩溃恢复按批次和原生消息 ID 核对；未确认的背景恢复，已提交背景清理", async t => {
  const f = await fixture(t);
  await f.activity.observe(event(1));
  const trigger = await f.activity.observe(event(2, "触发", "123", "1", { mentioned: true }));
  const run = await f.activity.submission("123", trigger.seq);
  run.submission.prepared("native-1", "msg-1");
  const checked = [];
  await f.activity.recover(async (...args) => { checked.push(args); return true; });
  assert.deepEqual(checked, [["native-1", "msg-1", run.submission.batchId]]); assert.equal(f.state.messages("123").length, 0);
  const second = await f.activity.observe(event(3, "没有保存的当前消息", "123", "1", { mentioned: true }));
  const pending = await f.activity.submission("123", second.seq);
  pending.submission.prepared("native-2", "msg-2");
  await f.activity.recover(async () => false);
  assert.equal(f.state.messages("123")[0].batchId, null);
});

test("概率默认关闭；双开关覆盖裸消息规则，同时保留 @ 与关键词触发", async t => {
  const f = await fixture(t, { random: () => 0.99 });
  f.c.modules.chat.requireMention = false;
  assert.equal((await f.activity.observe(event(1))).triggered, true);
  enable(f.c);
  assert.equal((await f.activity.observe(event(2))).triggered, false);
  assert.equal((await f.activity.observe(event(3, "当前问题", "123", "1", { mentioned: true }))).triggered, true);
  f.c.modules.chat.keywordTriggers = ["召唤"];
  assert.equal((await f.activity.observe(event(4, "召唤你"))).triggered, true);
  assert.equal((await f.activity.observe(event(5, "普通其他群消息", "456"))).triggered, true);
});

test("概率公式取最大加成，冷却、分钟与小时额度及发送中的忙碌状态生效", async t => {
  const f = await fixture(t, { random: () => 0, cloud: { message: async () => ({ boost: 20, words: ["铁砧"] }), removeUsers: async () => {}, close: async () => {} } });
  enable(f.c);
  const hit = await f.activity.observe(event(1));
  assert.equal(hit.automatic, true);
  const roll = f.state.logs({ type: "roll" })[0]; assert.equal(roll.probabilityBps, 900);
  assert.equal((await f.activity.observe(event(2))).triggered, false);
  assert.match(f.state.logs({ type: "skip" })[0].reason, /执行、排队或发送中/);
  const run = await f.activity.submission("123", hit.seq, hit.triggerId);
  f.activity.delivery("run-1", "123", hit.triggerId);
  run.submission.committed();
  await f.activity.finished("run-1", run.submission.batchId, true, hit.triggerId);
  assert.equal((await f.activity.observe(event(3))).triggered, false);
  assert.match(f.state.logs({ type: "skip" })[0].reason, /冷却/);
  f.c.activity.probability.cooldownSec = 0;
  assert.equal((await f.activity.observe(event(4))).triggered, false);
  assert.match(f.state.logs({ type: "skip" })[0].reason, /分钟/);
  f.advance(60001); f.c.activity.probability.perHour = 1;
  assert.equal((await f.activity.observe(event(5))).triggered, false);
  assert.match(f.state.logs({ type: "skip" })[0].reason, /小时/);
  f.advance(3600000);
  assert.equal((await f.activity.observe(event(6))).triggered, true);
});

test("机器人、命令、纯表情与纯网址不自动触发；普通图片有效，屏蔽词仍更新真人活跃", async t => {
  const f = await fixture(t, { random: () => 0 }); enable(f.c);
  for (const [id, text] of [[1, "/help"], [2, "😀☕"], [3, "https://example.com/abc"]]) { assert.equal((await f.activity.observe(event(id, text))).triggered, false); }
  assert.equal(f.state.getGroup("123").lastHumanAt, 0);
  const face = await f.activity.observe(event(4, "", "123", "1", { message: [{ type: "mface", data: { url: "https://example.com/face.gif" } }] }));
  assert.equal(face.triggered, false);
  f.c.activity.blockedWords = ["铁砧"]; f.advance(1000);
  assert.equal((await f.activity.observe(event(5))).triggered, false);
  assert.equal(f.state.getGroup("123").lastHumanAt, f.now());
  f.c.activity.blockedWords = [];
  const image = await f.activity.observe(event(6, "", "123", "1", { message: [{ type: "image", data: { url: "https://example.com/example.png" } }] }));
  assert.equal(image.triggered, true);
  assert.equal((await f.activity.observe(event(7, "bot", "123", "42"))).ignored, true);
});

test("持久化词云按单消息去重、历史 Top20 与半衰期加权，窗口外贡献不再提升概率", async t => {
  const f = await fixture(t);
  const cloud = new CloudStore(path.join(f.paths.data, "chat-state.sqlite"));
  try {
    const settings = f.c.activity;
    for (let i = 1; i <= 3; i++) { cloud.observe("123", String(i), "1", "铁砧 铁砧 工艺", epoch, epoch); }
    cloud.observe("123", "3", "1", "铁砧", epoch, epoch);
    const result = cloud.evaluate("123", "铁砧 工艺", epoch, settings);
    assert.equal(result.top.find(item => item.word === "铁砧").messages, 3);
    assert.equal(result.boost, 2); assert.equal(finalProbability(settings, result.boost), 900);
    const decayed = cloud.evaluate("123", "铁砧", epoch + 18 * 3600000, settings);
    assert.equal(decayed.top[0].weight, result.top[0].weight / 2);
    assert.equal(cloud.evaluate("123", "铁砧", epoch + 49 * 3600000, settings).boost, 0);
    assert.equal(cloud.evaluate("456", "铁砧", epoch, settings).boost, 0);
    assert.deepEqual(cloudTokens("https://example.com/xxx @昵称 C:/data/xxx.png 的 了 12345"), []);
    cloud.removeUsers(["1"]); assert.equal(cloud.evaluate("123", "铁砧", epoch, settings).boost, 0);
  } finally { cloud.close(); }
});

test("真实异步词云先查询后写入；失败时只降级加成，不影响基础概率", async t => {
  const f = await fixture(t);
  const cloud = new AsyncWordCloud(path.join(f.paths.data, "chat-state.sqlite"));
  try {
    await cloud.recover(epoch);
    for (let i = 1; i <= 3; i++) { await cloud.message("123", String(i), "1", "铁砧", epoch, epoch, f.c.activity); }
    const result = await cloud.message("123", "4", "1", "铁砧", epoch, epoch, f.c.activity);
    assert.ok(result.degraded || result.boost === 2);
  } finally { await cloud.close(); }
  const persisted = new CloudStore(path.join(f.paths.data, "chat-state.sqlite"));
  try { assert.equal(persisted.evaluate("123", "铁砧", epoch, f.c.activity).boost, 2); }
  finally { persisted.close(); }
  const broken = await fixture(t, { random: () => 0.02, cloud: { message: async () => { throw new Error("数据库异常"); }, removeUsers: async () => {}, close: async () => {} } });
  enable(broken.c);
  assert.equal((await broken.activity.observe(event(1))).triggered, true);
  assert.equal(broken.state.logs({ type: "roll" })[0].probabilityBps, 300);
});

test("空闲每窗口只掷一次；未命中后重新等待，静默、忙碌和冷却只跳过不掷骰", async t => {
  const f = await fixture(t, { random: () => 0.9 }); enable(f.c, "idle");
  await f.activity.check(); assert.equal(f.state.logs({ type: "roll" }).length, 0);
  f.setTime(f.state.getGroup("123").windowDue + 1);
  await f.activity.check(); assert.equal(f.state.logs({ type: "roll" }).length, 1);
  const next = f.state.getGroup("123").windowDue; assert.ok(next > f.now());
  await f.activity.check(); assert.equal(f.state.logs({ type: "roll" }).length, 1);
  f.setTime(next + 1); f.activity.delivery("manual", "123"); await f.activity.check();
  assert.equal(f.state.logs({ type: "roll" }).length, 1);
  await f.activity.finished("manual"); f.activity.sent("123"); await f.activity.check();
  assert.equal(f.state.logs({ type: "roll" }).length, 1);
  f.setTime(Date.parse("2026-11-04T17:00:00Z")); await f.activity.check();
  assert.equal(f.state.logs({ type: "roll" }).length, 1);
  assert.equal(quietTime(f.now(), f.c.activity.idle), true);
  f.c.activity.idle.quietStart = "23:00"; f.c.activity.idle.quietEnd = "06:00";
  assert.equal(quietTime(f.now(), f.c.activity.idle), true);
});

test("空闲命中延迟被真人消息取消；纯网址不重置窗口；提交固定非管理员系统来源并占用额度", async t => {
  const f = await fixture(t, { random: () => 0 }); enable(f.c, "idle");
  f.setTime(f.state.getGroup("123").windowDue + 1); await f.activity.check();
  const first = f.state.getGroup("123"); assert.ok(first.pendingId); assert.equal(first.pendingDue - f.now(), 30000);
  await f.activity.observe(event(1, "https://example.com/foo")); assert.equal(f.state.getGroup("123").pendingId, first.pendingId);
  f.advance(1000); await f.activity.observe(event(2, "新的真人消息")); assert.equal(f.state.getGroup("123").pendingId, undefined);
  let submitted;
  f.activity.activate = async activation => {
    submitted = await f.activity.submission(activation.groupId, 0, activation.triggerId);
    f.activity.delivery("idle-run", activation.groupId, activation.triggerId, submitted.submission.batchId);
    submitted.submission.committed();
    await f.activity.finished("idle-run", submitted.submission.batchId, false, activation.triggerId);
  };
  f.setTime(f.state.getGroup("123").windowDue + 1); await f.activity.check();
  f.setTime(f.state.getGroup("123").pendingDue + 1); await f.activity.dispatchDue();
  assert.match(submitted.input, /系统来源，非管理员/); assert.equal(submitted.source, "idle");
  assert.equal(f.state.count("123", "idle", epoch), 1);
  f.advance(15 * 60000 + 1); await f.activity.check();
  assert.equal(f.state.logs({ type: "roll" }).length, 2);
  assert.match(f.state.logs({ type: "skip" })[0].reason, /冷却/);
});

test("重启不重新掷骰或补发已过期窗口，配置关闭取消待发事件且不清除配额", async t => {
  const f = await fixture(t, { random: () => 0 }); enable(f.c, "idle");
  f.setTime(f.state.getGroup("123").windowDue + 1); await f.activity.check();
  const old = f.state.getGroup("123"); assert.ok(old.pendingId);
  await f.activity.recover(async () => false);
  assert.equal(f.state.getGroup("123").pendingId, undefined); assert.equal(f.state.logs({ type: "roll" }).length, 1);
  f.advance(4 * 3600000); await f.activity.recover(async () => false); await f.activity.check();
  assert.equal(f.state.logs({ type: "roll" }).length, 1);
  const id = f.state.trigger("123", "idle", f.now()); f.state.submitTrigger(id, f.now());
  const before = structuredClone(f.c); f.c.activity.idleEnabled = false;
  await f.activity.configure(before, "测试", 3);
  assert.equal(f.state.count("123", "idle", f.now() - 1), 1);
  assert.equal(f.state.logs({ type: "config" })[0].source, "测试");
});

test("AI 忽略名单与其他机器人名单清除待提交背景和词云贡献，reset 保留配额", async t => {
  const removed = [];
  const f = await fixture(t, { cloud: { message: async () => ({ boost: 0, words: [] }), removeUsers: async users => removed.push(...users), close: async () => {} } });
  await f.activity.observe(event(1)); await f.activity.observe(event(2, "另一个用户", "123", "2"));
  const previous = structuredClone(f.c); f.c.modules.chat.blockedUsers = [1]; f.c.activity.botUsers = [3];
  await f.activity.configure(previous, "设置页", 5);
  assert.deepEqual(f.state.messages("123").map(item => item.userId), ["2"]); assert.deepEqual(removed, ["1", "3"]);
  assert.equal((await f.activity.observe(event(3, "机器人", "123", "3"))).ignored, true);
  const id = f.state.trigger("123", "probability", f.now()); f.state.submitTrigger(id, f.now());
  f.activity.reset("123"); assert.equal(f.state.messages("123").length, 0); assert.equal(f.state.count("123", "probability", epoch - 1), 1);
});

test("图片原始状态先提交、按内容哈希与真实扩展名缓存，普通表情保留标识且保护执行中引用", async t => {
  const f = await fixture(t, { images: true }); await f.cache.start();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const input = event(1, "", "123", "1", { mentioned: true, message: [{ type: "face", data: { id: 14 } }, { type: "image", data: { file: "base64://" + png.toString("base64") } }, { type: "mface", data: { url: "base64://" + png.toString("base64") } }] });
  const observed = f.activity.observe(input);
  assert.equal(f.state.allMessages()[0].attachments[0].state, "pending");
  const trigger = await observed, run = await f.activity.submission("123", trigger.seq);
  const item = f.state.messages("123")[0];
  assert.equal(item.attachments[0].path, item.attachments[1].path); assert.match(item.attachments[0].path, /[a-f0-9]{64}\.png$/);
  assert.deepEqual(await readFile(item.attachments[0].path), png); assert.match(run.input, /QQ 表情 14/); assert.doesNotMatch(run.input, /base64|image_url/);
  run.submission.prepared("native", "msg"); run.submission.committed();
  f.advance(8 * 86400000); await f.cache.collect(7); assert.deepEqual(await readFile(item.attachments[0].path), png);
  await f.activity.finished("run", run.submission.batchId); await f.cache.collect(7);
  await assert.rejects(readFile(item.attachments[0].path), { code: "ENOENT" });
});

test("图片下载失败明确占位且日志不记录带凭据的 URL", async t => {
  const f = await fixture(t, { images: true }); await f.cache.start();
  const server = createServer((_req, res) => { res.writeHead(500); res.end(); }); server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const trigger = await f.activity.observe(event(1, "", "123", "1", { mentioned: true, message: [{ type: "image", data: { url: `http://127.0.0.1:${server.address().port}/example?token=secret-token` } }] }));
  const run = await f.activity.submission("123", trigger.seq);
  assert.match(run.input, /图片下载失败/); assert.doesNotMatch(JSON.stringify(f.state.logs()), /secret-token/);
  assert.equal(groupContent("[CQ:face,id=14][CQ:image,file=foo,sub_type=1]", "42").human, false);
});

test("管理员命令按当前群生效，global 限 operators，百分比精度与策略统一校验", async t => {
  const f = await fixture(t); f.c.modules.chat.admins = [1]; f.c.modules.management.operators = [2];
  await assert.rejects(f.activity.command("123", "3", "/synapse probability on"), /权限/);
  await assert.rejects(f.activity.command("123", "1", "/synapse probability on global"), /operators/);
  await f.activity.command("123", "2", "/synapse probability on global");
  await f.activity.command("123", "1", "/synapse probability on");
  await f.activity.command("123", "1", "/synapse probability set base 3.25%");
  assert.equal(f.c.activity.groups[0].probability.baseBps, 325); assert.equal(f.c.activity.probability.baseBps, 300);
  await assert.rejects(f.activity.command("123", "1", "/synapse probability set base 3.251"), /两位/);
  await assert.rejects(f.activity.command("123", "1", "/synapse probability set min 90"), /最低/);
  await f.activity.command("123", "1", "/synapse blockword add 屏蔽词");
  assert.match(await f.activity.command("123", "1", "/synapse blockword status"), /屏蔽词/);
  assert.match(await f.activity.command("123", "1", "/synapse logs config"), /配置|热更新/);
  assert.doesNotMatch(JSON.stringify(f.state.logs()), /httpToken|wsToken|githubToken/);
});

test("原生 session/event 与持久化屏障确认背景，模型执行中即可清批次，HTTP 接收不清理", async t => {
  const f = await fixture(t);
  let release; const held = new Promise(resolve => { release = resolve; }); let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const host = hostFixture(async () => { entered(); await held; return "完成"; });
  const agent = new Agent({ loader: host.loader, config: () => f.c, paths: f.paths, memory: {}, skills: { retrieve: async () => [] }, mcp: { available: async () => [] } });
  t.after(() => agent.close());
  await f.activity.observe(event(1, "背景"));
  const trigger = await f.activity.observe(event(2, "触发", "123", "2", { mentioned: true }));
  const input = await f.activity.submission("123", trigger.seq);
  assert.equal(f.state.messages("123").length, 2);
  const task = agent.run(input.input, "chat", [], undefined, () => {}, "", undefined, "chat:group:123", { submission: input.submission });
  await started;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.messages("123").length, 0);
  release(); await task;
  const batch = f.state.batch(input.submission.batchId);
  assert.equal(await agent.harness.hasInput(batch.sessionId, batch.messageId, batch.id), true);
});

test("词云等待期间热更新忽略名单或关闭策略，不恢复旧判定或重新污染词频", async t => {
  let release, calls = 0;
  const hold = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { random: () => 0, cloud: { message: async () => { calls++; await hold; return { boost: 2, words: ["铁砧"] }; }, removeUsers: async () => {}, close: async () => {} } });
  enable(f.c);
  const first = f.activity.observe(event(1)), second = f.activity.observe(event(2));
  await new Promise(resolve => setImmediate(resolve));
  const previous = structuredClone(f.c); f.c.modules.chat.blockedUsers = [1];
  await f.activity.configure(previous, "热更新", 1); release();
  assert.equal((await first).ignored, true); assert.equal((await second).ignored, true);
  assert.equal(calls, 1); assert.equal(f.state.busy("123"), false); assert.equal(f.state.allMessages().length, 0);
});

test("提交前失败和显式放弃释放观察预留；已领取的批次不会被 HTTP 失败重复回滚", async t => {
  const f = await fixture(t, { random: () => 0 }); enable(f.c);
  const first = await f.activity.observe(event(1)); assert.equal(f.state.busy("123"), true);
  f.activity.abandon(first.seq, "HTTP 提交失败"); assert.equal(f.state.busy("123"), false);
  const second = await f.activity.observe(event(2));
  const run = await f.activity.submission("123", second.seq, second.triggerId);
  f.activity.delivery("run", "123", second.triggerId, run.submission.batchId);
  f.activity.abandon(second.seq, "HTTP 应答丢失"); assert.equal(f.state.busy("123"), true);
  run.submission.committed(); await f.activity.finished("run", run.submission.batchId, true, second.triggerId);
  assert.equal(f.state.busy("123"), false); assert.equal(f.state.messages("123").length, 0);
});

test("空闲等待图片后重新检查静默、冷却和忙碌，失败保留背景且不占额度", async t => {
  let release; const hold = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { random: () => 0 });
  const original = f.cache.process;
  f.cache.process = async seq => { await original(seq); await hold; };
  enable(f.c, "idle"); await f.activity.observe(event(1));
  f.setTime(f.state.getGroup("123").windowDue + 1); await f.activity.check();
  const group = f.state.getGroup("123"); f.setTime(group.pendingDue + 1);
  const submission = f.activity.submission("123", 0, group.pendingId);
  f.activity.sent("123"); release();
  await assert.rejects(submission, /冷却/);
  assert.equal(f.state.count("123", "idle", 0), 0);
  assert.equal(f.state.messages("123").length, 1);
});

test("空闲小时额度采用滚动窗口，每日额度按上海自然日跨午夜恢复", async t => {
  const f = await fixture(t, { random: () => 0 }); enable(f.c, "idle");
  Object.assign(f.c.activity.idle, { cooldownSec: 0, perHour: 10, perDay: 1, quietStart: "00:00", quietEnd: "00:00" });
  f.setTime(Date.parse("2026-11-04T15:59:00Z"));
  const earlier = f.state.trigger("123", "idle", f.now()); f.state.submitTrigger(earlier, f.now());
  const group = f.state.getGroup("123"); group.windowDue = f.now() - 1; f.state.saveGroup(group);
  await f.activity.check(); assert.equal(f.state.logs({ type: "roll" }).length, 0); assert.match(f.state.logs({ type: "skip" })[0].reason, /每日/);
  f.advance(120000); await f.activity.check(); assert.equal(f.state.logs({ type: "roll" }).length, 1);
  f.setTime(f.state.getGroup("123").pendingDue + 1);
  const triggerId = f.state.getGroup("123").pendingId;
  const run = await f.activity.submission("123", 0, triggerId); run.submission.committed();
  await f.activity.finished("idle-run", run.submission.batchId, false, triggerId);
  assert.equal(f.activity.status().find(item => item.groupId === "123").idleDay, 1);
  f.c.activity.idle.perDay = 10; f.c.activity.idle.perHour = 2;
  const next = f.state.getGroup("123"); delete next.pendingId; delete next.pendingDue; next.windowDue = f.now() - 1; f.state.saveGroup(next);
  await f.activity.check(); assert.match(f.state.logs({ type: "skip" })[0].reason, /小时/);
  f.advance(3600001); await f.activity.check(); assert.equal(f.state.logs({ type: "roll" }).length, 2);
});

test("真实工作线程写锁超过 100ms 时返回基础加成，原始统计任务仍可恢复完成", async t => {
  const f = await fixture(t); const cloud = new AsyncWordCloud(path.join(f.paths.data, "chat-state.sqlite"));
  try {
    await cloud.recover(epoch);
    f.state.db.exec("BEGIN IMMEDIATE");
    try {
      const start = performance.now();
      const result = await cloud.message("123", "slow-1", "1", "铁砧", epoch, epoch, f.c.activity);
      assert.equal(result.degraded, true); assert.equal(result.boost, 0); assert.ok(performance.now() - start < 500);
    } finally { f.state.db.exec("ROLLBACK"); }
    await cloud.recover(epoch);
  } finally { await cloud.close(); }
});

test("引用与聊天记录中的图片异步展开并使用本地路径，词频只保存当前作者原文", async t => {
  const f = await fixture(t, { images: true }); await f.cache.start();
  const png = "base64://iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const actions = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const part of req) { body += part; }
    assert.deepEqual(JSON.parse(body), req.url === "/get_msg" ? { message_id: 2 } : { message_id: "3" });
    actions.push(req.url); res.setHeader("Content-Type", "application/json");
    const original = { sender: { user_id: 5, nickname: "引用作者" }, message: [{ type: "text", data: { text: "引用正文" } }, { type: "image", data: { file: png } }] };
    res.end(JSON.stringify({ retcode: 0, data: req.url === "/get_msg" ? original : { messages: [original] } }));
  }); server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve))); f.c.httpUrl = `http://127.0.0.1:${server.address().port}`;
  const trigger = await f.activity.observe(event(1, "", "123", "1", { mentioned: true, message: [{ type: "text", data: { text: "本条发言" } }, { type: "reply", data: { id: 2 } }, { type: "forward", data: { id: 3 } }] }));
  const run = await f.activity.submission("123", trigger.seq);
  assert.match(run.input, /本条发言/); assert.match(run.input, /引用正文/); assert.match(run.input, /[a-f0-9]{64}\.png/);
  assert.deepEqual(actions.sort(), ["/get_forward_msg", "/get_msg"]);
  assert.equal(f.state.message(trigger.seq).rawText, "本条发言");
});

test("原始判定暂存与未领取的触发在重启时恢复为最多 100 条背景，关闭先取消图片请求", async t => {
  let release; const hold = new Promise(resolve => { release = resolve; });
  const f = await fixture(t);
  for (let id = 1; id <= 105; id++) { f.state.append(event(id), "文字", "文字", [], epoch); }
  assert.equal(f.state.messages("123").length, 100);
  const last = f.state.append(event(106), "触发", "触发", [], epoch, undefined, true);
  f.state.finishObservation(last.seq, true);
  f.state.recoverDeliveries(epoch); assert.equal(f.state.messages("123").length, 100); assert.ok(f.state.messages("123").every(item => !item.foreground));
  f.cache.process = async () => hold; f.cache.close = async () => { release(); };
  await f.activity.observe(event(107));
  await f.activity.close();
});

test("网关放弃提交可取消图片准备，接收成功但应答丢失时按原生提交状态收尾", async t => {
  const f = await fixture(t);
  let releaseImages, entered;
  const heldImages = new Promise(resolve => { releaseImages = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const host = hostFixture(async ({ signal }) => {
    entered();
    await new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
    return "不会发出的回复";
  });
  const agent = new Agent({ loader: host.loader, config: () => f.c, paths: f.paths, memory: {}, skills: { retrieve: async () => [] }, mcp: { available: async () => [] } });
  await f.activity.recover((...args) => agent.harness.hasInput(...args));
  const gateway = new Gateway(agent, () => f.c, () => {}, f.activity); await gateway.start();
  t.after(async () => { releaseImages(); await gateway.close(); await agent.close(); });
  const post = (action, data) => fetch(gateway.url + action, { method: "POST", headers: { Authorization: `Bearer ${gateway.token}`, "Content-Type": "application/json" }, body: JSON.stringify(data) });
  const wait = async predicate => {
    const end = Date.now() + 5000;
    while (!predicate()) { assert.ok(Date.now() < end); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  f.cache.process = async () => heldImages;
  const first = await f.activity.observe(event(1, "准备期间取消", "123", "1", { mentioned: true }));
  const preparing = post("/v1/runs", { session_id: "group_123", context: { type: "group", groupId: "123", userId: "1", observationId: first.seq }, input: "由宿主展开" });
  await wait(() => Boolean(f.state.message(first.seq)?.batchId));
  assert.equal((await post("/v1/activity/abandon", { observationId: first.seq })).status, 200);
  assert.ok((await preparing).status >= 400); assert.equal(f.state.busy("123"), false);
  assert.equal(f.state.messages("123")[0].batchId, null);
  releaseImages(); f.cache.process = async () => {};
  const second = await f.activity.observe(event(2, "原生输入已保存", "123", "1", { mentioned: true }));
  const accepted = await post("/v1/runs", { session_id: "group_123", context: { type: "group", groupId: "123", userId: "1", observationId: second.seq }, input: "由宿主展开" });
  assert.equal(accepted.status, 202); await started; await wait(() => f.state.messages("123").length === 0);
  assert.equal((await post("/v1/activity/abandon", { observationId: second.seq })).status, 200);
  await wait(() => !f.activity.status()[0].busy);
  assert.equal(f.state.messages("123").length, 0);
  f.c.modules.chat.blockedUsers = [1];
  assert.equal((await post("/v1/runs", { session_id: "user_1", context: { type: "user", userId: "1" }, input: "不应进入模型" })).status, 403);
});

test("白名单非空时 operator 仍可正常触发，普通未授权用户保持原规则", async t => {
  const f = await fixture(t); f.c.modules.chat.allowedUsers = [8]; f.c.modules.management.operators = [9];
  assert.equal((await f.activity.observe(event(1, "普通用户", "123", "1", { mentioned: true }))).triggered, false);
  assert.equal((await f.activity.observe(event(2, "operator 消息", "123", "9", { mentioned: true }))).triggered, true);
});

test("消息与真人窗口、自动额度与冷却各自原子提交，SQLite 错误不会保存半组状态", async t => {
  const f = await fixture(t, { random: () => 0 });
  f.state.db.exec("CREATE TRIGGER fail_group_update BEFORE UPDATE ON groups BEGIN SELECT RAISE(ABORT,'模拟磁盘写入失败'); END");
  assert.throws(() => f.activity.observe(event(1)), /模拟磁盘/);
  assert.equal(f.state.allMessages().length, 0); assert.equal(f.state.getGroup("123").lastHumanAt, 0);
  f.state.db.exec("DROP TRIGGER fail_group_update");
  enable(f.c); const observed = await f.activity.observe(event(1)); assert.equal(observed.triggered, true);
  f.state.db.exec("CREATE TRIGGER fail_group_update BEFORE UPDATE ON groups BEGIN SELECT RAISE(ABORT,'模拟磁盘写入失败'); END");
  await assert.rejects(f.activity.submission("123", observed.seq, observed.triggerId), /模拟磁盘/);
  assert.equal(f.state.count("123", "probability", 0), 0); assert.equal(f.state.getGroup("123").lastAutoAt, 0); assert.equal(f.state.busy("123"), false);
  f.state.db.exec("DROP TRIGGER fail_group_update");
});

test("收尾首次写入失败后允许重试，并发通知只完成一次状态转换", async t => {
  const f = await fixture(t); let calls = 0, release;
  const held = new Promise(resolve => { release = resolve; });
  const integration = {
    submission: (...args) => f.activity.submission(...args), delivery: (...args) => f.activity.delivery(...args), state: f.state,
    finished: async (...args) => { calls++; if (calls === 1) { throw new Error("SQLITE_BUSY"); } await held; await f.activity.finished(...args); },
  };
  const gateway = new Gateway({ run: async () => "完成", reset: async () => {} }, () => f.c, () => {}, integration); await gateway.start();
  t.after(async () => { release(); await gateway.close(); });
  const post = (action, data) => fetch(gateway.url + action, { method: "POST", headers: { Authorization: `Bearer ${gateway.token}`, "Content-Type": "application/json" }, body: JSON.stringify(data) });
  const observed = await f.activity.observe(event(1, "触发", "123", "1", { mentioned: true }));
  const accepted = await post("/v1/runs", { session_id: "group_123", context: { type: "group", groupId: "123", userId: "1", observationId: observed.seq }, input: "由宿主展开" });
  const { run_id: runId } = await accepted.json();
  assert.equal((await post("/v1/activity/finished", { runId })).status, 500); assert.equal(f.state.busy("123"), true);
  const first = post("/v1/activity/finished", { runId }), second = post("/v1/activity/finished", { runId });
  const deadline = Date.now() + 5000;
  while (calls < 2) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10)); }
  release(); assert.equal((await first).status, 200); assert.equal((await second).status, 200);
  assert.equal(calls, 2); assert.equal(f.state.busy("123"), false);
  assert.equal(f.state.messages("123")[0].batchId, null);
});

test("事件流提前结束会取消原生任务，等待实际清理完成后才释放图片引用和群投递", async t => {
  const f = await fixture(t, { images: true }); f.c.timeoutSec = -1;
  let release, entered, cancelled = false, cleaned = false;
  const held = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const host = hostFixture(async ({ signal }) => {
    entered();
    await new Promise(resolve => { signal.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true }); });
    await held; cleaned = true; signal.throwIfAborted();
    return "不会发送的回复";
  });
  const agent = new Agent({ loader: host.loader, config: () => f.c, paths: f.paths, memory: {}, skills: { retrieve: async () => [] }, mcp: { available: async () => [] } });
  await f.activity.recover((...args) => agent.harness.hasInput(...args));
  const gateway = new Gateway(agent, () => f.c, () => {}, f.activity); await gateway.start();
  t.after(async () => { release(); await gateway.close(); await agent.close(); });
  const post = (action, data) => fetch(gateway.url + action, { method: "POST", headers: { Authorization: `Bearer ${gateway.token}`, "Content-Type": "application/json" }, body: JSON.stringify(data) });
  const wait = async predicate => {
    const deadline = Date.now() + 5000;
    while (!predicate()) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  const observed = await f.activity.observe(event(1, "", "123", "1", { mentioned: true, message: [{ type: "image", data: { file: "base64://iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" } }] }));
  const response = await post("/v1/runs", { session_id: "group_123", context: { type: "group", groupId: "123", userId: "1", observationId: observed.seq }, input: "宿主读取图片路径" });
  const { run_id: runId } = await response.json(); await started; await wait(() => f.state.messages("123").length === 0);
  const finishing = post("/v1/activity/finished", { runId, failed: false });
  await wait(() => cancelled);
  assert.equal(cleaned, false); assert.equal(f.state.busy("123"), true); assert.equal(f.state.expiredImages(f.now() + 8 * 86400000).length, 0);
  release(); assert.equal((await finishing).status, 200);
  assert.equal(cleaned, true); assert.equal(f.state.busy("123"), false); assert.equal(f.state.expiredImages(f.now() + 8 * 86400000).length, 1);
});
