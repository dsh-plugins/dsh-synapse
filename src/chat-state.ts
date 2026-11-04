import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

/** QQ 原始事件的 AI 专用副本，不改变命令、卡片与转发收到的消息。 */
export interface GroupMessage {
  groupId: string;
  messageId: string;
  userId: string;
  selfId: string;
  name: string;
  groupName?: string;
  time: number;
  message: unknown;
  mentioned: boolean;
}

/** 已持久化的群消息及附件状态。 */
export interface ContextMessage extends GroupMessage {
  seq: number;
  rawText: string;
  text: string;
  attachments: ImageReference[];
  batchId: string | null;
  foreground: boolean;
  expanded?: boolean;
}

/** 附件先入库后处理，失败也保留明确的状态。 */
export interface ImageReference {
  id: string;
  source: string;
  face: boolean;
  state: "pending" | "ready" | "failed";
  path?: string;
  error?: string;
}

/** 空闲窗口代次用于撤销延迟任务，冷却和配额独立于窗口。 */
export interface GroupState {
  groupId: string;
  name: string;
  selfId: string;
  lastHumanAt: number;
  lastBotAt: number;
  lastAutoAt: number;
  generation: number;
  windowStart: number;
  windowDue: number;
  pendingId?: string;
  pendingDue?: number;
}

/** 每次自动检查与配置修改均使用相同的可查询日志格式。 */
export interface ActivityLog {
  groupId: string;
  type: string;
  triggerId?: string;
  probabilityBps?: number;
  words?: string[];
  reason: string;
  source?: string;
  details?: unknown;
  time?: number;
}

/** 窗口批次与原生消息一一关联，恢复时只认原生日志中的提交记录。 */
export interface ContextBatch {
  id: string;
  groupId: string;
  state: "claimed" | "committed" | "released";
  sessionId?: string;
  messageId?: string;
  currentSeq: number;
  created: number;
}

