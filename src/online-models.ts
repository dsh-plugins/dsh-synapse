import { createHash } from "node:crypto";
import type { MemoryModelConfig } from "./types.js";

class ModelResponseError extends Error {}

function baseUrl(config: MemoryModelConfig): URL {
  let url: URL;
  try {
    url = new URL(config.baseUrl.trim());
  } catch {
    throw new Error("在线模型服务地址必须是 HTTP(S) URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "在线模型服务地址必须使用 HTTP(S)，且不包含账号、密码、查询参数或片段",
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

/** 配置只校验已选择的在线服务，密钥通过独立的密码字段保存。 */
export function validateMemoryModel(config: MemoryModelConfig) {
  if (config.source !== "online") {
    return;
  }
  baseUrl(config);
  if (!config.apiKey.trim() || /[\r\n]/.test(config.apiKey)) {
    throw new Error("在线模型 API Key 不能为空或包含换行");
  }
  if (!config.model.trim()) {
    throw new Error("在线模型名称不能为空");
  }
}

/** 向量索引仅绑定模型与服务地址，轮换访问密钥不改变向量语义空间。 */
export function embeddingIdentity(config?: MemoryModelConfig): string {
  if (config?.source !== "online") {
    return "local:Xenova/bge-small-zh-v1.5";
  }
  return (
    "online:" +
    createHash("sha256")
      .update(
        JSON.stringify([
          baseUrl(config).href,
          config.model.trim(),
          config.dimensions || 0,
        ]),
      )
      .digest("hex")
  );
}

async function request(
  config: MemoryModelConfig,
  action: "embeddings" | "rerank",
  params: object,
  signal: AbortSignal,
): Promise<any> {
  validateMemoryModel(config);
  signal.throwIfAborted();
  const url = baseUrl(config);
  url.pathname = url.pathname.replace(/\/+$/, "") + "/" + action;
  const label = action === "embeddings" ? "在线嵌入" : "在线重排";
  const timeout = AbortSignal.timeout(60000);
  try {
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.any([signal, timeout]),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + config.apiKey.trim(),
      },
      body: JSON.stringify({ model: config.model.trim(), ...params }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ModelResponseError(
        `${label}请求失败（HTTP ${response.status}），请检查模型、密钥和服务配额`,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) {
      throw new ModelResponseError(`${label}返回了空回执`);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        size += value.byteLength;
        if (size > 2 * 1024 * 1024) {
          throw new ModelResponseError(`${label}回执超过 2 MB`);
        }
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new ModelResponseError(`${label}返回了无效 JSON`);
    }
  } catch (error) {
    signal.throwIfAborted();
    if (timeout.aborted) {
      throw new Error(`${label}请求超时（60 秒）`);
    }
    if (error instanceof ModelResponseError) {
      throw error;
    }
    throw new Error(`${label}连接或读取失败，请检查服务地址和网络`);
  }
}

async function embeddings(
  config: MemoryModelConfig,
  input: string | string[],
  signal: AbortSignal,
): Promise<number[][]> {
  const texts = typeof input === "string" ? [input] : input;
  if (texts.some((text) => typeof text !== "string" || !text.trim())) {
    throw new Error("嵌入文本不能为空");
  }
  const response = await request(
    config,
    "embeddings",
    {
      input,
      encoding_format: "float",
      ...(config.dimensions ? { dimensions: config.dimensions } : {}),
    },
    signal,
  );
  const count = typeof input === "string" ? 1 : input.length;
  if (!Array.isArray(response?.data) || response.data.length !== count) {
    throw new Error("在线嵌入回执未包含全部输入的向量");
  }
  const vectors: number[][] = new Array(count);
  let dimensions = config.dimensions || 0;
  for (const item of response.data) {
    const vector = item?.embedding;
    if (
      !item ||
      !Number.isSafeInteger(item.index) ||
      item.index < 0 ||
      item.index >= count ||
      vectors[item.index] ||
      !Array.isArray(vector) ||
      !vector.length ||
      vector.length > 8192 ||
      vector.some(
        (value) =>
          typeof value !== "number" ||
          !Number.isFinite(value) ||
          !Number.isFinite(Math.fround(value)),
      ) ||
      (dimensions && vector.length !== dimensions)
    ) {
      throw new Error("在线嵌入回执的向量、维度或索引无效");
    }
    dimensions = vector.length;
    vectors[item.index] = vector;
  }
  return vectors;
}

/** 使用浮点嵌入回执；输入按原文发送，检索前缀由在线模型自行处理。 */
export async function onlineEmbed(
  config: MemoryModelConfig,
  text: string,
  signal: AbortSignal,
): Promise<number[]> {
  return (await embeddings(config, text, signal))[0];
}

/** 批量生成文档向量，重建索引时减少在线请求次数。 */
export async function onlineEmbedMany(
  config: MemoryModelConfig,
  texts: string[],
  signal: AbortSignal,
): Promise<number[][]> {
  return texts.length ? embeddings(config, texts, signal) : [];
}

/** 重排回执按文档索引还原分数，避免把相关性排序当作原始输入顺序。 */
export async function onlineRerank(
  config: MemoryModelConfig,
  query: string,
  documents: string[],
  signal: AbortSignal,
): Promise<number[]> {
  if (!documents.length) {
    return [];
  }
  if (!query.trim()) {
    throw new Error("重排查询不能为空");
  }
  const response = await request(
    config,
    "rerank",
    { query, documents, top_n: documents.length, return_documents: false },
    signal,
  );
  if (
    !Array.isArray(response?.results) ||
    response.results.length !== documents.length
  ) {
    throw new Error("在线重排回执未包含全部文档分数");
  }
  const scores: number[] = new Array(documents.length);
  for (const result of response.results) {
    if (
      !result ||
      !Number.isSafeInteger(result.index) ||
      result.index < 0 ||
      result.index >= documents.length ||
      scores[result.index] !== undefined ||
      typeof result.relevance_score !== "number" ||
      !Number.isFinite(result.relevance_score)
    ) {
      throw new Error("在线重排回执的文档索引或分数无效");
    }
    scores[result.index] = result.relevance_score;
  }
  return scores;
}
