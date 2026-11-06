import test from "node:test";
import assert from "node:assert/strict";
import { QQSendQueue } from "../lib/host/qq-send-queue.js";

const text = value => [{ type: "text", data: { text: value } }];
const plain = message => message.filter(segment => segment.type === "text").map(segment => segment.data.text).join("");
const waitFor = async predicate => {
  const until = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= until) {
      throw new Error("等待发送队列状态超时");
    }
    await new Promise(resolve => setTimeout(resolve, 2));
  }
};
function fixture(t, request, identity = () => ({ user_id: 42, nickname: "bot" }), canSendGroup, groupSignal) {
  const requests = [], sent = [], errors = [];
  const limits = { compactMaxChars: 300, compactMaxLines: 5, maxMessageLength: 1200, botName: "测试机器人" };
  const queue = new QQSendQueue({
    request: async (action, payload, signal) => {
      requests.push({ action, payload, at: Date.now() });
      return request ? request(action, payload, signal) : requests.length;
    },
    limits: () => limits,
    identity,
    canSendGroup,
    groupSignal,
    sent: event => sent.push(event),
    onError: error => errors.push(error),
  }, 10);
  t.after(() => queue.close());
  return { queue, requests, sent, errors, limits };
}

test("禁言查询期间私聊继续发送，命中禁言丢弃整群批次且不占用发送间隔", async t => {
  let release, allowed;
  const check = new Promise(resolve => { release = resolve; });
  const f = fixture(t, undefined, undefined, id => id === "123" ? allowed ?? check : true);
  const first = f.queue.send("group", 123, text("待发一"));
  const second = f.queue.send("group", 123, text("待发二"));
  await f.queue.send("private", 123, text("同号私聊"));
  allowed = false; release(false);
  assert.deepEqual(await Promise.all([first, second]), [undefined, undefined]);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].action, "send_private_msg");
  allowed = true;
  assert.equal(await f.queue.send("group", 123, text("解禁后的新消息")), 2);
  assert.equal(plain(f.requests[1].payload.message), "解禁后的新消息");
});

test("禁言取消正在发送及等待的消息，旧回执不发送通知也不删除解禁后的新队列", async t => {
  let finishOld, oldSignal;
  const held = new Promise(resolve => { finishOld = resolve; });
  const f = fixture(t, async (_action, payload, signal) => {
    if (plain(payload.message) === "旧回复") { oldSignal = signal; await held; }
    return 77;
  });
  const old = f.queue.send("group", 123, text("旧回复"));
  await waitFor(() => oldSignal);
  const queued = f.queue.send("group", 123, text("旧积压"));
  f.queue.discardGroup("123");
  assert.deepEqual(await Promise.all([old, queued]), [undefined, undefined]);
  assert.equal(oldSignal.aborted, true);
  const fresh = f.queue.send("group", 123, text("新回复"));
  finishOld();
  assert.equal(await fresh, 77);
  assert.deepEqual(f.sent.map(item => plain(item.message)), ["新回复"]);
  assert.equal(f.requests.length, 2);
});

test("查询失败结束当前群等待，下一条重查且其他群继续发送", async t => {
  let fail = true;
  const f = fixture(t, undefined, undefined, id => id === "123" && fail ? Promise.reject(new Error("断线")) : true);
  const blocked = f.queue.send("group", 123, text("检查失败"));
  assert.equal(await blocked, undefined);
  fail = false;
  await Promise.all([f.queue.send("group", 123, text("重查")), f.queue.send("group", 456, text("其他群"))]);
  assert.equal(f.errors.length, 1);
  assert.equal(f.requests.length, 2);
});

test("延迟确认禁言只丢弃旧代，等待同次查询的解禁后新消息仍可发送", async t => {
  let release, entered = false, allowed;
  const held = new Promise(resolve => { release = resolve; });
  const old = new AbortController(); let current = old;
  const f = fixture(t, undefined, undefined, () => { entered = true; return allowed ?? held; }, () => current.signal);
  const first = f.queue.send("group", 123, text("禁言前的旧消息"));
  await waitFor(() => entered);
  current = new AbortController();
  const fresh = f.queue.send("group", 123, text("解禁后的新消息"));
  old.abort(); f.queue.discardAbortedGroup("123");
  assert.equal(await first, undefined);
  allowed = true; release(true);
  assert.equal(await fresh, 1);
  assert.equal(plain(f.requests[0].payload.message), "解禁后的新消息");
});

