import { abortable } from "./abort.js";

interface MuteState {
  until?: number;
  whole?: boolean;
  role?: string;
  memberRevision: number;
  wholeRevision: number;
  roleRevision: number;
  blocked: boolean;
  generation: number;
  reply: AbortController;
  pendingWhole: { reply: AbortController; generation: number }[];
  olderReplies: AbortController[];
  query?: { controller: AbortController; task: Promise<boolean> };
}
interface MuteOptions {
  identity(): { user_id: string | number } | Promise<{ user_id: string | number }>;
  request(action: string, params: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>>;
  changed(groupId: string, blocked: boolean): void;
  cancel?(groupId: string, throughGeneration: number): void;
  now?: () => number;
}

/** 缓存每群的自身禁言截止时间、全员禁言与角色；连接中断后必须重新查询。 */
export class QQMute {
  private groups = new Map<string, MuteState>();
  private closed = false;
  constructor(private options: MuteOptions) {}

  canSend(groupId: string): boolean | Promise<boolean> {
    if (this.closed) { return false; }
    const state = this.get(groupId);
    this.refresh(groupId, state);
    if (state.blocked || !state.pendingWhole.length && state.until !== undefined && state.whole !== undefined && (!state.whole || state.role !== undefined)) {
      return !state.blocked;
    }
    if (!state.query) {
      const controller = new AbortController();
      const query = { controller, task: undefined as Promise<boolean> };
      state.query = query;
      query.task = this.load(groupId, state, AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]))
        .finally(() => { if (state.query === query) { state.query = undefined; } });
    }
    return state.query.task;
  }

  /** 回复持有这一代信号，解禁创建的新信号不会恢复旧回复。 */
  replySignal(groupId: string): AbortSignal {
    const state = this.get(groupId);
    this.refresh(groupId, state);
    return state.reply.signal;
  }

  replyGeneration(groupId: string): number { return this.get(groupId).generation; }

  async notice(event: any): Promise<void> {
    if (this.closed || event.post_type !== "notice" || !/^[1-9]\d*$/.test(String(event.group_id))) { return; }
    const self = String(event.user_id) === String(event.self_id);
    const whole = String(event.user_id) === "0";
    if ((!self && !whole) || !["group_ban", "group_admin"].includes(event.notice_type)) { return; }
    const groupId = String(event.group_id), state = this.get(groupId);
    if (event.notice_type === "group_admin") {
      if (!self || !["set", "unset"].includes(event.sub_type)) { return; }
      if (event.sub_type === "set" && state.role === undefined && state.pendingWhole.length) {
        state.role = "member";
        this.refresh(groupId, state);
      }
      state.role = event.sub_type === "set" ? "admin" : "member";
      state.roleRevision++;
    } else {
      if (!["ban", "lift_ban"].includes(event.sub_type)) { return; }
      if (whole) {
        if (state.role === undefined && !state.blocked && (event.sub_type === "ban" && !state.whole || event.sub_type === "lift_ban" && state.whole === true && state.pendingWhole.length)) {
          state.pendingWhole.push({ reply: state.reply, generation: state.generation });
          state.generation++; state.reply = new AbortController();
        }
        state.whole = event.sub_type === "ban";
        state.wholeRevision++;
      } else {
        const duration = Number(event.duration);
        if (event.sub_type === "ban" && (!Number.isFinite(duration) || duration <= 0)) { return; }
        const time = Number(event.time) > 0 ? Number(event.time) * 1000 : this.now();
        state.until = event.sub_type === "ban" ? time + duration * 1000 : 0;
        state.memberRevision++;
      }
    }
    this.refresh(groupId, state);
    if (state.whole && state.role === undefined && !state.blocked) { await this.canSend(groupId); }
  }

  clear(): void {
    for (const state of this.groups.values()) {
      state.query?.controller.abort(new Error("OneBot 连接变化，禁言缓存已清除"));
      state.query = undefined;
      state.until = undefined; state.whole = undefined; state.role = undefined;
      state.memberRevision++; state.wholeRevision++; state.roleRevision++;
      if (state.blocked) { state.generation++; state.reply = new AbortController(); }
      state.blocked = false;
    }
  }

  close(): void {
    this.closed = true;
    this.clear();
    for (const state of this.groups.values()) { state.reply.abort(new Error("Bot 已停止")); }
    for (const state of this.groups.values()) {
      for (const pending of state.pendingWhole) { pending.reply.abort(new Error("Bot 已停止")); }
      for (const reply of state.olderReplies) { reply.abort(new Error("Bot 已停止")); }
    }
    this.groups.clear();
  }

  private now() { return (this.options.now ?? Date.now)(); }
  private get(groupId: string): MuteState {
    if (!/^[1-9]\d*$/.test(groupId)) { throw new Error("禁言检查的群号无效"); }
    let state = this.groups.get(groupId);
    if (!state) {
      state = { memberRevision: 0, wholeRevision: 0, roleRevision: 0, blocked: false, generation: 0, reply: new AbortController(), pendingWhole: [], olderReplies: [] };
      this.groups.set(groupId, state);
    }
    return state;
  }
  private refresh(groupId: string, state: MuteState): void {
    let cancelled = -1;
    const reason = new Error(`QQ 群 ${groupId} 中 Bot 已被禁言`);
    // 角色确认前保留禁言经过，快速解禁也必须取消当时的旧回复。
    if (state.role !== undefined) {
      for (const pending of state.pendingWhole.splice(0)) {
        if (state.role === "member") { pending.reply.abort(reason); cancelled = Math.max(cancelled, pending.generation); }
        else { state.olderReplies.push(pending.reply); }
      }
    }
    const blocked = state.until > this.now() || state.whole === true && state.role === "member";
    if (blocked !== state.blocked) {
      state.blocked = blocked;
      if (blocked) {
        state.reply.abort(reason); cancelled = Math.max(cancelled, state.generation);
        for (const pending of state.pendingWhole.splice(0)) { pending.reply.abort(reason); }
      }
      else { state.generation++; state.reply = new AbortController(); }
      this.options.changed(groupId, blocked);
    }
    if (cancelled >= 0) {
      for (const reply of state.olderReplies.splice(0)) { reply.abort(reason); }
      this.options.cancel?.(groupId, cancelled);
    }
  }
  private async load(groupId: string, state: MuteState, signal: AbortSignal): Promise<boolean> {
    const { memberRevision, wholeRevision, roleRevision } = state;
    const identity = await abortable(Promise.resolve(this.options.identity()), signal);
    signal.throwIfAborted();
    if (!identity?.user_id) { throw new Error("禁言检查未获取到 Bot QQ 号"); }
    const [member, group] = await abortable(Promise.all([
      this.options.request("get_group_member_info", { group_id: Number(groupId), user_id: Number(identity.user_id), no_cache: true }, signal),
      this.options.request("get_group_info", { group_id: Number(groupId), no_cache: true }, signal),
    ]), signal);
    signal.throwIfAborted();
    const until = Number(member?.shut_up_timestamp), whole = group?.group_all_shut;
    if (!Number.isFinite(until) || until < 0 || !["member", "admin", "owner"].includes(String(member?.role)) || ![0, -1, 1, false, true].includes(whole as any)) {
      throw new Error(`QQ 群 ${groupId} 的禁言查询未返回有效的截止时间、群角色或全员禁言状态`);
    }
    // 查询开始后收到的通知优先，避免旧回执覆盖禁言或解禁事件。
    if (state.memberRevision === memberRevision) { state.until = until * 1000; }
    if (state.wholeRevision === wholeRevision) { state.whole = Boolean(whole); }
    if (state.roleRevision === roleRevision) { state.role = String(member.role); }
    this.refresh(groupId, state);
    return !state.blocked;
  }
}
