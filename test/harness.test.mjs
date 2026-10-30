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
