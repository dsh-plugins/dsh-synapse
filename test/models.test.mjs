import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultsFor, validateValues } from "@dsh-plugin/dsh-loader/config";
import { template } from "../lib/host/config.js";
import { Agent } from "../lib/host/agent.js";
import { hostFixture } from "./fixtures/host.mjs";

test("聊天与审查模型通过 loader 校验并用于各自任务、自总结和后续消息", async (t) => {
  const chat = { provider: "foo", model: "chat", reasoningEffort: "high" };
  const review = { provider: "bar", model: "review", reasoningEffort: "low" };
  const c = validateValues(template.fields, {
    ...defaultsFor(template.fields),
    chatModel: chat,
    reviewModel: review,
  });
  const selected = [];
  const host = hostFixture(async ({ message, selected: choices }) => {
    selected.push(choices.at(-1));
    return message.content[0].text === "example"
      ? "done"
      : '{"memories":[],"skill":null}';
  });
  const data = await mkdtemp(path.join(os.tmpdir(), "synapse-models-"));
  const agent = new Agent({
    loader: host.loader,
    config: () => c,
    paths: { data, profile: data, home: data },
    memory: { search: async () => [], addMany: async () => {} },
    skills: { retrieve: async () => [] },
    mcp: { available: async () => [] },
    onError: (error) => {
      throw error;
    },
  });
  t.after(async () => {
    await agent.close();
    await rm(data, { recursive: true, force: true });
  });
  const run = (channel) =>
    agent.run(
      "example",
      channel,
      [],
      undefined,
      undefined,
      "",
      undefined,
      `${channel}:example`,
    );
  await run("chat");
  await run("review");
  assert.deepEqual(selected, [chat, chat, review, review]);
  c.chatModel = { provider: "foo", model: "changed" };
  await run("chat");
  assert.deepEqual(selected.slice(-2), [c.chatModel, c.chatModel]);
  c.chatModel = null;
  c.reviewModel = null;
  const fallback = { provider: "example", model: "default" };
  host.select(fallback);
  await run("chat");
  await run("review");
  assert.deepEqual(selected.slice(-4), [
    fallback,
    fallback,
    fallback,
    fallback,
  ]);
});

test("显式选择模型后无需配置宿主默认模型", async (t) => {
  const model = { provider: "foo", model: "example" };
  const host = hostFixture();
  host.select(undefined);
  const data = await mkdtemp(path.join(os.tmpdir(), "synapse-models-"));
  const agent = new Agent({
    loader: host.loader,
    config: () => ({
      ...defaultsFor(template.fields),
      chatModel: model,
      learnSkills: false,
      learnMemory: false,
      ragEnabled: false,
    }),
    paths: { data, profile: data, home: data },
    memory: {},
    skills: { retrieve: async () => [] },
    mcp: { available: async () => [] },
  });
  t.after(async () => {
    await agent.close();
    await rm(data, { recursive: true, force: true });
  });
  assert.equal(
    await agent.run(
      "example",
      "chat",
      [],
      undefined,
      undefined,
      "",
      undefined,
      "chat:example",
    ),
    "done",
  );
  assert.deepEqual(host.created[0].options.agentOptions, model);
});
