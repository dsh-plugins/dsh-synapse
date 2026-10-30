import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { once } from "node:events";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { defaultsFor } from "@dsh-plugin/dsh-loader/config";
import { template } from "../lib/host/config.js";
import { McpManager } from "../lib/host/mcp.js";
import { Bot } from "../lib/host/bot.js";
import { Gateway } from "../lib/host/gateway.js";
import { apply } from "../lib/host/index.js";
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
test("full upstream bot starts, connects OneBot and executes /help", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "synapse-bot-"));
  const profile = path.join(home, "profiles", "test"),
    data = path.join(profile, "data", "dsh-synapse");
  await mkdir(data, { recursive: true });
  const c = {
    ...defaultsFor(template.fields),
    enabled: true,
    ragEnabled: false,
    profileDir: profile,
    homeDir: home,
  };
  c.modules.command.groups = [123];
  Object.assign(c.modules.chat, {
    groups: [123],
    reactionEnabled: false,
    progressAsImage: false,
    replyPerSentence: false,
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
    gateway = new Gateway(
      { run: async () => "hello" },
      () => c,
      (e) => errors.push(e.message),
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
      () => requests.some((r) => r.url === "/send_group_msg"),
      12000,
    );
    assert.match(
      JSON.stringify(requests.find((r) => r.url === "/send_group_msg").body),
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
        log.slice(-6000),
    );
  } finally {
    await bot.stop();
    await gateway.close();
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
    profileDir: profile,
    homeDir: home,
  };
  const routes = new Map(),
    cleanups = [];
  let registered, watched;
  const ctx = {
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
