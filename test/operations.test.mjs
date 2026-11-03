import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { template } from "../lib/host/config.js";
import { operationFixture } from "./fixtures/operations.mjs";

test("loader card operations create, update and delete Skill with revision protection", async (t) => {
  const f = await operationFixture();
  t.after(() => f.close());
  const before = f.handle.get();
  let watched = 0;
  f.handle.watch(() => watched++);
  const registered = f.store.read("dsh-synapse").availableOperations;
  assert.deepEqual(
    registered.sort(),
    template.panels.flatMap((p) => p.operations.map((o) => o.id)).sort(),
  );
  const created = await f.invoke("skills.create", {
    name: "demo",
    content: "# 文档\n内容",
  });
  assert.equal(created.resource.id, "skill:demo");
  assert.equal((await f.invoke("skills.list")).value.items[0].name, "demo");
  const loaded = await f.invoke("skills.load", { selected: "demo" });
  await assert.rejects(
    f.invoke("skills.create", { name: "demo", content: "覆盖" }),
    { code: "conflict" },
  );
  await assert.rejects(
    f.invoke(
      "skills.save",
      { name: "renamed", content: "新内容" },
      loaded.resource,
    ),
    { code: "conflict" },
  );
  const saved = await f.invoke(
    "skills.save",
    { name: "demo", content: "# 更新" },
    loaded.resource,
  );
  await assert.rejects(
    f.invoke(
      "skills.save",
      { name: "demo", content: "旧草稿" },
      loaded.resource,
    ),
    { code: "conflict" },
  );
  await assert.rejects(
    f.invoke(
      "skills.delete",
      { name: "demo", selected: "demo", confirmDelete: false },
      saved.resource,
    ),
    { code: "validation" },
  );
  const removed = await f.invoke(
    "skills.delete",
    { name: "demo", selected: "demo", confirmDelete: true },
    saved.resource,
  );
  assert.equal(removed.resource, null);
  assert.equal((await f.invoke("skills.list")).value.items.length, 0);
  assert.equal(watched, 0);
  assert.deepEqual(f.handle.get(), before);
});

test("Home Skill is identified, cannot be deleted, and saves as a profile override", async (t) => {
  const f = await operationFixture();
  t.after(() => f.close());
  await mkdir(path.join(f.paths.home, "skills"));
  await writeFile(path.join(f.paths.home, "skills", "shared.md"), "Home");
  const loaded = await f.invoke("skills.load", { selected: "shared" });
  assert.match(loaded.value.origin, /Home/);
  await assert.rejects(
    f.invoke(
      "skills.delete",
      { name: "shared", selected: "shared", confirmDelete: true },
      loaded.resource,
    ),
    /当前 profile/,
  );
  const saved = await f.invoke(
    "skills.save",
    { name: "shared", content: "Profile" },
    loaded.resource,
  );
  await f.invoke(
    "skills.delete",
    { name: "shared", selected: "shared", confirmDelete: true },
    saved.resource,
  );
  assert.equal(
    (await f.invoke("skills.load", { selected: "shared" })).value.content,
    "Home",
  );
});

test("机器人不可用时仍可测试 MCP 草稿并按修订号保存、删除，凭据保持脱敏", async (t) => {
  const f = await operationFixture({ serviceAvailable: false });
  t.after(() => f.close());
  await f.handle.update({ mcpServers: [{
    name: "saved", enabled: true, transport: "stdio", command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url))],
    env: [{ name: "TOKEN", value: "never-expose" }], headers: [], url: "", allowedTools: [],
  }] });
  const before = f.handle.get();
  const server = { ...f.store.read("dsh-synapse").value.mcpServers[0], name: "draft", enabled: false };
  const result = await f.invoke("mcp.test", { server });
  assert.deepEqual(result.value.tools.map(tool => tool.name).sort(), ["blocked", "read"]);
  assert(!JSON.stringify(result).includes("never-expose"));
  assert.deepEqual(f.handle.get(), before);
  const resource = { id: "mcp-servers", revision: before.revision };
  const saved = await f.invoke("mcp.save", { originalName: "saved", server }, resource);
  assert.equal(f.handle.get().value.mcpServers[0].name, "draft");
  assert.equal(f.handle.get().value.mcpServers[0].env[0].value, "never-expose");
  await assert.rejects(f.invoke("mcp.save", { originalName: "saved", server }, resource), { code: "conflict" });
  await assert.rejects(f.invoke("mcp.save", { originalName: "draft", server: { ...server, enabled: true, command: "" } }, saved.resource), /启动命令不能为空/);
  await assert.rejects(f.invoke("mcp.delete", { originalName: "draft", confirmDelete: false }, saved.resource), { code: "validation" });
  await f.invoke("mcp.delete", { originalName: "draft", confirmDelete: true }, saved.resource);
  assert.deepEqual(f.handle.get().value.mcpServers, []);
});

test("Hermes preview/import stay transient, deduplicate, and abort without a partial commit", async (t) => {
  const f = await operationFixture();
  t.after(() => f.close());
  const before = f.handle.get();
  const input = { markdown: "# User\n喜欢猫", channel: "chat" };
  assert.equal((await f.invoke("memory.preview", input)).value.items.length, 1);
  assert.equal(f.service.memory.list("chat").length, 0);
  assert.equal((await f.invoke("memory.import", input)).value.inserted, 1);
  assert.equal((await f.invoke("memory.import", input)).value.duplicates, 1);
  assert.equal(
    (await f.invoke("memory.search", { query: "猫", channel: "chat" })).value
      .items.length,
    1,
  );
  assert.equal(
    (await f.invoke("memory.recent", { channel: "review" })).value.items.length,
    0,
  );
  const started = Promise.withResolvers(),
    pending = Promise.withResolvers();
  f.service.memory.inference.embed = () => {
    started.resolve();
    return pending.promise;
  };
  const controller = new AbortController();
  const job = f.invoke(
    "memory.import",
    { markdown: "# 新记忆\n不能写入", channel: "chat" },
    undefined,
    controller.signal,
  );
  const rejected = assert.rejects(job, { code: "cancelled" });
  await started.promise;
  controller.abort();
  await rejected;
  pending.resolve([1, ...Array(511).fill(0)]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.service.memory.list("chat").length, 1);
  assert.deepEqual(f.handle.get(), before);
});
