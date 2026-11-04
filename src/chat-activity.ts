import { randomUUID } from "node:crypto";
import type { ActivityConfig, ActivitySettings } from "./activity-config.js";
import { groupSettings } from "./activity-config.js";
import { groupContent } from "./chat-images.js";
import type { ChatImages } from "./chat-images.js";
import { ChatState } from "./chat-state.js";
import type { GroupMessage, GroupState } from "./chat-state.js";
import type { ConfigSource, NativeSubmission, SynapseConfig } from "./types.js";
import type { WordCloud } from "./word-cloud.js";
import { abortable } from "./abort.js";

/** 主动事件只包含可信群路由，不借用真人的管理员身份。 */
export interface IdleActivation { triggerId: string; groupId: string; selfId: string; name: string }
/** 入站判定结果由宿主保存，Bot 只负责将领取标识交给原生网关。 */
export interface Observation { seq?: number; triggered: boolean; automatic?: boolean; triggerId?: string; ignored?: boolean; duplicate?: boolean; reason: string }
/** 策略持久化由配置框架提供修订号，并与正常设置页使用同一条热更新路径。 */
export type ActivityWriter = (activity: ActivityConfig, source: string, previous: ActivityConfig) => Promise<void>;

const minute = 60000, hour = 3600000;
const normalized = (value: string) => value.normalize("NFKC").toLowerCase();

export function finalProbability(settings: ActivitySettings, boost: number): number {
  const { baseBps, minBps, maxBps } = settings.probability;
  return Math.max(minBps, Math.min(maxBps, Math.round(baseBps * (1 + Math.max(0, Math.min(2, boost))))));
}

function zonedParts(time: number, timeZone: string) {
  const values = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(time);
  const get = (type: string) => values.find(part => part.type === type)?.value;
  return { day: `${get("year")}-${get("month")}-${get("day")}`, minute: Number(get("hour")) * 60 + Number(get("minute")) };
}

export function quietTime(now: number, idle: ActivitySettings["idle"]): boolean {
  const current = zonedParts(now, idle.timeZone).minute;
  const toMinute = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const start = toMinute(idle.quietStart), end = toMinute(idle.quietEnd);
  return start === end ? false : start < end ? current >= start && current < end : current >= start || current < end;
}

/** 群聊状态的唯一协调者：持久化、触发、延迟取消与原生提交确认。 */
export class ChatActivity {
  readonly state: ChatState;
  private images: ChatImages;
  private cloud: WordCloud;
  private config: ConfigSource;
  private now: () => number;
  private random: () => number;
  private onError: (error: Error) => void;
  private externalBusy: (groupId: string) => boolean;
  private writer?: ActivityWriter;
  private observations = new Map<number, Observation>();
  private groupQueues = new Map<string, Promise<unknown>>();
  private dispatching = new Set<string>();
  private timer?: NodeJS.Timeout;
  private pendingTimer?: NodeJS.Timeout;
  private maintenance?: NodeJS.Timeout;
  private background = new Set<Promise<unknown>>();
  private closed = false;
  private closing?: Promise<void>;
  private hasInput?: (sessionId: string, messageId: string, batchId: string) => Promise<boolean>;
  activate?: (event: IdleActivation) => Promise<void>;
  available: () => boolean = () => true;

  constructor(options: { state: ChatState; images: ChatImages; cloud: WordCloud; config: ConfigSource; now?: () => number; random?: () => number; onError?: (error: Error) => void; busy?: (groupId: string) => boolean; writer?: ActivityWriter }) {
    this.state = options.state; this.images = options.images; this.cloud = options.cloud; this.config = options.config;
    this.now = options.now ?? Date.now; this.random = options.random ?? Math.random; this.onError = options.onError ?? (() => {});
    this.externalBusy = options.busy ?? (() => false); this.writer = options.writer;
  }

  private track<T>(task: Promise<T>): Promise<T> {
    this.background.add(task);
    void task.finally(() => this.background.delete(task)).catch(() => {});
    return task;
  }

  private enabled(groupId: string) { return this.config().enabled && this.config().modules.chat.groups.some(id => String(id) === groupId); }
  private ignored(userId: string, selfId?: string) {
    return userId === selfId || [...this.config().modules.chat.blockedUsers, ...this.config().activity.botUsers].some(id => String(id) === userId);
  }
  private busy(groupId: string) { return this.state.busy(groupId) || this.externalBusy(groupId); }
  private log(groupId: string, type: string, reason: string, extra: Record<string, any> = {}) { this.state.log({ groupId, type, reason, time: this.now(), ...extra }); }

