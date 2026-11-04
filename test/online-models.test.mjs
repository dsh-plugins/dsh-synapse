import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  copyFile,
  access,
  rm,
} from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { defaultsFor } from "@dsh-plugin/dsh-loader/config";
import { template, validateConfig } from "../lib/host/config.js";
import { Inference } from "../lib/host/runtime.js";
import { Memory } from "../lib/host/memory.js";

const vector = (text, dimensions) =>
  Array.from({ length: dimensions }, (_, index) =>
    index === (text.includes("猫") ? 0 : 1) ? 1 : 0,
  );

async function fixture(t) {
  const data = await mkdtemp(path.join(os.tmpdir(), "synapse-online-models-"));
  const c = defaultsFor(template.fields),
    requests = [],
    progress = [];
  let override;
  const respond = (payload, response) => {
    response.setHeader("Content-Type", "application/json");
    if (payload.input !== undefined) {
      const texts =
        typeof payload.input === "string" ? [payload.input] : payload.input;
      response.end(
        JSON.stringify({
          data: texts
            .map((text, index) => ({
              index,
              embedding: vector(text, payload.dimensions || 4),
            }))
            .reverse(),
        }),
      );
    } else {
      response.end(
        JSON.stringify({
          results: payload.documents
            .map((_text, index) => ({
              index,
              relevance_score: (index + 1) / (payload.documents.length + 1),
            }))
            .reverse(),
        }),
      );
    }
  };
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) {
      body += chunk;
    }
    const payload = JSON.parse(body);
    requests.push({
      url: request.url,
      headers: request.headers,
      method: request.method,
      body: payload,
    });
    if (override) {
      override(payload, response, respond);
    } else {
      respond(payload, response);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  for (const key of ["embeddingModel", "rerankModel"]) {
    Object.assign(c.memory[key], {
      source: "online",
      baseUrl: `http://127.0.0.1:${server.address().port}/prefix/v1/`,
      apiKey: "example-secret",
    });
  }
  const inference = new Inference(data, () => c);
  const f = {
    data,
    c,
    inference,
    requests,
    progress,
    file: path.join(data, "memory.sqlite"),
    setHandler: (value) => {
      override = value;
    },
  };
  f.memory = new Memory(
    f.file,
    inference,
    () => c,
    (completed, total) => progress.push([completed, total]),
  );
  t.after(async () => {
    f.memory.close();
    await inference.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    const target = path.resolve(data);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith("synapse-online-models-"));
    await rm(target, { recursive: true, force: true });
  });
  return f;
}

async function seedLegacy(f) {
  f.memory.close();
  const c = structuredClone(f.c);
  c.memory.embeddingModel.source = "local";
  const memory = new Memory(
    f.file,
    { embed: async (text) => vector(text, 512) },
    () => c,
  );
  try {
    await memory.addMany([
      { channel: "chat", source: "example", text: "猫喜欢吃鱼" },
      { channel: "review", source: "example", text: "审查代码" },
    ]);
    memory.db.exec("DROP TABLE memory_index");
    return memory.list("chat").concat(memory.list("review"));
  } finally {
    memory.close();
    f.memory = new Memory(
      f.file,
      f.inference,
      () => f.c,
      (completed, total) => f.progress.push([completed, total]),
    );
  }
}

test("模型配置默认本地，在线配置校验地址、模型和密钥且错误不包含凭据", () => {
  const c = defaultsFor(template.fields);
  assert.equal(validateConfig(c), c);
  assert.equal(c.memory.embeddingModel.source, "local");
  assert.equal(c.memory.rerankModel.source, "local");
  c.memory.embeddingModel.source = "online";
  assert.throws(() => validateConfig(c), /API Key/);
  c.memory.embeddingModel.apiKey = "example-secret";
  assert.equal(validateConfig(c), c);
  for (const baseUrl of [
    "file:///example",
    "https://user:example-secret@example.com/v1",
    "https://example.com/v1?key=example-secret",
    "https://example.com/#example-secret",
  ]) {
    c.memory.embeddingModel.baseUrl = baseUrl;
    assert.throws(
      () => validateConfig(c),
      (error) =>
        !String(error).includes("example-secret") &&
        /服务地址/.test(error.message),
    );
  }
  c.memory.embeddingModel.baseUrl = "https://api.siliconflow.cn/v1";
  c.memory.embeddingModel.model = " ";
  assert.throws(() => validateConfig(c), /模型名称/);
  c.memory.embeddingModel.model = "BAAI/bge-m3";
  c.memory.embeddingModel.dimensions = 8193;
  assert.throws(() => validateConfig(c));
});