/** 群聊持久化状态；每条入站消息在独立事务内提交。 */
export class ChatState {
  readonly db: Database.Database;
  constructor(file: string) {
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("busy_timeout = 1000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS seen(group_id TEXT NOT NULL,message_id TEXT NOT NULL,time INTEGER NOT NULL,PRIMARY KEY(group_id,message_id));
      CREATE TABLE IF NOT EXISTS context(seq INTEGER PRIMARY KEY AUTOINCREMENT,group_id TEXT NOT NULL,message_id TEXT NOT NULL,sender TEXT NOT NULL,time INTEGER NOT NULL,payload TEXT NOT NULL,batch_id TEXT,foreground INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS context_group ON context(group_id,seq);
      CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY,group_id TEXT NOT NULL,state TEXT NOT NULL,current_seq INTEGER NOT NULL,session_id TEXT,message_id TEXT,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS groups(group_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS triggers(id TEXT PRIMARY KEY,group_id TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL,submitted INTEGER);
      CREATE INDEX IF NOT EXISTS trigger_quota ON triggers(group_id,kind,submitted);
      CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,group_id TEXT NOT NULL,trigger_id TEXT,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sent_events(id TEXT PRIMARY KEY,group_id TEXT NOT NULL,time INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS activity_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,time INTEGER NOT NULL,group_id TEXT NOT NULL,type TEXT NOT NULL,trigger_id TEXT,payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS activity_log_filter ON activity_logs(group_id,time,type);
      CREATE TABLE IF NOT EXISTS image_cache(path TEXT PRIMARY KEY,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS image_pins(batch_id TEXT NOT NULL,path TEXT NOT NULL,PRIMARY KEY(batch_id,path));
      CREATE TABLE IF NOT EXISTS image_refs(seq INTEGER NOT NULL,path TEXT NOT NULL,PRIMARY KEY(seq,path));
      CREATE INDEX IF NOT EXISTS image_ref_path ON image_refs(path);
      CREATE TABLE IF NOT EXISTS cloud_inbox(group_id TEXT NOT NULL,message_id TEXT NOT NULL,sender TEXT NOT NULL,time INTEGER NOT NULL,text TEXT NOT NULL,PRIMARY KEY(group_id,message_id));
    `);
  }

  append(message: GroupMessage, rawText: string, text: string, attachments: ImageReference[], now: number, cloudText?: string, observing = false): ContextMessage | null {
    return this.db.transaction(() => {
      const inserted = this.db.prepare("INSERT OR IGNORE INTO seen VALUES(?,?,?)").run(message.groupId, message.messageId, now);
      if (!inserted.changes) { return null; }
      const payload = { ...message, rawText, text, attachments };
      // 2 表示仍在判定的原始输入，不计入已确定的未触发背景窗口。
      const result = this.db.prepare("INSERT INTO context(group_id,message_id,sender,time,payload,foreground) VALUES(?,?,?,?,?,?)").run(message.groupId, message.messageId, message.userId, message.time, JSON.stringify(payload), observing ? 2 : 0);
      if (cloudText) { this.db.prepare("INSERT OR IGNORE INTO cloud_inbox VALUES(?,?,?,?,?)").run(message.groupId, message.messageId, message.userId, message.time, cloudText); }
      this.trim(message.groupId);
      return { ...payload, seq: Number(result.lastInsertRowid), batchId: null, foreground: false };
    })();
  }

  message(seq: number): ContextMessage | undefined {
    const row: any = this.db.prepare("SELECT * FROM context WHERE seq=?").get(seq);
    return row ? { ...JSON.parse(row.payload), seq: row.seq, batchId: row.batch_id, foreground: Boolean(row.foreground) } : undefined;
  }
  allMessages(): ContextMessage[] { return (this.db.prepare("SELECT seq FROM context ORDER BY seq").all() as any[]).map(row => this.message(row.seq)); }

  messages(groupId: string, batchId?: string, includeObserving = false): ContextMessage[] {
    const rows: any[] = batchId
      ? this.db.prepare("SELECT seq FROM context WHERE group_id=? AND batch_id=? ORDER BY seq").all(groupId, batchId)
      : this.db.prepare(`SELECT seq FROM context WHERE group_id=? ${includeObserving ? "" : "AND foreground<>2"} ORDER BY seq`).all(groupId);
    return rows.map(row => this.message(row.seq));
  }

  updateMessage(seq: number, text: string, attachments: ImageReference[], expanded?: boolean) {
    const item = this.message(seq);
    if (!item) { return; }
    this.db.transaction(() => {
      this.db.prepare("UPDATE context SET payload=? WHERE seq=?").run(JSON.stringify({ ...item, text, attachments, ...(expanded === undefined ? {} : { expanded }) }), seq);
      this.db.prepare("DELETE FROM image_refs WHERE seq=?").run(seq);
      for (const image of attachments) {
        if (image.path) {
          this.db.prepare("INSERT OR IGNORE INTO image_refs VALUES(?,?)").run(seq, image.path);
          if (item.batchId) { this.db.prepare("INSERT OR IGNORE INTO image_pins VALUES(?,?)").run(item.batchId, image.path); }
        }
      }
    })();
  }

  finishObservation(seq: number, foreground: boolean) {
    this.db.transaction(() => {
      const item = this.message(seq);
      if (!item) { return; }
      this.db.prepare("UPDATE context SET foreground=? WHERE seq=?").run(Number(foreground), seq);
      this.trim(item.groupId);
    })();
  }

  private trim(groupId: string) {
    this.db.prepare(`DELETE FROM context WHERE group_id=? AND batch_id IS NULL AND foreground=0 AND seq NOT IN
      (SELECT seq FROM context WHERE group_id=? AND batch_id IS NULL AND foreground=0 ORDER BY seq DESC LIMIT 100)`).run(groupId, groupId);
  }

  claim(groupId: string, currentSeq: number, now: number): ContextBatch {
    return this.db.transaction(() => {
      const current = this.message(currentSeq);
      if (currentSeq && (!current || current.groupId !== groupId || current.batchId)) { throw new Error("触发消息已经领取或不存在"); }
      const id = randomUUID();
      this.db.prepare("INSERT INTO batches(id,group_id,state,current_seq,created) VALUES(?,?,'claimed',?,?)").run(id, groupId, currentSeq, now);
      const cutoff = currentSeq || (this.db.prepare("SELECT MAX(seq) AS seq FROM context WHERE group_id=?").get(groupId) as any).seq || 0;
      this.db.prepare("UPDATE context SET batch_id=? WHERE group_id=? AND seq<=? AND batch_id IS NULL AND foreground<>2").run(id, groupId, cutoff);
      this.db.prepare("INSERT OR IGNORE INTO image_pins SELECT ?,image_refs.path FROM image_refs JOIN context USING(seq) WHERE context.batch_id=?").run(id, id);
      return { id, groupId, state: "claimed" as const, currentSeq, created: now };
    })();
  }

  prepareBatch(id: string, sessionId: string, messageId: string) {
    const result = this.db.prepare("UPDATE batches SET session_id=?,message_id=? WHERE id=? AND state='claimed'").run(sessionId, messageId, id);
    if (!result.changes) { throw new Error("背景批次已失效"); }
  }

  commitBatch(id: string) {
    this.db.transaction(() => {
      const batch = this.batch(id);
      if (!batch || batch.state !== "claimed") { return; }
      for (const item of this.messages(batch.groupId, id)) {
        for (const image of item.attachments) {
          if (image.path) { this.db.prepare("INSERT OR IGNORE INTO image_pins VALUES(?,?)").run(id, image.path); }
        }
      }
      this.db.prepare("UPDATE batches SET state='committed' WHERE id=?").run(id);
      this.db.prepare("DELETE FROM context WHERE batch_id=?").run(id);
    })();
  }

  releaseBatch(id: string) {
    this.db.transaction(() => {
      if (this.batch(id)?.state !== "claimed") { return; }
      this.db.prepare("UPDATE batches SET state='released' WHERE id=?").run(id);
      this.db.prepare("DELETE FROM image_pins WHERE batch_id=?").run(id);
      this.db.prepare("UPDATE context SET batch_id=NULL,foreground=0 WHERE batch_id=?").run(id);
      const groupId = this.batch(id).groupId;
      this.trim(groupId);
    })();
  }

  batch(id: string): ContextBatch | undefined {
    const row: any = this.db.prepare("SELECT * FROM batches WHERE id=?").get(id);
    return row ? { id: row.id, groupId: row.group_id, state: row.state, sessionId: row.session_id, messageId: row.message_id, currentSeq: row.current_seq, created: row.created } : undefined;
  }

  unsettled(): ContextBatch[] {
    return (this.db.prepare("SELECT id FROM batches WHERE state='claimed'").all() as any[]).map(row => this.batch(row.id));
  }

  unpin(id: string) { this.db.prepare("DELETE FROM image_pins WHERE batch_id=?").run(id); }

  getGroup(groupId: string): GroupState | undefined {
    const row: any = this.db.prepare("SELECT payload FROM groups WHERE group_id=?").get(groupId);
    return row ? JSON.parse(row.payload) : undefined;
  }

  saveGroup(group: GroupState) {
    this.db.prepare("INSERT INTO groups VALUES(?,?) ON CONFLICT(group_id) DO UPDATE SET payload=excluded.payload").run(group.groupId, JSON.stringify(group));
  }

  groups(): GroupState[] {
    return (this.db.prepare("SELECT payload FROM groups ORDER BY group_id").all() as any[]).map(row => JSON.parse(row.payload));
  }

  trigger(groupId: string, kind: string, now: number, id = randomUUID()) {
    this.db.prepare("INSERT INTO triggers VALUES(?,?,?,'reserved',?,NULL)").run(id, groupId, kind, now);
    return id;
  }

  triggerState(id: string, state: string) { this.db.prepare("UPDATE triggers SET state=? WHERE id=?").run(state, id); }

  submitTrigger(id: string, now: number) {
    const result = this.db.prepare("UPDATE triggers SET state='submitted',submitted=? WHERE id=? AND state='reserved'").run(now, id);
    if (!result.changes) { throw new Error("自动触发已撤销或提交"); }
  }

  triggerInfo(id: string): { group_id: string; kind: string; state: string; created: number; submitted?: number } | undefined {
    return this.db.prepare("SELECT * FROM triggers WHERE id=?").get(id) as any;
  }

  count(groupId: string, kind: string, after: number, before = Number.MAX_SAFE_INTEGER): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM triggers WHERE group_id=? AND kind=? AND submitted>? AND submitted<=?").get(groupId, kind, after, before) as any).n;
  }

  addDelivery(id: string, groupId: string, triggerId: string | undefined, now: number) {
    this.db.prepare("INSERT INTO deliveries VALUES(?,?,?,?)").run(id, groupId, triggerId ?? null, now);
  }
  finishDelivery(id: string) { this.db.prepare("DELETE FROM deliveries WHERE id=?").run(id); }
  sentEvent(id: string, groupId: string, now: number): boolean { return Boolean(this.db.prepare("INSERT OR IGNORE INTO sent_events VALUES(?,?,?)").run(id, groupId, now).changes); }
  busy(groupId: string, exceptId = ""): boolean { return Boolean(this.db.prepare("SELECT 1 FROM deliveries WHERE group_id=? AND id<>? LIMIT 1").get(groupId, exceptId)); }

  recoverDeliveries(now: number) {
    this.db.transaction(() => {
      for (const row of this.db.prepare("SELECT * FROM deliveries").all() as any[]) {
        if (row.trigger_id) { this.log({ groupId: row.group_id, triggerId: row.trigger_id, type: "failure", reason: "重启中断了回复投递", time: now }); }
      }
      this.db.prepare("DELETE FROM deliveries").run();
      this.db.prepare("DELETE FROM image_pins").run();
      this.db.prepare("UPDATE triggers SET state='cancelled' WHERE state='reserved'").run();
      this.db.prepare("UPDATE context SET foreground=0 WHERE batch_id IS NULL").run();
      for (const row of this.db.prepare("SELECT DISTINCT group_id FROM context").all() as any[]) { this.trim(row.group_id); }
    })();
  }

  reset(groupId: string) {
    this.db.transaction(() => {
      this.db.prepare("UPDATE batches SET state='released' WHERE group_id=? AND state='claimed'").run(groupId);
      this.db.prepare("DELETE FROM context WHERE group_id=?").run(groupId);
    })();
  }

  removeUsers(users: string[]) {
    const drop = this.db.prepare("DELETE FROM context WHERE sender=?");
    this.db.transaction(() => {
      const cloud = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cloud_counts'").get());
      for (const user of users) {
        drop.run(user); this.db.prepare("DELETE FROM cloud_inbox WHERE sender=?").run(user);
        if (cloud) {
          this.db.prepare("DELETE FROM cloud_counts WHERE sender=?").run(user);
          this.db.prepare("DELETE FROM cloud_documents WHERE sender=?").run(user);
        }
      }
    })();
  }

  log(item: ActivityLog) {
    this.db.prepare("INSERT INTO activity_logs(time,group_id,type,trigger_id,payload) VALUES(?,?,?,?,?)").run(item.time ?? Date.now(), item.groupId, item.type, item.triggerId ?? null, JSON.stringify(item));
  }

  logs(filter: { groupId?: string; type?: string; from?: number; to?: number; limit?: number; beforeId?: number } = {}) {
    const clauses = ["id<?", "time>=?", "time<=?"];
    const args: any[] = [filter.beforeId ?? Number.MAX_SAFE_INTEGER, filter.from ?? 0, filter.to ?? Number.MAX_SAFE_INTEGER];
    if (filter.groupId) { clauses.push("group_id=?"); args.push(filter.groupId); }
    if (filter.type) { clauses.push("type=?"); args.push(filter.type); }
    args.push(Math.max(1, Math.min(500, filter.limit || 100)));
    return (this.db.prepare(`SELECT * FROM activity_logs WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT ?`).all(...args) as any[]).map(row => ({ ...JSON.parse(row.payload), id: row.id, time: row.time }));
  }

  registerImage(file: string, now: number) {
    this.db.prepare("INSERT INTO image_cache VALUES(?,?) ON CONFLICT(path) DO UPDATE SET created=excluded.created").run(file, now);
  }

  expiredImages(before: number): string[] {
    return (this.db.prepare(`SELECT path FROM image_cache WHERE created<?
      AND NOT EXISTS(SELECT 1 FROM image_pins WHERE image_pins.path=image_cache.path)
      AND NOT EXISTS(SELECT 1 FROM image_refs JOIN context USING(seq) WHERE image_refs.path=image_cache.path)`).all(before) as any[]).map(row => row.path);
  }
  imageExpired(file: string, before: number): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM image_cache WHERE path=? AND created<?
      AND NOT EXISTS(SELECT 1 FROM image_pins WHERE image_pins.path=image_cache.path)
      AND NOT EXISTS(SELECT 1 FROM image_refs JOIN context USING(seq) WHERE image_refs.path=image_cache.path)`).get(file, before));
  }
  hasImage(file: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM image_cache WHERE path=?").get(file)); }

  forgetImage(file: string) { this.db.prepare("DELETE FROM image_cache WHERE path=?").run(file); }

  prune(now: number, days: number) {
    const before = now - days * 86400000;
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM activity_logs WHERE time<?").run(before);
      this.db.prepare("DELETE FROM sent_events WHERE time<?").run(before);
      this.db.prepare("DELETE FROM seen WHERE time<?").run(now - Math.max(days, 7) * 86400000);
      this.db.prepare("DELETE FROM triggers WHERE created<?").run(now - Math.max(days, 2) * 86400000);
      this.db.prepare("DELETE FROM batches WHERE state!='claimed' AND created<?").run(before);
      this.db.prepare("DELETE FROM image_refs WHERE NOT EXISTS(SELECT 1 FROM context WHERE context.seq=image_refs.seq)").run();
    })();
  }

  close() { this.db.close(); }
}
