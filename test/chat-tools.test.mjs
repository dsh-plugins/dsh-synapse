import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { defaultsFor } from "@dsh-plugin/dsh-loader/config";
import { template } from "../lib/host/config.js";
import { Agent } from "../lib/host/agent.js";
import { chatTools } from "../lib/host/chat-tools.js";
import { hostFixture } from "./fixtures/host.mjs";

async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), "synapse-chat-tools-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const c = defaultsFor(template.fields);
  c.github.allowedRepositories = ["foo/*"];
  Object.assign(c.memory, { enabled: false, learnMemory: false, learnSkills: false });
  c.modules.github.subscriptions = [{ repository: "foo/bar", groups: [123] }];
  c.modules.chat.admins = [7];
  const paths = {
    home,
    profile: home,
    data: home,
    skills: path.join(home, "skills"),
  };
  const route = {
    type: "group",
    userId: "7",
    groupId: "123",
    name: "example",
    admin: true,
  };
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input, init = {}) => {
    init.signal?.throwIfAborted();
    const url = new URL(input);
    requests.push({
      url,
      ...init,
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    if (url.pathname.endsWith("/issues/114")) {
      return Response.json({
        number: 114,
        title: "修复缓存",
        body: "详细说明",
        state: "open",
        html_url: "https://github.com/foo/bar/pull/114",
        user: { login: "foo" },
        pull_request: {},
      });
    }
    if (url.pathname.endsWith("/pulls/114")) {
      return Response.json({
        merged: false,
        draft: true,
        head: { ref: "example" },
        base: { ref: "main" },
      });
    }
    if (url.hostname === "api.bilibili.com") {
      return Response.json({
        code: 0,
        data: {
          bvid: "BV1xx411c7mD",
          title: "测试视频",
          desc: "视频简介",
          owner: { name: "foo", mid: 1 },
          duration: 120,
          stat: { view: 123 },
        },
      });
    }
    if (url.hostname === "b23.tv") {
      return new Response(null, {
        status: 302,
        headers: { location: "https://www.bilibili.com/video/BV1xx411c7mD" },
      });
    }
    if (url.hostname === "piston-meta.mojang.com") {
      return Response.json({
        latest: { release: "example-release", snapshot: "example-snapshot" },
      });
    }
    if (url.hostname === "api.mcstatus.io") {
      return Response.json({
        online: true,
        version: { name_clean: "example" },
        motd: { clean: "你好" },
        players: { online: 1, max: 20, list: [{ name_clean: "foo" }] },
      });
    }
    if (url.hostname === "zh.minecraft.wiki") {
      return new Response(
        '<h1 id="firstHeading">铁砧</h1><div id="mw-content-text"><div class="mw-parser-output"><p>铁砧的用法。</p></div></div>',
      );
    }
    if (url.hostname === "api.modrinth.com") {
      return new Response(
        "<metadata><versioning><latest>example+mc</latest></versioning></metadata>",
      );
    }
    if (url.hostname === "127.0.0.1") {
      return Response.json({ status: "ok", retcode: 0, data: null });
    }
    throw new Error(`未预期的请求：${url}`);
  });
  return {
    c,
    paths,
    route,
    requests,
    tools: () => chatTools(() => c, paths, route),
  };
}

test("Issue 与视频结果由主模型在同一次原生回合中组合回复", async (t) => {
  const f = await fixture(t);
  let turns = 0;
  const host = hostFixture(async ({ tools, signal }) => {
    turns++;
    const call = (name, args) =>
      tools.find((tool) => tool.name === name).execute(args, { signal });
    const issue = await call("synapse_github_issue", {
      reference: "foo/bar#114",
    });
    const video = await call("synapse_bilibili_video", {
      video: "https://b23.tv/example",
    });
    assert.equal(issue.type, "PR");
    assert.equal(issue.draft, true);
    return `审查 ${issue.title}：${issue.url}\n视频 ${video.title}：${video.url}`;
  });
  const agent = new Agent({
    loader: host.loader,
    config: () => f.c,
    paths: f.paths,
    memory: {},
    skills: { retrieve: async () => [] },
    mcp: { available: async () => [] },
  });
  t.after(() => agent.close());
  const output = await agent.run(
    "查询 Issue 和视频",
    "chat",
    [],
    undefined,
    undefined,
    "",
    undefined,
    "chat:group:123",
    { route: f.route },
  );
  assert.match(output, /修复缓存.*github.com/);
  assert.match(output, /测试视频.*bilibili.com/);
  assert.equal(turns, 1);
  assert(
    f.requests.every(
      (request) => !new Headers(request.headers).has("Authorization"),
    ),
  );
});

