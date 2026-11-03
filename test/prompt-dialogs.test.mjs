import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Agent } from "../lib/host/agent.js";
import { operationFixture } from "./fixtures/operations.mjs";
import { loadClient } from "./fixtures/client.mjs";
import { hostFixture } from "./fixtures/host.mjs";

test("两个提示词弹窗编辑并通过 loader 保存后用于实际 Agent 上下文", async (t) => {
  const f = await operationFixture();
  t.after(() => f.close());
  const { dialogs } = await loadClient();
  const agent = new Agent({ ...f.service, loader: hostFixture().loader });
  t.after(() => agent.close());
  function textarea(element) {
    if (!React.isValidElement(element)) { return; }
    if (element.type === "textarea") { return element; }
    for (const child of React.Children.toArray(element.props.children)) {
      const found = textarea(child);
      if (found) { return found; }
    }
  }
  for (const field of ["memoryPrompt", "skillPrompt"]) {
    const dialog = dialogs.find((item) => item.field[0] === field);
    assert(dialog);
    const before = f.handle.get();
    let draft = before.value[field];
    const props = { value: draft, errors: {}, saving: false, setValue: (value) => { draft = value; } };
    const editor = dialog.component(props);
    const content = `自定义 ${field}\n应根据验证结果主动保存。`;
    textarea(editor).props.onChange({ target: { value: content } });
    assert.equal(f.handle.get().value[field], before.value[field]);
    await f.handle.update({ [field]: draft });
    assert.equal(f.handle.get().value[field], content);
    assert.match(await agent.context("example", "chat"), new RegExp(`自定义 ${field}`));
    const html = renderToStaticMarkup(React.createElement(dialog.component, { ...props, value: draft, saving: true }));
    assert.match(html, /disabled/);
    assert.match(html, new RegExp(`自定义 ${field}`));
  }
  await f.handle.update({ learnMemory: false, learnSkills: false });
  assert(! (await agent.context("example", "review")).includes("自定义"));
});
