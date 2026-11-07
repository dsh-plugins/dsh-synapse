import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { defaultsFor, validateValues } from "@dsh-plugin/dsh-loader/config";
import { ConfigStore } from "../node_modules/@dsh-plugin/dsh-loader/dist/services/config.js";
import { template, validateConfig } from "../lib/host/config.js";
import { registerConfig, migrateConfig } from "../lib/host/config-migration.js";
import { featureFiles } from "../lib/host/feature-config.js";
import { newRepository } from "../lib/host/github-repositories.js";

async function profileFixture(t, value, revision) {
  const home = await mkdtemp(path.join(os.tmpdir(), "synapse-migrate-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const profile = path.join(home, "profiles", "test");
  const directory = path.join(profile, "config", "dsh-synapse");
  const bot = path.join(profile, "data", "dsh-synapse", "bot", "configs", "features");
  await mkdir(directory, { recursive: true });
  await mkdir(bot, { recursive: true });
  await writeFile(path.join(directory, "config.json"), JSON.stringify({ formatVersion: 1, revision, value }));
  const store = new ConfigStore(profile);
  const ctx = { baseUrl: pathToFileURL(profile + path.sep).href, dshLoader: { config: store } };
  return { profile, directory, bot, store, ctx };
}

/** 平铺布局的完整配置，覆盖每个迁移后改变位置或类型的字段。 */
function flatConfig() {
  return {
    enabled: true,
    chatModel: { provider: "example", model: "chat" },
    reviewModel: null,
    httpUrl: "http://127.0.0.1:3100", wsUrl: "ws://127.0.0.1:3101",
    httpToken: "http-secret", wsToken: "ws-secret",
    tokenParams: "?token=", chromePath: "C:/chrome.exe", userAgent: "example-agent", logLevel: "debug",
    sessionPermission: "workspace-write", timeoutSec: -1, maxToolRounds: 12,
    githubEnabled: true, githubToken: "gh-secret", webhookSecret: "hook-secret",
    repositories: "foo/bar\n  example/*  ", publishReviews: true, maxDiffChars: 2000,
    ragEnabled: false, recallK: 30, memoryK: 4, reranker: true, learnMemory: false, learnSkills: true,
    memoryPrompt: "记忆规则", skillPrompt: "Skill 规则", maxMemories: 500,
    embeddingModel: { source: "online", baseUrl: "https://api.example.com/v1", apiKey: "embed-secret", model: "example-embed", dimensions: 8 },
    rerankModel: { source: "local", baseUrl: "https://api.example.com/v1", apiKey: "", model: "example-rerank" },
    modules: {
      management: { groups: [11], operators: [21], discordOperators: ["900"] },
      parentheses: { groups: [31] }, poke: { groups: [32] }, minecraft: { groups: [33] },
      modrinth: { groups: [34] }, command: { groups: [35, 36] },
      bili: { groups: [41], follow: [4001] },
      github: { subscriptions: [{ repository: "foo/bar", groups: [51] }] },
      welcome: { welcomes: [{ group: [61], msg: "欢迎 ${at}" }] },
      discord: { token: "discord-secret", bridges: [{ guildId: "123", channelName: "general", group: "71", needReply: true, needCmd: false }] },
      chat: {
        botName: "示例", groups: [81], admins: [83], allowedUsers: [], blockedUsers: [85], requireMention: false, keywordTriggers: ["foo"],
        progressRateLimitSec: 9, progressAsImage: false, progressMaxTools: 7, maxMessageLength: 900, forwardImages: false,
        replyPerSentence: false, compactMaxChars: 120, compactMaxLines: 3, localHistoryMaxMessages: 12, persistHistoryEnabled: false,
        persistHistoryMax: 50, approvalEnabled: false, approvalTimeoutSec: 60, reactionEnabled: false, reactionEmojiQq: "66",
        reactionEmojiDiscord: "✅", privateReactionFallbackText: false, privateReceiptText: "收到",
      },
      peakValley: {
        groups: [91], mode: "valley",
        time: [{ start: "08:00", end: "10:00", days: ["Sat"], mode: "peak", msg: "专属" }],
        peak_msg: "峰 ${time}", valley_msg: "谷 ${time}", cmd_peak_msg: "查峰 ${time}", cmd_valley_msg: "查谷 ${time}",
      },
    },
    activity: defaultsFor(template.fields).activity,
    mcpServers: [{ name: "docs", enabled: true, transport: "stdio", command: "node", args: ["server.mjs"], env: [{ name: "TOKEN", value: "mcp-secret" }], url: "", headers: [], allowedTools: ["read"] }],
  };
}

test("平铺配置迁移到分组结构，保留全部值并备份原文件", async (t) => {
  const old = flatConfig();
  const f = await profileFixture(t, old, 4);
  const handle = await registerConfig(f.ctx);
  t.after(() => handle.dispose());
  const { value: c, revision } = handle.get();
  assert.equal(revision, 5);
  assert.deepEqual(c.connection, {
    httpUrl: old.httpUrl, wsUrl: old.wsUrl, httpToken: "http-secret", wsToken: "ws-secret",
    chromePath: old.chromePath, userAgent: old.userAgent, tokenParams: old.tokenParams, logLevel: "debug",
  });
  assert.deepEqual(c.limits, { sessionPermission: "workspace-write", timeoutSec: -1, maxToolRounds: 12 });
  assert.deepEqual(c.github, {
    enabled: true, webhookSecret: "hook-secret", token: "gh-secret",
    allowUnsignedCards: false, repositories: [newRepository("foo/bar"), newRepository("example/*")], publishReviews: true, maxDiffChars: 2000,
  });
  assert.deepEqual(
    { ...c.memory, embeddingModel: undefined, rerankModel: undefined },
    { enabled: false, contextCount: 4, recallCount: 30, maxItems: 500, reranker: true, learnMemory: false,
      memoryPrompt: "记忆规则", learnSkills: true, skillPrompt: "Skill 规则", embeddingModel: undefined, rerankModel: undefined },
  );
  assert.deepEqual(c.memory.embeddingModel, old.embeddingModel);
  assert.equal(c.memory.rerankModel.model, "example-rerank");
  assert.deepEqual(c.modules.groupFeatures, { parentheses: [31], poke: [32], minecraft: [33], modrinth: [34], command: [35, 36] });
  assert.equal(c.modules.presentation.approvalTimeoutSec, 60);
  assert.equal("approvalTimeoutSec" in c.modules.chat, false);
  assert.equal(c.modules.peakValley.peakReply, "查峰 ${time}");
  assert.deepEqual(c.mcpServers, old.mcpServers);
  for (const key of ["httpUrl", "githubEnabled", "ragEnabled", "repositories", "timeoutSec"]) {
    assert.equal(key in c, false, key);
  }
  const backup = JSON.parse(await readFile(path.join(f.profile, "data", "dsh-synapse", "config-before-restructure.json"), "utf8"));
  assert.equal(backup.revision, 4);
  assert.equal(backup.value.httpToken, "http-secret");
  handle.dispose();
  const again = await registerConfig(f.ctx);
  assert.equal(again.get().revision, 5);
  again.dispose();
});

test("迁移前后生成的机器人功能文件内容一致", () => {
  const old = flatConfig();
  const files = Object.fromEntries(featureFiles(migrateConfig(old).value).map((item) => [item.id, item.value]));
  const m = old.modules;
  assert.deepEqual(files.parentheses, { version: 1, groups: [31] });
  assert.deepEqual(files.command, { version: 1, groups: [35, 36] });
  assert.deepEqual(files.management, { version: 1, ...m.management });
  const { version, systemPrompt, ...chat } = files.hermes;
  assert.deepEqual(Object.keys(chat), Object.keys(m.chat));
  assert.deepEqual(chat, m.chat);
  assert.equal(systemPrompt, "");
  assert.deepEqual(files["peak-valley-timer"], {
    groups: [91], mode: "valley", time: [{ start: "08:00", end: "10:00", days: ["Sat"], mode: "peak", msg: "专属" }],
    peak_msg: "峰 ${time}", valley_msg: "谷 ${time}", cmd_peak_msg: "查峰 ${time}", cmd_valley_msg: "查谷 ${time}",
  });
  assert.equal(files["discord-bridge"].bridges["123#general"].need_reply, "true");
});

test("分组结构的配置不会再次迁移", () => {
  assert.equal(migrateConfig(defaultsFor(template.fields)), undefined);
  assert.equal(migrateConfig(migrateConfig(flatConfig()).value), undefined);
});

test("迁移后的功能文件与重构前构建生成的快照逐字一致", async () => {
  // 快照由重构前的 lib 构建对同一份平铺配置调用 featureFiles 生成；bot.ts 按序列化字符串判断表单是否改过，键顺序也必须一致。
  const baseline = JSON.parse(await readFile(new URL("./fixtures/feature-files-baseline.json", import.meta.url), "utf8"));
  const files = Object.fromEntries(featureFiles(migrateConfig(baseline.config).value).map((item) => [item.id, JSON.stringify(item.value)]));
  assert.deepEqual(Object.keys(files), Object.keys(baseline.files));
  for (const [id, expected] of Object.entries(baseline.files)) {
    assert.equal(files[id], expected, id);
  }
});

test("仓库连接逐项校验，迁移时丢弃旧版多行文本中的无效项", () => {
  const c = defaultsFor(template.fields);
  Object.assign(c.github, { enabled: true, token: "gh-example", webhookSecret: "secret-example" });
  for (const items of [[""], [" foo/bar "], ["foo"], ["foo/bar", "foo bar/x"], ["foo/.."], ["foo/bar\n"]]) {
    c.github.repositories = items.map(newRepository);
    assert.throws(() => validateConfig(validateValues(template.fields, c)), items.join(","));
  }
  c.github.repositories = ["foo/bar", "example/*"].map(newRepository);
  assert.doesNotThrow(() => validateConfig(validateValues(template.fields, c)));
  const migrated = migrateConfig({ ...flatConfig(), repositories: "foo/bar\n\nbad entry example/*\nfoo" }).value;
  assert.deepEqual(migrated.github.repositories, ["foo/bar", "example/*"].map(newRepository));
});

test("现有分组仓库名单迁移后只开启卡片并保留订阅与凭据", async t => {
  const old = defaultsFor(template.fields);
  delete old.github.repositories;
  delete old.github.allowUnsignedCards;
  Object.assign(old.github, { enabled: true, token: "旧令牌", webhookSecret: "旧密钥", allowedRepositories: ["foo/bar", "FOO/BAR", "foo/*"] });
  old.modules.github.subscriptions = [{ repository: "foo/bar", groups: [51] }];
  const f = await profileFixture(t, old, 11);
  const handle = await registerConfig(f.ctx);
  t.after(() => handle.dispose());
  const { value, revision } = handle.get();
  assert.equal(revision, 12);
  assert.deepEqual(value.github.repositories, [
    { repository: "foo/bar", reviewPr: false, triageIssues: false, sendCards: true },
    { repository: "foo/*", reviewPr: false, triageIssues: false, sendCards: true },
  ]);
  assert.equal(value.github.webhookSecret, "旧密钥");
  assert.equal(value.github.token, "旧令牌");
  assert.equal(value.github.allowUnsignedCards, false);
  assert.deepEqual(value.modules.github.subscriptions, old.modules.github.subscriptions);
  const backup = JSON.parse(await readFile(path.join(f.profile, "data/dsh-synapse/config-before-github-repositories.json"), "utf8"));
  assert.deepEqual(backup.value, old);
});

test("表单化之前的旧配置迁移，保留聊天命令写入的功能文件并脱敏密钥", async (t) => {
  const old = {
    ...flatConfig(),
    llmUrl: "https://obsolete.example/v1",
    llmKey: "old-key",
    externalHermes: true,
    botJson: JSON.stringify({ logLevel: "warn" }),
    features: [
      { id: "hermes", json: JSON.stringify({ groups: [123], apiKey: "old-api-key", requireMention: false, approvalTimeoutSec: 30 }) },
      { id: "discord-bridge", json: JSON.stringify({ token: "discord-secret", bridges: { "123#general": { group: "456", need_reply: "true", need_cmd: "false" } } }) },
      { id: "peak-valley-timer", json: JSON.stringify({ time: ["9:00-12:00 Mon-Fri"], peak_msg: "旧峰" }) },
      { id: "poke", json: JSON.stringify({ groups: [77] }) },
    ],
    mcp: [{
      name: "docs", enabled: true, transport: "stdio", command: "node", argsJson: '["server.mjs"]',
      envJson: '{"TOKEN":"mcp-secret"}', headersJson: "{}", allowedTools: "read search", url: "",
    }],
  };
  delete old.modules;
  delete old.mcpServers;
  const f = await profileFixture(t, old, 7);
  await writeFile(path.join(f.bot, "hermes.json"), JSON.stringify({ groups: [789], requireMention: true }));
  const handle = await registerConfig(f.ctx);
  t.after(() => handle.dispose());
  const { value: c, revision } = handle.get();
  assert.equal(revision, 8);
  assert.equal(c.connection.logLevel, "warn");
  assert.deepEqual(c.modules.chat.groups, [789]);
  assert.equal(c.modules.chat.requireMention, true);
  assert.equal(c.modules.presentation.approvalTimeoutSec, 30);
  assert.deepEqual(c.modules.groupFeatures.poke, [77]);
  assert.equal(c.modules.peakValley.peakMessage, "旧峰");
  assert.deepEqual(c.modules.peakValley.time[0].days, ["Mon", "Tue", "Wed", "Thu", "Fri"]);
  assert.equal(c.modules.discord.bridges[0].needReply, true);
  assert.deepEqual(c.mcpServers[0].allowedTools, ["read", "search"]);
  for (const key of ["llmUrl", "llmKey", "externalHermes", "features", "botJson", "mcp"]) {
    assert.equal(key in c, false, key);
  }
  const visible = JSON.stringify(f.store.read("dsh-synapse"));
  assert(!visible.includes("discord-secret"));
  assert(!visible.includes("mcp-secret"));
  const backup = JSON.parse(await readFile(path.join(f.profile, "data", "dsh-synapse", "config-before-forms.json"), "utf8"));
  assert.equal(backup.revision, 7);
  assert.equal(backup.value.llmKey, "old-key");
  assert.equal(JSON.parse(await readFile(path.join(f.directory, "config.json"), "utf8")).value.llmKey, undefined);
  handle.dispose();
  const again = await registerConfig(f.ctx);
  assert.equal(again.get().revision, 8);
  again.dispose();
});
