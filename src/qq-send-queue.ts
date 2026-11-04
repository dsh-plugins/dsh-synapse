/** 用于排队发送的 OneBot 消息段，保留协议端的段数据。 */
export interface QQSegment { type: string; data?: any }
/** 区分桥接、通知及需要独立消息 ID 的发送请求。 */
export interface QQSendOptions { fromBridge?: boolean; fromWebhook?: boolean; merge?: boolean }
interface SendTask {
  parts: QQSegment[][];
  options: QQSendOptions;
  mergeable: boolean;
  resolve: ((id: number | undefined) => void)[];
}
interface OperationTask { work: () => void | Promise<void> }
type Task = SendTask | OperationTask;
interface Outbox { type: "group" | "private" | "operation"; id: string | number; tasks: Task[]; busy: boolean; ready: boolean; preparing: boolean }
interface QueueOptions {
  request(action: string, payload: Record<string, unknown>, signal: AbortSignal): Promise<number | undefined>;
  limits(): { compactMaxChars: number; compactMaxLines: number; maxMessageLength: number; botName: string };
  identity(): { user_id: string | number; nickname?: string } | Promise<{ user_id: string | number; nickname?: string }>;
  sent(event: { groupId: number; message: QQSegment[]; messageId: number; fromBridge: boolean; fromWebhook: boolean }): void;
  onError(error: unknown): void;
}
interface PreparedMessage { message: QQSegment[]; forward: boolean; limits: ReturnType<QueueOptions["limits"]> }

const mergeableTypes = new Set(["text", "at", "reply", "image", "face", "node"]);
const quote = (parts: QQSegment[][]) => parts.flat().find(segment => segment.type === "reply")?.data?.id;

/** 每个 QQ 会话独立合并待发消息，共用全局发送间隔。 */
export class QQSendQueue {
  private outboxes = new Map<string, Outbox>();
  private ready: string[] = [];
  private active = new Set<Task>();
  private timer?: ReturnType<typeof setTimeout>;
  private nextAt = 0;
  private closed = false;
  private shutdown = new AbortController();
  private identity?: Awaited<ReturnType<QueueOptions["identity"]>>;
  private identityTask?: Promise<Awaited<ReturnType<QueueOptions["identity"]>>>;

  constructor(private options: QueueOptions, private intervalMs = 2000) {}

  send(type: "group" | "private", id: string | number, message: QQSegment[], options: QQSendOptions = {}): Promise<number | undefined> {
    if (this.closed || !message.length) {
      return Promise.resolve(undefined);
    }
    const key = `${type}:${id}`;
    const outbox = this.get(key, type, id);
    const parts = [structuredClone(message)];
    const mergeable = options.merge !== false && !options.fromBridge && message.every(segment => mergeableTypes.has(segment.type)
      && (segment.type !== "node" || typeof segment.data?.content === "string" || Array.isArray(segment.data?.content)));
    return new Promise(resolve => {
      const tail = outbox.tasks.at(-1);
      const currentQuote = quote(parts);
      if (tail && "parts" in tail && tail.mergeable && mergeable
        && Boolean(tail.options.fromBridge) === Boolean(options.fromBridge)
        && Boolean(tail.options.fromWebhook) === Boolean(options.fromWebhook)
        && (currentQuote === undefined || currentQuote === quote(tail.parts))) {
        tail.parts.push(...parts);
        tail.resolve.push(resolve);
      } else {
        outbox.tasks.push({ parts, options: { ...options }, mergeable, resolve: [resolve] });
      }
      this.enqueue(key, outbox);
    });
  }

  operation(work: () => void | Promise<void>): void {
    if (this.closed) {
      return;
    }
    const outbox = this.get("operation", "operation", "operation");
    outbox.tasks.push({ work });
    this.enqueue("operation", outbox);
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.shutdown.abort();
    for (const outbox of this.outboxes.values()) {
      for (const task of outbox.tasks) {
        this.settle(task);
      }
    }
    for (const task of this.active) {
      this.settle(task);
    }
    this.outboxes.clear();
    this.ready = [];
  }

  private get(key: string, type: Outbox["type"], id: string | number): Outbox {
    let outbox = this.outboxes.get(key);
    if (!outbox) {
      outbox = { type, id, tasks: [], busy: false, ready: false, preparing: false };
      this.outboxes.set(key, outbox);
    }
    return outbox;
  }

