import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, unlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { defaultsFor } from "@dsh-plugin/dsh-loader/config";
import { template } from "../lib/host/config.js";
import { instructionFor } from "../lib/host/files.js";
import { Agent } from "../lib/host/agent.js";
import { hostFixture } from "./fixtures/host.mjs";
import { loadClient } from "./fixtures/client.mjs";

test("聊天和审查使用各自内置规则，自定义文件按 profile、Home 顺序覆盖且不被改写", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "synapse-defaults-"));
  const profile = path.join(home, "profiles", "example");
  await mkdir(profile, { recursive: true });
  const paths = { home, profile, data: path.join(profile, "data"), skills: path.join(profile, "skills") };
  const c = defaultsFor(template.fields);
  Object.assign(c.memory, { enabled: false, learnMemory: false, learnSkills: false });
  const defaults = {
    chat: await readFile(new URL("../defaults/SOUL.md", import.meta.url), "utf8"),
    review: await readFile(new URL("../defaults/AGENTS.md", import.meta.url), "utf8"),
  };
  let expected, channel;
  const host = hostFixture(async ({ conversation }) => {
    const message = conversation.findLast(item => item.source?.kind === "runtime-context");
    assert.equal(message.role, "user");
    assert(message.content[0].text.includes(expected));
    assert(!message.content[0].text.includes(defaults[channel === "chat" ? "review" : "chat"]));
    return "done";
  });
  const agent = new Agent({ loader: host.loader, paths, config: () => c, memory: {}, skills: { retrieve: async () => [] }, mcp: { available: async () => [] } });
  t.after(async () => {
    await agent.close();
    assert.equal(path.dirname(path.resolve(home)), path.resolve(os.tmpdir()));
    await rm(home, { recursive: true, force: true });
  });
  const run = current => { channel = current; return agent.run("消息", current, [], undefined, undefined, "", undefined, `${current}:defaults`); };
  for (const current of ["chat", "review"]) {
    const file = await instructionFor(paths, current);
    assert.equal(file.content, defaults[current]);
    assert.match(file.displayPath, /<synapse>\/defaults\//);
    expected = defaults[current]; await run(current); await run(current);
    const name = current === "chat" ? "SOUL.md" : "AGENTS.md";
    await assert.rejects(readFile(path.join(profile, name)), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(home, name)), { code: "ENOENT" });
  }
  const homeFile = path.join(home, "SOUL.md"), profileFile = path.join(profile, "SOUL.md");
  await writeFile(homeFile, "Home 自定义聊天规则");
  expected = "Home 自定义聊天规则"; await run("chat");
  await writeFile(profileFile, "profile 自定义聊天规则");
  expected = "profile 自定义聊天规则"; await run("chat");
  assert.equal(await readFile(homeFile, "utf8"), "Home 自定义聊天规则");
  assert.equal(await readFile(profileFile, "utf8"), expected);
  await writeFile(profileFile, "");
  assert.equal((await instructionFor(paths, "chat")).content, "");
  await unlink(profileFile); await unlink(homeFile);
  expected = defaults.chat; await run("chat");
  await assert.rejects(instructionFor(paths, "review", AbortSignal.abort()), /abort/i);
});

test("获取 API Key 链接在密码字段前挂载，使用指定地址并在安全的新标签页打开", async t => {
  const speech = template.fields.find(field => field.key === "speech");
  const index = speech.fields.findIndex(field => field.key === "apiKey");
  const panelId = speech.fields[index - 1].panel;
  assert(panelId);
  assert.equal(speech.fields[index].type, "password");
  const dom = new JSDOM("<!doctype html><body></body>");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  t.after(() => { dom.window.close(); delete globalThis.window; delete globalThis.document; });
  const { panels } = await loadClient({ realFacade: true });
  const panel = panels.find(item => item.id === panelId);
  assert(panel);
  const html = renderToStaticMarkup(React.createElement(panel.component));
  const doc = JSDOM.fragment(html);
  const link = doc.querySelector("a");
  assert.equal(link.href, "https://breezeblue.ai/zh?code=MQC8R5");
  assert.equal(link.textContent, "点击获取 API KEY");
  assert.equal(link.target, "_blank");
  assert(link.relList.contains("noopener"));
  assert(link.relList.contains("noreferrer"));
});
