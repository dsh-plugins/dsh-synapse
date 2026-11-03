import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import vm from "node:vm";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { operationFixture } from "./fixtures/operations.mjs";

test("功能与 MCP 弹窗的嵌套字段可新增、编辑和删除并保留其他配置", async (t) => {
  const dom = new JSDOM("<!doctype html><body></body>");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");
  const { Simulate } = await import("react-dom/test-utils");
  const f = await operationFixture();
  const dialogs = [];
  vm.runInNewContext(await readFile(new URL("../lib/client.js", import.meta.url), "utf8"), {
    structuredClone,
    window: { __ModuleLoader__: { load: ({ factory }) => factory(createRequire(import.meta.url)).apply({
      dshLoaderUi: { config: { registerDialog: (_owner, dialog) => dialogs.push(dialog) } },
    }) } },
  });
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  t.after(async () => {
    act(() => root.unmount());
    await f.close();
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });
  let draft;
  function render(field, value) {
    const Component = dialogs.find((dialog) => dialog.field[0] === field).component;
    draft = value;
    function update(next) {
      draft = next;
      root.render(React.createElement(Component, { value: next, errors: {}, saving: false, setValue: update }));
    }
    act(() => update(value));
  }
  function click(scope, label) {
    const button = [...scope.querySelectorAll("button")].find((item) => item.textContent === label);
    assert(button, label);
    act(() => button.click());
  }
  function edit(id, value) {
    const input = document.getElementById(id);
    assert(input, id);
    act(() => Simulate.change(input, { target: { value } }));
  }
  const initial = f.handle.get().value.modules;
  render("modules", initial);
  click(document, "群管理与管理员");
  const groups = () => document.getElementById("synapse-modules-management.groups");
  const management = () => [...document.querySelectorAll("fieldset")].find((node) => node.querySelector("legend")?.textContent === "群管理与管理员");
  click(management(), "新增");
  edit("synapse-modules-management.groups.0", "659356928");
  assert.deepEqual(draft.management.groups, [659356928]);
  assert.deepEqual(draft.minecraft, initial.minecraft);
  click(management(), "群管理与管理员");
  const collapsed = management();
  assert.equal(collapsed.getAttribute("data-expanded"), "false");
  assert.equal(dom.window.getComputedStyle(collapsed).borderStyle, "none");
  click(document, "群管理与管理员");
  click(management(), "删除");
  assert.deepEqual(draft.management.groups, []);
  assert.equal(groups(), null);

  click(document, "GitHub 仓库通知");
  const github = [...document.querySelectorAll("fieldset")].find((node) => node.querySelector("legend")?.textContent === "GitHub 仓库通知");
  click(github, "新增");
  edit("synapse-modules-github.subscriptions.0.repository", "Anvil-Dev/AnvilLib");
  const groupsArray = [...github.querySelectorAll(".synapse-config-item")].find((node) => node.querySelector("label")?.textContent === "启用的 QQ 群");
  click(groupsArray, "新增");
  edit("synapse-modules-github.subscriptions.0.groups.0", "659356928");
  assert.deepEqual(draft.github.subscriptions, [{ repository: "Anvil-Dev/AnvilLib", groups: [659356928] }]);
  assert.deepEqual(draft.management.groups, []);
  await f.handle.update({ modules: draft });
  assert.deepEqual(f.handle.get().value.modules.github.subscriptions, draft.github.subscriptions);

  render("mcpServers", []);
  click(document, "新增 MCP 服务");
  edit("synapse-mcp-0-name", "example");
  edit("synapse-mcp-0-command", "node");
  const args = [...document.querySelectorAll(".synapse-config-item")].find((node) => node.querySelector("label")?.textContent === "命令参数（每项一个参数）");
  click(args, "新增");
  edit("synapse-mcp-0-args.0", "server.mjs");
  assert.equal(draft[0].name, "example");
  assert.equal(draft[0].command, "node");
  assert.deepEqual(draft[0].args, ["server.mjs"]);
  await f.handle.update({ mcpServers: draft });
  assert.deepEqual(f.handle.get().value.mcpServers[0].args, ["server.mjs"]);
});
