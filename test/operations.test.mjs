import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { template } from "../lib/host/config.js";
import { operationFixture } from "./fixtures/operations.mjs";

test("loader card operations create, preview, update and delete Skill with revision protection", async (t) => {
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
  const preview = "<script>alert(1)</script>\n# 标题";
  assert.equal(
    (await f.invoke("skills.preview", { content: preview })).value,
    preview,
  );
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

test("MCP selection uses only saved enabled names without exposing server credentials", async (t) => {
  const f = await operationFixture();
  t.after(() => f.close());
  await f.handle.update({
    mcpServers: [
      {
        name: "docs",
        enabled: true,
        transport: "stdio",
        command: "node",
        args: [],
        env: [{ name: "TOKEN", value: "never-expose" }],
        url: "",
        headers: [],
        allowedTools: [],
      },
    ],
  });
  const names = await f.invoke("mcp.servers");
  assert.deepEqual(names.value.items, [{ name: "docs" }]);
  assert(!JSON.stringify(names).includes("never-expose"));
  assert.equal(
    (await f.invoke("mcp.tools", { name: "docs" })).value.tools[0].name,
    "lookup",
  );
  await f.handle.update({ mcpServers: [] });
  await assert.rejects(f.invoke("mcp.tools", { name: "docs" }), /未启用/);
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
