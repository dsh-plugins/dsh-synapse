import type {
  ConfigSource,
  Embeddings,
  MemoryRow,
  MemoryItem,
} from "./types.js";
import Database from "better-sqlite3";
import * as vec from "sqlite-vec";
import { createHash } from "node:crypto";
import { abortable } from "./abort.js";
import { embeddingIdentity } from "./online-models.js";
const channelCheck = (c) => {
  if (!["chat", "review"].includes(c)) throw new Error("记忆分类无效");
  return c;
};
// Whitespace-separated Han characters let unicode61 index Chinese without an external tokenizer.
export const tokenize = (text: string): string =>
  (text.toLowerCase().match(/[\p{Script=Han}]|[\p{L}\p{N}_]+/gu) || []).join(
    " ",
  );
export function parseHermes(markdown, channel = "chat") {
  channelCheck(channel);
  if (typeof markdown !== "string" || markdown.length > 2000000)
    throw new Error("记忆文档无效或超过 2 MB");
  const chunks = [];
  let heading = "Hermes memory",
    lines = [];
  const flush = () => {
    const content = lines.join("\n").trim();
    if (content)
      for (let i = 0; i < content.length; i += 1200)
        chunks.push({
          channel,
          source: "hermes",
          text: `${heading}\n${content.slice(i, i + 1200)}`,
        });
    lines = [];
  };
  const clean = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
  let fenced = false;
  for (const line of clean.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const match = !fenced && line.match(/^#{1,6}\s+(.+)/);
    if (match) {
      flush();
      heading = match[1];
    } else lines.push(line);
  }
  flush();
  return chunks;
}
export class Memory {
  inference: Embeddings;
  config: ConfigSource;
  db: Database.Database;
  private queue: Promise<unknown> = Promise.resolve();
  private shutdown = new AbortController();

  constructor(
    file: string,
    inference: Embeddings,
    config: ConfigSource,
    private onReindex?: (completed: number, total: number) => void,
  ) {
    this.inference = inference;
    this.config = config;
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    vec.load(this.db);
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS memories(id INTEGER PRIMARY KEY, channel TEXT NOT NULL, source TEXT NOT NULL, text TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(tokens);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(id INTEGER PRIMARY KEY, embedding float[512], channel TEXT partition key);
      CREATE TABLE IF NOT EXISTS memory_index(id INTEGER PRIMARY KEY CHECK(id=1),model TEXT NOT NULL,dimensions INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, event TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, error TEXT, result TEXT, updated TEXT DEFAULT CURRENT_TIMESTAMP);`);
    // 旧库没有模型标识，其向量由固定的本地 512 维模型生成。
    this.db
      .prepare("INSERT OR IGNORE INTO memory_index VALUES(1,?,512)")
      .run(embeddingIdentity());
  }
  private serial<T>(
    work: (signal: AbortSignal) => Promise<T>,
    caller?: AbortSignal,
  ): Promise<T> {
    const signal = AbortSignal.any([
      this.shutdown.signal,
      ...(caller ? [caller] : []),
    ]);
    const task = this.queue.then(() => {
      signal.throwIfAborted();
      return work(signal);
    });
    // 原始错误由调用者接收，后续记忆操作仍能继续执行。
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    return abortable(task, signal);
  }

  private vector(values: number[], dimensions?: number): Float32Array {
    if (
      !Array.isArray(values) ||
      !values.length ||
      values.length > 8192 ||
      (dimensions && values.length !== dimensions) ||
      values.some(
        (value) =>
          typeof value !== "number" ||
          !Number.isFinite(value) ||
          !Number.isFinite(Math.fround(value)),
      )
    ) {
      throw new Error("嵌入维度或数值无效");
    }
    return Float32Array.from(values);
  }

  private async embedDocuments(
    texts: string[],
    signal: AbortSignal,
    progress?: (completed: number, total: number) => void,
  ): Promise<Float32Array[]> {
    const vectors: Float32Array[] = [];
    let reported = performance.now();
    progress?.(0, texts.length);
    for (let offset = 0; offset < texts.length; offset += 16) {
      signal.throwIfAborted();
      const batch = texts.slice(offset, offset + 16);
      let values: number[][];
      if (this.inference.embedMany) {
        values = await abortable(
          this.inference.embedMany(batch, signal),
          signal,
        );
      } else {
        values = [];
        for (const text of batch) {
          values.push(
            await abortable(this.inference.embed(text, false, signal), signal),
          );
        }
      }
      if (values.length !== batch.length) {
        throw new Error("嵌入模型未返回全部文档的向量");
      }
      for (const value of values) {
        vectors.push(this.vector(value, vectors[0]?.length));
      }
      if (
        vectors.length === texts.length ||
        performance.now() - reported >= 1000
      ) {
        progress?.(vectors.length, texts.length);
        reported = performance.now();
      }
    }
    return vectors;
  }

  private checkModel(identity: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (embeddingIdentity(this.config().embeddingModel) !== identity) {
      throw new Error("嵌入模型配置已变更，请重新执行记忆操作");
    }
  }

  private async ensureIndex(
    identity: string,
    dimensions: number,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const stored = this.db
      .prepare("SELECT model,dimensions FROM memory_index WHERE id=1")
      .get() as { model: string; dimensions: number };
    if (stored.model === identity && stored.dimensions === dimensions) {
      return;
    }
    const rows = this.db
      .prepare("SELECT id,channel,text FROM memories ORDER BY id")
      .all() as MemoryRow[];
    const vectors = await this.embedDocuments(
      rows.map((row) => row.text),
      signal,
      this.onReindex,
    );
    if (vectors.some((vector) => vector.length !== dimensions)) {
      throw new Error("嵌入模型的文档与查询维度不一致");
    }
    this.checkModel(identity, signal);
    this.db
      .transaction(() => {
        this.db.exec(
          `DROP TABLE memory_vec; CREATE VIRTUAL TABLE memory_vec USING vec0(id INTEGER PRIMARY KEY,embedding float[${dimensions}],channel TEXT partition key);`,
        );
        const insert = this.db.prepare(
          "INSERT INTO memory_vec(id,embedding,channel) VALUES(?,?,?)",
        );
        rows.forEach((row, index) =>
          insert.run(BigInt(row.id), vectors[index], row.channel),
        );
        this.db
          .prepare("UPDATE memory_index SET model=?,dimensions=? WHERE id=1")
          .run(identity, dimensions);
      })
      .immediate();
  }

  async addMany(items: MemoryItem[], signal?: AbortSignal) {
    return this.serial(async (signal) => {
      const identity = embeddingIdentity(this.config().embeddingModel),
        ready = [];
      const hashes = new Set<string>();
      for (const item of items) {
        signal.throwIfAborted();
        channelCheck(item.channel);
        if (!item.text?.trim()) {
          continue;
        }
        const hash = createHash("sha256")
          .update(item.channel + "\0" + item.text)
          .digest("hex");
        if (
          hashes.has(hash) ||
          this.db.prepare("SELECT 1 FROM memories WHERE hash=?").get(hash)
        ) {
          continue;
        }
        hashes.add(hash);
        ready.push({ ...item, hash });
      }
      const vectors = await this.embedDocuments(
        ready.map((item) => item.text),
        signal,
      );
      if (ready.length) {
        await this.ensureIndex(identity, vectors[0].length, signal);
      }
      this.checkModel(identity, signal);
      return this.db
        .transaction(() => {
          let count = 0;
          for (const [index, item] of ready.entries()) {
            const result = this.db
              .prepare(
                "INSERT OR IGNORE INTO memories(channel,source,text,hash) VALUES(?,?,?,?)",
              )
              .run(item.channel, item.source, item.text, item.hash);
            if (!result.changes) {
              continue;
            }
            const id = BigInt(result.lastInsertRowid);
            this.db
              .prepare("INSERT INTO memory_fts(rowid,tokens) VALUES(?,?)")
              .run(id, tokenize(item.text));
            this.db
              .prepare(
                "INSERT INTO memory_vec(id,embedding,channel) VALUES(?,?,?)",
              )
              .run(id, vectors[index], item.channel);
            count++;
          }
          const old = this.db
            .prepare(
              "SELECT id FROM memories ORDER BY id DESC LIMIT -1 OFFSET ?",
            )
            .all(this.config().maxMemories) as { id: number }[];
          for (const { id } of old) {
            this.remove(id);
          }
          return { inserted: count, duplicates: items.length - count };
        })
        .immediate();
    }, signal);
  }
  remove(id) {
    this.db.prepare("DELETE FROM memory_vec WHERE id=?").run(BigInt(id));
    this.db.prepare("DELETE FROM memory_fts WHERE rowid=?").run(id);
    this.db.prepare("DELETE FROM memories WHERE id=?").run(id);
  }
  async search(query, channel, signal?: AbortSignal) {
    return this.serial(async (signal) => {
      channelCheck(channel);
      const c = this.config();
      if (!c.ragEnabled) {
        return [];
      }
      const identity = embeddingIdentity(c.embeddingModel);
      const embedding = this.vector(
        await abortable(this.inference.embed(query, true, signal), signal),
      );
      await this.ensureIndex(identity, embedding.length, signal);
      this.checkModel(identity, signal);
      const vectors = this.db
        .prepare(
          "SELECT id,distance FROM memory_vec WHERE embedding MATCH ? AND k=? AND channel=? ORDER BY distance",
        )
        .all(embedding, c.recallK, channel) as { id: number }[];
      const terms = [
        ...new Set(tokenize(query).split(" ").filter(Boolean)),
      ].slice(0, 64);
      const lexical = terms.length
        ? this.db
            .prepare(
              "SELECT f.rowid AS id FROM memory_fts f JOIN memories m ON m.id=f.rowid WHERE memory_fts MATCH ? AND m.channel=? ORDER BY rank LIMIT ?",
            )
            .all(
              terms
                .map((t) => '"' + t.replaceAll('"', '""') + '"')
                .join(" OR "),
              channel,
              c.recallK,
            )
        : [];
      const scores = new Map();
      for (const rows of [vectors, lexical] as { id: number }[][]) {
        rows.forEach(({ id }, i) =>
          scores.set(id, (scores.get(id) || 0) + 1 / (60 + i + 1)),
        );
      }
      let results = [...scores]
        .sort((a, b) => b[1] - a[1])
        .slice(0, c.recallK)
        .map(([id, score]) => ({
          ...(this.db
            .prepare("SELECT * FROM memories WHERE id=?")
            .get(id) as MemoryRow),
          score,
        }));
      if (c.reranker && results.length) {
        const ranks = await abortable(
          this.inference.rerank(
            query,
            results.map((x) => x.text),
            signal,
          ),
          signal,
        );
        results = results
          .map((x, i) => ({ ...x, score: ranks[i] }))
          .sort((a, b) => b.score - a.score);
      }
      return results.slice(0, c.memoryK);
    }, signal);
  }
  list(channel, limit = 100) {
    channelCheck(channel);
    return this.db
      .prepare(
        "SELECT * FROM memories WHERE channel=? ORDER BY id DESC LIMIT ?",
      )
      .all(channel, limit) as MemoryRow[];
  }
  close() {
    this.shutdown.abort(new Error("记忆库已关闭"));
    this.db.close();
  }
}