test("同一会话待发文字合并，群聊和同号私聊相互独立且共享间隔", async t => {
  const f = fixture(t);
  const original = text("第一条");
  const first = f.queue.send("group", 123, original);
  const second = f.queue.send("group", "123", text("第二条"));
  const third = f.queue.send("private", 123, text("私聊"));
  original[0].data.text = "后续修改不影响队列";
  assert.deepEqual(await Promise.all([first, second, third]), [1, 1, 2]);
  assert.equal(f.requests.length, 2);
  assert.equal(plain(f.requests[0].payload.message), "第一条\n第二条");
  assert.equal(f.requests[1].action, "send_private_msg");
  assert(f.requests[1].at - f.requests[0].at >= 10);
  assert.equal(f.sent.length, 1);
});

test("语音排队期间取消不会发送，执行中取消会中止 OneBot 请求，后续文字仍可发送", async t => {
  const controller = new AbortController();
  const f = fixture(t);
  const record = [{ type: "record", data: { file: "base64://example" } }];
  const first = f.queue.send("group", 123, text("前一条"));
  const cancelled = f.queue.send("group", 123, record, { signal: controller.signal });
  const following = f.queue.send("group", 123, text("后一条"));
  controller.abort();
  assert.deepEqual(await Promise.all([first, cancelled, following]), [1, undefined, 2]);
  assert(f.requests.every(item => item.payload.message.every(segment => segment.type !== "record")));
  const running = new AbortController(); let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const active = fixture(t, async (_action, _payload, signal) => {
    entered(); await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    signal.throwIfAborted();
  });
  const pending = active.queue.send("private", 1, record, { signal: running.signal });
  await ready; running.abort();
  assert.equal(await pending, undefined);
  assert.equal(active.sent.length, 0);
});

test("同代回复的取消信号允许合并，不同信号的消息独立取消", async t => {
  const f = fixture(t), group = new AbortController(), other = new AbortController();
  const first = f.queue.send("group", 123, text("第一句"), { signal: group.signal });
  const second = f.queue.send("group", 123, text("第二句"), { signal: group.signal });
  const cancelled = f.queue.send("group", 123, text("独立取消"), { signal: other.signal });
  other.abort();
  assert.deepEqual(await Promise.all([first, second, cancelled]), [1, 1, undefined]);
  assert.equal(f.requests.length, 1);
  assert.equal(plain(f.requests[0].payload.message), "第一句\n第二句");
});

for (const operation of [false, true]) {
  test(`${operation ? "共享操作" : "消息请求"}同步启动耗时不缩短后续发送间隔`, async t => {
    let now = 1000;
    const started = [];
    t.mock.method(Date, "now", () => now);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const record = () => {
      if (!started.length) { now += 5; }
      started.push(now);
      return started.length;
    };
    const queue = new QQSendQueue({
      request: async () => record(),
      limits: () => ({ compactMaxChars: 0, compactMaxLines: 0, maxMessageLength: 0, botName: "bot" }),
      identity: () => ({ user_id: 42 }),
      sent: () => undefined,
      onError: error => assert.fail(error),
    }, 10);
    t.after(() => queue.close());
    const pending = [];
    if (operation) { queue.operation(() => { record(); }); }
    else { pending.push(queue.send("group", 1, text("第一条"))); }
    pending.push(queue.send("group", 2, text("第二条")));
    t.mock.timers.tick(0);
    assert.equal(started.length, 1);
    now += 5;
    t.mock.timers.tick(5);
    assert.equal(started.length, 1);
    now += 5;
    t.mock.timers.tick(5);
    await Promise.all(pending);
    assert.equal(started.length, 2);
    assert(started[1] - started[0] >= 10);
  });
}