  private newWindow(group: GroupState, now: number) {
    const { idle } = groupSettings(this.config().activity, group.groupId);
    const seconds = (idle.windowMinutes - idle.jitterMinutes + this.random() * idle.jitterMinutes * 2) * 60;
    group.generation++; group.windowStart = now; group.windowDue = now + Math.round(seconds * 1000);
  }

  private cancelPending(group: GroupState, reason: string) {
    if (!group.pendingId) { return; }
    this.state.triggerState(group.pendingId, "cancelled");
    this.log(group.groupId, "skip", reason, { triggerId: group.pendingId });
    delete group.pendingId; delete group.pendingDue;
  }

  identity(selfId: string) {
    if (!/^\d+$/.test(selfId)) { throw new Error("机器人身份无效"); }
    for (const id of this.config().modules.chat.groups) {
      const groupId = String(id);
      let group = this.state.getGroup(groupId);
      if (!group) {
        group = { groupId, selfId, name: "", lastHumanAt: 0, lastBotAt: 0, lastAutoAt: 0, generation: 0, windowStart: 0, windowDue: 0 };
        this.newWindow(group, this.now());
      }
      group.selfId = selfId; this.state.saveGroup(group);
    }
  }

  async recover(hasInput: (sessionId: string, messageId: string, batchId: string) => Promise<boolean>) {
    this.hasInput = hasInput;
    this.state.recoverDeliveries(this.now());
    await this.reconcile(hasInput);
    await this.cloud.removeUsers([...this.config().modules.chat.blockedUsers, ...this.config().activity.botUsers].map(String));
    await this.cloud.recover?.(this.now());
    for (const group of this.state.groups()) {
      this.cancelPending(group, "重启取消未发送的空闲事件");
      // 不补发停机期间越过期限的窗口，也不重掷已完成的骰。
      if (group.windowDue <= this.now()) { this.newWindow(group, this.now()); }
      this.state.saveGroup(group);
    }
    await this.images.start();
  }

  async reconcile(hasInput: (sessionId: string, messageId: string, batchId: string) => Promise<boolean>) {
    for (const batch of this.state.unsettled()) {
      try {
        const committed = batch.sessionId && batch.messageId && await hasInput(batch.sessionId, batch.messageId, batch.id);
        if (committed) { this.state.commitBatch(batch.id); this.state.unpin(batch.id); }
        else { this.state.releaseBatch(batch.id); }
        this.log(batch.groupId, "recovery", committed ? "原生输入已保存，确认背景批次" : "原生输入未保存，恢复背景批次", { details: { batchId: batch.id } });
      } catch (cause) {
        this.log(batch.groupId, "failure", "原生提交状态暂时无法核对，保留背景批次", { details: { batchId: batch.id } });
        this.onError(cause);
      }
    }
  }

  start() {
    this.timer = setInterval(() => { void this.track(this.check()).catch(this.onError); }, minute).unref();
    this.pendingTimer = setInterval(() => { void this.track(this.dispatchDue()).catch(this.onError); }, 1000).unref();
    this.maintenance = setInterval(() => { void this.track(this.collect()).catch(this.onError); }, hour).unref();
  }

