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

  constructor(file: string, inference: Embeddings, config: ConfigSource) {
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
      CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, event TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, error TEXT, result TEXT, updated TEXT DEFAULT CURRENT_TIMESTAMP);`);
  }
  async addMany(items: MemoryItem[], signal?: AbortSignal) {
    signal?.throwIfAborted();
    const ready = [];
    for (const item of items) {
      signal?.throwIfAborted();
      channelCheck(item.channel);
      if (!item.text?.trim()) continue;
      const hash = createHash("sha256")
        .update(item.channel + "\0" + item.text)
        .digest("hex");
      if (this.db.prepare("SELECT 1 FROM memories WHERE hash=?").get(hash))
        continue;
      const embedding = await abortable(
        this.inference.embed(item.text),
        signal,
      );
      if (
        embedding.length !== 512 ||
        embedding.some((n) => !Number.isFinite(n))
      )
        throw new Error("嵌入维度或数值无效");
      ready.push({ ...item, hash, embedding: Float32Array.from(embedding) });
    }
    signal?.throwIfAborted();
    return this.db.transaction(() => {
      let count = 0;
      for (const item of ready) {
        const result = this.db
          .prepare(
            "INSERT OR IGNORE INTO memories(channel,source,text,hash) VALUES(?,?,?,?)",
          )
          .run(item.channel, item.source, item.text, item.hash);
        if (!result.changes) continue;
        const id = BigInt(result.lastInsertRowid);
        this.db
          .prepare("INSERT INTO memory_fts(rowid,tokens) VALUES(?,?)")
          .run(id, tokenize(item.text));
        this.db
          .prepare("INSERT INTO memory_vec(id,embedding,channel) VALUES(?,?,?)")
          .run(id, item.embedding, item.channel);
        count++;
      }
      const old = this.db
        .prepare("SELECT id FROM memories ORDER BY id DESC LIMIT -1 OFFSET ?")
        .all(this.config().maxMemories) as { id: number }[];
      for (const { id } of old) this.remove(id);
      return { inserted: count, duplicates: items.length - count };
    })();
  }
  remove(id) {
    this.db.prepare("DELETE FROM memory_vec WHERE id=?").run(BigInt(id));
    this.db.prepare("DELETE FROM memory_fts WHERE rowid=?").run(id);
    this.db.prepare("DELETE FROM memories WHERE id=?").run(id);
  }
  async search(query, channel, signal?: AbortSignal) {
    signal?.throwIfAborted();
    channelCheck(channel);
    const c = this.config();
    if (!c.ragEnabled) return [];
    const embedding = Float32Array.from(
      await abortable(this.inference.embed(query, true), signal),
    );
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
            terms.map((t) => '"' + t.replaceAll('"', '""') + '"').join(" OR "),
            channel,
            c.recallK,
          )
      : [];
    const scores = new Map();
    for (const rows of [vectors, lexical] as { id: number }[][])
      rows.forEach(({ id }, i) =>
        scores.set(id, (scores.get(id) || 0) + 1 / (60 + i + 1)),
      );
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
        ),
        signal,
      );
      results = results
        .map((x, i) => ({ ...x, score: ranks[i] }))
        .sort((a, b) => b.score - a.score);
    }
    return results.slice(0, c.memoryK);
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
    this.db.close();
  }
}
