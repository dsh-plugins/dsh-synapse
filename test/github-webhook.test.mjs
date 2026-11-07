import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { defaultsFor } from "@dsh-plugin/dsh-loader/config";
import { Agent } from "../lib/host/agent.js";
import { template, validateConfig } from "../lib/host/config.js";
import { Reviews } from "../lib/host/github.js";
import { newRepository } from "../lib/host/github-repositories.js";
import { Memory } from "../lib/host/memory.js";
import { hostFixture } from "./fixtures/host.mjs";

function eventPayload(event, repo = "Owner/Repo") {
  const target = { number: 7, title: "报告", body: "描述", head: { sha: "abc" }, user: { login: "author" } };
  return {
    action: "opened", repository: { full_name: repo }, sender: { type: "User", login: "author" },
    [event === "issues" ? "issue" : "pull_request"]: target,
  };
}

function fixture(t, overrides = {}) {
  const config = defaultsFor(template.fields);
  Object.assign(config.github, { enabled: true, repositories: [newRepository("owner/repo")], ...overrides });
  Object.assign(config.memory, { enabled: false, learnMemory: false, learnSkills: false });
  const memory = new Memory(":memory:", {}, () => config);
  const cards = [], errors = [];
  const reviews = new Reviews(memory.db, {}, () => config, { notify: (event, payload) => cards.push({ event, payload }) }, error => errors.push(error));
  t.after(async () => { await reviews.close(); memory.close(); });
  const post = async (event, id, { payload = eventPayload(event), sign = false, headers = {} } = {}) => {
    const raw = Buffer.from(JSON.stringify(payload));
    const req = Readable.from([raw]);
    req.headers = { "x-github-event": event, "x-github-delivery": id, ...headers };
    if (sign) {
      req.headers["x-hub-signature-256"] = "sha256=" + createHmac("sha256", config.github.webhookSecret).update(raw).digest("hex");
    }
    const response = {};
    await reviews.webhook(req, {
      writeHead: status => { response.status = status; },
      end: value => { response.data = JSON.parse(value); },
    });
    return response;
  };
  return { config, reviews, memory, cards, errors, post };
}