  observe(message: GroupMessage): Promise<Observation> {
    if (this.closed) { return Promise.reject(new Error("群聊状态正在关闭")); }
    if (![message.groupId, message.userId, message.selfId].every(value => typeof value === "string" && /^\d+$/.test(value)) || typeof message.messageId !== "string" || !/^-?\d+$/.test(message.messageId) || !Number.isSafeInteger(message.time)) {
      return Promise.reject(new Error("群聊事件无效"));
    }
    if (!this.enabled(message.groupId) || this.ignored(message.userId, message.selfId)) { return Promise.resolve({ triggered: false, ignored: true, reason: "AI 忽略名单或群聊未启用" }); }
    // 保存消息与更新真人活跃立即同步完成，不等待图片或词云工作线程。
    const content = groupContent(message.message, message.selfId);
    const item = this.state.db.transaction(() => {
      const item = this.state.append(message, content.rawText, content.text, content.images, this.now(), content.human ? content.rawText : undefined, true);
      if (!item) { return null; }
      let group = this.state.getGroup(message.groupId);
      if (!group) {
        group = { groupId: message.groupId, selfId: message.selfId, name: message.groupName || "", lastHumanAt: 0, lastBotAt: 0, lastAutoAt: 0, generation: 0, windowStart: 0, windowDue: 0 };
        this.newWindow(group, this.now());
      }
      group.selfId = message.selfId; group.name = message.groupName || group.name;
      if (content.human) {
        group.lastHumanAt = this.now(); this.cancelPending(group, "真人消息取消延迟中的空闲回复"); this.newWindow(group, this.now());
      }
      this.state.saveGroup(group);
      return item;
    }).immediate();
    if (!item) { return Promise.resolve({ triggered: false, duplicate: true, reason: "重复事件" }); }
    this.track(this.images.process(item.seq)).catch(this.onError);
    const previous = this.groupQueues.get(message.groupId) ?? Promise.resolve();
    const task = previous.then(async () => {
      if (!this.state.message(item.seq) || this.ignored(message.userId, message.selfId) || !this.enabled(message.groupId)) {
        return { triggered: false, ignored: true, reason: "消息在等待判定期间已被清除或忽略" };
      }
      let config = this.config(), settings = groupSettings(config.activity, message.groupId);
      const cloud = content.human
        ? await this.cloud.message(message.groupId, message.messageId, message.userId, content.rawText, message.time, this.now(), settings).catch(() => ({ boost: 0, words: [], degraded: true }))
        : { boost: 0, words: [] as string[], degraded: false };
      config = this.config(); settings = groupSettings(config.activity, message.groupId);
      if (!this.state.message(item.seq) || this.ignored(message.userId, message.selfId) || !this.enabled(message.groupId)) {
        return { triggered: false, ignored: true, reason: "消息在词云统计期间已被清除或忽略" };
      }
      if (cloud.degraded) { this.log(message.groupId, "failure", "词云统计超时或异常，本次使用基础概率"); }
      let result: Observation = { seq: item.seq, triggered: false, reason: "背景消息" };
      const allowed = !config.modules.chat.allowedUsers.length || [...config.modules.chat.allowedUsers, ...config.modules.chat.admins, ...config.modules.management.operators].includes(Number(message.userId));
      const keyword = !content.command && config.modules.chat.keywordTriggers.some(word => word && normalized(content.rawText).includes(normalized(word)));
      const direct = message.mentioned || keyword;
      if (direct && allowed) {
        result = { ...result, triggered: true, reason: message.mentioned ? "mention" : "keyword" };
      } else if (!content.command && allowed && settings.probabilityEnabled) {
        const blocked = settings.blockedWords.find(word => normalized(content.rawText).includes(normalized(word)));
        const reason = !content.human ? "非有效真人消息" : blocked ? "命中概率屏蔽词" : this.guard(message.groupId, "probability", settings);
        if (reason) { this.log(message.groupId, "skip", reason); }
        else {
          const probabilityBps = finalProbability(settings, cloud.boost);
          const hit = this.random() * 10000 < probabilityBps;
          const triggerId = this.state.trigger(message.groupId, "probability", this.now());
          this.log(message.groupId, "roll", hit ? "概率回复命中" : "概率回复未命中", { triggerId, probabilityBps, words: cloud.words, details: { boost: cloud.boost, degraded: cloud.degraded } });
          if (hit) {
            result = { ...result, triggered: true, automatic: true, triggerId, reason: "probability" };
            // 领取前也占用群忙碌状态，避免连续入站消息同时命中。
            this.state.addDelivery(`observation:${item.seq}`, message.groupId, triggerId, this.now());
            this.log(message.groupId, "hit", "概率回复等待提交", { triggerId, probabilityBps, words: cloud.words });
          } else { this.state.triggerState(triggerId, "missed"); }
        }
      } else if (!content.command && allowed && !settings.probabilityEnabled && !config.modules.chat.requireMention) {
        result = { ...result, triggered: true, reason: "bare" };
      }
      if (!allowed) { result.reason = "AI 用户白名单限制"; }
      if (result.triggered && !result.automatic) { this.state.addDelivery(`observation:${item.seq}`, message.groupId, undefined, this.now()); }
      this.state.finishObservation(item.seq, result.triggered);
      if (result.triggered) { this.observations.set(item.seq, result); }
      return result;
    });
    const tail = task.catch(() => {}).finally(() => { if (this.groupQueues.get(message.groupId) === tail) { this.groupQueues.delete(message.groupId); } });
    this.groupQueues.set(message.groupId, tail);
    return this.track(task);
  }

