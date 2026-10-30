import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { defaultsFor } from "@dsh-plugin/dsh-loader/config";
import { ConfigStore } from "../node_modules/@dsh-plugin/dsh-loader/dist/services/config.js";
import { template } from "../lib/host/config.js";
import { registerConfig } from "../lib/host/config-migration.js";
import { featureFiles } from "../lib/host/feature-config.js";

test("real loader migrates legacy JSON, preserves live commands, backs up and redacts secrets", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "synapse-migrate-"));
  const profile = path.join(home, "profiles", "test");
  const directory = path.join(profile, "config", "dsh-synapse");
  const bot = path.join(
    profile,
    "data",
    "dsh-synapse",
    "bot",
    "configs",
    "features",
  );
  await mkdir(directory, { recursive: true });
  await mkdir(bot, { recursive: true });
  const old = {
    ...defaultsFor(template.fields),
    profileDir: profile,
    homeDir: home,
    llmUrl: "https://obsolete.example/v1",
    llmKey: "old-key",
    externalHermes: true,
    botJson: JSON.stringify({ logLevel: "warn" }),
    features: [
      {
        id: "hermes",
        json: JSON.stringify({
          groups: [123],
          apiKey: "old-api-key",
          requireMention: false,
        }),
      },
      {
        id: "discord-bridge",
        json: JSON.stringify({
          token: "discord-secret",
          bridges: {
            "123#general": {
              group: "456",
              need_reply: "true",
              need_cmd: "false",
            },
          },
        }),
      },
      {
        id: "peak-valley-timer",
        json: JSON.stringify({ time: ["9:00-12:00 Mon-Fri"] }),
      },
    ],
    mcp: [
      {
        name: "docs",
        enabled: true,
        transport: "stdio",
        command: "node",
        argsJson: '["server.mjs"]',
        envJson: '{"TOKEN":"mcp-secret"}',
        headersJson: "{}",
        allowedTools: "read search",
        url: "",
      },
    ],
  };
  await writeFile(
    path.join(directory, "config.json"),
    JSON.stringify({ formatVersion: 1, revision: 7, value: old }),
  );
  await writeFile(
    path.join(bot, "hermes.json"),
    JSON.stringify({ groups: [789], requireMention: true }),
  );
  const store = new ConfigStore(profile);
  const ctx = { dshLoader: { config: store } };
  const handle = await registerConfig(ctx);
  try {
    const { value: c, revision } = handle.get();
    assert.equal(revision, 8);
    assert.equal(c.logLevel, "warn");
    assert.deepEqual(c.modules.chat.groups, [789]);
    assert.equal(c.modules.discord.bridges[0].needReply, true);
    assert.equal(c.modules.discord.bridges[0].needCmd, false);
    assert.deepEqual(c.modules.peakValley.time[0].days, [
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri",
    ]);
    assert.deepEqual(c.mcpServers[0].allowedTools, ["read", "search"]);
    for (const key of [
      "llmUrl",
      "llmKey",
      "externalHermes",
      "features",
      "botJson",
      "mcp",
    ])
      assert.equal(key in c, false);
    assert(
      !JSON.stringify(store.read("dsh-synapse")).includes("discord-secret"),
    );
    assert(!JSON.stringify(store.read("dsh-synapse")).includes("mcp-secret"));
    const discord = featureFiles(c).find(
      (f) => f.id === "discord-bridge",
    ).value;
    assert.equal(discord.bridges["123#general"].need_reply, "true");
    const backup = JSON.parse(
      await readFile(
        path.join(profile, "data", "dsh-synapse", "config-before-forms.json"),
        "utf8",
      ),
    );
    assert.equal(backup.revision, 7);
    assert.equal(backup.value.llmKey, "old-key");
    assert.equal(
      JSON.parse(await readFile(path.join(directory, "config.json"), "utf8"))
        .value.llmKey,
      undefined,
    );
  } finally {
    handle.dispose();
  }
  const again = await registerConfig(ctx);
  assert.equal(again.get().revision, 8);
  again.dispose();
});
