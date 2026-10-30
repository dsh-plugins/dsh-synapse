import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { defaultsFor } from "@dsh-plugin/dsh-loader/config";
import { template, validateConfig } from "../lib/host/config.js";
import { SkillStore, promptFor, pathsFor } from "../lib/host/files.js";
import { Memory, parseHermes } from "../lib/host/memory.js";
import {
  verifySignature,
  repositoryAllowed,
  Reviews,
} from "../lib/host/github.js";
import { hostFixture } from "./fixtures/host.mjs";
import { Agent } from "../lib/host/agent.js";
import { Gateway } from "../lib/host/gateway.js";
import { browserAuthorized } from "../lib/host/http.js";
const config = () => defaultsFor(template.fields);
const fixture = async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "synapse-"));
  const profile = path.join(home, "profiles", "test");
  await mkdir(profile, { recursive: true });
  return {
    home,
    profile,
    skills: path.join(profile, "skills"),
    data: path.join(profile, "data", "dsh-synapse"),
  };
};
const inference = {
  async embed(text) {
    const v = Array(512).fill(0);
    v[text.includes("猫") ? 0 : 1] = 1;
    return v;
  },
  async rerank(q, docs) {
    return docs.map((t) => (t.includes("重排") ? 1 : 0));
  },
};
test("defaults form valid config and reject invalid structured fields", () => {
  const c = config();
  assert.equal(validateConfig(c), c);
  assert.throws(() => validateConfig({ ...c, mcpServers: [{ name: "x" }] }));
  assert.throws(() => validateConfig({ ...c, githubEnabled: true }));
  assert.throws(() => validateConfig({ ...c, recallK: 1.5 }));
});
test("profile prompt overrides home; chat and review use distinct files", async () => {
  const p = await fixture();
  await writeFile(path.join(p.home, "SOUL.md"), "home soul");
  await writeFile(path.join(p.home, "AGENTS.md"), "home review");
  assert.equal(await promptFor(p, "chat"), "home soul");
  await writeFile(path.join(p.profile, "SOUL.md"), "profile soul");
  assert.equal(await promptFor(p, "chat"), "profile soul");
  assert.equal(await promptFor(p, "review"), "home review");
  assert.equal(pathsFor({}, { profileDir: p.profile }).home, p.home);
  assert.throws(() => pathsFor({}, {}));
});
test("skills import, edit conflicts, inheritance, retrieval, deletion and traversal", async () => {
  const p = await fixture();
  const skills = new SkillStore(p);
  await mkdir(path.join(p.home, "skills"), { recursive: true });
  await writeFile(path.join(p.home, "skills", "global.md"), "global reference");
  const saved = await skills.save(
    "testing",
    "# Testing\nUse assert for tests.",
  );
  assert.equal((await skills.retrieve("assert", "chat")).length, 1);
  await assert.rejects(skills.save("testing", "changed", null), /已变更/);
  await assert.rejects(skills.save("../escape", "oops"), /名称无效/);
  await skills.save("testing", "Updated procedure", saved.revision);
  const now = (await skills.list()).find((s) => s.name === "testing");
  await skills.remove("testing", now.revision);
  assert.equal((await skills.list()).length, 1);
  await assert.rejects(skills.remove("global", "anything"), /当前 profile/);
});
test("Hermes headings, frontmatter, fenced text, CRLF, and categories", () => {
  const entries = parseHermes(
    "---\r\nname: memory\r\n---\r\n# 用户\r\n喜欢猫\r\n## 项目\r\n```md\r\n# this is code\r\n```",
    "review",
  );
  assert.equal(entries.length, 2);
  assert.equal(entries[0].channel, "review");
  assert.match(entries[1].text, /# this is code/);
  assert.throws(() => parseHermes("test", "unknown"));
  assert.equal(parseHermes("").length, 0);
});
test("actual sqlite-vec + FTS5 hybrid retrieval isolates channels and deduplicates", async () => {
  const c = config();
  const memory = new Memory(":memory:", inference, () => c);
  try {
    await memory.addMany([
      { channel: "chat", source: "test", text: "猫喜欢鱼" },
      { channel: "review", source: "test", text: "猫审查代码" },
      { channel: "chat", source: "test", text: "代码重排" },
    ]);
    const result = await memory.addMany([
      { channel: "chat", source: "hermes", text: "猫喜欢鱼" },
    ]);
    assert.equal(result.inserted, 0);
    const found = await memory.search("猫", "chat");
    assert.equal(found[0].text, "猫喜欢鱼");
    assert(found.every((x) => x.channel === "chat"));
    c.reranker = true;
    assert.equal((await memory.search("代码", "chat"))[0].text, "代码重排");
    assert.equal(memory.list("review").length, 1);
  } finally {
    memory.close();
  }
});
test("embedding failure does not partially import a batch", async () => {
  let i = 0;
  const memory = new Memory(
    ":memory:",
    {
      async embed() {
        if (i++) throw new Error("download failed");
        return Array(512).fill(0);
      },
    },
    config,
  );
  try {
    await assert.rejects(
      memory.addMany(parseHermes("# A\none\n# B\ntwo")),
      /download failed/,
    );
    assert.equal(memory.list("chat").length, 0);
  } finally {
    memory.close();
  }
});
test("signature validation uses raw bytes and repository allowlists", () => {
  const raw = Buffer.from('{ "a": 1 }'),
    secret = "secret",
    signature =
      "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  assert(verifySignature(raw, secret, signature));
  assert(!verifySignature(Buffer.from('{"a":1}'), secret, signature));
  assert(!verifySignature(raw, "", signature));
  assert(repositoryAllowed("Owner/Repo", "owner/*"));
  assert(!repositoryAllowed("owner-evil/repo", "owner/*"));
  assert(!repositoryAllowed("../repo", "owner/*"));
});
test("cross-site and unavailable browser authentication are denied", () => {
  let status;
  const res = {
    writeHead(s) {
      status = s;
    },
    end() {},
  };
  assert.equal(
    browserAuthorized(
      { dshLoader: { services: { get: () => undefined } } },
      { headers: {} },
      res,
    ),
    false,
  );
  assert.equal(status, 503);
  assert.equal(
    browserAuthorized({}, { headers: { "sec-fetch-site": "cross-site" } }, res),
    false,
  );
  assert.equal(status, 403);
});
test("agent injects SOUL, retrieved skill and memory; tools execute only in chat", async () => {
  const p = await fixture();
  await writeFile(path.join(p.profile, "SOUL.md"), "shared soul");
  const c = { ...config(), learnSkills: false, learnMemory: false };
  let calls = 0;
  const host = hostFixture(
    async ({ variables, tools, restrictions, options }) => {
      assert.deepEqual(restrictions, [{ allow: [] }]);
      assert.equal(options.agentOptions.model, "configured-model");
      assert.match(
        variables.get("synapse_context")(),
        /shared soul|Review changes/,
      );
      assert.match(variables.get("synapse_context")(), /durable/);
      if (tools.length)
        await tools[0].execute({}, { signal: new AbortController().signal });
      return "done";
    },
  );
  const a = new Agent({
    loader: host.loader,
    paths: p,
    config: () => c,
    memory: { search: async () => [{ text: "durable", source: "test" }] },
    skills: { retrieve: async () => [{ content: "skill procedure" }] },
    mcp: {
      available: async () => [
        {
          name: "mcp_0",
          server: "test",
          rawName: "read",
          parameters: { type: "object" },
        },
      ],
      call: async () => {
        calls++;
        return { content: "ok" };
      },
    },
  });
  assert.equal(await a.run("question"), "done");
  assert.equal(calls, 1);
  assert.equal(await a.run("question", "review"), "done");
  assert.equal(calls, 1);
  assert.equal(host.disposed.length, 2);
  await a.close();
});
test("Gateway authenticates, serves replayable completion events, and stops runs", async () => {
  const g = new Gateway({ run: async () => "hello" }, config, () => {});
  await g.start();
  try {
    assert.equal((await fetch(g.url + "/v1/runs")).status, 401);
    const headers = {
      Authorization: `Bearer ${g.token}`,
      "Content-Type": "application/json",
    };
    const response = await fetch(g.url + "/v1/runs", {
      method: "POST",
      headers,
      body: JSON.stringify({ input: "hi" }),
    });
    const { run_id } = await response.json();
    const events = await (
      await fetch(g.url + `/v1/runs/${run_id}/events`, { headers })
    ).text();
    assert.match(events, /run.completed/);
    assert.match(events, /hello/);
  } finally {
    await g.close();
  }
});
test("Gateway routes single-use DSH approval and cancels pending approval on stop", async () => {
  const g = new Gateway(
    {
      run: async (
        _input,
        _channel,
        _history,
        signal,
        _event,
        _instructions,
        ask,
      ) => ask({ toolName: "docs/read", signal }),
    },
    config,
    () => {},
  );
  await g.start();
  const headers = {
    Authorization: `Bearer ${g.token}`,
    "Content-Type": "application/json",
  };
  const post = (url, value = {}) =>
    fetch(g.url + url, {
      method: "POST",
      headers,
      body: JSON.stringify(value),
    });
  try {
    const { run_id: first } = await (
      await post("/v1/runs", { input: "read" })
    ).json();
    assert.equal(
      (await post(`/v1/runs/${first}/approval`, { choice: "always" })).status,
      400,
    );
    assert.equal(
      (await post(`/v1/runs/${first}/approval`, { choice: "once" })).status,
      200,
    );
    const events = await (
      await fetch(g.url + `/v1/runs/${first}/events`, { headers })
    ).text();
    assert.match(events, /approval.request/);
    assert.match(events, /allowed-once/);
    assert.equal(
      (await post(`/v1/runs/${first}/approval`, { choice: "once" })).status,
      409,
    );
    const { run_id: second } = await (
      await post("/v1/runs", { input: "read" })
    ).json();
    await post(`/v1/runs/${second}/stop`);
    assert.match(
      await (
        await fetch(g.url + `/v1/runs/${second}/events`, { headers })
      ).text(),
      /cancelled/,
    );
  } finally {
    await g.close();
  }
});
test("durable GitHub queue creates head-bound review, deduplicates publication and skips stale heads", async () => {
  const memory = new Memory(":memory:", inference, config);
  const c = {
    ...config(),
    githubEnabled: true,
    publishReviews: true,
    repositories: "owner/repo",
  };
  const r = new Reviews(
    memory.db,
    { run: async () => "Finding" },
    () => c,
    { notify() {} },
    () => {},
  );
  const posted = [];
  r.api = async (route, options) => {
    if (options) {
      posted.push(JSON.parse(options.body));
      return {};
    }
    if (route.includes("/reviews?")) return [];
    if (route.includes("/files?"))
      return [{ filename: "a.js", patch: "+ bad()" }];
    return { title: "PR", body: "body", head: { sha: "abc" } };
  };
  const job = {
    id: "delivery",
    event: "pull_request",
    payload: JSON.stringify({
      number: 1,
      repository: { full_name: "owner/repo" },
      pull_request: { head: { sha: "abc" } },
    }),
  };
  assert.equal((await r.review(job)).published, true);
  assert.equal(posted[0].commit_id, "abc");
  assert.match(posted[0].body, /dsh-synapse:delivery/);
  job.payload = job.payload.replace("abc", "old");
  assert.equal((await r.review(job)).skipped, "superseded-head");
  await r.close();
  memory.close();
});
