import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { once } from "node:events";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultsFor } from "@dsh-plugin/dsh-loader/config";
import { template } from "../lib/host/config.js";
import { McpManager } from "../lib/host/mcp.js";
import { Bot } from "../lib/host/bot.js";
import { Gateway } from "../lib/host/gateway.js";
import { Agent } from "../lib/host/agent.js";
import { hostFixture } from "./fixtures/host.mjs";
import { apply } from "../lib/host/index.js";
import { ChatState } from "../lib/host/chat-state.js";
import { ChatImages } from "../lib/host/chat-images.js";
import { ChatActivity } from "../lib/host/chat-activity.js";
import { AsyncWordCloud } from "../lib/host/word-cloud.js";
const waitFor = async (fn, ms = 10000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("Timed out waiting for integration state");
};
test("real MCP stdio discovery, allowlist and invocation", async () => {
  const c = defaultsFor(template.fields);
  c.mcpServers = [
    {
      name: "fixture",
      enabled: true,
      transport: "stdio",
      command: process.execPath,
      args: [
        fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url)),
      ],
      env: [],
      headers: [],
      allowedTools: ["read"],
      url: "",
    },
  ];
  const mcp = new McpManager(() => c);
  try {
    assert.equal((await mcp.list("fixture")).length, 2);
    const available = await mcp.available();
    assert.equal(available.length, 1);
    assert.equal(
      (await mcp.call(available[0], {})).content[0].text,
      "fixture result",
    );
    await assert.rejects(
      mcp.call({ server: "fixture", rawName: "blocked" }, {}),
      /允许列表/,
    );
  } finally {
    await mcp.close();
  }
});
test("full upstream bot starts, connects OneBot and executes /help and native queries", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "synapse-bot-"));
  const profile = path.join(home, "profiles", "test"),
    data = path.join(profile, "data", "dsh-synapse");
  await mkdir(data, { recursive: true });
  const c = {
    ...defaultsFor(template.fields),
    enabled: true,
    ragEnabled: false,
    learnMemory: false,
    learnSkills: false,
  };
  c.modules.command.groups = [123];
  Object.assign(c.modules.chat, {
    requireMention: false,
    groups: [123],
    reactionEnabled: false,
    progressAsImage: false,
    replyPerSentence: true,
  });
  const requests = [];
  const http = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    requests.push({ url: req.url, body: body ? JSON.parse(body) : {} });
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        status: "ok",
        retcode: 0,
        data:
          req.url === "/get_login_info"
            ? { user_id: 42, nickname: "testbot" }
            : req.url === "/get_group_info"
              ? { group_name: "铁砧工艺交流反馈☕" }
              : { message_id: 77 },
      }),
    );
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  c.httpUrl = `http://127.0.0.1:${http.address().port}`;
  const ws = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(ws, "listening");
  c.wsUrl = `ws://127.0.0.1:${ws.address().port}`;
  let socket;
  ws.on("connection", (s) => {
    socket = s;
  });
  const errors = [],
    received = [],
    resets = [];
  const originalFetch = globalThis.fetch;
  let queries = 0;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    if (new URL(input).hostname === "piston-meta.mojang.com") {
      queries++;
      return Response.json({ latest: { release: "example-release", snapshot: "example-snapshot" } });
    }
    return originalFetch(input, init);
  });
  const host = hostFixture(async ({ message, tools, signal }) => {
    const input = message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
    if (input.includes("merge queued sentences")) {
      return "甲".repeat(190) + "。\n" + "乙".repeat(190) + "。";
    }
    if (input.includes("first group message")) {
      const version = await tools.find((tool) => tool.name === "synapse_minecraft_version").execute({}, { signal });
      return `hello ${version.release}`;
    }
    return "hello";
  });
  const agent = new Agent({ loader: host.loader, config: () => c, paths: { home, profile, data, skills: path.join(profile, "skills") }, memory: {}, skills: { retrieve: async () => [] }, mcp: { available: async () => [] } });
  const state = new ChatState(path.join(data, "chat-state.sqlite"));
  const activity = new ChatActivity({ state, config: () => c, images: new ChatImages({ home, profile, data }, state, () => c), cloud: new AsyncWordCloud(path.join(data, "chat-state.sqlite")) });
  await activity.recover((...args) => agent.harness.hasInput(...args));
  const gateway = new Gateway(
      {
        run: async (...args) => {
          received.push({ input: args[0], key: args[7], context: args[8] });
          return agent.run(...args);
        },
        reset: async (key) => {
          resets.push(key);
          await agent.reset(key);
        },
        whenCurrentSettled: key => agent.whenCurrentSettled(key),
      },
      () => c,
      (e) => errors.push(e.message),
      activity,
    );
  await gateway.start();
  const bot = new Bot(
    { home, profile, data },
    () => c,
    gateway,
    (e) => errors.push(e.message),
  );
  try {
    await bot.start();
    await waitFor(() => bot.state === "running" && socket, 15000);
    socket.send(
      JSON.stringify({
        post_type: "message",
        message_type: "group",
        group_id: 123,
        user_id: 1,
        self_id: 42,
        message_id: 1,
        raw_message: "/help",
        message: [{ type: "text", data: { text: "/help" } }],
        sender: { user_id: 1, nickname: "tester", role: "owner" },
      }),
    );
    await waitFor(
      () => requests.some((r) => ["/send_group_msg", "/send_group_forward_msg"].includes(r.url) && /mcv|help|github/.test(JSON.stringify(r.body))),
      12000,
    );
    assert.match(
      JSON.stringify(requests.find((r) => ["/send_group_msg", "/send_group_forward_msg"].includes(r.url) && /mcv|help|github/.test(JSON.stringify(r.body))).body),
      /mcv|help|github/,
    );
    socket.send(
      JSON.stringify({
        post_type: "message",
        message_type: "private",
        sub_type: "friend",
        user_id: 1,
        self_id: 42,
        message_id: 2,
        raw_message: "你好",
        message: [{ type: "text", data: { text: "你好" } }],
        sender: { user_id: 1, nickname: "tester" },
      }),
    );
    await waitFor(
      () =>
        requests.some(
          (r) =>
            r.url === "/send_private_msg" &&
            JSON.stringify(r.body).includes("hello"),
        ),
      12000,
    );
    assert.equal(received[0].key, "chat:user:1");
    assert.equal(received[0].context.title, "【私聊】tester（1）");
    socket.send(JSON.stringify({
      post_type: "message", message_type: "group", group_id: 123, user_id: 1,
      self_id: 42, message_id: 99, raw_message: "merge queued sentences",
      message: [{ type: "text", data: { text: "merge queued sentences" } }],
      sender: { user_id: 1, nickname: "tester", role: "owner" },
    }));
    await waitFor(() => requests.some(r => r.url === "/send_group_forward_msg" && JSON.stringify(r.body).includes("甲".repeat(190)) && JSON.stringify(r.body).includes("乙".repeat(190))));
    const merged = requests.find(r => r.url === "/send_group_forward_msg" && JSON.stringify(r.body).includes("甲".repeat(190)));
    assert.equal(merged.body.messages.length, 2);
    assert.deepEqual(merged.body.messages.map(node => node.data.content.find(segment => segment.type === "text").data.text), ["甲".repeat(190) + "。", "乙".repeat(190) + "。"]);
    for (const [user, text] of [
      [1, "first group message"],
      [2, "second group message"],
      [1, "清除上下文"],
    ]) {
      if (text === "清除上下文") {
        await waitFor(() => received.length === 4, 12000);
        await waitFor(() => requests.some((r) => r.url === "/send_group_msg" && JSON.stringify(r.body).includes("example-release")));
      }
      socket.send(
        JSON.stringify({
          post_type: "message",
          message_type: "group",
          group_id: 123,
          user_id: user,
          self_id: 42,
          message_id: 100 + user,
          raw_message: text,
          message: [{ type: "text", data: { text } }],
          sender: { user_id: user, nickname: "tester" + user, role: "owner" },
        }),
      );
    }
    await waitFor(() => resets.length === 1, 12000);
    assert.deepEqual(
      received.slice(2).map((r) => r.key),
      ["chat:group:123", "chat:group:123"],
    );
    assert.match(received[2].input, /first group message/);
    assert.match(received[3].input, /second group message/);
    assert.equal(received[2].context.title, "【群聊】铁砧工艺交流反馈☕（123）");
    assert.equal(received[3].context.route.userId, "2");
    assert.equal(queries, 1);
    await waitFor(() => requests.some((r) => r.url === "/send_group_msg" && JSON.stringify(r.body).includes("example-release")));
    assert.deepEqual(resets, ["chat:group:123"]);
    assert.deepEqual(errors, []);
  } catch (e) {
    const log = await readFile(
      path.join(data, "bot/logs/latest.log"),
      "utf8",
    ).catch(() => "(no upstream log)");
    throw new Error(
      e.message +
        "\n" +
        bot.state +
        "\n" +
        bot.stderr +
        "\n" +
        log.slice(-6000) +
        "\n" + JSON.stringify({ received: received.map(item => ({ key: item.key, input: item.input })), errors,
          pending: state.allMessages().map(({ seq, messageId, foreground, batchId }) => ({ seq, messageId, foreground, batchId })) }),
      { cause: e },
    );
  } finally {
    await bot.stop();
    await gateway.close();
    await agent.close();
    await activity.close();
    for (const s of ws.clients) s.terminate();
    await new Promise((r) => ws.close(r));
    await new Promise((r) => http.close(r));
  }
});
test("loader 2.0 lifecycle registers, authenticates routes and disposes services", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "synapse-host-"));
  const profile = path.join(home, "profiles", "test");
  await mkdir(profile, { recursive: true });
  const c = {
    ...defaultsFor(template.fields),
  };
  const routes = new Map(),
    cleanups = [];
  let registered, watched;
  const ctx = {
    baseUrl: pathToFileURL(profile + path.sep).href,
    effect(fn) {
      cleanups.push(fn());
    },
    logger: { warn() {} },
    dshLoader: {
      config: {
        async register(owner, t) {
          registered = t;
          return {
            get: () => ({ value: c }),
            dispose() {},
            watch(fn) {
              watched = fn;
              return () => {
                watched = null;
              };
            },
            registerOperation() {
              return () => {};
            },
          };
        },
      },
      services: { get: () => ({ authorizeIndex: () => true }) },
      web: Object.fromEntries(
        ["register", "post", "get"].map((method) => [
          method,
          (p, h) => {
            routes.set(p, h);
            return () => routes.delete(p);
          },
        ]),
      ),
    },
  };
  await apply(ctx);
  assert.equal(registered.id, "dsh-synapse");
  assert(watched);
  assert(routes.has("/hooks/dsh-synapse/github"));
  assert(!routes.has("/synapse"));
  assert(!routes.has("/synapse-panel.js"));
  const status = await new Promise((resolve) =>
    routes.get("/api/dsh-synapse/")(
      { url: "/api/dsh-synapse/status", headers: {} },
      {
        writeHead() {},
        end(s) {
          resolve(JSON.parse(s));
        },
      },
    ),
  );
  assert.equal(status.running, true);
  assert.equal(status.bot, "stopped");
  for (const fn of cleanups) fn();
  assert.equal(routes.size, 0);
  assert.equal(watched, null);
});
