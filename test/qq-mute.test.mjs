import test from "node:test";
import assert from "node:assert/strict";
import { QQMute } from "../lib/host/qq-mute.js";

function fixture(t) {
  let now = 1000000;
  const requests = [], changes = [], cancellations = [];
  const member = { role: "member", shut_up_timestamp: 0 };
  const group = { group_all_shut: 0 };
  let respond = async action => structuredClone(action === "get_group_member_info" ? member : group);
  const mute = new QQMute({
    identity: async () => ({ user_id: 42 }),
    request: async (action, params, signal) => {
      requests.push({ action, params, signal });
      return respond(action, params, signal);
    },
    changed: (id, blocked) => changes.push({ id, blocked }),
    cancel: (id, throughGeneration) => cancellations.push({ id, throughGeneration }),
    now: () => now,
  });
  t.after(() => mute.close());
  const notice = (user_id, sub_type, duration = 0, extra = {}) => mute.notice({
    post_type: "notice", notice_type: "group_ban", self_id: 42, group_id: 123,
    user_id, sub_type, duration, time: now / 1000, ...extra,
  });
  return { mute, requests, changes, cancellations, member, group, notice, advance: ms => { now += ms; }, respond: fn => { respond = fn; } };
}

test("首次检查合并并发查询，后续发送复用群级禁言时间缓存", async t => {
  const f = fixture(t);
  assert.deepEqual(await Promise.all([f.mute.canSend("123"), f.mute.canSend("123")]), [true, true]);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].params.user_id, 42);
  assert.equal(f.requests[0].params.no_cache, true);
  assert.equal(f.mute.canSend("123"), true);
  await f.mute.canSend("456");
  assert.equal(f.requests.length, 4);
  assert.equal(f.mute.canSend("123"), true);
});

test("自身禁言与解禁事件更新截止时间，旧回复取消，正常到期无需再次查询", async t => {
  const f = fixture(t);
  await f.mute.canSend("123");
  const old = f.mute.replySignal("123");
  await f.notice(42, "ban", 60);
  assert.equal(f.mute.canSend("123"), false);
  assert.equal(old.aborted, true);
  assert.equal(f.requests.length, 2);
  f.advance(60000);
  assert.equal(f.mute.canSend("123"), true);
  assert.equal(f.mute.replySignal("123").aborted, false);
  assert.equal(old.aborted, true);
  await f.notice(42, "ban", 100);
  await f.notice(42, "lift_ban");
  assert.equal(f.mute.canSend("123"), true);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.changes.map(item => item.blocked), [true, false, true, false]);
});

test("查询到的禁言时间进入缓存，其他成员事件不改变 Bot 状态", async t => {
  const f = fixture(t);
  f.member.shut_up_timestamp = 1010;
  assert.equal(await f.mute.canSend("123"), false);
  await f.notice(7, "lift_ban");
  await f.notice(7, "ban", 999);
  assert.equal(f.mute.canSend("123"), false);
  f.advance(10001);
  assert.equal(f.mute.canSend("123"), true);
  assert.equal(f.requests.length, 2);
});

test("全员禁言区分普通成员与管理员，单独解禁不覆盖全员禁言", async t => {
  const f = fixture(t);
  await f.mute.canSend("123");
  await f.notice(0, "ban", -1);
  assert.equal(f.mute.canSend("123"), false);
  await f.notice(42, "lift_ban");
  assert.equal(f.mute.canSend("123"), false);
  await f.mute.notice({ post_type: "notice", notice_type: "group_admin", self_id: 42, group_id: 123, user_id: 42, sub_type: "set" });
  assert.equal(f.mute.canSend("123"), true);
  await f.mute.notice({ post_type: "notice", notice_type: "group_admin", self_id: 42, group_id: 123, user_id: 42, sub_type: "unset" });
  assert.equal(f.mute.canSend("123"), false);
  await f.notice(0, "lift_ban");
  assert.equal(f.mute.canSend("123"), true);
  assert.equal(f.requests.length, 2);
});

test("冷启动先收到全员禁言事件时查询角色，群主继续发送", async t => {
  const f = fixture(t);
  f.member.role = "owner";
  await f.notice(0, "ban", -1);
  assert.equal(await f.mute.canSend("123"), true);
  assert.equal(f.changes.some(item => item.blocked), false);
});