  private dayStart(now: number, timeZone: string): number {
    const day = zonedParts(now, timeZone).day;
    let lower = now - 36 * hour, upper = now;
    // 二分查找自然日边界，兼容夏令时的 23/25 小时日。
    while (upper - lower > 1) {
      const mid = Math.floor((lower + upper) / 2);
      if (zonedParts(mid, timeZone).day < day) { lower = mid; } else { upper = mid; }
    }
    return upper;
  }

  private guard(groupId: string, kind: "probability" | "idle", settings: ReturnType<typeof groupSettings>, exceptDelivery = ""): string {
    const now = this.now(), group = this.state.getGroup(groupId);
    if (!this.enabled(groupId) || !settings[`${kind}Enabled`]) { return "功能或群白名单未启用"; }
    if (!this.available()) { return "Bot 尚未就绪"; }
    if (this.state.busy(groupId, exceptDelivery) || this.externalBusy(groupId)) { return "群内 AI 回复执行、排队或发送中"; }
    if (kind === "idle" && quietTime(now, settings.idle)) { return "静默时段"; }
    const limits = settings[kind];
    const last = Math.max(group?.lastBotAt || 0, group?.lastAutoAt || 0);
    if (last && now - last < limits.cooldownSec * 1000) { return "群级冷却中"; }
    if (kind === "probability" && this.state.count(groupId, kind, now - minute, now) >= settings.probability.perMinute) { return "达到每分钟限额"; }
    if (this.state.count(groupId, kind, now - hour, now) >= limits.perHour) { return "达到每小时限额"; }
    if (kind === "idle" && this.state.count(groupId, kind, this.dayStart(now, settings.idle.timeZone) - 1, now) >= settings.idle.perDay) { return "达到每日限额"; }
    return "";
  }

  async check() {
    for (const group of this.state.groups()) {
      const settings = groupSettings(this.config().activity, group.groupId);
      if (!settings.idleEnabled || !this.enabled(group.groupId) || group.pendingId) { continue; }
      this.log(group.groupId, "check", "检查空闲窗口", { details: { due: group.windowDue, lastHumanAt: group.lastHumanAt } });
      if (this.now() < group.windowDue) { continue; }
      const reason = this.guard(group.groupId, "idle", settings);
      if (reason) { this.log(group.groupId, "skip", reason); continue; }
      const triggerId = this.state.trigger(group.groupId, "idle", this.now());
      const hit = this.random() * 10000 < settings.idle.probabilityBps;
      this.log(group.groupId, "roll", hit ? "空闲消息命中" : "空闲消息未命中", { triggerId, probabilityBps: settings.idle.probabilityBps });
      this.newWindow(group, this.now());
      if (hit) {
        group.pendingId = triggerId;
        group.pendingDue = this.now() + Math.round((settings.idle.delayMinSec + this.random() * (settings.idle.delayMaxSec - settings.idle.delayMinSec)) * 1000);
        this.log(group.groupId, "hit", "空闲事件进入随机延迟", { triggerId, details: { due: group.pendingDue, generation: group.generation } });
      } else { this.state.triggerState(triggerId, "missed"); }
      this.state.saveGroup(group);
    }
  }

  async dispatchDue() {
    for (const group of this.state.groups()) {
      if (!group.pendingId || group.pendingDue > this.now() || this.dispatching.has(group.pendingId)) { continue; }
      const triggerId = group.pendingId;
      const reason = this.guard(group.groupId, "idle", groupSettings(this.config().activity, group.groupId));
      if (reason) { this.cancelPending(group, reason); this.state.saveGroup(group); continue; }
      if (!this.activate) { this.log(group.groupId, "skip", "Bot 主动事件通道尚未连接", { triggerId }); continue; }
      this.dispatching.add(triggerId);
      try {
        await this.activate({ triggerId, groupId: group.groupId, selfId: group.selfId, name: group.name });
      } catch {
        this.state.triggerState(triggerId, "failed");
        this.log(group.groupId, "failure", "空闲事件提交失败，不立即重试", { triggerId });
      } finally {
        this.dispatching.delete(triggerId);
        const current = this.state.getGroup(group.groupId);
        if (current?.pendingId === triggerId) { delete current.pendingId; delete current.pendingDue; this.state.saveGroup(current); }
      }
    }
  }

