import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, copyFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setImmediate } from "node:timers/promises";
import { Inference } from "../lib/host/runtime.js";

async function fixture(t) {
  const data = await mkdtemp(path.join(os.tmpdir(), "synapse-inference-"));
  const pkg = path.join(
    data,
    "runtime",
    "node_modules",
    "@huggingface",
    "transformers",
  );
  await mkdir(pkg, { recursive: true });
  await writeFile(
    path.join(pkg, "package.json"),
    JSON.stringify({
      name: "@huggingface/transformers",
      version: "3.8.1",
      type: "module",
      exports: "./index.mjs",
    }),
  );
  await copyFile(
    new URL("./fixtures/inference-runtime.mjs", import.meta.url),
    path.join(pkg, "index.mjs"),
  );
  const inference = new Inference(data);
  t.after(async () => {
    await inference.close();
    assert(path.resolve(data).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(data, { recursive: true, force: true });
  });
  return inference;
}

test(
  "RAG 在独立进程运行，并复用模型处理排队的嵌入与重排",
  { timeout: 10000 },
  async (t) => {
    const inference = await fixture(t);
    const [first, second] = await Promise.all([
      inference.embed("example"),
      inference.embed("example", true),
    ]);
    assert.notEqual(first[0], process.pid);
    assert.equal(second[0], first[0]);
    assert.deepEqual([first[1], second[1]], [1, 2]);
    assert.deepEqual([first[2], second[2]], [0, 1]);
    const ranks = await inference.rerank("example", [
      "a",
      "aa",
      "aaa",
      "aaaa",
      "aaaaa",
      "aaaaaa",
    ]);
    assert.equal(ranks.length, 6);
    assert(
      ranks.every(
        (value, index) =>
          value > 0 && value < 1 && (index === 0 || value > ranks[index - 1]),
      ),
    );
  },
);

test(
  "关闭推理进程会拒绝待处理请求，并等待进程退出",
  { timeout: 10000 },
  async (t) => {
    const inference = await fixture(t);
    const [pid] = await inference.embed("example");
    const pending = assert.rejects(inference.embed("wait"), /已关闭|退出/);
    await setImmediate();
    await Promise.all([inference.close(), inference.close()]);
    await pending;
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    await assert.rejects(inference.embed("example"), /已关闭/);
  },
);

test(
  "单次推理错误不阻塞后续请求，进程崩溃会返回退出码与诊断",
  { timeout: 10000 },
  async (t) => {
    const inference = await fixture(t);
    await assert.rejects(inference.embed("fail"), /推理测试错误/);
    await inference.embed("example");
    await Promise.all([
      assert.rejects(inference.embed("crash"), /7.*推理进程测试崩溃/s),
      assert.rejects(inference.embed("example"), /7.*推理进程测试崩溃/s),
    ]);
    await assert.rejects(inference.embed("example"), /已关闭/);
  },
);

test("启动中关闭不会遗留推理进程", { timeout: 10000 }, async (t) => {
  const inference = await fixture(t);
  const pending = assert.rejects(inference.embed("example"), /已关闭|abort/i);
  await inference.close();
  await pending;
});

test(
  "IPC 断开后推理进程退出，拒绝待处理请求",
  { timeout: 10000 },
  async (t) => {
    const inference = await fixture(t);
    const [pid] = await inference.embed("example");
    await assert.rejects(inference.embed("disconnect"), /退出.*0/);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  },
);
