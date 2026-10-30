import fs from 'node:fs';
import path from 'node:path';
import { Message as DiscordMessage } from 'discord.js';
import { QQBot } from '@/index';
import { GroupMessageWSMSG, PrivateMessageWSMSG, ReceiveMessage, SentMessage } from '@/type';
import { getHermesConfig, isHermesAdmin } from '@/features/hermes/config';
import { HermesClient } from '@/features/hermes/client';
import { SkillManager } from '@/features/hermes/skills';
import { ChatHistoryStore } from '@/features/hermes/history';
import { buildConversationHistory, buildGroupContext, appendAutoCardNote } from '@/features/hermes/context';
import { MessageResolvers, parseMessage } from '@/features/hermes/message';
import { ReplyUnit, ReplyUnitOptions, splitReplyIntoUnits, takeCompleteUnits } from '@/features/hermes/reply-units';
import { ReactionManager } from '@/features/hermes/reaction';
import { Github } from '@/features/github';
import { isGithubEnabledGroup } from '@/config/features';
import { renderApprovalImage, renderProgressImage } from '@/features/hermes/render';
import {
  decideGroupTrigger,
  isResetCommand,
  isStopCommand,
  parseApprovalChoice,
  splitMessageText
} from '@/features/hermes/trigger';
import {
  Approval,
  ApprovalChoice,
  DiscordChatParams,
  FormattedMessage,
  GroupAdminApi,
  HermesApprovalEvent,
  MessageContentPart,
  OneBotGetForwardMsgResponse,
  OneBotGetMsgResponse,
  OneBotGroupMemberInfo,
  RouteInfo,
  RunState,
  Session
} from '@/features/hermes/types';

/**
 * QQ ⇄ Hermes Agent 桥接（移植自 qq-hermes-bridge src/index.ts，MIT 协议，原作者 Amorter：
 * https://github.com/Amorter/qq-hermes-bridge）。
 *
 * 与上游的差异：
 * - OneBot 连接/事件/发送全部复用本仓库 QQBot（不再自建 WebSocket 客户端）；
 * - 配置改为 configs/features/hermes.json（ConfigStore 热重载），SOUL.md 读 configs/SOUL.md；
 * - 管理员 = hermes admins ∪ management operators；
 * - 群聊命令守卫：/ 或 ! 开头的消息不触发（除非显式 @bot），避免与 gugle-command 双重响应；
 * - 审批否定词（不允许/不批准）匹配顺序修正（上游先匹配「批准」导致否定词不可达）；
 * - 不实现 COMPACT_LINES 合并转发（上游默认关闭），长回复按长度切分发送；
 * - QQ 群聊的 AI 回复改为「逐句发送」：流式增量里已完整的句子立即作为独立消息发出，
 *   单条超过 compactMaxChars 字或 compactMaxLines 行时改用聊天记录（合并转发）发送；
 *   引用只贴在本轮首条单元上；QQ 私聊与 Discord 维持原有整段切分行为；
 * - 触发消息的引用/聊天记录按深度解析（depth ≤ 1 转发图片原图、depth 2 仅文字、
 *   depth ≥ 3 记作 [聊天记录]），引用与聊天记录内的图片都会作为多模态输入转发给 AI
 *   （解析逻辑见 message.ts；get_msg 只回 file 时兜底调 NapCat get_image 换直链）；
 * - 多人共享历史在提交时按当前对话者标注归属（[群聊背景] / [你回复 xxx 的话]），
 *   系统提示显式声明当前对话者与标注约定，避免串台认错人（context.ts）；
 * - 技能系统在群管理技能之外扩展卡片类公共技能（查Issue / B站视频），技能可产出
 *   base64 图片，由完成处理器逐张发送（复用 github / bili 功能的渲染管线）；
 * - 查询类技能（MC版本 / MC服务器 / MC维基 / Modrinth版本，feedback 标记）的执行结果
 *   不直接发摘要，而是作为 [工具结果] 输入再提交一轮 run 由 AI 整理回答（最多回喂
 *   MAX_FEEDBACK_DEPTH 轮防循环，达上限后数据附在回复里兜底）；
 * - 触发 AI 时给触发消息贴「处理中」表情回应（QQ 贴表情 / Discord reaction，
 *   reaction.ts），完整回复完成（含回喂轮）后摘除；记录立即持久化到
 *   data/hermes-reactions.json，进程在回应期间退出时下次启动自动清理残留；
 *   QQ 私聊消息 NapCat 通常不支持表情回应，贴失败时退化为一条文字回执
 *   （privateReceiptText），AI 首条回复发出后撤回，让用户确认「AI 收到了」；
 * - AI 的群回复经 bot.sendGroupMsg 发出，会按既定行为同步转发到互通的 Discord 频道。
 *
 * Discord 频道触发（对上游的扩展）：
 * - 互通的 Discord 频道消息同样可触发 AI（@提及/关键词/requireMention 同一套规则），
 *   频道是否启用由其桥接的 QQ 群是否在 hermes.json groups 中决定；
 * - Discord 与 QQ 群共享同一份会话上下文（group:{群号}），AI 能看到两侧的对话；
 * - AI 回复发在提问侧（Discord 提问回 Discord，QQ 提问回 QQ），发送经 DiscordBridge
 *   注入的委托完成，本模块不持有 discord.js Client；
 * - Discord 侧管理员（服务器拥有者/管理服务器/管理员权限）可审批与调用管理技能；
 *   QQ 用户黑白名单（allowedUsers/blockedUsers）不约束 Discord 用户。
 */

/** 图片扩展名 → MIME 类型映射（本地图片转 base64 data URL 用） */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp'
};