test("在线嵌入、批量嵌入与重排使用服务前缀及 Bearer 鉴权，并按回执索引恢复顺序", async (t) => {
  const f = await fixture(t);
  const [embedding, documents, scores] = await Promise.all([
    f.inference.embed("猫", true),
    f.inference.embedMany(["猫", "天空"]),
    f.inference.rerank("猫", ["猫", "天空"]),
  ]);
  assert.deepEqual(embedding, vector("猫", 4));
  assert.deepEqual(documents, [vector("猫", 4), vector("天空", 4)]);
  assert.deepEqual(scores, [1 / 3, 2 / 3]);
  assert.ok(
    f.requests.every(
      (item) =>
        item.method === "POST" &&
        item.headers.authorization === "Bearer example-secret",
    ),
  );
  const single = f.requests.find((item) => typeof item.body.input === "string");
  assert.equal(single.url, "/prefix/v1/embeddings");
  assert.equal(single.body.input, "猫");
  assert.equal(single.body.encoding_format, "float");
  assert.ok(!("dimensions" in single.body));
  const ranking = f.requests.find((item) => item.body.query);
  assert.equal(ranking.url, "/prefix/v1/rerank");
  assert.equal(ranking.body.model, f.c.memory.rerankModel.model);
  assert.equal(ranking.body.top_n, 2);
  assert.equal(ranking.body.return_documents, false);
  f.c.memory.embeddingModel.dimensions = 8;
  assert.equal((await f.inference.embed("猫")).length, 8);
  assert.equal(f.requests.at(-1).body.dimensions, 8);
  await assert.rejects(access(path.join(f.data, "runtime")), {
    code: "ENOENT",
  });
});

test("嵌入和重排可以分别混用本地进程与在线服务", async (t) => {
  const f = await fixture(t);
  const pkg = path.join(
    f.data,
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
  f.c.memory.embeddingModel.source = "local";
  const local = await f.inference.embed("example");
  assert.notEqual(local[0], process.pid);
  assert.deepEqual(await f.inference.rerank("example", ["a", "b"]), [
    1 / 3,
    2 / 3,
  ]);
  f.c.memory.embeddingModel.source = "online";
  f.c.memory.rerankModel.source = "local";
  assert.deepEqual(await f.inference.embed("猫"), vector("猫", 4));
  const ranks = await f.inference.rerank("example", ["a", "aa"]);
  assert.ok(ranks[0] < ranks[1]);
  assert.equal(f.requests.length, 2);
});

test("在线接口的 HTTP、JSON、响应大小和向量错误均明确返回且隐藏原始错误凭据", async (t) => {
  const f = await fixture(t);
  for (const status of [401, 429, 503]) {
    f.setHandler((_payload, response) => {
      response.writeHead(status);
      response.end("example-secret");
    });
    await assert.rejects(
      f.inference.embed("猫"),
      (error) =>
        error.message.includes(String(status)) &&
        !String(error).includes("example-secret"),
    );
  }
  f.setHandler((_payload, response) => response.end("example-secret"));
  await assert.rejects(f.inference.embed("猫"), /无效 JSON/);
  f.setHandler((_payload, response) =>
    response.end(JSON.stringify({ value: "x".repeat(2 * 1024 * 1024) })),
  );
  await assert.rejects(f.inference.embed("猫"), /超过 2 MB/);
  for (const data of [
    [],
    [{ index: 1, embedding: [1, 0] }],
    [{ index: 0, embedding: [null, 1] }],
    [{ index: 0, embedding: [] }],
    [{ index: 0, embedding: [1e100, 0] }],
  ]) {
    f.setHandler((_payload, response) =>
      response.end(JSON.stringify({ data })),
    );
    await assert.rejects(f.inference.embed("猫"), /向量|索引/);
  }
  f.c.memory.embeddingModel.dimensions = 8;
  f.setHandler((_payload, response) =>
    response.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] })),
  );
  await assert.rejects(f.inference.embed("猫"), /维度/);
  f.c.memory.embeddingModel.dimensions = 0;
  for (const data of [
    [
      { index: 0, embedding: [1, 0] },
      { index: 0, embedding: [0, 1] },
    ],
    [
      { index: 0, embedding: [1, 0] },
      { index: 1, embedding: [0, 1, 0] },
    ],
  ]) {
    f.setHandler((_payload, response) =>
      response.end(JSON.stringify({ data })),
    );
    await assert.rejects(f.inference.embedMany(["猫", "天空"]), /维度|索引/);
  }
});

