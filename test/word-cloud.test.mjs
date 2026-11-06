import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { CloudStore } from "../lib/host/word-cloud-core.js";
import { operationFixture } from "./fixtures/operations.mjs";
import { defaultsFor } from "@dsh-plugin/dsh-loader/config";
import { template } from "../lib/host/config.js";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { loadClient } from "./fixtures/client.mjs";

const epoch = Date.parse("2026-11-06T04:00:00Z");

test("词云快照展示全部词，热词标记与消息触发使用同一排名和加成", () => {
  const store = new CloudStore(":memory:"), settings = defaultsFor(template.fields).activity;
  settings.blockedWords = ["blockedtoken"];
  try {
    const words = Array.from({ length: 25 }, (_, i) => `topic${String(i).padStart(2, "0")}`).join(" ");
    for (let id = 0; id < 3; id++) { store.observe("123", `topics-${id}`, "1", words, epoch, epoch); }
    for (let id = 0; id < 6; id++) { store.observe("123", `hot-${id}`, "1", "铁砧 铁砧", epoch, epoch); }
    store.observe("123", "low", "2", "冷门", epoch, epoch);
    store.observe("123", "blocked", "2", "blockedtoken", epoch, epoch);
    store.observe("123", "expired", "2", "expiredtoken", epoch - 49 * 3600000, epoch);
    store.observe("456", "other", "2", "othergroup", epoch, epoch);
    const snapshot = store.snapshot("123", epoch, settings);
    assert.equal(snapshot.length, 28);
    assert.equal(snapshot.filter(item => item.eligible).length, 20);
    assert.equal(snapshot.find(item => item.word === "铁砧").messages, 6);
    assert.equal(snapshot.find(item => item.word === "冷门").eligible, false);
    assert.equal(snapshot.find(item => item.word === "blockedtoken").blocked, true);
    assert.ok(snapshot.some(item => item.messages >= 3 && !item.eligible));
    assert.ok(!snapshot.some(item => /expiredtoken|othergroup/.test(item.word)));
    for (const term of snapshot) {
      assert.equal(store.evaluate("123", term.word, epoch, settings).boost, term.boost);
    }
    assert.deepEqual(store.snapshot("123", epoch, settings), snapshot);
    const decayed = store.snapshot("123", epoch + 18 * 3600000, settings).find(item => item.word === "铁砧");
    assert.equal(decayed.weight, snapshot.find(item => item.word === "铁砧").weight / 2);
    store.removeUsers(["2"]);
    assert.ok(!store.snapshot("123", epoch, settings).some(item => item.word === "冷门"));
  } finally { store.close(); }
});

async function fixture(t) {
  const f = await operationFixture({ wordCloud: true });
  t.after(() => f.close());
  const current = f.handle.get(), value = structuredClone(current.value);
  value.enabled = true; value.modules.chat.groups = [123, 456];
  value.activity.probabilityEnabled = true;
  value.activity.blockedWords = ["blockedtoken"];
  const { probability, idle, words, blockedWords } = structuredClone(value.activity);
  value.activity.groups = [{ groupId: 123, probabilityEnabled: true, idleEnabled: false, useDefaults: false,
    probability: { ...probability, baseBps: 125, maxBps: 350 }, idle, words, blockedWords }];
  await f.handle.update({ enabled: value.enabled, modules: value.modules, activity: value.activity }, current.revision);
  f.service.activity.identity("42");
  const now = Date.now(); await f.cloud.recover(now);
  const writer = new CloudStore(path.join(f.paths.data, "chat-state.sqlite"));
  try {
    for (let id = 0; id < 4; id++) { writer.observe("123", `hot-${id}`, "7", "铁砧", now, now); }
    writer.observe("123", "low", "7", "冷门 blockedtoken", now, now);
    writer.observe("456", "other", "7", "othergroup", now, now);
  } finally { writer.close(); }
  return f;
}

test("设置页词云操作读取真实工作线程，概率使用群覆盖与上限且不修改配置或词频", async t => {
  const f = await fixture(t), before = f.handle.get();
  const { value: result } = await f.invoke("activity.words", { groupId: "123" });
  assert.equal(result.enabled, true);
  assert.equal(result.items.find(item => item.word === "铁砧").probabilityBps, 350);
  assert.equal(result.items.find(item => item.word === "冷门").probabilityBps, 125);
  assert.equal(result.items.find(item => item.word === "blockedtoken").probabilityBps, 0);
  assert.ok(!result.items.some(item => item.word === "othergroup"));
  const repeated = (await f.invoke("activity.words", { groupId: "123" })).value;
  assert.deepEqual(repeated.items.map(item => [item.word, item.messages]), result.items.map(item => [item.word, item.messages]));
  assert.deepEqual(f.handle.get(), before);
  await assert.rejects(f.invoke("activity.words", { groupId: "999" }), /未启用|不存在/);
  await assert.rejects(f.invoke("activity.words", { groupId: "../123" }), /未启用|不存在/);
  await assert.rejects(f.invoke("activity.words", { groupId: "123" }, undefined, AbortSignal.abort()), /取消|abort/i);
  assert.deepEqual((await f.invoke("activity.words", { groupId: "456" })).value.items.map(item => item.word), ["othergroup"]);
  const current = f.handle.get();
  await f.handle.update({ activity: { ...current.value.activity, probabilityEnabled: false } }, current.revision);
  assert.equal((await f.invoke("activity.words", { groupId: "123" })).value.enabled, false);
  await f.cloud.close();
  await assert.rejects(f.invoke("activity.words", { groupId: "123" }), /词云统计暂时不可用/);
});