/** 从路径/URL 扩展名推断 MIME，未知默认 image/jpeg */
function mimeFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.split(/[?#]/)[0]?.toLowerCase() || '';
  return IMAGE_MIME_BY_EXT[ext] || 'image/jpeg';
}

/** 保留标签：命中即不得经流式/工具边界下发，统一留给 finishRun 处理 */
const RESERVED_LABEL_RE = /\[SKILL:|MEDIA:/;

export class HermesBridge {
  private static instance?: HermesBridge;

  public static getInstance(): HermesBridge {
    if (!HermesBridge.instance) HermesBridge.instance = new HermesBridge();
    return HermesBridge.instance;
  }

  private bot?: QQBot;
  private readonly hermes = new HermesClient();
  private readonly skillManager = new SkillManager();
  /** 「处理中」表情回应（触发时贴上、完整回复后摘除、残留随重启清理） */
  private readonly reactions = ReactionManager.getInstance();

  /** 查询技能结果回喂的最大轮数（防止 AI 反复调用查询技能死循环） */
  private static readonly MAX_FEEDBACK_DEPTH = 2;

  /** 对话会话：sessionKey → Session */
  private readonly sessions = new Map<string, Session>();
  /** 活跃运行：runId → RunState */
  private readonly activeRuns = new Map<string, RunState>();
  /** 待审批记录：runId → Approval */
  private readonly pendingApprovals = new Map<string, Approval>();
  /** 已发送审批消息跟踪：runId → true（防止重复发送） */
  private readonly approvalMessageSent = new Map<string, boolean>();
  /** 群成员昵称缓存：groupId:userId → 群名片或昵称 */
  private readonly memberCache = new Map<string, string>();

  /** 历史存储（随持久化配置变更重建） */
  private historyStore?: ChatHistoryStore;
  private historyStoreKey = '';

  private constructor() {}

  // ===================================================================
  //  事件入口
  // ===================================================================

  /** message-event-group 钩子 */
  public handleGroupMessage(bot: QQBot, msg: GroupMessageWSMSG): void {
    this.handleMessageSafe(bot, msg).catch(error => {
      bot.logger?.error(`[Hermes] 群消息处理失败: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    });
  }

  /** message-event-private 钩子 */
  public handlePrivateMessage(bot: QQBot, msg: PrivateMessageWSMSG): void {
    this.handleMessageSafe(bot, msg).catch(error => {
      bot.logger?.error(`[Hermes] 私聊消息处理失败: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    });
  }

  /** Discord 频道消息钩子（由 DiscordBridge 调用，发送经注入的委托完成） */
  public handleDiscordMessage(bot: QQBot, message: DiscordMessage, params: DiscordChatParams): void {
    this.handleDiscordMessageSafe(bot, message, params).catch(error => {
      bot.logger?.error(
        `[Hermes] Discord 消息处理失败: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
      );
    });
  }

  // ===================================================================
  //  访问控制与触发
  // ===================================================================

  /** 检查用户是否有权与 Bot 对话 */
  private canChat(route: RouteInfo): boolean {
    const config = getHermesConfig();
    if (route.type === 'discord') {
      // Discord 频道由其桥接的 QQ 群决定是否启用；QQ 用户黑白名单不约束 Discord 用户
      return config.groups.includes(Number(route.groupId));
    }
    const uid = Number(route.userId);
    if (config.blockedUsers.includes(uid)) return false;
    if (config.allowedUsers.length > 0 && !config.allowedUsers.includes(uid) && !isHermesAdmin(uid)) return false;
    if (route.type === 'group' && !config.groups.includes(Number(route.groupId))) return false;
    return true;
  }

  /** 路由是否指向同一会话域（QQ 群与互通的 Discord 频道按桥接群号对齐） */
  private routeMatches(a: RouteInfo, b: RouteInfo): boolean {
    if (a.type === 'user' || b.type === 'user') return a.type === b.type && a.userId === b.userId;
    return a.groupId !== undefined && a.groupId === b.groupId;
  }

  /** 路由发送者是否为管理员（QQ 侧取 hermes admins ∪ operators，Discord 侧取服务器权限） */
  private isRouteAdmin(route: RouteInfo): boolean {
    if (route.type === 'discord') return route.discord?.isAdmin === true;
    return isHermesAdmin(Number(route.userId));
  }

  /** 检查是否 @了 Bot */
  private hasAtSelf(message: ReceiveMessage): boolean {
    if (!Array.isArray(message)) return false;
    const selfId = this.bot?.getLoginInfoSync()?.user_id;
    if (selfId === undefined) return false;
    return message.some(segment => segment.type === 'at' && String(segment.data.qq) === String(selfId));
  }

  /** 提取消息中的纯文本 */
  private extractText(message: ReceiveMessage | string): string {
    if (typeof message === 'string') return message;
    if (!Array.isArray(message)) return '';
    return message
      .filter(segment => segment.type === 'text')
      .map(segment => (segment.type === 'text' ? segment.data.text : ''))
      .join('')
      .trim();
  }

  /**
   * 统计消息中会被消息管道自动渲染卡片的 Issue/PR 引用数
   * （该群启用 github 功能且仓库在允许列表内；私聊无自动卡片，返回 0）。
   * 与 Github.processMessage / processDiscordMessage 的自动发卡口径一致。
   */
  private countAutoCardReferences(text: string, route: RouteInfo): number {
    if (route.type === 'user' || !route.groupId) return 0;
    const groupId = Number(route.groupId);
    if (!Number.isSafeInteger(groupId) || !isGithubEnabledGroup(groupId)) return 0;
    return Github.parseReferences(text).filter(reference => Github.isAllowedRepository(reference.repository)).length;
  }

  /** 发送者展示名：群名片（昵称）或昵称或 QQ 号 */
  private senderLabel(sender: { card?: string; nickname?: string }, userId: string): string {
    const card = sender.card?.trim();
    const nick = sender.nickname?.trim();
    const name = card && nick && card !== nick ? `${card}（${nick}）` : card || nick || userId;
    return `${name} (${userId})`;
  }

  // ===================================================================
  //  会话管理
  // ===================================================================

  private get store(): ChatHistoryStore {
    const config = getHermesConfig();
    const key = `${config.persistHistoryMax}:${config.persistHistoryEnabled}`;
    if (!this.historyStore || this.historyStoreKey !== key) {
      this.historyStore = new ChatHistoryStore(config.persistHistoryMax, config.persistHistoryEnabled);
      this.historyStoreKey = key;
    }
    return this.historyStore;
  }

  /** 获取会话键（QQ 群与互通的 Discord 频道按群共享，私聊按人隔离） */
  private getSessionKey(route: RouteInfo): string {
    return route.type === 'user' ? `user:${route.userId}` : `group:${route.groupId}`;
  }

  /** 获取或创建会话（优先从持久化存储恢复） */
  private getSession(key: string): Session {
    if (!this.sessions.has(key)) {
      this.sessions.set(key, { history: this.store.load(key), sessionVersion: 0 });
    }
    return this.sessions.get(key)!;
  }

  /** 清除会话上下文（内存 + 持久化） */
  private clearSession(route: RouteInfo): number {
    const baseKey = this.getSessionKey(route);
    const session = this.sessions.get(baseKey);
    if (session) {
      session.sessionVersion = (session.sessionVersion || 0) + 1;
      session.history = [];
    }
    this.store.clear(baseKey);
    return session?.sessionVersion || 0;
  }

  /** 追加历史消息（内存 + 持久化），跳过空内容；label 用于 assistant 消息标注回复对象 */
  private appendHistory(key: string, role: string, content: string, userId?: string, label?: string): void {
    if (!content.trim()) return;
    const config = getHermesConfig();
    const session = this.getSession(key);
    session.history.push({
      role,
      content,
      ...(userId !== undefined ? { userId } : {}),
      ...(label !== undefined ? { label } : {})
    });
    const max = config.localHistoryMaxMessages * 2;
    if (session.history.length > max) {
      session.history = session.history.slice(-max);
    }
    this.store.save(key, session.history);
  }

  // ===================================================================
  //  OneBot API（QQBot 未封装的少量接口，经 HTTP API 直接调用）
  // ===================================================================

  private async callApi<T>(action: string, params: Record<string, unknown>): Promise<T> {
    if (!this.bot) throw new Error('bot 未就绪');
    const res = await this.bot.axiosInstance.post(`/${action}`, params);
    const payload = res.data as { retcode?: number; msg?: string; wording?: string; data?: T };
    if (payload?.retcode !== 0) {
      throw new Error(`API 错误 ${payload?.retcode}: ${payload?.msg || payload?.wording || ''}`);
    }
    return payload?.data as T;
  }

  /** 技能执行用的群管理 API 门面 */
  private groupAdminApi(): GroupAdminApi {
    return {
      setGroupBan: (groupId, userId, durationSec) =>
        this.callApi('set_group_ban', { group_id: Number(groupId), user_id: Number(userId), duration: durationSec }),
      setGroupKick: (groupId, userId) =>
        this.callApi('set_group_kick', { group_id: Number(groupId), user_id: Number(userId), reject_add_request: false }),
      setGroupWholeBan: (groupId, enable) =>
        this.callApi('set_group_whole_ban', { group_id: Number(groupId), enable })
    };
  }

  /** 解析群成员名称（群名片 → QQ 昵称 → QQ 号），带缓存 */
  private async resolveMemberName(groupId: string | number, userId: string | number): Promise<string | null> {
    const key = `${groupId}:${userId}`;
    if (this.memberCache.has(key)) return this.memberCache.get(key)!;
    try {
      const info = await this.callApi<OneBotGroupMemberInfo>('get_group_member_info', {
        group_id: Number(groupId),
        user_id: Number(userId)
      });
      const name = info.card || info.nickname || String(userId);
      this.memberCache.set(key, name);
      return name;
    } catch {
      return null;
    }
  }

  // ===================================================================
  //  消息发送
  // ===================================================================

  /** 发送文本回复（超长按 maxMessageLength 切分；discord 路由经委托发送） */
  private async sendReply(route: RouteInfo, text: string): Promise<void> {
    if (route.type === 'discord') {
      await route.discord?.send(text, false);
      return;
    }
    if (!this.bot) return;
    const chunks = splitMessageText(text, getHermesConfig().maxMessageLength);
    for (const chunk of chunks) {
      if (route.type === 'group') {
        await this.bot.sendGroupMsg(route.groupId!, [{ type: 'text', data: { text: chunk } }]);
      } else {
        await this.bot.sendPrivateMsg(route.userId, [{ type: 'text', data: { text: chunk } }]);
      }
    }
  }

  /** 发送带引用的文本回复（群聊回复原消息，私聊退化为普通发送；discord 路由引用原消息） */
  private async sendReplyWithMention(route: RouteInfo, text: string, userMsgId: number): Promise<void> {
    if (route.type === 'discord') {
      await route.discord?.send(text, true);
      return;
    }
    if (!this.bot) return;
    if (route.type === 'group' && userMsgId) {
      const chunks = splitMessageText(text, getHermesConfig().maxMessageLength);
      for (const chunk of chunks) {
        await this.bot.sendGroupMsg(route.groupId!, [
          { type: 'reply', data: { id: userMsgId } },
          { type: 'text', data: { text: chunk } }
        ]);
      }
      return;
    }
    await this.sendReply(route, text);
  }

  /** 发送图片（base64，允许已带 base64:// 前缀；discord 路由以附件发送） */
  private async sendReplyImage(route: RouteInfo, imageData: string): Promise<void> {
    if (route.type === 'discord') {
      const base64 = imageData.startsWith('base64://') ? imageData.slice('base64://'.length) : imageData;
      await route.discord?.sendImage(base64);
      return;
    }
    if (!this.bot) return;
    const file = imageData.startsWith('base64://') ? imageData : `base64://${imageData}`;
    try {
      if (route.type === 'group') {
        await this.bot.sendGroupMsg(route.groupId!, [{ type: 'image', data: { file } }]);
      } else {
        await this.bot.sendPrivateMsg(route.userId, [{ type: 'image', data: { file } }]);
      }
    } catch (error) {
      this.bot.logger?.error(`[Hermes] 图片发送失败: ${(error as Error).message}，回退到文字`);
    }
  }

  // ===================================================================
  //  QQ 群聊 AI 回复发送（逐句 + 超长转聊天记录）
  // ===================================================================

  /** 分句与合并转发阈值（每次发送时读取配置，热重载生效） */
  private replyUnitOptions(): ReplyUnitOptions {
    const config = getHermesConfig();
    return {
      maxUnitLength: config.maxMessageLength,
      compactMaxChars: config.compactMaxChars,
      compactMaxLines: config.compactMaxLines
    };
  }

  /** 群聊 AI 文本是否走「逐句 + 聊天记录」新路径（私聊与 Discord 维持现状） */
  private useReplyUnits(route: RouteInfo): boolean {
    return route.type === 'group' && getHermesConfig().replyPerSentence;
  }

  /**
   * 以聊天记录（合并转发）形式发送一段群聊文本。
   * 单节点署名取 bot 昵称与 QQ 号；机器人信息缺失或发送失败时回退普通文本（不丢内容）。
   */
  private async sendGroupForward(route: RouteInfo, text: string): Promise<void> {
    const bot = this.bot;
    const login = bot?.getLoginInfoSync();
    if (!bot || route.type !== 'group' || !login?.user_id) {
      await this.sendReply(route, text);
      return;
    }
    const messageId = await bot.sendGroupForwardMsg(route.groupId!, [
      { name: getHermesConfig().botName, uin: login.user_id, content: text }
    ]);
    if (messageId === undefined) {
      bot.logger?.warn(`[Hermes] 聊天记录发送失败，回退为普通文本（${text.length} 字）`);
      await this.sendReply(route, text);
    }
  }

  /**
   * 把一段发送任务挂到会话的串行链上，保证按调用顺序执行。
   *
   * message.delta 的逐句下发展开是 fire-and-forget（不能阻塞 SSE 事件流），
   * 若各自并发 await 发送，后一次 flush 的句子会插到前一次未发完的句子之前，
   * 群聊里就出现「一、尾句、二、三」这种错序。因此所有 AI 文本发送统一经此串行化。
   * 返回的 Promise 在该段发送完成后 resolve（调用方可按需 await）。
   */
  private enqueueSend(run: RunState | undefined, task: () => Promise<void>): Promise<void> {
    if (!run) return task();
    const previous = run.sendChain ?? Promise.resolve();
    // 前一段失败不影响后续发送：链上只传递完成信号
    const next = previous.then(task, task);
    run.sendChain = next.catch(() => {});
    return next;
  }

  /** 等待串行链上全部发送完成（finishRun 收尾与测试用） */
  private async drainSends(run: RunState): Promise<void> {
    // 链尾可能仍在追加，循环等到稳定
    let current = run.sendChain;
    while (current) {
      await current.catch(() => {});
      if (current === run.sendChain) return;
      current = run.sendChain;
    }
  }

  /**
   * 发送一条群聊 AI 回复单元：超阈值走聊天记录，否则普通文本。
   * 引用段仅贴在本轮首个单元上（阶梯式回复，避免每条都重复引用）。
   */
  private async sendReplyUnit(route: RouteInfo, unit: ReplyUnit, replyMsgId: number, run?: RunState): Promise<void> {
    await this.sendReplyUnits(route, [unit], replyMsgId, run);
  }

  /**
   * 批量发送回复单元：整批作为串行链上的**一个任务**执行。
   *
   * 必须是整批入链而不是逐条入链：message.delta 的 flush 是 fire-and-forget，
   * 若逐条入链，下一批会在「上一批还没发完」时把自己的任务追加到链上，
   * 于是上一批剩余的句子被排到下一批之后，群聊里出现
   * 「一一得一 / 尾句 / 一二得二 / 一三得三」这种错序。
   */
  private async sendReplyUnits(
    route: RouteInfo,
    units: ReplyUnit[],
    replyMsgId: number,
    run?: RunState
  ): Promise<void> {
    if (units.length === 0) return;
    await this.enqueueSend(run, async () => {
      for (const unit of units) {
        await this.sendSingleUnit(route, unit, replyMsgId, run);
      }
    });
  }

  /** 单条单元的实际发送（不做排队，仅供串行链内部调用） */
  private async sendSingleUnit(
    route: RouteInfo,
    unit: ReplyUnit,
    replyMsgId: number,
    run?: RunState
  ): Promise<void> {
    if (unit.asForward) {
      await this.sendGroupForward(route, unit.text);
      if (run) await this.recallReceiptOnce(run);
      return;
    }
    if (!this.bot) return;
    const attachReply = route.type === 'group' && replyMsgId > 0 && !(run?.replySent ?? false);
    const segments: SentMessage = attachReply
      ? [
          { type: 'reply', data: { id: replyMsgId } },
          { type: 'text', data: { text: unit.text } }
        ]
      : [{ type: 'text', data: { text: unit.text } }];
    if (route.type === 'group') {
      await this.bot.sendGroupMsg(route.groupId!, segments);
    } else {
      await this.bot.sendPrivateMsg(route.userId, segments);
    }
    // 无论发送成功与否都置位：避免失败时每条单元都重复贴引用
    if (run && attachReply) run.replySent = true;
    // 私聊回执：首条真实回复已发出，撤回「收到」提示
    if (run) await this.recallReceiptOnce(run);
  }

  /**
   * 首条真实回复发出后撤回私聊回执：用户已经看到 AI 的内容，回执不必常驻。
   * 只执行一次（撤回后清空 run.receiptId）。
   */
  private async recallReceiptOnce(run: RunState): Promise<void> {
    if (run.receiptId === undefined) return;
    const receiptId = run.receiptId;
    // exactOptionalPropertyTypes 下不能显式赋 undefined，用 delete 清除
    delete run.receiptId;
    await this.recallReceipt(run.route, receiptId);
  }

  /**
   * QQ 群聊 AI 文本出口：按句拆成多条消息逐条发出；单条超过 compactMaxChars 字或
   * compactMaxLines 行时改用聊天记录发送。非群聊路由或 replyPerSentence=false 时退回
   * sendReply / sendReplyWithMention 的原有整段发送行为。
   *
   * 命中 `[SKILL:` / `MEDIA:` 的文本不下发（留给 finishRun 统一处理）。
   */
  private async sendAiReplyUnits(route: RouteInfo, text: string, replyMsgId: number, run?: RunState): Promise<void> {
    if (!text.trim()) return;
    if (!this.useReplyUnits(route)) {
      await this.sendReplyWithMention(route, text, replyMsgId);
      return;
    }
    if (RESERVED_LABEL_RE.test(text)) return;
    const units = splitReplyIntoUnits(text, this.replyUnitOptions());
    // 整批入链：保证本批句子连续发出，不被后续 flush 插队
    await this.sendReplyUnits(route, units, replyMsgId, run);
  }

  /**
   * 流式逐句下发：把 pendingText 里已完整的单元立即发出，未成形的部分写回 pendingText。
   * 逐句单元不贴引用（由 finishRun 的收尾文本负责贴），保证「引用 + 首句」不会拆成两条。
   */
  private async flushStreamUnits(run: RunState): Promise<void> {
    if (!this.useReplyUnits(run.route)) return;
    if (!run.pendingText) return;
    // 已出现保留标签：整段留给 finishRun（技能标签/图片路径绝不能原样发到群里）
    if (RESERVED_LABEL_RE.test(run.pendingText)) return;
    const { units, rest } = takeCompleteUnits(run.pendingText, this.replyUnitOptions());
    run.pendingText = rest;
    if (units.length === 0) return;
    run.sentTextLength = run.messageDelta.length;
    run.lastTextSent = Date.now();
    // 整批入链（内部按序发完），避免与后续 flush 交错
    await this.sendReplyUnits(run.route, units, run.userMsgId, run);
  }

  // ===================================================================
  //  图片处理（Hermes 多模态输入 / MEDIA 标签输出）
  // ===================================================================

  /** 下载远程图片并编码为 base64:// */
  private async downloadImageToBase64(imageUrl: string): Promise<string> {
    const resp = await fetch(imageUrl);
    if (!resp.ok) throw new Error(`下载失败: ${resp.status}`);
    return `base64://${Buffer.from(await resp.arrayBuffer()).toString('base64')}`;
  }

  /** 下载远程图片并转成 base64 data URL（Hermes 多模态输入用） */
  private async downloadImageToDataUrl(imageUrl: string): Promise<string> {
    const resp = await fetch(imageUrl);
    if (!resp.ok) throw new Error(`下载失败: ${resp.status}`);
    const buffer = Buffer.from(await resp.arrayBuffer());
    const contentType = (resp.headers.get('content-type') || '').split(';')[0]!.trim();
    const mime = /^image\//i.test(contentType) ? contentType : mimeFromPath(imageUrl);
    return `data:${mime};base64,${buffer.toString('base64')}`;
  }

  /**
   * 解析图片段为 base64 data URL，全部转为 base64 后传给 Hermes。
   * 优先下载 CDN url / http(s) file，其次读本地文件，最后兜底问一次 NapCat get_image
   * （get_msg 返回的图片段常只有 file 没有 url，例如被引用消息里的图片）。
   * 失败时返回 null（仅保留 [图片] 占位符），不抛错中断消息处理。
   */
  private async resolveImageDataUrl(segment: { data: { file: string; url?: string } }): Promise<string | null> {
    const { url, file } = segment.data || {};
    const remote = url || (file && /^https?:\/\//i.test(file) ? file : '');
    if (remote) {
      try {
        return await this.downloadImageToDataUrl(remote);
      } catch (error) {
        this.bot?.logger?.error(`[Hermes] 图片下载失败 ${remote}: ${(error as Error).message}`);
      }
    }
    if (file && !/^https?:\/\//i.test(file)) {
      try {
        const buffer = fs.readFileSync(file);
        return `data:${mimeFromPath(file)};base64,${buffer.toString('base64')}`;
      } catch (error) {
        this.bot?.logger?.error(`[Hermes] 图片本地文件读取失败 ${file}: ${(error as Error).message}`);
      }
    }
    return await this.resolveImageViaApi(file);
  }

  /**
   * 兜底：请 NapCat 换取图片直链（get_image），再按直链下载为 data URL。
   * 引用消息 / 聊天记录里的图片段常常只有 file 字段，这一步能把原图拿回来给 AI 识别。
   */
  private async resolveImageViaApi(file: string | undefined): Promise<string | null> {
    if (!file) return null;
    try {
      const result = await this.callApi<{ url?: string; file?: string }>('get_image', { file });
      const target = result?.url || result?.file;
      if (!target) return null;
      if (/^https?:\/\//i.test(target)) return await this.downloadImageToDataUrl(target);
      const buffer = fs.readFileSync(target);
      return `data:${mimeFromPath(target)};base64,${buffer.toString('base64')}`;
    } catch (error) {
      this.bot?.logger?.warn(`[Hermes] get_image 兜底失败 ${file}: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * 组装消息解析用的 resolver（IO 由本类提供，深度/占位/去重逻辑在 message.ts 中）。
   * 解析失败一律降级为 null / 抛错由 message.ts 转成占位符，不阻塞触发流程。
   */
  private messageResolvers(groupId: number | undefined): MessageResolvers {
    return {
      getMsg: messageId =>
        this.callApi<OneBotGetMsgResponse>('get_msg', { message_id: messageId }).then(original => ({
          sender: original?.sender,
          time: original?.time,
          message: original?.message
        })),
      getForward: forwardId => this.callApi<OneBotGetForwardMsgResponse>('get_forward_msg', { message_id: forwardId }),
      resolveImage: segment => this.resolveImageDataUrl(segment),
      resolveName: qq => (groupId === undefined ? Promise.resolve(null) : this.resolveMemberName(groupId, qq)),
      formatTime: unixTs => this.formatTime(unixTs),
      forwardImages: getHermesConfig().forwardImages
    };
  }

  // ===================================================================
  //  进度跟踪
  // ===================================================================

  /** 格式化毫秒为可读时长 */
  private formatElapsed(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
    return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
  }

  /** 检查是否应发送进度更新 */
  private shouldSendProgress(run: RunState): boolean {
    if (run.sendingProgress) return false;
    const elapsed = (Date.now() - run.lastProgressSent) / 1000;
    return elapsed >= getHermesConfig().progressRateLimitSec;
  }

  /** 发送进度卡片（渲染失败降级纯文本） */
  private async sendProgressCard(runId: string): Promise<void> {
    const run = this.activeRuns.get(runId);
    if (!run || run.sendingProgress) return;
    run.sendingProgress = true;

    const now = Date.now();
    const elapsed = this.formatElapsed(now - run.startedAt);

    try {
      const image = await renderProgressImage({
        tools: run.tools,
        currentTool: run.currentTool,
        // 逐句下发后 pendingText 只剩未成形的尾巴，进度预览用完整增量更贴近实际输出
        messageDelta: run.messageDelta,
        elapsed
      });
      if (image) {
        await this.sendReplyImage(run.route, image);
        run.lastProgressSent = now;
        return;
      }

      // 文字回退
      const lines: string[] = [`⏳ Hermes 执行中 (${elapsed})`];
      for (const tool of run.tools.slice(-8)) {
        const icon = tool.error ? '❌' : '✅';
        const duration = tool.duration ? ` (${this.formatElapsed(tool.duration)})` : '';
        const preview = tool.preview ? ` → ${tool.preview.slice(0, 80)}` : '';
        lines.push(`${icon} ${tool.name}${duration}${preview}`);
      }
      if (run.currentTool) {
        const preview = run.currentTool.preview ? ` → ${run.currentTool.preview.slice(0, 80)}` : '';
        lines.push(`⏳ ${run.currentTool.name}...${preview}`);
      }
      await this.sendReply(run.route, lines.join('\n'));
      run.lastProgressSent = now;
    } finally {
      run.sendingProgress = false;
    }
  }

  // ===================================================================
  //  消息格式化（富文本 → AI 可理解的文本 + 图片）
  // ===================================================================

  /** 格式化 Unix 时间戳 */
  private formatTime(unixTs: number): string {
    const date = new Date(unixTs * 1000);
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  /**
   * 将 OneBot 消息转换为 AI 可理解的富文本格式（委托 message.ts 的深度解析）。
   * 深度规则：引用/聊天记录逐层展开（depth+1），depth ≤ 1 的图片转发原图给 Hermes，
   * depth 2 只解析文字，depth ≥ 3 一律记作 [聊天记录]；详见 message.ts 文件头深度表。
   */
  private async formatMessage(
    message: ReceiveMessage | string,
    groupId: number | undefined
  ): Promise<FormattedMessage> {
    const parsed = await parseMessage(message, groupId, this.messageResolvers(groupId));
    return { text: parsed.text, images: parsed.images };
  }

  // ===================================================================
  //  消息处理主入口
  // ===================================================================

  private async handleMessageSafe(bot: QQBot, msg: GroupMessageWSMSG | PrivateMessageWSMSG): Promise<void> {
    // 防自环：NapCat 配置回报自身消息时直接忽略
    if (msg.user_id === msg.self_id) return;
    this.bot = bot;

    const route: RouteInfo =
      msg.message_type === 'group'
        ? { type: 'group', groupId: String(msg.group_id), userId: String(msg.sender.user_id) }
        : { type: 'user', userId: String(msg.sender.user_id) };

    if (!this.canChat(route)) return;

    const config = getHermesConfig();
    const rawText = this.extractText(msg.message);

    // 审批回复优先于触发判定（仅管理员的选择类文本会被拦截，避免误伤正常聊天）
    if (rawText && (await this.handleApprovalReply(route, rawText, msg.message_id))) return;

    // 触发判定：私聊始终触发；群聊按 @提及/关键词/requireMention（含命令守卫）
    let triggered = true;
    let reason = 'private';
    if (route.type === 'group') {
      const decision = decideGroupTrigger({
        text: rawText,
        mentioned: this.hasAtSelf(msg.message),
        requireMention: config.requireMention,
        keywordTriggers: config.keywordTriggers
      });
      triggered = decision.triggered;
      reason = decision.reason ?? '';

      if (!triggered) {
        // 未触发但群聊消息仍需记录到背景上下文（供 AI 感知群聊氛围）
        if (rawText) {
          this.appendHistory(this.getSessionKey(route), 'user', `${this.senderLabel(msg.sender, route.userId)}: ${rawText}`, route.userId);
        }
        return;
      }
    }

    bot.logger?.info(`[Hermes] 触发: ${reason} from ${route.userId} in ${route.type}:${route.groupId || route.userId}`);

    const formatted = await this.formatMessage(msg.message, msg.message_type === 'group' ? msg.group_id : undefined);
    // 消息中的 #编号 会被消息管道自动渲染卡片时加注记，避免 AI 再调查Issue技能重复发卡
    const text = appendAutoCardNote(formatted.text, this.countAutoCardReferences(formatted.text, route));
    if (!text) return;

    // 停止命令
    if (isStopCommand(text)) {
      await this.handleStopCommand(route);
      return;
    }

    // 清除上下文命令
    if (isResetCommand(text)) {
      const newVersion = this.clearSession(route);
      await this.sendReplyWithMention(route, `✅ 上下文已清除，开始新对话 (v${newVersion})`, msg.message_id);
      return;
    }

    // 贴上「处理中」表情回应（立即持久化，进程崩溃时由下次启动清理残留）。
    // 私聊消息 NapCat 通常不支持表情回应：失败时退化为一条文字回执，
    // 让用户知道 AI 已收到（reactionKey 为 null 表示没贴上）。
    const reactionKey = await this.reactions.addQQ(bot, msg.message_id);
    const receiptId =
      reactionKey === null && route.type === 'user' ? await this.sendPrivateReceipt(route) : undefined;

    await this.startHermesRun(
      bot,
      route,
      text,
      formatted.images,
      this.senderLabel(msg.sender, route.userId),
      msg.message_id,
      0,
      reactionKey ?? undefined,
      receiptId
    );
  }

  /**
   * 私聊文字回执：贴表情失败时发一条简短提示，让用户知道 AI 已收到。
   * 返回回执消息 id（供 AI 回复时撤回；撤回失败则留在聊天里，不影响对话）。
   */
  private async sendPrivateReceipt(route: RouteInfo): Promise<number | undefined> {
    const config = getHermesConfig();
    if (!config.privateReactionFallbackText || !config.privateReceiptText.trim()) return undefined;
    if (!this.bot || route.type !== 'user') return undefined;
    try {
      return await this.bot.sendPrivateMsg(route.userId, [
        { type: 'text', data: { text: config.privateReceiptText } }
      ]);
    } catch (error) {
      this.bot.logger?.warn(`[Hermes] 私聊文字回执发送失败: ${(error as Error).message}`);
      return undefined;
    }
  }

  /** 撤回私聊文字回执（AI 开始回复时清掉，避免回执常驻聊天；失败只记日志） */
  private async recallReceipt(route: RouteInfo, receiptId: number | undefined): Promise<void> {
    if (receiptId === undefined || !this.bot) return;
    try {
      await this.bot.axiosInstance.post('/delete_msg', { message_id: receiptId });
    } catch (error) {
      this.bot.logger?.debug(`[Hermes] 撤回私聊回执失败（${receiptId}）: ${(error as Error).message}`);
    }
  }

  // ===================================================================
  //  Discord 消息处理
  // ===================================================================

  /** Discord 消息处理主入口（与 QQ 共用触发/审批/会话逻辑） */
  private async handleDiscordMessageSafe(bot: QQBot, message: DiscordMessage, params: DiscordChatParams): Promise<void> {
    if (message.author.bot || message.webhookId) return;
    this.bot = bot;

    const route: RouteInfo = {
      type: 'discord',
      groupId: params.groupId,
      userId: `dc:${message.author.id}`,
      channelId: message.channelId,
      discord: params
    };
    if (!this.canChat(route)) return;

    const config = getHermesConfig();
    const rawText = this.plainDiscordText(message, params.botUserId);

    // 审批回复优先于触发判定（仅管理员的选择类文本会被拦截）
    if (rawText && (await this.handleApprovalReply(route, rawText, 0))) return;

    const mentioned = params.botUserId ? message.mentions.has(params.botUserId) : false;
    const decision = decideGroupTrigger({
      text: rawText,
      mentioned,
      requireMention: config.requireMention,
      keywordTriggers: config.keywordTriggers
    });

    const displayName = message.member?.displayName ?? message.author.username;
    const label = this.senderLabel({ nickname: displayName }, route.userId);

    if (!decision.triggered) {
      // 未触发的频道消息记录到共享会话的背景上下文（AI 可感知两侧对话）
      if (rawText) {
        this.appendHistory(this.getSessionKey(route), 'user', `${label}: ${rawText}`, route.userId);
      }
      return;
    }

    bot.logger?.info(
      `[Hermes] 触发: ${decision.reason} from ${route.userId} in discord:${params.guildName}#${params.channelName}`
    );

    const formatted = await this.formatDiscordMessage(message, params.botUserId);
    // 与 QQ 侧同理：#编号 已由 DiscordBridge 自动渲染卡片时加注记，避免技能重复发卡
    const text = appendAutoCardNote(formatted.text, this.countAutoCardReferences(formatted.text, route));
    if (!text) return;

    if (isStopCommand(text)) {
      await this.handleStopCommand(route);
      return;
    }
    if (isResetCommand(text)) {
      const newVersion = this.clearSession(route);
      await this.sendReplyWithMention(route, `✅ 上下文已清除，开始新对话 (v${newVersion})`, 0);
      return;
    }

    // 贴上「处理中」表情回应（立即持久化，摘除动作由委托完成）
    let reactionKey: string | undefined;
    if (config.reactionEnabled) {
      try {
        await message.react(config.reactionEmojiDiscord);
        reactionKey = this.reactions.persistDiscord(message.channelId, message.id, config.reactionEmojiDiscord);
      } catch (error) {
        bot.logger?.warn(`[Hermes] Discord 表情回应失败: ${(error as Error).message}`);
      }
    }

    await this.startHermesRun(bot, route, text, formatted.images, label, 0, 0, reactionKey);
  }

  /** Discord 消息正文纯文本化：提及/角色/频道/自定义表情 → 可读文本，并剔除对 bot 的提及 */
  private plainDiscordText(message: DiscordMessage, botUserId?: string): string {
    let text = message.content ?? '';
    if (botUserId) text = text.replace(new RegExp(`<@!?${botUserId}>`, 'g'), '');
    text = text.replace(/<@!?(\d+)>/g, (_match, id: string) => {
      const name = message.mentions.members?.get(id)?.displayName ?? message.mentions.users.get(id)?.username;
      return `@${name ?? id}(${id})`;
    });
    text = text.replace(/<@&(\d+)>/g, (_match, id: string) => {
      return `@${message.guild?.roles.cache.get(id)?.name ?? id}`;
    });
    text = text.replace(/<#(\d+)>/g, (_match, id: string) => {
      return `#${message.guild?.channels.cache.get(id)?.name ?? id}`;
    });
    text = text.replace(/<a?:(\w{2,32}):\d+>/g, ':$1:');
    return text.trim();
  }

  /**
   * 将 Discord 消息转换为 AI 可理解的富文本格式：
   * 正文 → 可读文本；回复引用 → 引用块（含其中图片）；图片附件 → [图片] + 原图
   * （forwardImages 可关）；其余附件/贴纸 → 占位符。
   */
  private async formatDiscordMessage(message: DiscordMessage, botUserId?: string): Promise<FormattedMessage> {
    const config = getHermesConfig();
    const parts: string[] = [];
    const images: string[] = [];

    const text = this.plainDiscordText(message, botUserId);
    if (text) parts.push(text);

    // 回复引用：拉取被引用消息，转为引用块（含其中图片）
    const referenceId = message.reference?.messageId;
    if (referenceId) {
      try {
        const original = await message.channel.messages.fetch(referenceId);
        const name = original.member?.displayName ?? original.author.username;
        const time = this.formatTime(Math.floor(original.createdTimestamp / 1000));
        const content = this.plainDiscordText(original, botUserId) || '[非文本消息]';
        parts.push(`> ${name}(dc:${original.author.id}) ${time}\n> ${content}\n`);
        if (config.forwardImages) {
          for (const attachment of original.attachments.values()) {
            if (attachment.contentType?.startsWith('image/')) {
              const dataUrl = await this.downloadImageToDataUrlSafe(attachment.url);
              if (dataUrl) images.push(dataUrl);
            }
          }
        }
      } catch {
        parts.push('> [引用消息获取失败]\n');
      }
    }

    // 附件：图片转多模态输入，其余类型占位
    for (const attachment of message.attachments.values()) {
      if (attachment.contentType?.startsWith('image/')) {
        parts.push('[图片]');
        if (config.forwardImages) {
          const dataUrl = await this.downloadImageToDataUrlSafe(attachment.url);
          if (dataUrl) images.push(dataUrl);
        }
      } else {
        parts.push(`[附件 ${attachment.name}]`);
      }
    }
    if (message.stickers.size > 0) parts.push('[贴纸]');

    return { text: parts.join('\n').trim(), images };
  }

  /** 下载图片为 data URL，失败返回 null（仅保留 [图片] 占位符） */
  private async downloadImageToDataUrlSafe(url: string): Promise<string | null> {
    try {
      return await this.downloadImageToDataUrl(url);
    } catch (error) {
      this.bot?.logger?.error(`[Hermes] Discord 图片下载失败 ${url}: ${(error as Error).message}`);
      return null;
    }
  }

  // ===================================================================
  //  Hermes 运行提交（QQ 与 Discord 共用）
  // ===================================================================

  /**
   * 组装提示词、提交 Hermes 运行并挂接 SSE 事件流。
   * feedbackDepth > 0 表示这是查询技能的回喂轮：text 是工具数据而非用户发言，
   * 不带发言人前缀（历史中保持在当前对话主线上）。
   * reactionKey 为「处理中」表情回应的持久化记录键：首轮由触发处贴上后传入，
   * 回喂轮原样转移，对话链完全结束时由 handleRunComplete 摘除。
   */
  private async startHermesRun(
    bot: QQBot,
    route: RouteInfo,
    text: string,
    images: string[],
    senderLabel: string,
    replyMsgId: number,
    feedbackDepth: number = 0,
    reactionKey?: string,
    receiptId?: number
  ): Promise<void> {
    const config = getHermesConfig();

    // 构建用户提示词（私聊与回喂轮不带发言人前缀）
    const isFeedback = feedbackDepth > 0;
    const userPrompt = isFeedback || route.type === 'user' ? text : `${senderLabel}: ${text}`;
    // 带图消息：组装 OpenAI 多模态内容段，将原图传给 Hermes
    const userMessage: string | MessageContentPart[] =
      images.length > 0
        ? [
            { type: 'text', text: userPrompt },
            ...images.map((url): MessageContentPart => ({ type: 'image_url', image_url: { url } }))
          ]
        : userPrompt;

    const sessionKey = this.getSessionKey(route);
    const session = this.getSession(sessionKey);
    const sessionVersion = session.sessionVersion || 0;
    // Hermes sessionId 按人区分；群聊/频道日志仍按群共享
    const hermesSessionBase = route.type === 'user' ? `user_${route.userId}` : `group_${route.groupId}_user_${route.userId}`;
    const hermesSessionId = sessionVersion > 0 ? `${hermesSessionBase}:v${sessionVersion}` : hermesSessionBase;

    // 回喂轮（工具数据）与私聊不带发言人前缀；工具数据标记 userId=当前对话者，
    // 在历史重组时保持在对话主线上（不会被标注为 [群聊背景]）
    const historyContent = isFeedback || route.type === 'user' ? text : `${senderLabel}: ${text}`;
    this.appendHistory(sessionKey, 'user', historyContent, route.userId);

    // 组装系统提示词：configs/SOUL.md > systemPrompt > 空 + 群聊上下文 + 技能列表。
    // 群聊上下文显式声明当前对话者与历史标注约定（配合 buildConversationHistory 防串台）
    const baseSystem = this.loadSoulPrompt() || config.systemPrompt || '';
    const groupContext = route.type === 'user' ? '' : buildGroupContext(route, senderLabel);
    const skillsPrompt = this.skillManager.buildPrompt();
    const systemPrompt = [baseSystem, groupContext, skillsPrompt].filter(Boolean).join('\n\n') || undefined;

    try {
      const { runId } = await this.hermes.submitRun({
        userMessage,
        sessionId: hermesSessionId,
        ...(systemPrompt !== undefined ? { systemPrompt } : {}),
        conversationHistory: buildConversationHistory(session.history.slice(0, -1), route.userId)
      });

      bot.logger?.info(`[Hermes] run 已提交: ${runId}`);

      const runState: RunState = {
        route,
        tools: [],
        currentTool: null,
        startedAt: Date.now(),
        lastProgressSent: 0,
        sendingProgress: false,
        messageDelta: '',
        pendingText: '',
        sentTextLength: 0,
        lastTextSent: 0,
        finalOutput: '',
        userMsgId: replyMsgId,
        senderLabel,
        feedbackDepth,
        ...(reactionKey !== undefined ? { reactionKey } : {}),
        ...(receiptId !== undefined ? { receiptId } : {})
      };
      this.activeRuns.set(runId, runState);

      // 流式输出：工具调用前后强制下发中间文本；群聊另有逐句即时下发（见 message.delta）
      const flushPendingText = async () => {
        const pending = runState.pendingText;
        if (!pending.trim()) return;
        // 命中 [SKILL: / MEDIA: 的文本留在缓冲区，交给 finishRun 统一处理
        if (RESERVED_LABEL_RE.test(pending)) return;
        runState.pendingText = '';
        runState.sentTextLength = runState.messageDelta.length;
        runState.lastTextSent = Date.now();
        try {
          if (this.useReplyUnits(runState.route)) {
            // 整批入链，避免被随后到达的 delta flush 插队
            await this.sendReplyUnits(
              runState.route,
              splitReplyIntoUnits(pending, this.replyUnitOptions()),
              runState.userMsgId,
              runState
            );
          } else {
            await this.sendReply(runState.route, pending.trim());
          }
        } catch (error) {
          this.bot?.logger?.error(`[Hermes] 文本发送错误: ${(error as Error).message}`);
        }
      };

      const stream = this.hermes.streamEvents(runId, {
        'tool.started': ev => {
          void flushPendingText();
          runState.currentTool = {
            name: ev.tool,
            ...(ev.preview !== undefined ? { preview: ev.preview } : {}),
            startedAt: ev.timestamp * 1000
          };
        },

        'tool.completed': ev => {
          runState.tools.push({
            name: ev.tool,
            duration: (ev.duration || 0) * 1000,
            error: ev.error || false,
            ...(runState.currentTool?.preview !== undefined ? { preview: runState.currentTool.preview } : {})
          });
          runState.currentTool = null;
          void flushPendingText();
        },

        'message.delta': ev => {
          runState.messageDelta += ev.delta || '';
          runState.pendingText += ev.delta || '';

          // 群聊逐句即时下发：完整句子立刻发出，未成形的部分留在 pendingText
          if (this.useReplyUnits(runState.route)) {
            void this.flushStreamUnits(runState).catch(error =>
              this.bot?.logger?.error(`[Hermes] 逐句发送错误: ${(error as Error).message}`)
            );
          }

          if (this.shouldSendProgress(runState) && runState.tools.length > 0) {
            this.sendProgressCard(runId).catch(error =>
              this.bot?.logger?.error(`[Hermes] 进度发送错误: ${(error as Error).message}`)
            );
          }
        },

        'approval.request': ev => {
          this.handleApprovalRequest(runId, ev);
        },

        'run.completed': ev => {
          runState.finalOutput = ev.output || '';
        },

        'run.failed': ev => {
          runState.finalOutput = `❌ 执行失败: ${ev.error || '未知错误'}`;
          runState.failed = true;
        },

        _end: () => {
          void this.handleRunComplete(runId);
        },

        _error: () => {
          void this.handleRunComplete(runId);
        }
      });

      runState.stream = stream;
    } catch (error) {
      bot.logger?.error(`[Hermes] 提交错误: ${(error as Error).message}`);
      // 提交即失败：摘除「处理中」表情回应，并撤回私聊回执
      if (reactionKey) {
        await this.removeReaction(reactionKey, route).catch(() => {});
      }
      await this.recallReceipt(route, receiptId);
      await this.sendReplyWithMention(route, `❌ 调用 Hermes 失败: ${(error as Error).message}`, replyMsgId);
    }
  }

  /** 摘除「处理中」表情回应并移除持久化记录（QQ 走 NapCat API；Discord 走路由委托） */
  private async removeReaction(reactionKey: string, route: RouteInfo): Promise<void> {
    if (route.type === 'discord') {
      try {
        await route.discord?.removeReaction?.();
      } catch (error) {
        this.bot?.logger?.warn(`[Hermes] Discord 摘除表情回应失败: ${(error as Error).message}`);
      }
      this.reactions.drop(reactionKey);
      return;
    }
    await this.reactions.removeQQ(this.bot, reactionKey);
  }

  /** 启动时清理残留的 QQ 表情回应（上次进程在 AI 处理中退出导致）；Discord 残留由 DiscordBridge 清理 */
  public async cleanupStaleQQReactions(bot: QQBot): Promise<void> {
    await this.reactions.cleanupQQ(bot);
  }

  /** 读取 configs/SOUL.md 作为系统提示词（每次触发时读取，编辑免重启） */
  private loadSoulPrompt(): string {
    try {
      const soulPath = path.resolve(process.cwd(), 'configs', 'SOUL.md');
      if (fs.existsSync(soulPath)) return fs.readFileSync(soulPath, 'utf-8').trim();
    } catch {
      // 读取失败按无 SOUL.md 处理
    }
    return '';
  }

  // ===================================================================
  //  运行完成处理
  // ===================================================================

  /** 处理运行完成：发送最终回复，执行技能标签，处理 MEDIA 标签 */
  private async handleRunComplete(runId: string): Promise<void> {
    const run = this.activeRuns.get(runId);
    if (!run) return;
    this.activeRuns.delete(runId);
    this.pendingApprovals.delete(runId);
    this.approvalMessageSent.delete(runId);

    // 「处理中」表情回应默认随本轮结束摘除；查询技能回喂会把记录键转移给
    // 下一轮 run（keepReaction），对话链完全结束时才摘除
    let keepReaction = false;
    try {
      await this.finishRun(run, () => {
        keepReaction = true;
      });
    } finally {
      if (!keepReaction && run.reactionKey) {
        await this.removeReaction(run.reactionKey, run.route).catch(() => {});
      }
    }
  }

  /** handleRunComplete 主体（拆出以便统一在 finally 中摘除表情回应；markKeepReaction 用于回喂转移） */
  private async finishRun(run: RunState, markKeepReaction: () => void): Promise<void> {
    try {
      await this.finishRunBody(run, markKeepReaction);
    } finally {
      // 收尾兜底：本轮若已把回执转移给查询技能的回喂轮（receiptTransferred），
      // 由下一轮负责撤回；否则无论走哪条分支（含提前 return）都在此撤回，
      // 避免「❌ 执行失败」这类走 sendReplyWithMention 的路径把回执留在聊天里。
      if (run.receiptTransferred !== true) {
        await this.recallReceiptOnce(run);
      }
    }
  }

  /** finishRun 主体（拆出以便统一在 finally 中撤回私聊回执） */
  private async finishRunBody(run: RunState, markKeepReaction: () => void): Promise<void> {
    // 先等在途的逐句下发完成，再计算/发送尾段，否则尾段会插到未发完的句子之前
    await this.drainSends(run);
    let output = run.finalOutput || run.messageDelta;

    // 逐句下发过时，remainingText 由流式路径负责；这里只处理「尚未下发的尾段」。
    // 说明：流式下发的单元已裁剪空白，无法与源串按下标对齐，因此改用缓冲区判断——
    // pendingText 为空表示全部已发出，非空表示还有未成形的尾段（可能同时含 run.completed 的完整输出差异）。
    if (this.useReplyUnits(run.route)) {
      const pending = run.pendingText.trim();
      run.pendingText = '';
      // run.completed 的完整输出比流式增量更长（SSE 丢帧等）：补发差额，避免漏字。
      // 仅在 messageDelta 确实是 finalOutput 前缀时补发，否则宁可漏发也不重复发。
      const tailFromFinal =
        run.finalOutput && run.messageDelta && run.finalOutput.startsWith(run.messageDelta)
          ? run.finalOutput.slice(run.messageDelta.length).trim()
          : '';
      if (run.failed) {
        // 运行失败：失败文案优先发出（已逐句下发的部分不重复发）
        output = run.finalOutput || output;
      } else if (pending) {
        output = pending;
      } else if (tailFromFinal) {
        output = tailFromFinal;
      } else if (run.sentTextLength > 0) {
        return; // 全部已发送
      }
      // 否则保持 output = finalOutput || messageDelta（例如无流式增量、仅 run.completed 给全文）
    } else if (run.sentTextLength > 0 && run.messageDelta && output) {
      const unsentFromDelta = run.messageDelta.slice(run.sentTextLength).trim();
      if (unsentFromDelta) {
        output = unsentFromDelta;
      } else if (output.length > run.sentTextLength) {
        output = output.slice(run.sentTextLength).trim();
      } else {
        return; // 全部已发送
      }
    }

    // 运行没有任何输出（SSE 连接失败 / 模型错误等），通知用户并记录空回复占位
    if (!output?.trim()) {
      const errorMsg = '❌ 执行失败：未收到 Hermes 响应，请稍后重试';
      this.appendHistory(this.getSessionKey(run.route), 'assistant', errorMsg, run.route.userId, run.senderLabel);
      await this.sendReplyWithMention(run.route, errorMsg, run.userMsgId).catch(() => {});
      return;
    }

    // 执行技能标签（管理技能的权限按路由发送者判定：QQ 取 operators，Discord 取服务器权限）；
    // 卡片类技能产出的图片在文本发送前逐张发出
    if (this.bot) {
      const skillOutput = await this.skillManager.processTags(output, run.route, {
        bot: this.bot,
        api: this.groupAdminApi(),
        isAdmin: () => this.isRouteAdmin(run.route)
      });
      output = skillOutput.text;
      for (const image of skillOutput.images) {
        await this.sendReplyImage(run.route, image).catch(error => {
          this.bot?.logger?.error(`[Hermes] 技能卡片发送失败: ${(error as Error).message}`);
        });
      }

      // 查询类技能：把工具数据回喂给 AI 整理回答（再提交一轮 run，有防循环上限）
      if (skillOutput.feedback.length > 0) {
        const depth = run.feedbackDepth ?? 0;
        if (depth < HermesBridge.MAX_FEEDBACK_DEPTH) {
          // 中间文本（如「我查一下」）照常发出，工具数据记入历史后提交回喂轮
          if (output) {
            await this.sendAiReplyUnits(run.route, output, run.userMsgId, run).catch(error => {
              this.bot?.logger?.error(`[Hermes] 中间回复发送失败: ${(error as Error).message}`);
            });
          }
          this.appendHistory(this.getSessionKey(run.route), 'assistant', output, run.route.userId, run.senderLabel);
          const feedbackText = skillOutput.feedback.map(item => `[工具结果 ${item.skill}]\n${item.data}`).join('\n\n');
          // 表情回应记录键随回喂转移给下一轮，链尾才摘除；私聊回执同理转移
          markKeepReaction();
          const transferredReceipt = run.receiptId;
          if (transferredReceipt !== undefined) run.receiptTransferred = true;
          await this.startHermesRun(
            this.bot,
            run.route,
            `${feedbackText}\n\n（以上是工具返回的数据，请据此用简短口语化的话回复对方，不要重复调用相同技能）`,
            [],
            run.senderLabel,
            run.userMsgId,
            depth + 1,
            run.reactionKey,
            transferredReceipt
          );
          return;
        }
        // 已达回喂上限：数据直接附在回复里兜底发出，不再提交新 run
        output = `${output}\n\n${skillOutput.feedback.map(item => `${item.skill}：${item.data}`).join('\n')}`.trim();
      }
    }
    // 记录回复对象（userId + 展示标签）：历史提交时据其标注「你回复 xxx 的话」，防串台
    this.appendHistory(this.getSessionKey(run.route), 'assistant', output, run.route.userId, run.senderLabel);

    // 解析 MEDIA: 标签，发送图片
    const mediaRegex = /MEDIA:((?:\/|https?:\/\/)[^\s\n]+)/g;
    const mediaPaths: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = mediaRegex.exec(output)) !== null) {
      mediaPaths.push(match[1]!);
    }
    const remainingText = output.replace(/MEDIA:(?:\/|https?:\/\/)[^\s\n]+/g, '').trim();

    for (const mediaPath of mediaPaths) {
      try {
        const imageData =
          mediaPath.startsWith('http://') || mediaPath.startsWith('https://')
            ? await this.downloadImageToBase64(mediaPath)
            : `base64://${fs.readFileSync(mediaPath).toString('base64')}`;
        await this.sendReplyImage(run.route, imageData);
      } catch (error) {
        this.bot?.logger?.error(`[Hermes] 图片发送失败 ${mediaPath}: ${(error as Error).message}`);
      }
    }

    if (remainingText) {
      // 群聊逐句发送（单条超阈值转聊天记录）；私聊与 Discord 走原有整段发送
      await this.sendAiReplyUnits(run.route, remainingText, run.userMsgId, run);
    }
    // 兜底：回复已发出但回执还没撤（例如走的是非 sendReplyUnit 路径），这里补一次
    await this.recallReceiptOnce(run);
  }

  // ===================================================================
  //  停止命令
  // ===================================================================

  /** 处理停止命令（QQ 群与互通的 Discord 频道按会话域匹配，可互相停止） */
  private async handleStopCommand(route: RouteInfo): Promise<void> {
    for (const [runId, run] of this.activeRuns) {
      if (this.routeMatches(route, run.route)) {
        await this.hermes.stopRun(runId);
        await this.sendReply(route, '已停止当前任务 ✋');
        return;
      }
    }
    await this.sendReply(route, '当前没有正在运行的任务');
  }

  // ===================================================================
  //  审批处理
  // ===================================================================

  /** 处理审批请求 */
  private handleApprovalRequest(runId: string, ev: HermesApprovalEvent): void {
    const config = getHermesConfig();
    if (!config.approvalEnabled) return;

    const run = this.activeRuns.get(runId);
    if (!run) return;

    // 防止同一 run 重复发送审批消息（仍更新待审批数据，工具可能被多次调用）
    if (this.approvalMessageSent.has(runId)) {
      this.pendingApprovals.set(runId, { runId, route: run.route, data: ev, createdAt: Date.now() });
      return;
    }

    const route = run.route;
    const command = ev.command || '未知命令';
    const patternKey = ev.pattern_key || '';

    const riskLevel = /rm|delete|sudo|chmod|chown|kill|reboot|shutdown/.test(patternKey)
      ? 'high'
      : /curl|wget|pip|npm|apt|docker/.test(patternKey)
        ? 'medium'
        : 'low';

    const approval: Approval = { runId, route, data: ev, createdAt: Date.now() };
    this.pendingApprovals.set(runId, approval);
    this.approvalMessageSent.set(runId, true);

    if (config.approvalTimeoutSec > 0) {
      approval.timeoutTimer = setTimeout(() => {
        void (async () => {
          if (this.pendingApprovals.has(runId)) {
            this.pendingApprovals.delete(runId);
            this.approvalMessageSent.delete(runId);
            try {
              await this.hermes.resolveApproval(runId, 'deny');
              await this.sendReply(route, `⏱️ 审批超时，已自动拒绝: ${command.slice(0, 100)}`);
            } catch {
              // 忽略
            }
          }
        })();
      }, config.approvalTimeoutSec * 1000);
    }

    this.sendApprovalCard(runId, command, riskLevel).catch(error =>
      this.bot?.logger?.error(`[Hermes] 审批卡片错误: ${(error as Error).message}`)
    );
  }

  /** 发送审批卡片（渲染失败降级纯文本） */
  private async sendApprovalCard(runId: string, command: string, riskLevel: string): Promise<void> {
    const approval = this.pendingApprovals.get(runId);
    if (!approval) return;

    const route = approval.route;
    const ev = approval.data;

    const image = await renderApprovalImage({
      command,
      riskLevel,
      toolName: ev.pattern_key || '',
      runId,
      preview: ev.description || ''
    });

    if (image) {
      await this.sendReplyImage(route, image);
      await this.sendReply(route, `⚠️ 上方命令需要审批。回复 "批准" / "拒绝" / "本次允许" / "始终允许" 来处理。`);
      return;
    }

    const toolName = ev.pattern_key || '';
    const preview = ev.description || '';
    const lines = [
      `⚠️ 需要审批`,
      toolName ? `模式: ${toolName}` : '',
      `命令: ${command.slice(0, 300)}`,
      preview ? `说明: ${preview.slice(0, 200)}` : '',
      riskLevel === 'high' ? `风险: 🔴 高` : riskLevel === 'medium' ? `风险: 🟡 中` : `风险: 🔵 低`,
      '',
      `回复 "批准" / "拒绝" / "本次允许" / "始终允许" 来处理`,
      `(run: ${runId.slice(-8)})`
    ].filter(Boolean);
    await this.sendReply(route, lines.join('\n'));
  }

  /**
   * 处理审批回复（在触发判定之前调用；命中返回 true 表示该消息已作为审批处理）。
   * 仅拦截「同一会话域存在待审批 + 文本可解析为审批选择 + 发送者是管理员」的消息；
   * 非管理员的选择类文本（如 "ok"）不拦截，避免审批等待期间误伤正常聊天。
   * QQ 群与互通的 Discord 频道按会话域匹配，两侧管理员可互相审批。
   */
  private async handleApprovalReply(route: RouteInfo, text: string, msgId: number): Promise<boolean> {
    for (const [runId, approval] of this.pendingApprovals) {
      if (!this.routeMatches(route, approval.route)) continue;

      const choice: ApprovalChoice | null = parseApprovalChoice(text);
      if (!choice) return false;

      // 仅管理员可审批（非管理员不拦截，按普通消息继续走触发/转发流程）
      if (!this.isRouteAdmin(route)) return false;

      if (approval.timeoutTimer) clearTimeout(approval.timeoutTimer);
      this.pendingApprovals.delete(runId);
      this.approvalMessageSent.delete(runId);

      try {
        await this.hermes.resolveApproval(runId, choice);
        const labels: Record<ApprovalChoice, string> = {
          once: '已批准（一次）✅',
          deny: '已拒绝 ❌',
          always: '已设置始终允许 ♾️',
          session: '已允许本次会话 ✅'
        };
        await this.sendReplyWithMention(route, labels[choice], msgId);
      } catch (error) {
        await this.sendReply(route, `审批处理失败: ${(error as Error).message}`);
      }

      return true;
    }
    return false;
  }
}