test("会话轮流发送，同会话不同引用和不可合并回执保留顺序", async t => {
  const f = fixture(t);
  const jobs = [
    f.queue.send("group", 1, [{ type: "reply", data: { id: 1 } }, ...text("A1")]),
    f.queue.send("group", 1, [{ type: "reply", data: { id: 2 } }, ...text("A2")]),
    f.queue.send("group", 1, text("A3"), { merge: false }),
    f.queue.send("group", 2, text("B")),
    f.queue.send("private", 1, text("C")),
  ];
  await Promise.all(jobs);
  assert.deepEqual(f.requests.map(item => plain(item.payload.message)), ["A1", "B", "C", "A2", "A3"]);
  assert.deepEqual(f.requests.filter(item => item.payload.group_id === 1).map(item => item.payload.message.find(segment => segment.type === "reply")?.data.id), [1, 2, undefined]);
});

test("某会话等待回执时其他会话仍可发送，当前会话保持串行", async t => {
  let finish;
  const blocked = new Promise(resolve => { finish = resolve; });
  const f = fixture(t, async (_action, payload) => {
    if (plain(payload.message) === "A1") {
      await blocked;
    }
    return 77;
  });
  const first = f.queue.send("group", 1, text("A1"));
  await waitFor(() => f.requests.length === 1);
  const next = f.queue.send("group", 1, text("A2"));
  const other = f.queue.send("group", 2, text("B"));
  await other;
  assert.deepEqual(f.requests.map(item => plain(item.payload.message)), ["A1", "B"]);
  finish();
  await Promise.all([first, next]);
  assert.deepEqual(f.requests.map(item => plain(item.payload.message)), ["A1", "B", "A2"]);
});

for (const type of ["group", "private"]) {
  test(`${type} 合并后才按字符和行数阈值转聊天记录，保留节点顺序和图片`, async t => {
    const f = fixture(t);
    f.limits.compactMaxChars = 8;
    const first = f.queue.send(type, 123, [{ type: "reply", data: { id: 9 } }, ...text("第一段文字")]);
    const second = f.queue.send(type, 123, [...text("第二段文字"), { type: "image", data: { file: "base64://YWJj" } }]);
    await Promise.all([first, second]);
    const item = f.requests[0];
    assert.equal(item.action, `send_${type}_forward_msg`);
    assert.deepEqual(item.payload.messages.map(node => plain(node.data.content)), ["第一段文字", "第二段文字"]);
    assert(item.payload.messages.every(node => node.data.uin === "42" && node.data.name === "测试机器人"));
    assert(!item.payload.messages[0].data.content.some(segment => segment.type === "reply"));
    assert.equal(item.payload.messages[1].data.content[1].type, "image");
    if (type === "group") {
      assert.equal(f.sent[0].message.find(segment => segment.type === "reply").data.id, 9);
      assert.equal(f.sent[0].message.find(segment => segment.type === "image").data.file, "base64://YWJj");
      assert.equal(plain(f.sent[0].message), "第一段文字\n第二段文字");
    }
    f.limits.compactMaxChars = 0;
    f.limits.compactMaxLines = 1;
    await Promise.all([f.queue.send(type, 123, text("甲")), f.queue.send(type, 123, text("乙"))]);
    assert.equal(f.requests[1].action, `send_${type}_forward_msg`);
  });
}

test("沿用实时阈值，关闭软阈值后仍遵循单条最大字符数", async t => {
  const f = fixture(t);
  f.limits.compactMaxChars = 1;
  const pending = f.queue.send("group", 1, text("普通消息"));
  f.limits.compactMaxChars = 0;
  f.limits.compactMaxLines = 0;
  await pending;
  assert.equal(f.requests[0].action, "send_group_msg");
  f.limits.maxMessageLength = 2;
  await f.queue.send("group", 1, text("超长消息"));
  assert.equal(f.requests[1].action, "send_group_forward_msg");
});

test("桥接及Webhook来源不混合，语音等独立消息保持独立", async t => {
  const f = fixture(t);
  await Promise.all([
    f.queue.send("group", 1, text("桥接"), { fromBridge: true }),
    f.queue.send("group", 1, text("通知"), { fromWebhook: true }),
    f.queue.send("group", 1, text("回复")),
    f.queue.send("group", 1, [{ type: "record", data: { file: "voice" } }]),
    f.queue.send("group", 1, text("之后")),
  ]);
  assert.equal(f.requests.length, 5);
  assert.deepEqual(f.sent.map(item => [item.fromBridge, item.fromWebhook]), [[true, false], [false, true], [false, false], [false, false], [false, false]]);
});

