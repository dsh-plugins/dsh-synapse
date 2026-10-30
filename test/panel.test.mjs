import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";
import { defaultsFor } from "@dsh-plugin/dsh-loader/config";
import { template } from "../lib/host/config.js";
test("panel renders persisted configuration, skills, MCP and Hermes import without HTML execution", async () => {
  const html = await readFile(
    new URL("../src/panel.html", import.meta.url),
    "utf8",
  );
  const source = await readFile(
    new URL("../lib/host/panel.js", import.meta.url),
    "utf8",
  );
  const dom = new JSDOM(html, {
    url: "http://localhost/synapse",
    runScripts: "outside-only",
  });
  const w = dom.window,
    calls = [];
  let saved = defaultsFor(template.fields);
  saved.modules.discord.token = { $secret: "opaque-token", set: true };
  w.structuredClone = structuredClone;
  w.confirm = () => true;
  w.fetch = async (url, options) => {
    calls.push([url, options]);
    let data;
    if (url.startsWith("/api/dshloader/config")) {
      if (options?.method === "POST") saved = JSON.parse(options.body).value;
      data = {
        ok: true,
        value: { value: saved, template, revision: 1 },
      };
    } else if (url.endsWith("/status")) data = { bot: "stopped" };
    else if (url.endsWith("/skills"))
      data = [
        {
          name: "demo",
          content: "<script>window.pwned=true</script>",
          revision: "abc",
        },
      ];
    else if (url.endsWith("/memory/import"))
      data = { items: [{ text: "memory" }] };
    else data = [];
    return { ok: true, json: async () => data };
  };
  const settle = () => new Promise((r) => setTimeout(r, 20));
  try {
    await w.eval(
      `(async()=>{${source.replace(/export\s*\{\s*\};?/g, "")}\n})()`,
    );
    const click = async (label) => {
      const b = [...w.document.querySelectorAll("button")].find(
        (b) => b.textContent === label,
      );
      assert(b, `Missing ${label}`);
      b.click();
      await settle();
    };
    assert.equal(w.document.querySelectorAll("nav button").length, 5);
    assert(!w.document.body.textContent.includes("AI 对话 / 审查"));
    assert(!w.document.querySelector('[name="botJson"]'));
    assert(!w.document.querySelector('[name="llmUrl"]'));
    const input = (name, value) => {
      const control = w.document.querySelector(`[name="${name}"]`);
      assert(control, name);
      if (control.type === "checkbox") {
        control.checked = value;
        control.dispatchEvent(new w.Event("change"));
      } else {
        control.value = value;
        control.dispatchEvent(
          new w.Event(control.tagName === "SELECT" ? "change" : "input"),
        );
      }
    };
    const add = async (name) => {
      const box = w.document.querySelector(`fieldset[data-path="${name}"]`);
      assert(box, name);
      [...box.children]
        .find((b) => b.tagName === "BUTTON" && b.textContent === "添加")
        .click();
      await settle();
    };
    await add("modules.chat.groups");
    input("modules.chat.groups.0", "123456");
    await add("modules.discord.bridges");
    input("modules.discord.bridges.0.guildId", "123");
    input("modules.discord.bridges.0.channelName", "general");
    input("modules.discord.bridges.0.group", "123456");
    input("modules.discord.bridges.0.needReply", true);
    const days = w.document.querySelector(
      '[name="modules.peakValley.time.0.days"]',
    );
    for (const option of days.options)
      option.selected = ["Sat", "Sun"].includes(option.value);
    days.dispatchEvent(new w.Event("change"));
    await click("保存配置");
    assert.deepEqual(saved.modules.chat.groups, [123456]);
    assert.equal(saved.modules.discord.bridges[0].needReply, true);
    assert.deepEqual(saved.modules.peakValley.time[0].days, ["Sat", "Sun"]);
    assert.deepEqual(saved.modules.discord.token, {
      $secret: "opaque-token",
      set: true,
    });
    input("modules.chat.groups.0", "654321");
    await click("保存配置");
    assert.deepEqual(saved.modules.chat.groups, [654321]);
    await click("Skill");
    await click("demo");
    assert.match(w.document.querySelector("pre").textContent, /<script>/);
    assert.equal(w.pwned, undefined);
    await click("MCP");
    assert.match(w.document.body.textContent, /允许列表/);
    await add("mcpServers");
    input("mcpServers.0.name", "docs");
    input("mcpServers.0.command", "node");
    await add("mcpServers.0.args");
    input("mcpServers.0.args.0", "server.mjs");
    await add("mcpServers.0.env");
    input("mcpServers.0.env.0.name", "TOKEN");
    input("mcpServers.0.env.0.value", "new-secret");
    assert.equal(
      w.document.querySelector('[name="mcpServers.0.env.0.value"]').type,
      "password",
    );
    await click("保存配置");
    assert.deepEqual(saved.mcpServers[0].args, ["server.mjs"]);
    assert.deepEqual(saved.mcpServers[0].env, [
      { name: "TOKEN", value: "new-secret" },
    ]);
    await click("Hermes 记忆");
    w.document.querySelector("textarea").value = "# User\n喜欢猫";
    await click("预览分块");
    assert(calls.some(([url]) => url.endsWith("/memory/import")));
  } finally {
    w.close();
  }
});
