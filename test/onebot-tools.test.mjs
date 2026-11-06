import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { defaultsFor } from "@dsh-plugin/dsh-loader/config";
import { template } from "../lib/host/config.js";
import { chatTools } from "../lib/host/chat-tools.js";
import { Agent } from "../lib/host/agent.js";
import { hostFixture } from "./fixtures/host.mjs";

async function fixture(t, respond = (_request, response) => response.end(JSON.stringify({ status: "ok", retcode: 0, data: { messages: [] } }))) {
  const root = await mkdtemp(path.join(os.tmpdir(), "synapse-onebot-tools-"));
  const requests = [];
  const server = createServer(async (req, res) => {
    let bytes = "";
    for await (const chunk of req) { bytes += chunk; }
    const request = { method: req.method, url: req.url, headers: req.headers, params: bytes ? JSON.parse(bytes) : undefined };
    requests.push(request); res.setHeader("Content-Type", "application/json"); respond(request, res);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const c = defaultsFor(template.fields);
  Object.assign(c.connection, { httpUrl: `http://127.0.0.1:${server.address().port}/onebot`, httpToken: "configured-secret" });
  Object.assign(c.memory, { enabled: false, learnMemory: false, learnSkills: false });
  const paths = { home: root, profile: root, data: root, skills: path.join(root, "skills") };
  const route = { type: "group", groupId: "123", userId: "7", name: "当前群", admin: false };
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    const target = path.resolve(root);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert.ok(path.basename(target).startsWith("synapse-onebot-tools-"));
    await rm(target, { recursive: true, force: true });
  });
  return { c, paths, route, requests, server, tools: (source = route) => chatTools(() => c, paths, source) };
}
const call = (tools, name, args, signal = new AbortController().signal) => tools.find(tool => tool.name === name).execute(args, signal);

test("群与好友历史使用当前会话，保留两种后端的分页参数、完整消息和回执", async t => {
  const receipt = { status: "ok", retcode: 0, data: { messages: [{ message_id: -12, message_seq: "9007199254740993", sender: { nickname: "用户" }, message: [{ type: "text", data: { text: "历史正文" } }, { type: "image", data: { url: "https://example.com/image.png" } }] }] }, echo: "original-echo" };
  const f = await fixture(t, (_request, response) => response.end(JSON.stringify(receipt)));
  assert.deepEqual(await call(f.tools(), "synapse_get_group_msg_history", { count: 2, message_seq: "9007199254740993", reverseOrder: true, group_id: 999 }), { httpStatus: 200, receipt });
  assert.deepEqual(f.requests[0].params, { group_id: 123, count: 2, message_seq: "9007199254740993", reverseOrder: true });
  assert.equal(f.requests[0].url, "/onebot/get_group_msg_history");
  await call(f.tools(), "synapse_get_group_msg_history", { message_id: -12, reverse_order: false });
  assert.deepEqual(f.requests[1].params, { group_id: 123, count: 20, message_id: -12, reverse_order: false });
  const privateTools = f.tools({ ...f.route, type: "user", userId: "8", groupId: undefined });
  assert.ok(!privateTools.some(tool => tool.name === "synapse_get_group_msg_history"));
  await call(privateTools, "synapse_get_friend_msg_history", { user_id: 999 });
  assert.equal(f.requests[2].url, "/onebot/get_friend_msg_history"); assert.deepEqual(f.requests[2].params, { user_id: 8, count: 20 });
  await call(privateTools, "synapse_get_friend_msg_history", { message_seq: "42", reverseOrder: false });
  await call(privateTools, "synapse_get_friend_msg_history", { message_id: -99, reverse_order: true });
  assert.equal(f.requests[3].params.message_seq, "42"); assert.equal(f.requests[4].params.message_id, -99);
  const bridge = f.tools({ ...f.route, type: "discord", userId: "dc:456" });
  await call(bridge, "synapse_get_group_msg_history", {}); assert.equal(f.requests.at(-1).params.group_id, 123);
});

