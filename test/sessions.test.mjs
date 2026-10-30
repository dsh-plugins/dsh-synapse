import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultsFor } from "@dsh-plugin/dsh-loader/config";
import { template } from "../lib/host/config.js";
import { Agent } from "../lib/host/agent.js";
import { chatSessionKey } from "../lib/host/session-bindings.js";
import { hostFixture } from "./fixtures/host.mjs";

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function fixture(execute) {
  const home = await mkdtemp(path.join(os.tmpdir(), "synapse-sessions-"));
  const paths = {
    home,
    profile: path.join(home, "profiles/test"),
    data: path.join(home, "profiles/test/data/dsh-synapse"),
  };
  await mkdir(paths.profile, { recursive: true });
  const config = {
    ...defaultsFor(template.fields),
    ragEnabled: false,
    learnMemory: false,
    learnSkills: false,
  };
  const host = hostFixture(execute);
  const create = () =>
    new Agent({
      loader: host.loader,
      paths,
      config: () => config,
      memory: {},
      skills: { retrieve: async () => [] },
      mcp: { available: async () => [] },
    });
  return { host, paths, create };
}
const run = (agent, input, key = "chat:group:123", signal, history = []) =>
  agent.run(input, "chat", history, signal, undefined, "", undefined, key);

test("group/bridge speakers share one binding; private chats are separate", () => {
  assert.equal(
    chatSessionKey("group_123_user_1"),
    chatSessionKey("group_123_user_dc:999"),
  );
  assert.equal(chatSessionKey("group_123"), "chat:group:123");
  assert.notEqual(chatSessionKey("user_123"), chatSessionKey("group_123"));
  assert.throws(() => chatSessionKey(undefined), /会话标识/);
  assert.throws(() => chatSessionKey("review:github:owner/repo"), /会话标识/);
});

test(
  "resident native sessions queue FIFO, run other conversations concurrently, and skip cancelled waiting messages",
  { timeout: 10000 },
  async () => {
    const gate = deferred(),
      entered = deferred(),
      starts = [];
    const f = await fixture(async ({ message }) => {
      const text = message.content[0].text;
      starts.push(text);
      if (text === "first") {
        entered.resolve();
        await gate.promise;
      }
      return text + " answer";
    });
    const agent = f.create();
    try {
      const history = [{ role: "user", content: "legacy-history" }];
      const first = run(agent, "first", undefined, undefined, history);
      await entered.promise;
      const second = run(agent, "second", undefined, undefined, history);
      const abort = new AbortController();
      const cancelled = assert.rejects(
        run(agent, "cancelled", undefined, abort.signal),
        /abort/i,
      );
      const fourth = run(agent, "fourth");
      abort.abort();
      await cancelled;
      assert.equal(await run(agent, "other", "chat:user:123"), "other answer");
      assert.deepEqual(starts, ["first", "other"]);
      gate.resolve();
      assert.deepEqual(await Promise.all([first, second, fourth]), [
        "first answer",
        "second answer",
        "fourth answer",
      ]);
      assert.deepEqual(starts, ["first", "other", "second", "fourth"]);
      assert.equal(f.host.created.length, 2);
      assert.equal(f.host.created[0].injected.length, 1);
      assert.equal(f.host.disposed.length, 0);
    } finally {
      gate.resolve();
      await agent.close();
    }
    assert.equal(f.host.disposed.length, 2);
  },
);

test(
  "reset cancels the active/queued turns and creates a durable fresh binding without old history",
  { timeout: 10000 },
  async () => {
    const entered = deferred();
    const f = await fixture(async ({ message, signal }) => {
      if (message.content[0].text === "active") {
        entered.resolve();
        await new Promise((r) =>
          signal.addEventListener("abort", r, { once: true }),
        );
        signal.throwIfAborted();
      }
      return "done";
    });
    const agent = f.create();
    try {
      const active = assert.rejects(run(agent, "active"), /清空/);
      await entered.promise;
      const queued = assert.rejects(run(agent, "queued"), /清空/);
      await agent.reset("chat:group:123");
      await Promise.all([active, queued]);
      await run(agent, "new", undefined, undefined, [
        { role: "user", content: "stale" },
      ]);
      assert.equal(f.host.created.length, 2);
      assert.notEqual(f.host.created[0].agent.id, f.host.created[1].agent.id);
      assert.equal(f.host.created[1].injected.length, 0);
    } finally {
      await agent.close();
    }
    const reloaded = f.create();
    try {
      await run(reloaded, "after reload");
      assert.equal(f.host.resumed[0].agent.id, f.host.created[1].agent.id);
      assert(!JSON.stringify(f.host.resumed[0].conversation).includes("stale"));
    } finally {
      await reloaded.close();
    }
  },
);

test("failed turns do not block followers; reloading restores history and refreshes prompt/model", async () => {
  const seen = [];
  const f = await fixture(async ({ message, variables, selected }) => {
    seen.push({
      prompt: variables.get("synapse_context")(),
      selected: selected.at(-1),
    });
    if (message.content[0].text === "failure") throw new Error("model failure");
    return "reply";
  });
  const agent = f.create();
  try {
    const failure = assert.rejects(run(agent, "failure"), /model failure/);
    const next = run(agent, "next");
    await failure;
    await next;
    assert.equal(f.host.created.length, 1);
  } finally {
    await agent.close();
  }
  await writeFile(path.join(f.paths.profile, "SOUL.md"), "updated persona");
  f.host.select({ provider: "new-provider", model: "new-model" });
  const reloaded = f.create();
  try {
    await run(reloaded, "resumed");
    assert.equal(f.host.resumed.length, 1);
    assert.equal(f.host.created[0].agent.id, f.host.resumed[0].agent.id);
    assert.match(JSON.stringify(f.host.resumed[0].conversation), /next/);
    assert.match(seen.at(-1).prompt, /updated persona/);
    assert.equal(seen.at(-1).selected.model, "new-model");
  } finally {
    await reloaded.close();
  }
});