  private enqueue(key: string, outbox: Outbox): void {
    if (!outbox.busy && !outbox.ready && !outbox.preparing && outbox.tasks.length) {
      outbox.ready = true;
      this.ready.push(key);
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.closed || this.timer || !this.ready.length) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (Date.now() < this.nextAt) {
        this.schedule();
        return;
      }
      const key = this.ready.shift();
      const outbox = this.outboxes.get(key);
      outbox.ready = false;
      const task = outbox.tasks[0];
      let prepared: PreparedMessage;
      try {
        if ("parts" in task) {
          prepared = this.prepare(task);
        }
      } catch (error) {
        outbox.tasks.shift();
        this.settle(task);
        this.finish(key, outbox);
        this.options.onError(error);
        this.schedule();
        return;
      }
      if (prepared?.forward && !this.identity) {
        outbox.preparing = true;
        this.identityTask ??= Promise.resolve().then(() => this.options.identity()).then(identity => {
          if (!identity?.user_id) {
            throw new Error("OneBot 未返回有效的机器人身份");
          }
          this.identity = identity;
          return identity;
        });
        void this.identityTask.then(() => {
          outbox.preparing = false;
          if (!this.closed) {
            this.enqueue(key, outbox);
          }
        }, error => {
          this.identityTask = undefined;
          outbox.preparing = false;
          outbox.tasks.shift();
          this.settle(task);
          this.finish(key, outbox);
          if (!this.closed) {
            this.options.onError(error);
          }
        });
        this.schedule();
        return;
      }
      outbox.tasks.shift();
      outbox.busy = true;
      this.active.add(task);
      void this.execute(outbox, task, prepared).finally(() => {
        this.active.delete(task);
        this.finish(key, outbox);
      });
      this.schedule();
    }, Math.max(0, this.nextAt - Date.now()));
  }

  private finish(key: string, outbox: Outbox): void {
    outbox.busy = false;
    if (!this.closed) {
      if (outbox.tasks.length) {
        this.enqueue(key, outbox);
      } else {
        this.outboxes.delete(key);
      }
    }
  }

  private prepare(task: SendTask): PreparedMessage {
    const limits = this.options.limits();
    const expand = (segment: QQSegment): QQSegment[] => {
      if (segment.type !== "node") {
        return [segment];
      }
      const content = segment.data?.content;
      if (typeof content === "string") {
        return [{ type: "text", data: { text: content } }];
      }
      return Array.isArray(content) ? content.filter(item => item.type !== "reply").flatMap(expand) : [segment];
    };
    const message: QQSegment[] = [];
    for (const part of task.parts) {
      if (message.length) {
        message.push({ type: "text", data: { text: "\n" } });
      }
      message.push(...part.flatMap(expand).filter(segment => segment.type !== "reply" || !message.some(previous => previous.type === "reply")));
    }
    const text = message.filter(segment => segment.type === "text").map(segment => segment.data.text).join("");
    const forward = task.parts.flat().some(segment => segment.type === "node")
      || limits.compactMaxChars > 0 && text.length > limits.compactMaxChars
      || limits.compactMaxLines > 0 && text.split("\n").length > limits.compactMaxLines
      || limits.maxMessageLength > 0 && text.length > limits.maxMessageLength;
    return { message, forward, limits };
  }

  private async execute(outbox: Outbox, task: Task, prepared?: PreparedMessage): Promise<void> {
    let id: number | undefined;
    try {
      if ("work" in task) {
        this.nextAt = Date.now() + this.intervalMs;
        await task.work();
        return;
      }
      const { limits, message, forward } = prepared;
      let payload: Record<string, unknown> = { [`${outbox.type === "group" ? "group" : "user"}_id`]: outbox.id, message };
      if (forward) {
        const login = this.identity;
        const nodes: QQSegment[] = [];
        for (const part of task.parts) {
          let content: QQSegment[] = [];
          const flush = () => {
            if (content.length) {
              nodes.push({ type: "node", data: { name: limits.botName || login.nickname || String(login.user_id), uin: String(login.user_id), content } });
              content = [];
            }
          };
          for (const segment of part) {
            if (segment.type === "node") {
              flush();
              nodes.push(segment);
            } else if (segment.type !== "reply") {
              content.push(segment);
            }
          }
          flush();
        }
        payload = { [`${outbox.type === "group" ? "group" : "user"}_id`]: outbox.id, messages: nodes };
      }
      this.shutdown.signal.throwIfAborted();
      this.nextAt = Date.now() + this.intervalMs;
      id = await this.options.request(`send_${outbox.type}_${forward ? "forward_msg" : "msg"}`, payload, this.shutdown.signal);
      if (id === undefined) {
        throw new Error(`QQ ${outbox.type}:${outbox.id} 发送失败，OneBot 未返回消息 ID`);
      }
      if (!this.closed && outbox.type === "group") {
        this.options.sent({ groupId: Number(outbox.id), message, messageId: id, fromBridge: Boolean(task.options.fromBridge), fromWebhook: Boolean(task.options.fromWebhook) });
      }
    } catch (error) {
      id = undefined;
      if (!this.closed) {
        this.options.onError(new Error(`QQ ${outbox.type}:${outbox.id} 发送失败：${error instanceof Error ? error.message : String(error)}`, { cause: error }));
      }
    } finally {
      this.settle(task, this.closed ? undefined : id);
    }
  }

  private settle(task: Task, id?: number): void {
    if ("resolve" in task) {
      for (const resolve of task.resolve) {
        resolve(id);
      }
    }
  }
}