test("通用接口拼接配置地址并自动鉴权，普通发送者获得可信身份提示且可以自行调用", async t => {
  const receipt = { status: "ok", retcode: 0, data: { message_id: 55 }, wording: "原始回执" };
  const f = await fixture(t, (_request, response) => response.end(JSON.stringify(receipt)));
  f.c.connection.httpUrl += "?access_token=configured-query";
  const tool = f.tools().find(item => item.name === "synapse_onebot_api");
  assert.match(tool.description, /调用前必须核对真实发言者/);
  assert.match(tool.description, /"senderId":"7"/); assert.match(tool.description, /"groupId":"123"/); assert.match(tool.description, /"senderIsAdmin":false/);
  assert.doesNotMatch(tool.description, /configured-secret|configured-query/);
  const params = { group_id: 456, message: [{ type: "text", data: { text: "授权后的测试消息" } }], auto_escape: false, nested: { items: [1, null, "中文"] } };
  const result = await tool.execute({ path: "/send_group_msg?mode=sync&access_token=attempted-override", params }, new AbortController().signal);
  assert.deepEqual(result, { httpStatus: 200, receipt }); assert.deepEqual(f.requests[0].params, params);
  assert.equal(f.requests[0].method, "POST"); assert.equal(f.requests[0].headers.authorization, "Bearer configured-secret");
  const url = new URL(f.requests[0].url, "http://localhost");
  assert.equal(url.pathname, "/onebot/send_group_msg"); assert.equal(url.searchParams.get("access_token"), "configured-query"); assert.equal(url.searchParams.get("mode"), "sync");
  assert.doesNotMatch(JSON.stringify(result), /configured-secret|configured-query/);
  f.c.connection.httpToken = "";
  await tool.execute({ path: "get_status", params: {} }, new AbortController().signal);
  assert.equal(f.requests[1].headers.authorization, undefined);
});

test("接口路径与参数验证阻止替换 base_url，非法历史参数不会发送请求", async t => {
  const f = await fixture(t), tools = f.tools();
  for (const input of ["http://example.com/get_status", "//example.com/get_status", "../get_status", "/onebot/../../get_status", "/%2e%2e/get_status", "get_status#fragment", "get_status\\foo", "get_status\r\nx"]) {
    await assert.rejects(call(tools, "synapse_onebot_api", { path: input, params: {} }), /path/);
  }
  for (const params of [null, [], "{}"]) { await assert.rejects(call(tools, "synapse_onebot_api", { path: "get_status", params }), /params/); }
  for (const args of [{ count: 0 }, { count: 101 }, { count: 1.5 }, { message_seq: "-1" }, { message_id: Number.MAX_SAFE_INTEGER + 1 }, { reverse_order: "true" }, { message_seq: "1", reverse_order: true }]) {
    await assert.rejects(call(tools, "synapse_get_group_msg_history", args), /count|message|reverse|混用/);
  }
  assert.equal(f.requests.length, 0);
  await assert.rejects(call(tools, "synapse_onebot_api", { path: "get_status", params: {} }, AbortSignal.abort()), /abort/i);
  assert.equal(f.requests.length, 0);
});

test("通用工具的群发送检查共享 Bot 缓存，私聊与查询继续执行", async t => {
  const f = await fixture(t), checked = [];
  let allowed = false;
  const tools = chatTools(() => f.c, f.paths, f.route, async (id, signal) => { signal.throwIfAborted(); checked.push(id); return allowed; });
  for (const path of ["/send_group_msg", "send_group_forward_msg_async", "send_msg", "send_group_ai_record"]) {
    await assert.rejects(call(tools, "synapse_onebot_api", { path, params: { group_id: 456, message: "测试" } }), /禁言/);
  }
  await assert.rejects(call(tools, "synapse_onebot_api", { path: "send_group_msg?group_id=123", params: {} }), /禁言/);
  assert.deepEqual(checked, ["456", "456", "456", "456", "123"]);
  assert.equal(f.requests.length, 0);
  for (const path of ["forward_group_single_msg", "forward_group_single_msg_async", "forward_group_single_msg_rate_limited"]) {
    await assert.rejects(call(tools, "synapse_onebot_api", { path, params: { group_id: 456, message_id: 77 } }), /禁言/);
  }
  await call(tools, "synapse_onebot_api", { path: "forward_friend_single_msg", params: { user_id: 7, message_id: 77 } });
  await call(tools, "synapse_onebot_api", { path: "send_msg", params: { message_type: "private", user_id: 7, message: "私聊" } });
  await call(tools, "synapse_get_group_msg_history", {});
  assert.equal(checked.length, 8);
  for (const path of [".handle_quick_operation", ".handle_quick_operation_async", ".handle_quick_operation_rate_limited"]) {
    await assert.rejects(call(tools, "synapse_onebot_api", { path, params: { context: { message_type: "group", group_id: 456 }, operation: { reply: "快速回复" } } }), /禁言/);
  }
  await call(tools, "synapse_onebot_api", { path: ".handle_quick_operation", params: { context: { message_type: "private", user_id: 7 }, operation: { reply: "私聊" } } });
  await call(tools, "synapse_onebot_api", { path: ".handle_quick_operation", params: { context: { message_type: "group", group_id: 456 }, operation: { delete: true } } });
  assert.equal(checked.length, 11);
  allowed = true;
  await call(tools, "synapse_onebot_api", { path: "send_group_msg", params: { group_id: 456, message: "解禁" } });
  assert.equal(f.requests.length, 6);
});