test("无密钥请求仅发送安全卡片，去重与已验签任务隔离", async t => {
  const f = fixture(t);
  const payload = eventPayload("issues");
  const hostile = `<img src="http://127.0.0.1/private" onerror="fetch('http://localhost')">\n- Other/Repo#42\u2028- #9\u2029{{issue title}} $&`;
  payload.issue.body = hostile;
  payload.issue.title = hostile;
  payload.issue.labels = [{ name: hostile, color: '" onload="bad()' }];
  payload.issue.repository_url = "file:///outside";
  assert.equal((await f.post("issues", "a", { payload })).status, 401);
  f.config.github.allowUnsignedCards = true;
  f.config.github.repositories[0].triageIssues = true;
  assert.doesNotThrow(() => validateConfig(f.config));
  for (const headers of [{ "x-hub-signature-256": "sha256=wrong" }, { "x-hub-signature": "sha1=wrong" }]) {
    assert.equal((await f.post("issues", "a", { payload, headers })).status, 401);
  }
  assert.equal((await f.post("issues", "unknown", { payload: eventPayload("issues", "outside/repo") })).status, 403);
  assert.deepEqual((await f.post("issues", "a", { payload })).data, { accepted: true, review: false, card: true });
  assert.deepEqual((await f.post("issues", "a", { payload })).data, { duplicate: true });
  assert.equal(f.cards.length, 1);
  const issue = f.cards[0].payload.issue;
  assert.doesNotMatch(issue.body, /[\r\n\u2028\u2029]/);
  const dom = new JSDOM(issue.body);
  try {
    assert(!dom.window.document.querySelector("img,script,iframe,a"));
    assert.match(dom.window.document.body.textContent, /Other\/Repo#42/);
  } finally {
    dom.window.close();
  }
  assert(!issue.title.includes("{{issue title}}"));
  assert(!issue.title.includes("$&"));
  assert.equal(issue.labels[0].color, "888888");
  assert.equal(issue.repository_url, "https://api.github.com/repos/Owner/Repo");
  assert.deepEqual(f.reviews.list(), []);
  const row = f.memory.db.prepare("SELECT * FROM deliveries WHERE id='unsigned:a'").get();
  assert.equal(row.state, "ignored");
  assert(!row.payload.includes("127.0.0.1"));
  f.reviews.retry(row.id);
  assert.deepEqual(await f.reviews.review(row), { skipped: "review-disabled" });

  Object.assign(f.config.github, { webhookSecret: "secret", token: "token" });
  const jobs = [];
  f.reviews.review = async job => { jobs.push(job.id); return {}; };
  assert.deepEqual((await f.post("issues", "a", { sign: true })).data, { accepted: true, review: true, card: true });
  await f.reviews.drain();
  assert.deepEqual(jobs, ["a"]);
});

test("逐仓库选择 PR、Issue 和卡片，精确仓库优先于组织规则", async t => {
  const f = fixture(t, {
    webhookSecret: "secret", token: "token", allowUnsignedCards: true,
    repositories: [
      { ...newRepository("owner/*"), triageIssues: true },
      { ...newRepository("OWNER/REPO"), reviewPr: true, sendCards: false },
      newRepository("owner/cards"),
    ],
  });
  const jobs = [];
  f.reviews.review = async job => { jobs.push(job.id); return {}; };
  assert.deepEqual((await f.post("pull_request", "pr", { sign: true })).data, { accepted: true, review: true, card: false });
  assert.deepEqual((await f.post("issues", "no-issue", { sign: true })).data, { accepted: true, review: false, card: false });
  assert.deepEqual((await f.post("pull_request", "unsigned-pr")).data, { accepted: true, review: false, card: false });
  for (const [id, repo, review] of [["triage", "owner/other", true], ["cards", "owner/cards", false]]) {
    assert.deepEqual((await f.post("issues", id, { sign: true, payload: eventPayload("issues", repo) })).data,
      { accepted: true, review, card: true });
  }
  await f.reviews.drain();
  assert.deepEqual(jobs.sort(), ["pr", "triage"]);
  assert.deepEqual(f.cards.map(card => card.payload.repository.full_name), ["owner/other", "owner/cards"]);
});

test("无密钥卡片限流和 Release 去重均与已验签投递隔离", async t => {
  const f = fixture(t, { allowUnsignedCards: true, webhookSecret: "secret" });
  const payload = { repository: { full_name: "Owner/Repo" }, action: "published", release: { id: 99, name: "Release" } };
  for (let i = 0; i < 30; i++) {
    assert.equal((await f.post("release", `card-${i}`, { payload })).status, 202);
  }
  assert.equal((await f.post("release", "rate-limit", { payload })).status, 429);
  assert.equal((await f.post("release", "signed-release", { payload, sign: true })).status, 202);
  assert.equal(f.cards.at(-1).payload.release.id, payload.release.id);
  assert.notEqual(f.cards[0].payload.release.id, f.cards.at(-1).payload.release.id);
  f.memory.db.prepare("UPDATE deliveries SET updated=datetime('now','-2 days') WHERE id GLOB 'unsigned:*'").run();
  assert.equal((await f.post("release", "new-card", { payload })).status, 202);
  assert.equal(f.memory.db.prepare("SELECT count(*) AS n FROM deliveries").get().n, 2);
});

test("Issue 原生回合可追加已读取的标签，写权限不足时保留分诊结果", async t => {
  for (const writable of [true, false]) {
    await t.test(writable ? "有写权限" : "只读凭据", async t => {
      const f = fixture(t, { webhookSecret: "secret", token: "example-token", repositories: [{ ...newRepository("owner/repo"), triageIssues: true }] });
      const profile = await mkdtemp(path.join(os.tmpdir(), "synapse-labels-"));
      const posts = [];
      const host = hostFixture(async ({ tools, signal, message }) => {
        const byName = name => tools.find(tool => tool.name === name);
        const list = byName("synapse_github_list_labels"), add = byName("synapse_github_add_issue_labels");
        assert.match(message.content[0].text, /Issue 分诊/);
        await assert.rejects(add.execute({ labels: ["bug"] }, { signal }), /请先读取/);
        const catalog = await list.execute({}, { signal });
        assert.deepEqual(catalog, { items: [{ name: "bug", description: "故障" }], assigned: ["existing"], nextPage: null });
        await assert.rejects(add.execute({ labels: ["invented"] }, { signal }), /已列出的标签/);
        const receipt = await add.execute({ labels: ["bug", "bug"] }, { signal });
        if (writable) {
          assert.deepEqual(receipt, { added: ["bug"], assigned: ["existing", "bug"] });
          assert.deepEqual(await add.execute({ labels: ["bug"] }, { signal }), { added: [], assigned: ["existing", "bug"] });
        } else {
          assert.match(receipt.error, /Issues 写权限/);
        }
        return "分诊完成";
      });
      const agent = new Agent({ loader: host.loader, config: () => f.config, paths: { home: profile, profile, data: profile },
        memory: f.memory, skills: { retrieve: async () => [] }, mcp: {} });
      f.reviews.agent = agent;
      t.after(async () => { await agent.close(); await rm(profile, { recursive: true, force: true }); });
      t.mock.method(globalThis, "fetch", async (input, options) => {
        const url = new URL(input);
        assert.equal(url.origin, "https://api.github.com");
        assert.equal(options.headers.Authorization, "Bearer example-token");
        assert(options.signal instanceof AbortSignal);
        if (url.pathname === "/repos/Owner/Repo/issues/7") {
          return Response.json({ title: "报告", body: "正文", labels: [{ name: "existing" }] });
        }
        if (url.pathname === "/repos/Owner/Repo/labels") {
          assert.equal(url.searchParams.get("page"), "1");
          return Response.json([{ name: "bug", description: "故障" }]);
        }
        assert.equal(url.pathname, "/repos/Owner/Repo/issues/7/labels");
        assert.equal(options.method, "POST");
        posts.push(JSON.parse(options.body));
        return writable ? Response.json([{ name: "existing" }, { name: "bug" }]) : Response.json({}, { status: 403 });
      });
      await f.post("issues", "issue", { sign: true });
      await f.reviews.drain();
      assert.deepEqual(f.errors, []);
      assert.deepEqual(posts, [{ labels: ["bug"] }]);
      assert.equal(f.reviews.list()[0].state, "complete");
      assert.match(f.reviews.list()[0].result, /分诊完成/);
    });
  }
});