test("词云按钮打开 Arco 弹窗，大小字重与悬浮概率正确，支持刷新、空状态、重试和关闭取消", async t => {
  const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true, url: "http://localhost" });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  dom.window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  const f = await fixture(t);
  const { createRoot } = await import("react-dom/client");
  const { Simulate } = await import("react-dom/test-utils");
  const { panels } = await loadClient({ realFacade: true });
  const Panel = panels.find(item => item.id === "activity").component;
  let mode = "normal", pendingSignal;
  const clone = value => JSON.parse(JSON.stringify(value));
  const client = { invoke: (_id, operation, request, signal) => {
    if (operation === "activity.words") {
      if (mode === "error") { return Promise.reject(new Error("词云读取测试失败")); }
      if (mode === "pending") {
        pendingSignal = signal;
        return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }
    }
    return f.invoke(operation, clone(request.input), request.resource, signal);
  } };
  const container = document.body.appendChild(document.createElement("div")), root = createRoot(container);
  t.after(() => {
    act(() => root.unmount()); dom.window.close();
    for (const key of ["window", "document", "IS_REACT_ACT_ENVIRONMENT", "ResizeObserver"]) { delete globalThis[key]; }
  });
  const until = async predicate => {
    const deadline = Date.now() + 10000;
    while (!predicate()) { assert.ok(Date.now() < deadline, document.body.textContent); await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); }
  };
  const modal = () => document.querySelector(".arco-modal");
  const click = async (text, scope = document) => {
    const button = [...scope.querySelectorAll("button")].find(item => item.textContent === text);
    assert.ok(button, `${text}: ${scope.textContent}`); await act(async () => button.click());
  };
  const row = id => [...container.querySelectorAll("tr")].find(item => item.textContent.includes(`（${id}）`));
  await act(async () => root.render(React.createElement(Panel, { view: f.store.read("dsh-synapse"), client })));
  await until(() => row("123"));
  assert.ok(container.querySelector("thead").textContent.includes("操作"));
  await click("显示词云", row("123"));
  await until(() => modal()?.querySelector('[aria-label="群聊词频"]'));
  const terms = [...modal().querySelectorAll(".synapse-cloud-word")];
  assert.equal(terms.length, 3);
  const hot = terms.find(item => item.textContent === "铁砧"), low = terms.find(item => item.textContent === "冷门");
  assert.ok(parseFloat(hot.style.fontSize) > parseFloat(low.style.fontSize));
  assert.ok(Number(hot.style.fontWeight) > Number(low.style.fontWeight));
  assert.ok(hot.classList.contains("is-hot")); assert.ok(!low.classList.contains("is-hot"));
  await act(async () => Simulate.mouseEnter(hot));
  await until(() => document.querySelector(".arco-tooltip-content")?.textContent.includes("3.50%"));
  assert.ok(document.querySelector(".arco-tooltip-content").textContent.includes("参与热词加成"));
  await act(async () => { Simulate.mouseLeave(hot); Simulate.focus(low); });
  await until(() => [...document.querySelectorAll(".arco-tooltip-content")].some(item => item.textContent.includes("1.25%") && item.textContent.includes("未达到 3 条消息")));
  await act(async () => Simulate.blur(low));
  mode = "error"; await click("刷新词云", modal());
  await until(() => modal()?.textContent.includes("词云读取测试失败"));
  mode = "normal"; await click("刷新词云", modal());
  await until(() => !modal()?.textContent.includes("词云读取测试失败"));
  await click("关闭", modal()); await until(() => !modal());
  await click("显示词云", row("456"));
  await until(() => modal()?.querySelector(".synapse-cloud-word")?.textContent === "othergroup");
  assert.ok(modal().textContent.includes("概率回复已关闭"));
  await click("关闭", modal()); await until(() => !modal());
  await f.cloud.removeUsers(["7"]);
  await click("显示词云", row("123"));
  await until(() => modal()?.textContent.includes("统计窗口内暂无词频"));
  await click("关闭", modal()); await until(() => !modal());
  mode = "pending"; await click("显示词云", row("123"));
  await until(() => pendingSignal);
  await click("关闭", modal()); await until(() => !modal());
  assert.equal(pendingSignal.aborted, true);
});