test("业务失败、异步接收与 HTTP 错误保留真实回执，非 JSON 和过大回执明确报错", async t => {
  const replies = [
    [200, { status: "failed", retcode: 100, message: "权限不足", data: null }],
    [202, { status: "async", retcode: 1, echo: "accepted", data: null }],
    [403, { status: "failed", retcode: 403, wording: "拒绝访问" }],
    [502, "not json"], [200, { data: "x".repeat(2 * 1024 * 1024) }],
  ];
  let i = 0;
  const f = await fixture(t, (_request, response) => { const [status, receipt] = replies[i++]; response.statusCode = status; response.end(typeof receipt === "string" ? receipt : JSON.stringify(receipt)); });
  for (let index = 0; index < 3; index++) { assert.deepEqual(await call(f.tools(), "synapse_onebot_api", { path: "get_status", params: {} }), { httpStatus: replies[index][0], receipt: replies[index][1] }); }
  await assert.rejects(call(f.tools(), "synapse_onebot_api", { path: "get_status", params: {} }), /非 JSON.*502/);
  await assert.rejects(call(f.tools(), "synapse_onebot_api", { path: "get_status", params: {} }), /2 MB/);
});

test("OneBot 请求执行期间取消会中止 HTTP 等待", async t => {
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, () => entered());
  const controller = new AbortController();
  const task = call(f.tools(), "synapse_onebot_api", { path: "get_status", params: {} }, controller.signal);
  await started; controller.abort(); await assert.rejects(task, /abort/i);
});

test("地址和请求构造失败的工具错误不泄露配置中的账号、令牌或查询凭据", async t => {
  const f = await fixture(t), tool = f.tools().find(item => item.name === "synapse_onebot_api");
  const invoke = () => tool.execute({ path: "get_status", params: {} }, new AbortController().signal);
  f.c.connection.httpUrl = "http://example-user:example-password@127.0.0.1:1/onebot?access_token=example-query";
  await assert.rejects(invoke(), error => !/example-user|example-password|example-query/.test(String(error)) && /HTTP Token/.test(error.message));
  f.c.connection.httpUrl = "http://127.0.0.1:1/onebot?access_token=example-query";
  f.c.connection.httpToken = "example-header\ninvalid";
  await assert.rejects(invoke(), error => !/example-query|example-header/.test(String(error)) && /请求失败/.test(error.message));
  assert.equal(f.requests.length, 0);
});

test("聊天模型在同一原生回合调用历史和通用接口，超过摘要长度的回执仍完整渲染", async t => {
  const large = "历史正文".repeat(15000) + "分页尾标记";
  const f = await fixture(t, (_request, response) => response.end(JSON.stringify({ status: "ok", retcode: 0, data: { messages: [{ raw_message: large }], next_message_seq: "9007199254740993" } })));
  let rendered = "";
  const host = hostFixture(async ({ tools, signal }) => {
    const history = tools.find(tool => tool.name === "synapse_get_group_msg_history");
    const result = await history.execute({}, { signal });
    rendered = history.output.render({}, result)[0].text;
    const generic = tools.find(tool => tool.name === "synapse_onebot_api");
    const status = await generic.execute({ path: "get_status", params: {} }, { signal });
    assert.equal(status.receipt.retcode, 0);
    return `已读取：${result.receipt.data.next_message_seq}`;
  });
  const agent = new Agent({ loader: host.loader, config: () => f.c, paths: f.paths, memory: {}, skills: { retrieve: async () => [] }, mcp: { available: async () => [] } });
  try {
    const output = await agent.run("读取历史并检查连接", "chat", [], undefined, undefined, "", undefined, "chat:group:123", { route: f.route });
    assert.match(output, /9007199254740993/); assert.ok(rendered.length > 40000); assert.match(rendered, /分页尾标记/);
    assert.equal(JSON.parse(rendered).receipt.data.messages[0].raw_message, large);
    assert.equal(f.requests.length, 2);
  } finally { await agent.close(); }
});
