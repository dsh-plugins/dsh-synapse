import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { defaultsFor } from "@dsh-plugin/dsh-loader/config";
import { template, validateConfig } from "../lib/host/config.js";
import { lookupGroup } from "../lib/host/group-directory.js";
import { addGroup, applyGroup, listGroups, policyFor, readGroup, removeGroup } from "../lib/host/client/channels/groups-model.js";

function legacy() {
  const c = defaultsFor(template.fields);
  c.modules.chat.groups = [11];
  c.modules.groupFeatures.command = [22];
  c.modules.management.operators = [33];
  c.modules.bili.groups = [44];
  c.modules.github.subscriptions = [{ repository: "anvil/test", groups: [55, 22] }];
  c.modules.welcome.welcomes = [{ group: [22, 11], msg: "共同欢迎" }, { group: [22], msg: "本群第二条" }];
  c.modules.discord.bridges = [
    { guildId: "101", channelName: "a", group: "22", needReply: true, needCmd: true },
    { guildId: "101", channelName: "b", group: "66", needReply: false, needCmd: true },
  ];
  const group = policyFor(c, "22");
  Object.assign(group, { useDefaults: false, blockedWords: ["本群特有"], probabilityEnabled: true });
  group.probability.baseBps = 600;
  c.activity.groups = [group];
  return c;
}

test("历史配置按群聚合，人员名单与通知订阅都不会被视为群权限", () => {
  const c = legacy(), ids = listGroups(c).map(g => g.id).sort();
  assert.deepEqual(ids, ["11", "22", "44", "55", "66"]);
  const group = { id: "22", name: "" }, original = structuredClone(c);
  assert.deepEqual(readGroup(c, group.id).features, ["command"]);
  assert.deepEqual(applyGroup(c, group, readGroup(c, group.id)), c);
  assert.deepEqual(c, original);
  const next = addGroup(c, { id: "88", name: " 新群 " });
  assert.deepEqual(next.groupDirectory, [{ id: "88", name: "新群" }]);
  assert.deepEqual(next.modules.chat.groups, [11, 88]);
  assert.deepEqual(next.modules.groupFeatures.command, [22, 88]);
  assert.throws(() => addGroup(next, { id: "55", name: "只有订阅" }), /已经添加/);
  assert.deepEqual(next.modules.management, original.modules.management);
});

test("编辑多条共享欢迎语保护其他群与规则顺序，并保留两项桥接开关和本群主动回复参数", () => {
  const c = legacy(), group = { id: "22", name: "来自群信息" }, draft = readGroup(c, "22");
  draft.welcomes[0].msg = "22 专用";
  draft.features = [...draft.features, "management"];
  draft.policy.idleEnabled = true;
  const next = applyGroup(c, group, draft);
  assert.deepEqual(next.modules.welcome.welcomes, [
    { group: [11], msg: "共同欢迎" }, { group: [22], msg: "22 专用" }, { group: [22], msg: "本群第二条" },
  ]);
  assert.deepEqual(next.modules.discord.bridges, c.modules.discord.bridges);
  assert.deepEqual(next.activity.groups, [{ ...c.activity.groups[0], idleEnabled: true }]);
  assert.deepEqual(next.modules.management.operators, [33]);
  assert.deepEqual(next.modules.chat.groups, [11]);
  assert.deepEqual(next.groupDirectory, [group]);
  validateConfig(next);
  const removed = removeGroup(next, group);
  assert.deepEqual(listGroups(removed).map(g => g.id).sort(), ["11", "44", "55", "66"]);
  assert.deepEqual(removed.modules.github.subscriptions, [{ repository: "anvil/test", groups: [55] }]);
  assert.deepEqual(removed.modules.welcome.welcomes, [{ group: [11], msg: "共同欢迎" }]);
  assert.deepEqual(removed.modules.discord.bridges, [c.modules.discord.bridges[1]]);
});

test("OneBot 群目录只接受目标群的成功回执，并复用连接的地址前缀和凭据", async t => {
  let data = { group_id: 123, group_name: " 群名 " };
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    calls.push([req.url, req.headers.authorization, JSON.parse(Buffer.concat(chunks))]);
    res.end(JSON.stringify({ status: "ok", retcode: 0, data }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const connection = { ...legacy().connection, httpUrl: `http://127.0.0.1:${server.address().port}/bot/?device=local`, httpToken: "test" };
  const signal = new AbortController().signal;
  assert.deepEqual(await lookupGroup(connection, "123", signal), { id: "123", name: "群名" });
  assert.deepEqual(calls, [["/bot/get_group_info?device=local", "Bearer test", { group_id: 123, no_cache: true }]]);
  data = { group_id: 456, group_name: "别的群" };
  await assert.rejects(() => lookupGroup(connection, "123", signal), /未返回该群/);
  await assert.rejects(() => lookupGroup(connection, "9007199254740993", signal), /有效的 QQ 群号/);
  assert.equal(calls.length, 2);
});
