import type { Observation, IdleActivation } from "./chat-activity.js";
import { randomUUID } from "node:crypto";

/** Bot 子进程只传输原始事件和发送完成通知；判定与配额全部留在宿主。 */
export class BotActivity {
  bot: any;
  onIdle?: (event: IdleActivation) => Promise<void>;
  private connection: () => { apiUrl: string; apiKey: string };
  private blockedUsers?: number[];
  private botUsers: number[] = [];
  private ingress = new Map<string, Promise<unknown>>();
  private notifications = new Set<Promise<unknown>>();
  constructor(connection: () => { apiUrl: string; apiKey: string }) {
    this.connection = connection;
    process.on("message", (message: any) => {
      if (message?.type === "activity-config") {
        this.blockedUsers = message.blockedUsers; this.botUsers = message.activity.botUsers;
      }
      if (message?.type === "activity-idle") {
        const task = this.onIdle ? this.onIdle(message.event) : Promise.reject(new Error("群聊会话尚未初始化"));
        void task.then(
          () => process.send?.({ type: "activity-ack", id: message.id }),
          () => process.send?.({ type: "activity-ack", id: message.id, error: "主动事件提交失败" }),
        );
      }
    });
  }
  ignored(userId: string, initial: number[] = []) { return [...(this.blockedUsers ?? initial), ...this.botUsers].some(id => String(id) === userId); }

  async request(action: string, input: object, timeout = 60000): Promise<any> {
    const config = this.connection();
    const response = await fetch(`${config.apiUrl}/v1/activity/${action}`, {
      method: "POST", signal: AbortSignal.timeout(timeout),
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", "X-Synapse-Bot": process.env.SYNAPSE_BOT_EPOCH || "" }, body: JSON.stringify(input),
    });
    const data = await response.json() as any;
    if (!response.ok) { throw new Error(data.error || "群聊状态请求失败"); }
    return data;
  }

  observe(message: any): Promise<Observation> {
    const groupId = String(message.group_id);
    const previous = this.ingress.get(groupId) ?? Promise.resolve();
    const task = previous.then(() => this.request("observe", {
      groupId, messageId: String(message.message_id), userId: String(message.user_id), selfId: String(message.self_id),
      name: String(message.sender?.card || message.sender?.nickname || message.user_id), time: Number(message.time || Math.floor(Date.now() / 1000)) * 1000,
      message: message.message, mentioned: Array.isArray(message.message)
        ? message.message.some(segment => segment.type === "at" && String(segment.data?.qq) === String(message.self_id))
        : new RegExp(`\\[CQ:at,qq=${message.self_id}(?:,|\\])`).test(String(message.message)),
    }));
    const tail = task.catch(() => {}).finally(() => { if (this.ingress.get(groupId) === tail) { this.ingress.delete(groupId); } });
    this.ingress.set(groupId, tail);
    return task;
  }

  async attach(bot: any) {
    this.bot = bot;
    const identity = await bot.getLoginInfo();
    await this.request("identity", { selfId: String(identity.user_id) });
  }
  sent(groupId: number | string) {
    const eventId = randomUUID();
    if (process.connected) { process.send?.({ type: "activity-sent", groupId: String(groupId), eventId }); }
    const task = this.request("sent", { groupId: String(groupId), eventId }, 10000).catch(() => { this.bot?.logger?.warn("[Synapse] 群消息已发送，冷却状态已通过 IPC 通知，HTTP 确认失败"); });
    this.notifications.add(task);
    void task.finally(() => this.notifications.delete(task));
  }
  async finished(runId: string, failed: boolean) {
    await Promise.allSettled(this.notifications);
    if (process.connected) { process.send?.({ type: "activity-finished", runId, failed }); }
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await this.request("finished", { runId, failed }, 10000); return; }
      catch (cause) {
        this.bot?.logger?.warn(`[Synapse] 运行 ${runId} 收尾通知失败（${attempt + 1}/3）`);
        if (attempt === 2) { throw cause; }
        await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 300));
      }
    }
  }
  async command(groupId: string, userId: string, line: string) {
    return (await this.request("command", { groupId, userId, line })).text as string;
  }
}

let instance: BotActivity;
/** 上游各模块共享一个 IPC 接收器，避免重复处理主动事件。 */
export function botActivity(connection: () => { apiUrl: string; apiKey: string }): BotActivity {
  return instance ??= new BotActivity(connection);
}