test("六类查询和群管理工具返回实际结果，群号由可信聊天信息限定", async (t) => {
  const f = await fixture(t);
  const signal = new AbortController().signal;
  const call = async (name, args) => {
    const result = await f
      .tools()
      .find((tool) => tool.name === name)
      .execute(args, signal);
    assert.deepEqual(result, JSON.parse(JSON.stringify(result)));
    return result;
  };
  assert.equal(
    (await call("synapse_minecraft_version", {})).release,
    "example-release",
  );
  assert.equal(
    (await call("synapse_minecraft_server", { address: "example.org:25565" }))
      .players.online,
    1,
  );
  assert.match(
    (await call("synapse_minecraft_wiki", { query: "铁砧" })).summary,
    /用法/,
  );
  assert.equal(
    (await call("synapse_modrinth_version", { slug: "example" })).version,
    "example+mc",
  );
  f.c.connection.httpToken = "onebot-secret";
  await call("synapse_group_mute", {
    userId: "9",
    minutes: 10,
    groupId: "999",
  });
  await call("synapse_group_mute", { userId: "9", minutes: 0 });
  await call("synapse_group_kick", { userId: "9" });
  await call("synapse_group_whole_ban", { enabled: true });
  const bans = f.requests.filter(
    (request) => request.url.pathname === "/set_group_ban",
  );
  assert.equal(bans[0].body.group_id, 123);
  assert.equal(bans[0].body.duration, 600);
  assert.equal(bans[1].body.duration, 0);
  assert.equal(
    new Headers(bans[0].headers).get("Authorization"),
    "Bearer onebot-secret",
  );
  await assert.rejects(
    call("synapse_group_mute", { userId: "9", minutes: 50000 }),
    /时长/,
  );
  f.c.modules.chat.admins = [];
  await assert.rejects(call("synapse_group_kick", { userId: "9" }), /管理员/);
  assert(
    !chatTools(() => f.c, f.paths, { ...f.route, admin: false }).some((tool) =>
      tool.name.startsWith("synapse_group_"),
    ),
  );
});

test("查询保留仓库绑定与群开关，拒绝越权仓库、非视频短链跳转和取消请求", async (t) => {
  const f = await fixture(t);
  const signal = new AbortController().signal;
  const call = (name, args, s = signal) =>
    f
      .tools()
      .find((tool) => tool.name === name)
      .execute(args, s);
  await assert.rejects(
    call("synapse_github_issue", { reference: "bar/example#114" }),
    /允许|绑定/,
  );
  assert.equal(f.requests.length, 0);
  await mkdir(path.join(f.paths.data, "bot", "configs"), { recursive: true });
  await writeFile(
    path.join(f.paths.data, "bot", "configs", "github-bind.json"),
    JSON.stringify({ githubToQq: { bar: "7" } }),
  );
  assert.equal(
    (await call("synapse_github_issue", { reference: "bar/example#114" }))
      .title,
    "修复缓存",
  );
  await mkdir(path.join(f.paths.data, "bot", "configs", "features"));
  await writeFile(
    path.join(f.paths.data, "bot", "configs", "features", "github.json"),
    JSON.stringify({ groups: {} }),
  );
  await assert.rejects(
    call("synapse_github_issue", { reference: "foo/bar#114" }),
    /本群/,
  );
  await assert.rejects(
    call("synapse_bilibili_video", { video: "av1" }, AbortSignal.abort()),
    /abort/i,
  );
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/secret" },
      }),
  );
  await assert.rejects(
    call("synapse_bilibili_video", { video: "https://b23.tv/example" }),
    /视频|地址/,
  );
});

test("查询保留离线状态，远程业务错误和管理失败不会返回成功", async (t) => {
  const f = await fixture(t);
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    if (url.hostname === "api.mcstatus.io") {
      return Response.json({ online: false });
    }
    if (url.hostname === "api.bilibili.com") {
      return Response.json({ code: -404, message: "视频不存在" });
    }
    return Response.json({ status: "failed", retcode: 100, msg: "权限不足" });
  });
  const signal = new AbortController().signal;
  const call = (name, args) =>
    f
      .tools()
      .find((tool) => tool.name === name)
      .execute(args, signal);
  const offline = await call("synapse_minecraft_server", {
    address: "example.org",
  });
  assert.equal(offline.online, false);
  assert.deepEqual(offline, JSON.parse(JSON.stringify(offline)));
  await assert.rejects(
    call("synapse_bilibili_video", { video: "av1" }),
    /视频不存在/,
  );
  await assert.rejects(
    call("synapse_group_mute", { userId: "9", minutes: 10 }),
    /权限不足/,
  );
});