  async submission(groupId: string, seq: number, triggerId?: string, signal?: AbortSignal): Promise<{ input: string; actorId: string; submission: NativeSubmission; automatic: boolean; source: "idle" | "user" }> {
    signal?.throwIfAborted();
    let observation: Observation;
    const trigger = triggerId && this.state.triggerInfo(triggerId);
    const idle = trigger && trigger.kind === "idle";
    if (idle) {
      const group = this.state.getGroup(groupId);
      if (trigger.group_id !== groupId || trigger.state !== "reserved" || group?.pendingId !== triggerId || group.pendingDue > this.now()) { throw new Error("空闲事件已取消或尚未到期"); }
      const reason = this.guard(groupId, "idle", groupSettings(this.config().activity, groupId));
      if (reason) { throw new Error(reason); }
    } else {
      observation = this.observations.get(seq);
      const message = this.state.message(seq);
      if (!observation?.triggered || message?.groupId !== groupId || this.ignored(message.userId, message.selfId)) { this.abandon(seq, "消息未通过 AI 输入判定或已失效"); throw new Error("消息未通过 AI 输入判定或已失效"); }
      if (observation.triggerId !== triggerId) { this.abandon(seq, "自动触发标识不匹配"); throw new Error("自动触发标识不匹配"); }
      if (observation.automatic) {
        const reason = this.guard(groupId, "probability", groupSettings(this.config().activity, groupId), `observation:${seq}`);
        if (reason) { this.abandon(seq, reason); throw new Error(reason); }
      }
    }
    const batch = this.state.claim(groupId, seq, this.now());
    try {
      const messages = this.state.messages(groupId, batch.id);
      await abortable(Promise.all(messages.map(message => this.images.process(message.seq))), signal);
      signal?.throwIfAborted();
      const current = seq ? this.state.message(seq) : undefined;
      const background = this.state.messages(groupId, batch.id).filter(message => message.seq !== seq).map(message => ({ messageId: message.messageId, sender: message.userId, name: message.name, time: message.time, text: message.text }));
      if (triggerId) {
        const live = this.state.triggerInfo(triggerId);
        if (live?.state !== "reserved" || idle && this.state.getGroup(groupId)?.pendingId !== triggerId) { throw new Error("自动事件在准备期间已取消"); }
        const reason = this.guard(groupId, idle ? "idle" : "probability", groupSettings(this.config().activity, groupId), idle ? "" : `observation:${seq}`);
        if (reason) { throw new Error(reason); }
        this.state.db.transaction(() => {
          this.state.submitTrigger(triggerId, this.now());
          const group = this.state.getGroup(groupId); group.lastAutoAt = this.now();
          if (idle) { delete group.pendingId; delete group.pendingDue; this.state.addDelivery(`trigger:${triggerId}`, groupId, triggerId, this.now()); }
          this.state.saveGroup(group);
          this.log(groupId, "submit", "自动任务提交到原生会话", { triggerId });
        }).immediate();
      }
      const read = () => {
        const batchState = this.state.batch(batch.id);
        if (batchState?.state !== "claimed") { throw new Error("群聊背景批次已失效"); }
        if (triggerId) {
          const enabled = groupSettings(this.config().activity, groupId)[idle ? "idleEnabled" : "probabilityEnabled"];
          if (!enabled || !this.enabled(groupId)) { throw new Error("自动任务在等待执行期间已关闭"); }
        }
        const latest = this.state.messages(groupId, batch.id);
        const current = latest.find(message => message.seq === seq);
        if (!idle && (!current || this.ignored(current.userId, current.selfId))) { throw new Error("当前发言者已被 AI 忽略或消息已清除"); }
        return {
          input: idle ? "[系统来源，非管理员] 好久没在群里说话了，说点什么吧" : `${current.name} (${current.userId}): ${current.text || "[非文本消息]"}`,
          background: latest.some(message => message.seq !== seq) ? JSON.stringify(latest.filter(message => message.seq !== seq).map(message => ({ messageId: message.messageId, sender: message.userId, name: message.name, time: message.time, text: message.text }))) : "",
        };
      };
      if (seq) { this.observations.delete(seq); }
      return {
        input: idle ? "[系统来源，非管理员] 好久没在群里说话了，说点什么吧" : `${current.name} (${current.userId}): ${current.text || "[非文本消息]"}`,
        actorId: idle ? this.state.getGroup(groupId).selfId : current.userId,
        automatic: Boolean(triggerId), source: idle ? "idle" : "user",
        submission: {
          batchId: batch.id, background: background.length ? JSON.stringify(background) : "", source: idle ? "system" : "user",
          read,
          prepared: (sessionId, messageId) => this.state.prepareBatch(batch.id, sessionId, messageId),
          committed: () => { this.state.commitBatch(batch.id); this.log(groupId, "commit", "原生输入已持久化，清理领取的背景", { triggerId, details: { batchId: batch.id } }); },
        },
      };
    } catch (cause) {
      this.state.releaseBatch(batch.id); this.abandon(seq, "任务准备或提交失败");
      if (triggerId && this.state.triggerInfo(triggerId)?.state === "reserved") { this.state.triggerState(triggerId, "cancelled"); }
      throw cause;
    }
  }