test("重排拒绝缺失、重复、越界或非数值的文档分数", async (t) => {
  const f = await fixture(t);
  for (const results of [
    [],
    [{ index: 0, relevance_score: 1 }],
    [
      { index: 0, relevance_score: 1 },
      { index: 0, relevance_score: 0 },
    ],
    [
      { index: -1, relevance_score: 1 },
      { index: 1, relevance_score: 0 },
    ],
    [
      { index: 0, relevance_score: "1" },
      { index: 1, relevance_score: 0 },
    ],
  ]) {
    f.setHandler((_payload, response) =>
      response.end(JSON.stringify({ results })),
    );
    await assert.rejects(f.inference.rerank("猫", ["猫", "天空"]), /文档|分数/);
  }
  f.setHandler(() => assert.fail("空文档不应请求在线服务"));
  assert.deepEqual(await f.inference.rerank("猫", []), []);
});

test("在线模型拒绝空输入，网络异常不泄露原始错误或密钥", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.inference.embed(" "), /文本不能为空/);
  await assert.rejects(f.inference.embedMany(["猫", " "]), /文本不能为空/);
  await assert.rejects(f.inference.rerank(" ", ["猫"]), /查询不能为空/);
  assert.equal(f.requests.length, 0);
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("example-secret: example transport error");
  });
  await assert.rejects(
    f.inference.embed("猫"),
    (error) =>
      /连接或读取失败/.test(error.message) &&
      !String(error).includes("example-secret") &&
      !error.cause,
  );
});

test(
  "取消和关闭会中止在线请求，取消后其他请求仍可继续",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    let entered, disconnected;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const closed = new Promise((resolve) => {
      disconnected = resolve;
    });
    f.setHandler((_payload, response) => {
      response.on("close", disconnected);
      entered();
    });
    const controller = new AbortController();
    const pending = assert.rejects(
      f.inference.embed("猫", true, controller.signal),
      /取消在线请求/,
    );
    await started;
    controller.abort(new Error("取消在线请求"));
    await pending;
    await closed;
    f.setHandler(undefined);
    assert.deepEqual(await f.inference.embed("猫"), vector("猫", 4));
    const next = new Promise((resolve) => {
      entered = resolve;
    });
    f.setHandler(() => entered());
    const closing = assert.rejects(f.inference.rerank("猫", ["猫"]), /已关闭/);
    await next;
    await f.inference.close();
    await closing;
    await assert.rejects(f.inference.embed("猫"), /已关闭/);
  },
);

test(
  "在线请求超时终止 HTTP 等待并返回明确原因",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      timeout = new AbortController();
    t.mock.method(AbortSignal, "timeout", () => timeout.signal);
    let entered;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    f.setHandler(() => entered());
    const pending = assert.rejects(f.inference.embed("猫"), /请求超时/);
    await started;
    timeout.abort(new DOMException("example timeout", "TimeoutError"));
    await pending;
  },
);

test("旧 512 维索引切换在线 1024 维后保留正文、ID 和通道，重启及密钥轮换复用新索引", async (t) => {
  const f = await fixture(t);
  f.c.memory.embeddingModel.model = "Qwen/Qwen3-Embedding-0.6B";
  f.c.memory.embeddingModel.dimensions = 1024;
  const original = await seedLegacy(f);
  const result = await f.memory.search("猫", "chat");
  assert.equal(result[0].text, "猫喜欢吃鱼");
  assert.ok(result.every((item) => item.channel === "chat"));
  assert.deepEqual(
    f.memory.list("chat").concat(f.memory.list("review")),
    original,
  );
  assert.deepEqual(f.progress, [
    [0, 2],
    [2, 2],
  ]);
  assert.equal(
    f.memory.db.prepare("SELECT dimensions FROM memory_index").get().dimensions,
    1024,
  );
  const batches = () =>
    f.requests.filter((item) => Array.isArray(item.body.input)).length;
  assert.equal(batches(), 1);
  f.memory.close();
  f.memory = new Memory(f.file, f.inference, () => f.c);
  f.c.memory.embeddingModel.apiKey = "example-rotated-key";
  await f.memory.search("猫", "chat");
  assert.equal(batches(), 1);
  assert.equal(
    f.requests.at(-1).headers.authorization,
    "Bearer example-rotated-key",
  );
  const metadata = JSON.stringify(
    f.memory.db.prepare("SELECT * FROM memory_index").get(),
  );
  assert.doesNotMatch(metadata, /example-secret|example-rotated-key/);
  f.c.memory.embeddingModel.model = "example-v2";
  await f.memory.search("猫", "chat");
  assert.equal(batches(), 2);
  f.c.memory.embeddingModel.dimensions = 8;
  await f.memory.search("猫", "chat");
  assert.equal(batches(), 3);
  assert.equal(
    f.memory.db.prepare("SELECT dimensions FROM memory_index").get().dimensions,
    8,
  );
  const local = structuredClone(f.c);
  local.memory.embeddingModel.source = "local";
  f.memory.close();
  f.memory = new Memory(
    f.file,
    { embed: async (text) => vector(text, 512) },
    () => local,
  );
  assert.equal((await f.memory.search("猫", "chat"))[0].text, "猫喜欢吃鱼");
  assert.equal(
    f.memory.db.prepare("SELECT dimensions FROM memory_index").get().dimensions,
    512,
  );
});