test("查询期间的新禁言事件优先于旧回执，断线清缓存且旧查询无法重新填充", async t => {
  const f = fixture(t);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  f.respond(async action => {
    await held;
    return action === "get_group_member_info" ? { role: "member", shut_up_timestamp: 0 } : { group_all_shut: 0 };
  });
  const first = f.mute.canSend("123");
  await new Promise(resolve => setImmediate(resolve));
  await f.notice(42, "ban", 100);
  release();
  assert.equal(await first, false);
  assert.equal(f.mute.canSend("123"), false);
  let releaseSecond;
  const heldSecond = new Promise(resolve => { releaseSecond = resolve; });
  f.respond(async action => { await heldSecond; return action === "get_group_member_info" ? f.member : f.group; });
  const stale = f.mute.canSend("456");
  const rejected = assert.rejects(stale, /连接|缓存/);
  await new Promise(resolve => setImmediate(resolve));
  f.mute.clear();
  releaseSecond();
  await rejected;
  f.member.shut_up_timestamp = 1020;
  assert.equal(await f.mute.canSend("123"), false);
  assert.equal(f.requests.length, 6);
});

test("查询失败不会缓存为可发送，下一条消息重新查询", async t => {
  const f = fixture(t);
  f.respond(async () => { throw new Error("查询失败"); });
  await assert.rejects(f.mute.canSend("123"), /查询失败/);
  f.respond(async action => action === "get_group_member_info" ? f.member : f.group);
  assert.equal(await f.mute.canSend("123"), true);
  assert.equal(f.requests.length, 4);
});

for (const clear of [false, true]) {
  for (const role of ["member", "owner"]) {
    test(`角色查询期间全员禁言后快速解禁保留新代消息（清缓存=${clear}，角色=${role}）`, async t => {
      const f = fixture(t);
      if (clear) { await f.mute.canSend("123"); f.mute.clear(); }
      let release;
      const held = new Promise(resolve => { release = resolve; });
      f.respond(async action => { await held; return action === "get_group_member_info" ? { role, shut_up_timestamp: 0 } : f.group; });
      const old = f.mute.replySignal("123"), oldGeneration = f.mute.replyGeneration("123");
      const query = f.mute.canSend("123");
      const ban = f.notice(0, "ban", -1);
      const duringBan = f.mute.replySignal("123");
      await f.notice(0, "lift_ban");
      await f.notice(42, "lift_ban");
      const fresh = f.mute.replySignal("123"), freshGeneration = f.mute.replyGeneration("123");
      await f.notice(0, "lift_ban");
      assert.equal(f.mute.replySignal("123"), fresh);
      assert.ok(f.mute.canSend("123") instanceof Promise);
      release(); await ban;
      assert.equal(await query, true);
      assert.equal(old.aborted, role === "member");
      assert.equal(duringBan.aborted, role === "member");
      assert.equal(fresh.aborted, false);
      assert.ok(freshGeneration > oldGeneration);
      if (role === "member") { assert.ok(f.cancellations[0].throughGeneration < freshGeneration); }
      await f.notice(42, "ban", 60);
      assert.equal(old.aborted, true);
      assert.equal(fresh.aborted, true);
    });
  }
}

test("角色待确认时收到自身明确禁言，立即取消全员禁言前与期间的回复", async t => {
  const f = fixture(t);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  f.respond(async action => { await held; return action === "get_group_member_info" ? f.member : f.group; });
  const old = f.mute.replySignal("123");
  const ban = f.notice(0, "ban", -1);
  const during = f.mute.replySignal("123");
  await f.notice(42, "ban", 60);
  assert.equal(old.aborted, true);
  assert.equal(during.aborted, true);
  assert.equal(f.mute.canSend("123"), false);
  release(); await ban;
});

test("角色查询中全员禁言后提升管理员，先取消提升前的回复再允许新代发送", async t => {
  const f = fixture(t);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  f.respond(async action => { await held; return action === "get_group_member_info" ? f.member : f.group; });
  const old = f.mute.replySignal("123");
  const ban = f.notice(0, "ban", -1);
  const during = f.mute.replySignal("123");
  await f.mute.notice({ post_type: "notice", notice_type: "group_admin", self_id: 42, group_id: 123, user_id: 42, sub_type: "set" });
  const fresh = f.mute.replySignal("123");
  assert.equal(old.aborted, true); assert.equal(during.aborted, true);
  assert.equal(fresh.aborted, false);
  assert.ok(f.cancellations[0].throughGeneration < f.mute.replyGeneration("123"));
  release(); await ban;
  assert.equal(await f.mute.canSend("123"), true);
  assert.equal(fresh.aborted, false);
});
