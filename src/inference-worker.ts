import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const require = createRequire(workerData.manifest);
const runtime = await import(
  pathToFileURL(require.resolve("@huggingface/transformers")).href
);
const { pipeline, env, AutoTokenizer, AutoModelForSequenceClassification } =
  runtime.default ?? runtime;
env.cacheDir = workerData.cache;
env.allowLocalModels = false;
let embedder, tokenizer, ranker;
async function load(factory) {
  try {
    env.remoteHost = "https://huggingface.co/";
    return await factory();
  } catch (direct) {
    env.remoteHost = "https://hf-mirror.com/";
    try {
      return await factory();
    } catch (mirror) {
      throw new Error(
        `模型直连和镜像均失败：${direct.message}; ${mirror.message}`,
      );
    }
  }
}
let queue = Promise.resolve();
parentPort.on("message", (message) => {
  queue = queue
    .then(async () => {
      const { id, method, args } = message;
      try {
        let value;
        if (method === "embed") {
          embedder ??= await load(() =>
            pipeline("feature-extraction", "Xenova/bge-small-zh-v1.5", {
              dtype: "q8",
              device: "cpu",
            }),
          );
          const output = await embedder(
            (args.query ? "为这个句子生成表示以用于检索相关文章：" : "") +
              args.text,
            {
              pooling: "cls",
              normalize: true,
              truncation: true,
              max_length: 512,
            },
          );
          value = Array.from(output.data);
        } else if (method === "rerank") {
          tokenizer ??= await load(() =>
            AutoTokenizer.from_pretrained("Xenova/bge-reranker-base"),
          );
          ranker ??= await load(() =>
            AutoModelForSequenceClassification.from_pretrained(
              "Xenova/bge-reranker-base",
              { dtype: "q8", device: "cpu" },
            ),
          );
          value = [];
          for (let i = 0; i < args.documents.length; i += 4) {
            const docs = args.documents.slice(i, i + 4);
            const inputs = tokenizer(
              docs.map(() => args.query),
              {
                text_pair: docs,
                padding: true,
                truncation: true,
                max_length: 512,
              },
            );
            const { logits } = await ranker(inputs);
            value.push(
              ...Array.from(logits.data as Float32Array).map(
                (n) => 1 / (1 + Math.exp(-n)),
              ),
            );
          }
        } else throw new Error("未知推理方法");
        parentPort.postMessage({ id, value });
      } catch (e) {
        parentPort.postMessage({ id, error: e.message });
      }
    })
    .catch((e) => parentPort.postMessage({ id: message.id, error: e.message }));
});
