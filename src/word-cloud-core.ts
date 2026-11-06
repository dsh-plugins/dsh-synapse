import Database from "better-sqlite3";
import { withoutUrls } from "./chat-images.js";
import type { ActivitySettings } from "./activity-config.js";
import type { WordFrequency, CloudTerm } from "./word-cloud.js";

const stopWords = new Set("的 了 和 是 我 你 他 她 它 我们 你们 他们 这个 那个 一个 这 那 就 都 也 在 有 没有 啊 呢 吗 吧 哦 嗯 哈哈 哈哈哈 好 可以 什么 怎么 还是 然后 因为 所以 但是 如果 以及 with from this that the and for are was you your http https www com qq".split(" "));
const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });

export function cloudTokens(text: string): string[] {
  const clean = withoutUrls(text).replace(/(?:[A-Za-z]:[\\/]|\/(?:data|tmp|home)\/)[^\s]+/g, " ").replace(/@\S+/g, " ").normalize("NFKC").toLowerCase();
  return [...new Set([...segmenter.segment(clean.slice(0, 64000))].filter(item => item.isWordLike && item.segment.length >= 2 && item.segment.length <= 40 && !/^\d+$/.test(item.segment) && !stopWords.has(item.segment)).map(item => item.segment))].slice(0, 512);
}

/** 工作线程的词频存储，分钟桶保留发送者贡献以支持忽略名单清理。 */
export class CloudStore {
  private db: Database.Database;
  constructor(file: string) {
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 1000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cloud_documents(group_id TEXT NOT NULL,message_id TEXT NOT NULL,sender TEXT NOT NULL,minute INTEGER NOT NULL,PRIMARY KEY(group_id,message_id));
      CREATE TABLE IF NOT EXISTS cloud_counts(group_id TEXT NOT NULL,sender TEXT NOT NULL,minute INTEGER NOT NULL,word TEXT NOT NULL,n INTEGER NOT NULL,PRIMARY KEY(group_id,sender,minute,word));
      CREATE INDEX IF NOT EXISTS cloud_window ON cloud_counts(group_id,minute);
      CREATE TABLE IF NOT EXISTS cloud_inbox(group_id TEXT NOT NULL,message_id TEXT NOT NULL,sender TEXT NOT NULL,time INTEGER NOT NULL,text TEXT NOT NULL,PRIMARY KEY(group_id,message_id));
    `);
  }

  private frequencies(groupId: string, now: number, settings: ActivitySettings): WordFrequency[] {
    const since = now - settings.words.windowHours * 3600000;
    const rows: any[] = this.db.prepare("SELECT minute,word,SUM(n) AS n FROM cloud_counts WHERE group_id=? AND minute>=? GROUP BY minute,word").all(groupId, Math.ceil(since / 60000));
    const scores = new Map<string, WordFrequency>();
    for (const row of rows) {
      const score = scores.get(row.word) ?? { word: row.word, weight: 0, messages: 0 };
      score.messages += row.n;
      score.weight += row.n * Math.pow(0.5, Math.max(0, now - row.minute * 60000) / (settings.words.halfLifeHours * 3600000));
      scores.set(row.word, score);
    }
    return [...scores.values()].sort((a, b) => b.weight - a.weight || a.word.localeCompare(b.word));
  }

  private blocked(word: string, settings: ActivitySettings): boolean {
    return settings.blockedWords.some(item => word.includes(item.normalize("NFKC").toLowerCase()));
  }
  private top(items: WordFrequency[], settings: ActivitySettings): WordFrequency[] {
    return items.filter(item => item.messages >= 3 && !this.blocked(item.word, settings)).slice(0, 20);
  }
  private boost(weight: number, highest: number, settings: ActivitySettings): number {
    return highest > 0 ? Math.min(2, settings.words.maxBoostPercent / 100) * weight / highest : 0;
  }

  evaluate(groupId: string, text: string, now: number, settings: ActivitySettings): { boost: number; words: string[]; top: WordFrequency[] } {
    const top = this.top(this.frequencies(groupId, now, settings), settings);
    const tokens = new Set(cloudTokens(text));
    const matched = top.filter(item => tokens.has(item.word));
    const weight = Math.max(0, ...matched.map(item => item.weight));
    return { boost: this.boost(weight, top[0]?.weight ?? 0, settings), words: matched.map(item => item.word), top };
  }

  snapshot(groupId: string, now: number, settings: ActivitySettings): CloudTerm[] {
    const items = this.frequencies(groupId, now, settings), top = this.top(items, settings);
    const eligible = new Set(top.map(item => item.word));
    return items.map(item => ({ ...item, eligible: eligible.has(item.word), blocked: this.blocked(item.word, settings),
      boost: eligible.has(item.word) ? this.boost(item.weight, top[0]?.weight ?? 0, settings) : 0 }));
  }

  observe(groupId: string, messageId: string, sender: string, text: string, time: number, now: number) {
    this.db.transaction(() => {
      const minute = Math.floor(Math.min(time, now) / 60000);
      const result = this.db.prepare("INSERT OR IGNORE INTO cloud_documents VALUES(?,?,?,?)").run(groupId, messageId, sender, minute);
      if (!result.changes) { this.db.prepare("DELETE FROM cloud_inbox WHERE group_id=? AND message_id=?").run(groupId, messageId); return; }
      const add = this.db.prepare("INSERT INTO cloud_counts VALUES(?,?,?,?,1) ON CONFLICT(group_id,sender,minute,word) DO UPDATE SET n=n+1");
      for (const word of cloudTokens(text)) { add.run(groupId, sender, minute, word); }
      const cutoff = Math.floor((now - 168 * 3600000) / 60000);
      this.db.prepare("DELETE FROM cloud_counts WHERE minute<?").run(cutoff);
      this.db.prepare("DELETE FROM cloud_documents WHERE minute<?").run(cutoff);
      this.db.prepare("DELETE FROM cloud_inbox WHERE group_id=? AND message_id=?").run(groupId, messageId);
    })();
  }

  removeUsers(users: string[]) {
    this.db.transaction(() => {
      for (const user of users) {
        this.db.prepare("DELETE FROM cloud_counts WHERE sender=?").run(user);
        this.db.prepare("DELETE FROM cloud_documents WHERE sender=?").run(user);
        this.db.prepare("DELETE FROM cloud_inbox WHERE sender=?").run(user);
      }
    })();
  }
  recover(now: number) {
    this.db.prepare("DELETE FROM cloud_inbox WHERE time<?").run(now - 168 * 3600000);
    for (const row of this.db.prepare("SELECT * FROM cloud_inbox ORDER BY time,rowid").all() as any[]) {
      this.observe(row.group_id, row.message_id, row.sender, row.text, row.time, now);
    }
  }
  close() { this.db.close(); }
}