test("重建失败保持旧索引和记忆，恢复服务后并发写入与检索按顺序完成", async (t) => {
  const f = await fixture(t),
    original = await seedLegacy(f);
  f.setHandler((payload, response, respond) => {
    if (Array.isArray(payload.input) && payload.input.includes("审查代码")) {
      response.writeHead(429);
      response.end("example-secret");
    } else {
      respond(payload, response);
    }
  });
  await assert.rejects(
    f.memory.addMany([
      { channel: "chat", source: "example", text: "猫喜欢阳光" },
    ]),
    /429/,
  );
  assert.equal(
    f.memory.db.prepare("SELECT dimensions FROM memory_index").get().dimensions,
    512,
  );
  assert.deepEqual(
    f.memory.list("chat").concat(f.memory.list("review")),
    original,
  );
  f.setHandler(undefined);
  const [first, second, results] = await Promise.all([
    f.memory.addMany([
      { channel: "chat", source: "example", text: "猫喜欢阳光" },
    ]),
    f.memory.addMany([
      { channel: "chat", source: "example", text: "猫喜欢阳光" },
    ]),
    f.memory.search("猫", "chat"),
  ]);
  assert.equal(first.inserted, 1);
  assert.equal(second.duplicates, 1);
  assert.equal(results.length, 2);
  assert.ok(results.every((item) => item.channel === "chat"));
  f.c.memory.reranker = true;
  const ranked = await f.memory.search("猫", "chat");
  const request = f.requests.at(-1);
  assert.equal(request.url, "/prefix/v1/rerank");
  assert.equal(ranked[0].text, request.body.documents.at(-1));
  assert.ok(ranked[0].score > ranked[1].score);
});

test("索引替换事务写入失败时恢复旧虚拟表和模型标识", async (t) => {
  const f = await fixture(t);
  await seedLegacy(f);
  f.memory.db.exec(
    "CREATE TRIGGER fail_model_update BEFORE UPDATE ON memory_index BEGIN SELECT RAISE(ABORT,'模拟索引写入失败'); END",
  );
  await assert.rejects(f.memory.search("猫", "chat"), /模拟索引写入失败/);
  assert.equal(
    f.memory.db.prepare("SELECT dimensions FROM memory_index").get().dimensions,
    512,
  );
  assert.equal(
    f.memory.db.prepare("SELECT COUNT(*) AS n FROM memory_vec").get().n,
    2,
  );
  f.memory.db.exec("DROP TRIGGER fail_model_update");
  assert.equal((await f.memory.search("猫", "chat"))[0].text, "猫喜欢吃鱼");
});

test(
  "重建期间取消或切换模型配置保留旧向量，后续操作可重新执行",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    await seedLegacy(f);
    let entered;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    f.setHandler((payload, response, respond) => {
      if (Array.isArray(payload.input)) {
        entered();
      } else {
        respond(payload, response);
      }
    });
    const controller = new AbortController();
    const pending = assert.rejects(
      f.memory.search("猫", "chat", controller.signal),
      /取消重建/,
    );
    await started;
    controller.abort(new Error("取消重建"));
    await pending;
    assert.equal(
      f.memory.db.prepare("SELECT dimensions FROM memory_index").get()
        .dimensions,
      512,
    );
    f.setHandler((payload, response, respond) => {
      if (Array.isArray(payload.input)) {
        f.c.memory.embeddingModel.model = "example-changed";
      }
      respond(payload, response);
    });
    await assert.rejects(f.memory.search("猫", "chat"), /配置已变更/);
    assert.equal(
      f.memory.db.prepare("SELECT dimensions FROM memory_index").get()
        .dimensions,
      512,
    );
    f.setHandler(undefined);
    assert.equal((await f.memory.search("猫", "chat"))[0].text, "猫喜欢吃鱼");
  },
);
