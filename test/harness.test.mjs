import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { defaultsFor } from "@dsh-plugin/dsh-loader/config";
import { template } from "../lib/host/config.js";
import { Harness } from "../lib/host/harness.js";
import { hostFixture } from "./fixtures/host.mjs";

test("native runs inherit current host selection, import attachments and dispose on cancellation", async () => {
  const c = defaultsFor(template.fields);
  const host = hostFixture(async ({ message, signal }) => {
    if (message.content[0].text === "cancel") {
      await new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true }),
      );
      signal.throwIfAborted();
    }
    return "done";
  });
  const harness = new Harness(
    host.loader,
    () => c,
    { data: await mkdtemp(path.join(os.tmpdir(), "synapse-harness-")) },
    {},
  );
  try {
    await harness.run("SOUL", [
      { type: "image_url", image_url: { url: "data:image/png;base64,YWJj" } },
    ]);
    assert.equal(host.attachments[0].data.toString(), "abc");
    host.select({
      provider: "changed",
      model: "new-model",
      reasoningEffort: "high",
    });
    await harness.run("SOUL", "hello");
    assert.deepEqual(host.created[1].options.agentOptions, {
      provider: "changed",
      model: "new-model",
      reasoningEffort: "high",
    });
    const controller = new AbortController();
    const task = harness.run("SOUL", "cancel", [], [], controller.signal);
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(task, /abort/i);
    assert.equal(host.created.length, host.disposed.length);
  } finally {
    await harness.close();
  }
});

test("native host errors propagate and approval answers stay in the requesting agent", async () => {
  const host = hostFixture(async ({ approve }) => {
    assert.equal(
      await approve({ toolName: "fixture/read", reason: "policy" }),
      "rejected",
    );
    throw new Error("host failure");
  });
  const harness = new Harness(
    host.loader,
    () => defaultsFor(template.fields),
    { data: await mkdtemp(path.join(os.tmpdir(), "synapse-harness-")) },
    {},
  );
  try {
    const seen = [];
    await assert.rejects(
      harness.run(
        "SOUL",
        "hello",
        [],
        [],
        undefined,
        undefined,
        async (req) => {
          seen.push(req);
          return "rejected";
        },
      ),
      /host failure/,
    );
    assert.equal(seen[0].toolName, "fixture/read");
    assert.equal(host.disposed.length, 1);
  } finally {
    await harness.close();
  }
});

test("every new Synapse session uses the selected native permission preset before its first turn", async () => {
  const c = defaultsFor(template.fields);
  const host = hostFixture(async ({ options }) => {
    const applied = host.permissionWrites.at(-1);
    assert.equal(applied.sessionId, options.sessionId);
    assert.equal(applied.preset, c.sessionPermission);
    return "done";
  });
  const harness = new Harness(
    host.loader,
    () => c,
    { data: await mkdtemp(path.join(os.tmpdir(), "synapse-permissions-")) },
    {},
  );
  try {
    for (const preset of host.permissions.names) {
      c.sessionPermission = preset;
      for (const key of [
        "chat:group:123",
        "chat:user:456",
        "review:github:owner/repo",
        undefined,
      ])
        await harness.run(
          "context",
          "hello",
          [],
          [],
          undefined,
          undefined,
          undefined,
          key && `${key}-${preset}`,
        );
    }
    assert.equal(host.permissionWrites.length, 16);
  } finally {
    await harness.close();
  }
});

test("permission changes affect new/reset sessions while residents and persisted restores retain their permissions", async () => {
  const c = defaultsFor(template.fields),
    host = hostFixture(),
    paths = {
      data: await mkdtemp(path.join(os.tmpdir(), "synapse-permissions-")),
    };
  const create = () => new Harness(host.loader, () => c, paths, {});
  let harness = create();
  const run = (key = "chat:group:123") =>
    harness.run(
      "context",
      "hello",
      [],
      [],
      undefined,
      undefined,
      undefined,
      key,
    );
  try {
    await run();
    const id = host.created[0].agent.id;
    c.sessionPermission = "workspace-write";
    await run();
    assert.deepEqual(host.permissionWrites, [
      { sessionId: id, preset: "read-only" },
    ]);
    await run("chat:user:456");
    assert.equal(host.permissionWrites.at(-1).preset, "workspace-write");
    await harness.close();
    harness = create();
    c.sessionPermission = "danger-full-access";
    await run();
    assert.equal(host.resumed[0].agent.id, id);
    assert.equal(
      host.resumed[0].agent.session.events.at(-1).data.preset,
      "read-only",
    );
    assert.equal(host.permissionWrites.length, 2);
    await harness.reset("chat:group:123");
    await run();
    assert.notEqual(host.permissionWrites.at(-1).sessionId, id);
    assert.equal(host.permissionWrites.at(-1).preset, "danger-full-access");
  } finally {
    await harness.close();
  }
});

test("unavailable Auto integration or native permission writer blocks new sessions without falling back", async () => {
  const c = { ...defaultsFor(template.fields), sessionPermission: "auto" },
    host = hostFixture();
  host.permissions.names = host.permissions.names.filter(
    (name) => name !== "auto",
  );
  const harness = new Harness(
    host.loader,
    () => c,
    { data: await mkdtemp(path.join(os.tmpdir(), "synapse-permissions-")) },
    {},
  );
  try {
    await assert.rejects(
      harness.run("context", "hello"),
      /@deepseek-ai\/dsh-experimental-auto-review/,
    );
    assert.equal(host.created.length, 0);
    assert.equal(host.permissionWrites.length, 0);
    host.permissions.names.push("auto");
    await harness.run("context", "hello");
    assert.equal(host.permissionWrites.at(-1).preset, "auto");
    host.permissions.set = () => {
      throw new Error("integration is closing");
    };
    await assert.rejects(
      harness.run("context", "hello"),
      /integration is closing/,
    );
    host.permissions.set = undefined;
    await assert.rejects(harness.run("context", "hello"), /权限预设服务不可用/);
  } finally {
    await harness.close();
  }
});
