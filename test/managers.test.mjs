import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { loadClient } from "./fixtures/client.mjs";
import { operationFixture } from "./fixtures/operations.mjs";

test("管理表格与弹窗完成 Skill 预览编辑、MCP 草稿测试保存、Hermes 导入和审查任务重试", async (t) => {
  const dom = new JSDOM("<!doctype html><style>textarea{font:14px/22px sans-serif;padding:6px;border:1px solid;box-sizing:border-box}</style><body></body>", { pretendToBeVisual: true, url: "http://localhost" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  dom.window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  const { createRoot } = await import("react-dom/client");
  const { Simulate } = await import("react-dom/test-utils");
  const { panels } = await loadClient({ realFacade: true });
  const f = await operationFixture();
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const client = {
    read: async () => clone(f.store.read("dsh-synapse")),
    invoke: (_id, operation, request, signal) => f.invoke(operation, clone(request.input), request.resource ? clone(request.resource) : undefined, signal),
  };
  const container = document.body.appendChild(document.createElement("div")), root = createRoot(container);
  t.after(async () => {
    act(() => root.unmount());
    await f.close(); dom.window.close();
    for (const key of ["window", "document", "IS_REACT_ACT_ENVIRONMENT", "ResizeObserver"]) { delete globalThis[key]; }
  });
  async function until(predicate) {
    const deadline = Date.now() + 15000;
    while (!predicate()) {
      assert(Date.now() < deadline, document.body.textContent);
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    }
  }
  async function render(id) {
    const Component = panels.find(panel => panel.id === id).component;
    await act(async () => root.render(React.createElement(Component, { key: id, view: f.store.read("dsh-synapse"), client })));
  }
  const modal = () => document.querySelector(".arco-modal");
  async function click(text, scope = document) {
    const button = [...scope.querySelectorAll("button")].find(button => button.textContent === text);
    assert(button, `${text}: ${scope.textContent}`);
    await act(async () => button.click());
  }
  async function input(selector, value) {
    const element = document.querySelector(selector);
    assert(element, selector);
    await act(async () => Simulate.change(element, { target: { value } }));
  }
  await f.invoke("skills.create", { name: "example", content: "# 预览标题\n旧内容" });
  await render("skills");
  await until(() => container.querySelector("table")?.textContent.includes("example"));
  await click("编辑", container);
  await until(() => modal());
  assert.equal(modal().querySelector("h1").textContent, "预览标题");
  assert.equal(modal().querySelector("textarea"), null);
  await click("编辑", modal());
  await input('textarea[aria-label="Skill Markdown"]', "# 已编辑\n<script>alert(1)</script>");
  await click("保存", modal());
  await until(() => modal()?.querySelector("h1")?.textContent === "已编辑");
  assert.equal(modal().querySelector("h1").textContent, "已编辑");
  assert.equal(modal().querySelector("script"), null);
  assert.equal((await f.service.skills.list())[0].content, "# 已编辑\n<script>alert(1)</script>");
  await click("关闭", modal());
  await until(() => !modal());

  await render("mcp");
  await click("新增 MCP", container);
  await until(() => modal());
  await input("#synapse-mcp-server-name", "fixture");
  await input("#synapse-mcp-server-command", process.execPath);
  const args = [...modal().querySelectorAll(".synapse-config-item")].find(node => node.querySelector("label")?.textContent === "命令参数（每项一个参数）");
  await click("新增", args);
  await input('[id="synapse-mcp-server-args.0"]', fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url)));
  const before = f.handle.get();
  await click("测试并获取工具", modal());
  await until(() => modal()?.querySelector("table")?.textContent.includes("read"));
  assert.deepEqual(f.handle.get(), before);
  assert(modal().textContent.includes("blocked"));
  await click("保存", modal());
  await until(() => !modal());
  assert.equal(f.handle.get().value.mcpServers[0].name, "fixture");
  assert(container.querySelector("table").textContent.includes("fixture"));

  await render("memory-import");
  await click("导入 Hermes 记忆", container);
  await input('textarea[aria-label="Hermes 记忆 Markdown"]', "# User\n偏好简体中文");
  await click("预览", modal());
  assert.equal(modal().querySelector("h1").textContent, "User");
  assert.equal(f.service.memory.list("chat").length, 0);
  await click("确认导入", modal());
  assert.match(f.service.memory.list("chat")[0].text, /偏好简体中文/);
  assert(modal().textContent.includes("新增 1 条"));
  await click("关闭", modal());
  await until(() => !modal());

  const jobs = [{ id: "job", event: "pull_request", state: "failed", attempts: 1, updated: "2026-11-03", target: "foo/bar#114", error: "# 审查失败" }];
  f.service.reviews.list = () => jobs;
  f.service.reviews.retry = id => { assert.equal(id, "job"); jobs[0].state = "pending"; };
  await render("reviews");
  await until(() => container.querySelector("table")?.textContent.includes("foo/bar#114"));
  await click("查看", container);
  await until(() => modal());
  assert.equal(modal().querySelector("h1").textContent, "审查失败");
  await click("关闭", modal());
  await until(() => !modal());
  await click("重试", container);
  assert(container.querySelector("table").textContent.includes("等待处理"));

  await render("activity");
  await until(() => !container.querySelector(".arco-btn-loading"));
  await click("编辑群聊策略", container); await until(() => modal());
  const base = modal().querySelector('input[aria-label="基础概率"]') || modal().querySelector('[aria-label="基础概率"] input');
  assert(base, "概率编辑器需要提供百分比输入");
  await act(async () => { Simulate.change(base, { target: { value: "3.25" } }); Simulate.blur(base); });
  const blockedSelector = 'textarea[aria-label="概率回复屏蔽词"]';
  await input(blockedSelector, "第一项"); await input(blockedSelector, "第一项\n");
  assert.equal(document.querySelector(blockedSelector).value, "第一项\n");
  await input(blockedSelector, "第一项\n第二项");
  const botSelector = 'textarea[aria-label="其他机器人 QQ 号"]';
  await input(botSelector, "111\n"); assert.equal(document.querySelector(botSelector).value, "111\n");
  await input(botSelector, "111\n222");
  await click("保存", modal()); await until(() => !modal());
  assert.equal(f.handle.get().value.activity.probability.baseBps, 325);
  assert.deepEqual(f.handle.get().value.activity.blockedWords, ["第一项", "第二项"]);
  assert.deepEqual(f.handle.get().value.activity.botUsers, [111, 222]);
  await click("编辑群聊策略", container); await until(() => modal());
  await input('input[aria-label="新增群号"]', "123");
  await click("新增群策略", modal());
  assert(modal().querySelector("table").textContent.includes("123"));
  assert(modal().textContent.includes("继承全局参数"));
  await click("保存", modal()); await until(() => !modal());
  assert.equal(f.handle.get().value.activity.groups[0].groupId, 123);

  const invoke = client.invoke;
  let finishSave, pendingSignal;
  client.invoke = (...args) => args[1] === "skills.save" ? new Promise((resolve, reject) => {
    pendingSignal = args[3];
    finishSave = () => invoke(...args).then(resolve, reject);
  }) : invoke(...args);
  await render("skills");
  await until(() => container.querySelector("table")?.textContent.includes("example"));
  await click("编辑", container); await until(() => modal());
  await click("编辑", modal());
  await input('textarea[aria-label="Skill Markdown"]', "# 保存完成");
  await click("保存", modal());
  assert([...modal().querySelectorAll("button")].find(button => button.textContent === "关闭").disabled);
  await act(async () => document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert(modal()); assert(!pendingSignal.aborted);
  await act(async () => finishSave());
  await until(() => modal()?.querySelector("h1")?.textContent === "保存完成");
  await click("关闭", modal()); await until(() => !modal());

  client.invoke = (...args) => ["mcp.test", "memory.import"].includes(args[1]) ? new Promise((_resolve, reject) => {
    pendingSignal = args[3];
    pendingSignal.addEventListener("abort", () => reject(pendingSignal.reason), { once: true });
  }) : invoke(...args);
  await render("mcp");
  await click("编辑", container); await until(() => modal());
  await click("测试并获取工具", modal());
  await click("关闭", modal()); await until(() => !modal());
  assert(pendingSignal.aborted);
  const memories = f.service.memory.list("chat").length;
  await render("memory-import");
  await click("导入 Hermes 记忆", container);
  await input('textarea[aria-label="Hermes 记忆 Markdown"]', "# User\n取消的草稿");
  await click("确认导入", modal());
  await click("取消导入", modal());
  await until(() => ![...modal().querySelectorAll("button")].find(button => button.textContent === "关闭").disabled);
  assert(pendingSignal.aborted);
  assert.equal(f.service.memory.list("chat").length, memories);
  assert(modal().textContent.includes("已取消请求"));
});
