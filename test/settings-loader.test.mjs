import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, cp, rm, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { ConfigStore } from "../node_modules/@dsh-plugin/dsh-loader/dist/services/config.js";
import { registerConfig } from "../lib/host/config-migration.js";
import { registerOperations } from "../lib/host/operations.js";
import { addGroup } from "../lib/host/client/channels/groups-model.js";

const configId = "dsh-synapse";
const settings = "settings.save";
test("legacy profile upgrades and persists settings through Loader with mocked OneBot", async t => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "synapse-settings-"));
  await cp(new URL("./fixtures/legacy-profile/", import.meta.url), profile, { recursive: true });
  const calls = [];
  let unavailable = true;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push([req.url, req.headers.authorization, JSON.parse(Buffer.concat(chunks))]);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(unavailable ? { status: "failed", retcode: 100 } :
      { status: "ok", retcode: 0, data: { group_id: 123456, group_name: "Mock group" } }));
  });
  const open = async () => {
    const store = new ConfigStore(profile);
    const handle = await registerConfig({ baseUrl: pathToFileURL(profile + path.sep).href, dshLoader: { config: store } });
    registerOperations(handle, () => { throw new Error("Unexpected live service"); }, () => "test");
    return { store, handle };
  };
  let state;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    state = await open();
    const config = path.join(profile, "config", configId, "config.json");
    const snapshot = state.store.read(configId);
    const signal = new AbortController().signal;
    assert.equal(snapshot.revision, 10);
    assert.deepEqual(snapshot.value.modules.chat.groups, [10001, 10002]);
    assert.equal(snapshot.value.modules.presentation.approvalTimeoutSec, 45);
    const save = (input, revision) => state.store.invoke(configId, settings,
      { input, resource: { id: "settings", revision } }, signal);
    const input = structuredClone(snapshot.value);
    input.connection.httpUrl = "http://127.0.0.1:" + server.address().port + "/bot/";
    input.connection.httpToken = "synthetic-onebot-token";
    const saved = await save(input, 10);
    assert.equal(saved.resource.revision, 11);
    await assert.rejects(() => save(input, 10));
    const lookup = () => state.store.invoke(configId, "groups.lookup", { input: { id: "123456" } }, signal);
    await assert.rejects(lookup);
    assert.equal(state.store.read(configId).revision, 11);
    unavailable = false;
    const result = await lookup();
    assert.deepEqual(result.value, { id: "123456", name: "Mock group" });
    assert.deepEqual(calls, Array.from({ length: 2 }, () =>
      ["/bot/get_group_info", "Bearer synthetic-onebot-token", { group_id: 123456, no_cache: true }]));
    const groupSaved = await save(addGroup(state.store.read(configId).value, result.value), 11);
    assert.equal(groupSaved.resource.revision, 12);
    assert(!JSON.stringify(state.store.read(configId)).includes("synthetic-onebot-token"));
    state.handle.dispose();
    state = undefined;
    state = await open();
    const restored = state.store.read(configId);
    assert.equal(restored.revision, 12);
    assert.deepEqual(restored.value.groupDirectory, [{ id: "123456", name: "Mock group" }]);
    assert.deepEqual(restored.value.modules.chat.groups, [10001, 10002, 123456]);
    assert.equal(restored.value.modules.presentation.approvalTimeoutSec, 45);
    assert.equal(JSON.parse(await readFile(config, "utf8")).revision, 12);
  } finally {
    state?.handle.dispose();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(profile, { recursive: true, force: true });
  }
});