test("已有转发节点与后续文字可合并，节点署名和内容保持原样", async t => {
  const f = fixture(t);
  const node = { type: "node", data: { name: "原作者", uin: "99", content: text("原节点") } };
  await Promise.all([f.queue.send("group", 1, [node]), f.queue.send("group", 1, text("补充"))]);
  assert.deepEqual(f.requests[0].payload.messages[0], node);
  assert.equal(plain(f.requests[0].payload.messages[1].data.content), "补充");
  assert.equal(plain(f.sent[0].message), "原节点\n补充");
});

test("桥接消息保留独立QQ消息ID，引用映射不会被合并覆盖", async t => {
  const f = fixture(t);
  const ids = await Promise.all([
    f.queue.send("group", 1, text("频道甲"), { fromBridge: true }),
    f.queue.send("group", 1, text("频道乙"), { fromBridge: true }),
  ]);
  assert.deepEqual(ids, [1, 2]);
  assert.deepEqual(f.requests.map(item => plain(item.payload.message)), ["频道甲", "频道乙"]);
});

test("异步获取身份后仍按实际请求时间限速，等待期间可继续合并且其他会话先发送", async t => {
  let resolveIdentity, preparing = false;
  const identity = new Promise(resolve => { resolveIdentity = resolve; });
  const f = fixture(t, async (_action, payload) => {
    if (payload.user_id === 2) {
      resolveIdentity({ user_id: 42 });
    }
    return 77;
  }, () => { preparing = true; return identity; });
  f.limits.compactMaxChars = 1;
  const first = f.queue.send("group", 1, text("第一段"));
  await waitFor(() => preparing);
  const second = f.queue.send("group", 1, text("第二段"));
  const other = f.queue.send("private", 2, text("短"));
  await Promise.all([first, second, other]);
  assert.equal(f.requests[0].action, "send_private_msg");
  assert.equal(f.requests[1].action, "send_group_forward_msg");
  assert(f.requests[1].at - f.requests[0].at >= 10);
  assert.equal(f.requests[1].payload.messages.length, 2);
});

test("身份无效时结束当前批次，其他会话继续发送", async t => {
  const f = fixture(t, undefined, () => undefined);
  f.limits.compactMaxChars = 1;
  assert.deepEqual(await Promise.all([
    f.queue.send("group", 1, text("长消息")),
    f.queue.send("private", 2, text("短")),
  ]), [undefined, 1]);
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0].message, /身份/);
});

test("发送失败会结束合并调用且不阻塞后续会话，共用操作也受全局节奏限制", async t => {
  let fail = true;
  const f = fixture(t, async () => {
    if (fail) {
      fail = false;
      throw new Error("协议端错误");
    }
    return 88;
  });
  let operationAt;
  const first = f.queue.send("group", 1, text("甲"));
  const second = f.queue.send("group", 1, text("乙"));
  f.queue.operation(() => { operationAt = Date.now(); });
  const next = f.queue.send("group", 2, text("丙"));
  assert.deepEqual(await Promise.all([first, second, next]), [undefined, undefined, 88]);
  assert.equal(f.errors.length, 1);
  assert(operationAt - f.requests[0].at >= 10);
  assert(f.requests[1].at - operationAt >= 10);
});

test("关闭会取消执行中的请求并结束全部等待，不再发送消息或触发桥接通知", async t => {
  let activeSignal;
  const f = fixture(t, async (_action, _payload, signal) => {
    activeSignal = signal;
    await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    signal.throwIfAborted();
  });
  const first = f.queue.send("group", 1, text("执行中"));
  await waitFor(() => f.requests.length === 1);
  const queued = f.queue.send("group", 2, text("排队中"));
  f.queue.close();
  assert.deepEqual(await Promise.all([first, queued]), [undefined, undefined]);
  assert(activeSignal.aborted);
  assert.equal(await f.queue.send("group", 3, text("关闭后")), undefined);
  assert.equal(f.requests.length, 1);
  assert.equal(f.sent.length, 0);
});