  abandon(seq: number, reason: string) {
    if (!Number.isSafeInteger(seq) || seq <= 0) { return; }
    const message = this.state.message(seq), observation = this.observations.get(seq);
    // HTTP 应答丢失时，已经领取的批次仍由原生提交确认与运行收尾负责。
    if (message?.batchId) { return; }
    if (message) { this.state.finishObservation(seq, false); this.log(message.groupId, "failure", reason, { triggerId: observation?.triggerId }); }
    if (observation?.triggerId && this.state.triggerInfo(observation.triggerId)?.state === "reserved") { this.state.triggerState(observation.triggerId, "cancelled"); }
    this.observations.delete(seq); this.state.finishDelivery(`observation:${seq}`);
  }
  disconnected() {
    for (const seq of [...this.observations.keys()]) { this.abandon(seq, "Bot 已断开，保留未提交的背景"); }
  }

  delivery(id: string, groupId: string, triggerId?: string, batchId?: string) {
    this.state.db.transaction(() => {
      this.state.addDelivery(id, groupId, triggerId, this.now());
      if (triggerId) { this.state.finishDelivery(`trigger:${triggerId}`); }
      const batch = batchId && this.state.batch(batchId);
      if (batch?.currentSeq) { this.state.finishDelivery(`observation:${batch.currentSeq}`); }
    }).immediate();
  }
  async finished(id: string, batchId?: string, failed = false, triggerId?: string) {
    let outcome: "commit" | "release" | "retain" = "release";
    const batch = batchId && this.state.batch(batchId);
    if (batch?.state === "claimed" && batch.sessionId && batch.messageId) {
      try {
        if (!this.hasInput) { throw new Error("原生提交核对不可用"); }
        outcome = await this.hasInput(batch.sessionId, batch.messageId, batch.id) ? "commit" : "release";
      } catch (cause) {
        outcome = "retain";
        this.log(batch.groupId, "failure", "提交状态无法核对，保留批次等待恢复", { details: { batchId } }); this.onError(cause);
      }
    }
    this.state.db.transaction(() => {
    if (batchId) {
      // 模型失败与输入未提交是两件事，已确认的批次不能重新投递。
      if (batch?.currentSeq) { this.state.finishDelivery(`observation:${batch.currentSeq}`); }
      if (outcome === "commit") { this.state.commitBatch(batchId); }
      else if (outcome === "release") { this.state.releaseBatch(batchId); }
      this.state.unpin(batchId);
    }
    this.state.finishDelivery(id);
    if (triggerId) { this.state.finishDelivery(`trigger:${triggerId}`); }
    if (triggerId) {
      const trigger = this.state.triggerInfo(triggerId);
      this.state.triggerState(triggerId, failed ? "failed" : "sent");
      this.log(trigger?.group_id || "", failed ? "failure" : "send", failed ? "自动回复执行或发送失败" : "自动回复发送完成", { triggerId });
    }
    }).immediate();
  }

  sent(groupId: string, eventId: string = randomUUID()) {
    const group = this.state.getGroup(groupId);
    if (!group) { return; }
    this.state.db.transaction(() => {
      if (!this.state.sentEvent(eventId, groupId, this.now())) { return; }
      group.lastBotAt = this.now(); this.state.saveGroup(group);
      this.log(groupId, "send", "Bot 成功发送群消息，刷新冷却");
    }).immediate();
  }

