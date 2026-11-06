/** 用于排队发送的 OneBot 消息段，保留协议端的段数据。 */
export interface QQSegment { type: string; data?: any }
/** 区分桥接、通知及需要独立消息 ID 的发送请求。 */
export interface QQSendOptions { fromBridge?: boolean; fromWebhook?: boolean; merge?: boolean; signal?: AbortSignal }
interface SendTask {
  parts: QQSegment[][];
  options: QQSendOptions;
  mergeable: boolean;
  resolve: ((id: number | undefined) => void)[];
}
interface OperationTask { work: () => void | Promise<void> }
type Task = SendTask | OperationTask;
interface Outbox { type: "group" | "private" | "operation"; id: string | number; tasks: Task[]; busy: boolean; ready: boolean; preparing: boolean; controller: AbortController; active?: Task }
interface QueueOptions {
  request(action: string, payload: Record<string, unknown>, signal: AbortSignal): Promise<number | undefined>;
  limits(): { compactMaxChars: number; compactMaxLines: number; maxMessageLength: number; botName: string };
  identity(): { user_id: string | number; nickname?: string } | Promise<{ user_id: string | number; nickname?: string }>;
  canSendGroup?(groupId: string): boolean | Promise<boolean>;
  groupSignal?(groupId: string): AbortSignal;
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
    if (!this.closed && type === "group" && this.options.groupSignal) {
      const groupSignal = this.options.groupSignal(String(id));
      options = { ...options, signal: options.signal && options.signal !== groupSignal ? AbortSignal.any([options.signal, groupSignal]) : groupSignal };
    }
    if (this.closed || !message.length || options.signal?.aborted) {
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
        && tail.options.signal === options.signal
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

  /** 禁言取消本群当前发送和待发批次，其他会话继续使用共享队列。 */
  discardGroup(groupId: string): void {
    const key = `group:${groupId}`, outbox = this.outboxes.get(key);
    if (!outbox) { return; }
    outbox.controller.abort(new Error(`QQ 群 ${groupId} 的待发消息已取消`));
    for (const task of outbox.tasks.splice(0)) { this.settle(task); }
    if (outbox.active) { this.settle(outbox.active); }
    this.outboxes.delete(key);
    this.ready = this.ready.filter(item => item !== key);
    this.schedule();
  }

  /** 延迟确认全员禁言时，只移除被取消代次，保留解禁后加入的消息。 */
  discardAbortedGroup(groupId: string): void {
    const outbox = this.outboxes.get(`group:${groupId}`);
    if (!outbox) { return; }
    outbox.tasks = outbox.tasks.filter(task => {
      if ("parts" in task && task.options.signal?.aborted) { this.settle(task); return false; }
      return true;
    });
    if (outbox.active && "parts" in outbox.active && outbox.active.options.signal?.aborted) { this.settle(outbox.active); }
    if (!outbox.tasks.length && !outbox.busy) { this.discardGroup(groupId); }
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
      outbox = { type, id, tasks: [], busy: false, ready: false, preparing: false, controller: new AbortController() };
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
      if (!outbox) { this.schedule(); return; }
      outbox.ready = false;
      const task = outbox.tasks[0];
      let prepared: PreparedMessage;
      try {
        if (outbox.type === "group" && this.options.canSendGroup) {
          const allowed = this.options.canSendGroup(String(outbox.id));
          if (typeof allowed !== "boolean") {
            outbox.preparing = true;
            void allowed.then(canSend => {
              if (this.closed || this.outboxes.get(key) !== outbox) { return; }
              outbox.preparing = false;
              if (canSend) { this.enqueue(key, outbox); }
              else { this.discardGroup(String(outbox.id)); }
            }, error => {
              if (this.closed || this.outboxes.get(key) !== outbox) { return; }
              this.discardGroup(String(outbox.id));
              this.options.onError(new Error(`QQ 群 ${outbox.id} 禁言检查失败`, { cause: error }));
            });
            this.schedule();
            return;
          }
          if (!allowed || this.outboxes.get(key) !== outbox) { this.discardGroup(String(outbox.id)); this.schedule(); return; }
        }
        if (outbox.tasks[0] !== task) { this.enqueue(key, outbox); return; }
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
          if (this.outboxes.get(key) !== outbox) { return; }
          outbox.preparing = false;
          if (!this.closed) {
            this.enqueue(key, outbox);
          }
        }, error => {
          this.identityTask = undefined;
          if (this.outboxes.get(key) !== outbox) { return; }
          outbox.preparing = false;
          const index = outbox.tasks.indexOf(task);
          if (index >= 0) { outbox.tasks.splice(index, 1); this.settle(task); }
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
      outbox.active = task;
      this.active.add(task);
      void this.execute(outbox, task, prepared).finally(() => {
        this.active.delete(task);
        this.finish(key, outbox);
      });
      this.nextAt = Date.now() + this.intervalMs;
      this.schedule();
    }, Math.max(0, this.nextAt - Date.now()));
  }

  private finish(key: string, outbox: Outbox): void {
    if (this.outboxes.get(key) !== outbox) { return; }
    outbox.busy = false;
    outbox.active = undefined;
    if (!this.closed) {
      if (outbox.tasks.length) {
        this.enqueue(key, outbox);
      } else {
        this.outboxes.delete(key);
      }
    }
  }

  private prepare(task: SendTask): PreparedMessage {
    task.options.signal?.throwIfAborted();
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
      const signal = AbortSignal.any([this.shutdown.signal, outbox.controller.signal, ...(task.options.signal ? [task.options.signal] : [])]);
      signal.throwIfAborted();
      id = await this.options.request(`send_${outbox.type}_${forward ? "forward_msg" : "msg"}`, payload, signal);
      signal.throwIfAborted();
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
