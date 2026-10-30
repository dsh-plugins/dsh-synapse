import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";
import { defaultsFor } from "@dsh-plugin/dsh-loader/config";
import { template } from "../lib/host/config.js";
test("panel renders persisted configuration, skills, MCP and Hermes import without HTML execution", async () => {
  const html = await readFile(
    new URL("../src/panel.html", import.meta.url),
    "utf8",
  );
  const source = await readFile(
    new URL("../lib/host/panel.js", import.meta.url),
    "utf8",
  );
  const dom = new JSDOM(html, {
    url: "http://localhost/synapse",
    runScripts: "outside-only",
  });
  const w = dom.window,
    calls = [];
  w.structuredClone = structuredClone;
  w.confirm = () => true;
  w.fetch = async (url, options) => {
    calls.push([url, options]);
    let data;
    if (url.startsWith("/api/dshloader/config"))
      data = {
        ok: true,
        value: { value: defaultsFor(template.fields), template, revision: 1 },
      };
    else if (url.endsWith("/status")) data = { bot: "stopped" };
    else if (url.endsWith("/skills"))
      data = [
        {
          name: "demo",
          content: "<script>window.pwned=true</script>",
          revision: "abc",
        },
      ];
    else if (url.endsWith("/memory/import"))
      data = { items: [{ text: "memory" }] };
    else data = [];
    return { ok: true, json: async () => data };
  };
  const settle = () => new Promise((r) => setTimeout(r, 20));
  try {
    await w.eval(
      `(async()=>{${source.replace(/export\s*\{\s*\};?/g, "")}\n})()`,
    );
    const click = async (label) => {
      const b = [...w.document.querySelectorAll("button")].find(
        (b) => b.textContent === label,
      );
      assert(b, `Missing ${label}`);
      b.click();
      await settle();
    };
    assert.equal(w.document.querySelectorAll("nav button").length, 5);
    await click("Skill");
    await click("demo");
    assert.match(w.document.querySelector("pre").textContent, /<script>/);
    assert.equal(w.pwned, undefined);
    await click("MCP");
    assert.match(w.document.body.textContent, /允许列表/);
    await click("Hermes 记忆");
    w.document.querySelector("textarea").value = "# User\n喜欢猫";
    await click("预览分块");
    assert(calls.some(([url]) => url.endsWith("/memory/import")));
  } finally {
    w.close();
  }
});
