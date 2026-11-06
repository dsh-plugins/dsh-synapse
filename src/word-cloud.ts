import { Worker } from "node:worker_threads";
import type { ActivitySettings } from "./activity-config.js";

/** 单词按消息去重后的出现次数与按时间衰减的词频。 */
export interface WordFrequency { word: string; weight: number; messages: number }
/** 统计快照保留低频词和屏蔽词，并标记实际参与加成的热词。 */
export interface CloudTerm extends WordFrequency { eligible: boolean; blocked: boolean; boost: number }
/** 设置页使用同一时刻的统计和群策略计算悬浮概率。 */
export interface GroupWordCloud {
  groupId: string; name: string; at: number; windowHours: number; halfLifeHours: number;
  enabled: boolean; baseProbabilityBps: number;
  items: (CloudTerm & { probabilityBps: number })[];
}

/** 词云工作线程的有界等待接口，故障只影响本次加成。 */
export interface WordCloud {
  message(groupId: string, messageId: string, sender: string, text: string, time: number, now: number, settings: ActivitySettings): Promise<{ boost: number; words: string[]; degraded?: boolean }>;
  removeUsers(users: string[]): Promise<void>;
  snapshot(groupId: string, now: number, settings: ActivitySettings): Promise<CloudTerm[]>;
  recover?(now: number): Promise<void>;
  close(): Promise<void>;
}

/** 同一工作线程顺序处理查询和写入，主线程等待至多 100ms。 */
export class AsyncWordCloud implements WordCloud {
  private worker: Worker;
  private requests = new Map<number, { finish(result: any): void; timer: NodeJS.Timeout }>();
  private sequence = 0;
  private failed = false;
  constructor(file: string) {
    this.worker = new Worker(new URL("./word-cloud-worker.js", import.meta.url), { workerData: { file } });
    this.worker.on("message", ({ id, result, error }) => {
      const pending = this.requests.get(id);
      if (!pending) { return; }
      this.requests.delete(id); clearTimeout(pending.timer);
      pending.finish(error ? { boost: 0, words: [], degraded: true } : result);
    });
    const fail = () => {
      this.failed = true;
      for (const { finish, timer } of this.requests.values()) { clearTimeout(timer); finish({ boost: 0, words: [], degraded: true }); }
      this.requests.clear();
    };
    this.worker.on("error", fail);
    this.worker.on("exit", fail);
  }

  private request(data: object, timeout = 100): Promise<any> {
    if (this.failed) { return Promise.resolve({ boost: 0, words: [], degraded: true }); }
    return new Promise(resolve => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.requests.delete(id); resolve({ boost: 0, words: [], degraded: true }); }, timeout);
      this.requests.set(id, { finish: resolve, timer });
      this.worker.postMessage({ ...data, id });
    });
  }

  message(groupId: string, messageId: string, sender: string, text: string, time: number, now: number, settings: ActivitySettings) {
    return this.request({ action: "message", groupId, messageId, sender, text, time, now, settings });
  }
  async snapshot(groupId: string, now: number, settings: ActivitySettings): Promise<CloudTerm[]> {
    const result = await this.request({ action: "snapshot", groupId, now, settings }, 5000);
    if (!Array.isArray(result)) { throw new Error("词云统计暂时不可用，请稍后重试"); }
    return result;
  }
  async removeUsers(users: string[]) { await this.request({ action: "remove", users }, 5000); }
  async recover(now: number) { await this.request({ action: "recover", now }, 5000); }
  async close() {
    await this.request({ action: "close" }, 5000);
    await this.worker.terminate();
  }
}