  reset(groupId: string) {
    this.state.reset(groupId);
    for (const [seq] of this.observations) {
      if (!this.state.message(seq)) { this.observations.delete(seq); this.state.finishDelivery(`observation:${seq}`); }
    }
  }

  async configure(previous: SynapseConfig, source: string, revision?: number) {
    const current = this.config();
    const ignored = [...current.modules.chat.blockedUsers, ...current.activity.botUsers].map(String);
    this.state.removeUsers(ignored); await this.cloud.removeUsers(ignored);
    for (const group of this.state.groups()) {
      const settings = groupSettings(current.activity, group.groupId);
      if (!settings.idleEnabled || !this.enabled(group.groupId)) { this.cancelPending(group, "配置关闭了空闲消息"); this.state.saveGroup(group); }
    }
    for (const [seq, observation] of this.observations) {
      const message = this.state.message(seq);
      if (!message || this.ignored(message.userId, message.selfId) || observation.automatic && !groupSettings(current.activity, message.groupId).probabilityEnabled) {
        this.state.finishDelivery(`observation:${seq}`);
        if (observation.triggerId) { this.state.triggerState(observation.triggerId, "cancelled"); }
        this.observations.delete(seq);
      }
    }
    this.log("", "config", "群聊策略热更新", { source, details: { revision, previous: previous.activity, current: current.activity, ignoredUsers: current.modules.chat.blockedUsers } });
    for (const groupId of current.modules.chat.groups.map(String)) {
      const before = groupSettings(previous.activity, groupId), after = groupSettings(current.activity, groupId);
      if (JSON.stringify(before) !== JSON.stringify(after) || JSON.stringify(previous.modules.chat.blockedUsers) !== JSON.stringify(current.modules.chat.blockedUsers)) {
        this.log(groupId, "config", "群聊策略热更新", { source, details: { revision, previous: before, current: after } });
      }
    }
  }

  status() {
    const now = this.now();
    return this.state.groups().filter(group => this.enabled(group.groupId)).map(group => {
      const settings = groupSettings(this.config().activity, group.groupId), last = Math.max(group.lastBotAt, group.lastAutoAt);
      const messages = this.state.messages(group.groupId);
      return { ...group, probabilityEnabled: settings.probabilityEnabled, idleEnabled: settings.idleEnabled, busy: this.busy(group.groupId), contextCount: messages.filter(message => !message.foreground && !message.batchId).length, claimedContextCount: messages.filter(message => message.batchId).length,
        probabilityCooldownUntil: last + settings.probability.cooldownSec * 1000, idleCooldownUntil: last + settings.idle.cooldownSec * 1000,
        probabilityMinute: this.state.count(group.groupId, "probability", now - minute, now), probabilityHour: this.state.count(group.groupId, "probability", now - hour, now),
        idleHour: this.state.count(group.groupId, "idle", now - hour, now), idleDay: this.state.count(group.groupId, "idle", this.dayStart(now, settings.idle.timeZone) - 1, now), limits: { probability: settings.probability, idle: settings.idle } };
    });
  }

  async collect() { this.state.prune(this.now(), this.config().activity.logRetentionDays); await this.images.collect(this.config().activity.imageRetentionDays); }
  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true; clearInterval(this.timer); clearInterval(this.pendingTimer); clearInterval(this.maintenance);
      this.closing = (async () => {
        await this.images.close();
        await Promise.allSettled(this.background);
        await this.cloud.close(); this.state.close();
      })();
    }
    return this.closing;
  }

  async command(groupId: string, userId: string, line: string): Promise<string> {
    return activityCommand(this, groupId, userId, line, this.config(), this.writer);
  }
}

