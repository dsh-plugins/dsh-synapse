import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { operationFixture } from "./fixtures/operations.mjs";
import { loadClient } from "./fixtures/client.mjs";

test("功能弹窗的嵌套字段可新增、编辑和删除并保留其他配置", async (t) => {
  const dom = new JSDOM("<!doctype html><body></body>");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");
  const { Simulate } = await import("react-dom/test-utils");
  const f = await operationFixture();
  const { dialogs } = await loadClient();
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
  assert.deepEqual(draft.groupFeatures, initial.groupFeatures);
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
  const groupsArray = [...github.querySelectorAll(".synapse-config-item")].find((node) => node.querySelector("label")?.textContent === "推送的 QQ 群");
  click(groupsArray, "新增");
  edit("synapse-modules-github.subscriptions.0.groups.0", "659356928");
  assert.deepEqual(draft.github.subscriptions, [{ repository: "Anvil-Dev/AnvilLib", groups: [659356928] }]);
  assert.deepEqual(draft.management.groups, []);
  await f.handle.update({ modules: draft });
  assert.deepEqual(f.handle.get().value.modules.github.subscriptions, draft.github.subscriptions);

});

test("GitHub 仓库连接表默认只勾选卡片，可独立切换并保存三项功能", async t => {
  const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true, url: "http://localhost" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  dom.window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  const { createRoot } = await import("react-dom/client");
  const { Simulate } = await import("react-dom/test-utils");
  const { dialogs } = await loadClient({ realFacade: true });
  const f = await operationFixture();
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  t.after(async () => {
    act(() => root.unmount());
    await f.close();
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.ResizeObserver;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });
  const dialog = dialogs.find(item => item.id === "github-repositories");
  assert.deepEqual(Array.from(dialog.field), ["github", "repositories"]);
  let reader;
  const setReader = read => { reader = read; return () => { reader = undefined; }; };
  const render = value => root.render(React.createElement(dialog.component, { value, setValue: render, setReader, saving: false }));
  act(() => render(f.handle.get().value.github.repositories));
  const click = label => {
    const button = [...document.querySelectorAll("button")].find(item => item.textContent === label);
    assert(button, label);
    act(() => button.click());
  };
  click("新增仓库");
  const name = document.querySelector('input[placeholder="owner/repo"]');
  act(() => Simulate.change(name, { target: { value: "owner/repo" } }));
  const checkboxes = [...document.querySelectorAll('input[type="checkbox"]')];
  assert.deepEqual(checkboxes.map(box => box.checked), [false, false, true]);
  act(() => checkboxes[0].click());
  act(() => checkboxes[1].click());
  act(() => checkboxes[2].click());
  const repositories = JSON.parse(JSON.stringify(reader()));
  assert.deepEqual(repositories, [{ repository: "owner/repo", reviewPr: true, triageIssues: true, sendCards: false }]);
  const current = f.handle.get();
  await f.handle.update({ github: { ...current.value.github, repositories } }, current.revision);
  assert.deepEqual(f.handle.get().value.github.repositories, repositories);
  click("删除");
  assert.equal(reader().length, 0);
});
