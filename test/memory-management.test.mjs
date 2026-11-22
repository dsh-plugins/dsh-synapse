import test from "node:test";
import assert from "node:assert/strict";
import { operationFixture } from "./fixtures/operations.mjs";

test("管理页在 SQLite 内分页并按全文、来源与分类筛选，只在打开条目后读取全文", async t => {
  const f = await operationFixture(); t.after(() => f.close());
  const before = f.handle.get();
  const long = "第一段。\n" + "很长的记忆".repeat(1000) + "%_end";
  await f.service.memory.addMany(Array.from({ length: 33 }, (_, i) => ({
    channel: i % 2 ? "review" : "chat", source: i === 1 ? "独有来源" : "agent", text: i === 32 ? long : `记录 ${i}`,
  })));
  const page = input => f.invoke("memory.page", {scope:"all", query:"", page:1, pageSize:10, ...input}).then(result => result.value);
  const first = await page({});
  assert.equal(first.total, 33); assert.equal(first.items.length, 10);
  assert.equal(first.items[0].summary, long.slice(0, 220));
  assert(!("text" in first.items[0])); assert(!JSON.stringify(first).includes("%_end"));
  assert.equal((await page({page:100})).page, 4);
  assert.equal((await page({page:4})).items.length, 3);
  assert.equal((await page({scope:"review", query:"独有来源"})).total, 1);
  assert.equal((await page({scope:"review", query:"%_END"})).total, 0);
  assert.equal((await page({scope:"chat", query:"%_END"})).total, 1);
  const memoryId = first.items[0].id;
  const loaded = await f.invoke("memory.load", {memoryId});
  assert.equal(loaded.value.text, long);
  const updated = await f.invoke("memory.update", {memoryId, channel:"review", text:"更新后的记忆"}, loaded.resource);
  assert.equal(updated.value.id, memoryId);
  assert.notEqual(updated.resource.revision, loaded.resource.revision);
  await assert.rejects(f.invoke("memory.delete", {memoryId,confirmDelete:true}, loaded.resource), {code:"conflict"});
  await assert.rejects(f.invoke("memory.update", {memoryId,channel:"review",text:"记录 1"}, updated.resource), /相同内容/);
  const db = f.service.memory.db;
  assert.equal(db.prepare("SELECT channel FROM memory_vec WHERE id=?").get(BigInt(memoryId)).channel, "review");
  assert.match(db.prepare("SELECT tokens FROM memory_fts WHERE rowid=?").get(memoryId).tokens, /更 新/);
  await assert.rejects(f.invoke("memory.delete", {memoryId,confirmDelete:false}, updated.resource), {code:"validation"});
  await f.invoke("memory.delete", {memoryId,confirmDelete:true}, updated.resource);
  assert.equal(db.prepare("SELECT rowid FROM memory_fts WHERE rowid=?").get(memoryId), undefined);
  assert.equal(db.prepare("SELECT id FROM memory_vec WHERE id=?").get(BigInt(memoryId)), undefined);
  assert.equal((await page({})).total, 32);
  assert.deepEqual(f.handle.get(), before);
});

test("Hermes 按预览索引导入，空选和无效索引不会写入", async t => {
  const f = await operationFixture(); t.after(() => f.close());
  const input = {channel:"chat", markdown:"# A\n第一个\n# B\n第二个\n# C\n第三个"};
  assert.equal((await f.invoke("memory.preview",input)).value.items.length, 3);
  for (const excluded of [[0,1,2], [0,3], [0,0.5]]) {
    await assert.rejects(f.invoke("memory.import",{...input,excluded}), {code:"validation"});
  }
  assert.equal(f.service.memory.list("chat").length, 0);
  assert.equal((await f.invoke("memory.import",{...input,excluded:[1]})).value.inserted, 2);
  assert.deepEqual(f.service.memory.list("chat").map(row => row.text).sort(), ["A\n第一个","C\n第三个"]);
});