async function activityCommand(activity: ChatActivity, groupId: string, userId: string, line: string, config: SynapseConfig, writer?: ActivityWriter): Promise<string> {
  const args = line.trim().split(/\s+/);
  if (args.shift()?.toLowerCase() !== "/synapse") { throw new Error("未知管理命令"); }
  const kind = args.shift();
  const operator = config.modules.management.operators.includes(Number(userId));
  if (!operator && !config.modules.chat.admins.includes(Number(userId))) { throw new Error("需要 Synapse 管理员权限"); }
  if (!["probability", "idle", "blockword", "logs"].includes(kind)) { return "用法：/synapse probability|idle|blockword|logs [status|on|off|set 参数 值|add 词|remove 词] [global]"; }
  const global = args.includes("global");
  if (global && !operator) { throw new Error("全局策略仅 operators 可以修改或查询"); }
  if (global) { args.splice(args.indexOf("global"), 1); }
  if (!global && !config.modules.chat.groups.some(id => String(id) === groupId)) { throw new Error("请在已启用聊天的群内执行，或由 operator 指定 global"); }
  if (kind === "logs") {
    const type = args[0] && args[0] !== "status" ? args[0] : undefined;
    return activity.state.logs({ groupId: global ? undefined : groupId, type, limit: 20 }).reverse().map(item => `${new Date(item.time).toISOString()} ${item.groupId || "全局"} ${item.type} ${item.reason}${item.probabilityBps === undefined ? "" : ` (${(item.probabilityBps / 100).toFixed(2)}%)`}`).join("\n") || "暂无日志";
  }
  const draft = structuredClone(config.activity);
  let target: ActivityConfig | ActivitySettings & { probabilityEnabled: boolean; idleEnabled: boolean; useDefaults?: boolean } = draft;
  if (!global) {
    let group = draft.groups.find(item => String(item.groupId) === groupId);
    if (!group) {
      const { probability, idle, words, blockedWords } = structuredClone(draft);
      group = { probability, idle, words, blockedWords, groupId: Number(groupId), probabilityEnabled: false, idleEnabled: false, useDefaults: true }; draft.groups.push(group);
    }
    target = group;
  }
  const action = args.shift() || "status";
  if (action === "status") {
    const effective = global ? draft : groupSettings(draft, groupId);
    return kind === "blockword" ? `屏蔽词：${effective.blockedWords.join("、") || "无"}` : JSON.stringify({ globalEnabled: kind === "idle" ? draft.idleEnabled : draft.probabilityEnabled, settings: effective[kind], state: global ? activity.status() : activity.status().find(item => item.groupId === groupId) }, null, 2);
  }
  if (!writer) { throw new Error("当前服务没有可写的配置句柄"); }
  if (kind === "blockword") {
    const word = args.join(" ").trim();
    if (!["add", "remove"].includes(action) || !word) { throw new Error("用法：/synapse blockword add|remove 词 [global]"); }
    if (!global && (target as any).useDefaults) {
      Object.assign(target, { probability: structuredClone(draft.probability), idle: structuredClone(draft.idle), words: structuredClone(draft.words), blockedWords: [...draft.blockedWords], useDefaults: false });
    }
    target.blockedWords = action === "add" ? [...new Set([...target.blockedWords, word])] : target.blockedWords.filter(item => item !== word);
  } else if (["on", "off"].includes(action)) { target[`${kind}Enabled`] = action === "on"; }
  else if (action === "inherit" && !global) { (target as any).useDefaults = true; }
  else if (action === "set") {
    const aliases = kind === "probability"
      ? { base: "baseBps", min: "minBps", max: "maxBps", cooldown: "cooldownSec", minute: "perMinute", hour: "perHour" }
      : { probability: "probabilityBps", window: "windowMinutes", jitter: "jitterMinutes", cooldown: "cooldownSec", hour: "perHour", day: "perDay", quietStart: "quietStart", quietEnd: "quietEnd", timezone: "timeZone", delayMin: "delayMinSec", delayMax: "delayMaxSec" };
    const key = aliases[args[0]];
    if (!key || args.length !== 2) { throw new Error(`可设置参数：${Object.keys(aliases).join("、")}；概率使用百分比，冷却与延迟使用秒`); }
    if (!global && (target as any).useDefaults) {
      Object.assign(target, { probability: structuredClone(draft.probability), idle: structuredClone(draft.idle), words: structuredClone(draft.words), blockedWords: [...draft.blockedWords], useDefaults: false });
    }
    if (key.endsWith("Bps") && !/^\d+(?:\.\d{1,2})?%?$/.test(args[1])) { throw new Error("概率使用百分比，最多两位小数"); }
    target[kind][key] = ["quietStart", "quietEnd", "timeZone"].includes(key) ? args[1] : key.endsWith("Bps") ? Math.round(Number(args[1].replace(/%$/, "")) * 100) : Number(args[1]);
  } else { throw new Error("支持 status、on、off、inherit、set 参数 值；global 表示全局设置"); }
  await writer(draft, `QQ:${userId}@${global ? "global" : groupId}`, config.activity);
  return "群聊策略已保存并热更新；现有冷却与额度保持不变。";
}
