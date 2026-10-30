import { ChannelType, Client, GatewayIntentBits, Guild, Message as DiscordMessage, TextChannel } from 'discord.js';
import { GroupMessageSentEvent, QQBot } from '@/index';
import { GroupMessageWSMSG, Message, SentMessage } from '@/type';
import { ConfigStore } from '@/config/manager';
import { escapeDiscord, isDiscordMarkdown, renderDiscordMessageToImage } from '@/features/discord-bridge/markdown';
import { DiscordMsgCommandSource, isDiscordAdmin } from '@/features/discord-bridge/source';
import { executeCommand, normalizeCommandText } from '@/command';
import { Github } from '@/features/github';
import { HermesBridge } from '@/features/hermes';
import { getHermesConfig } from '@/features/hermes/config';
import { ReactionManager } from '@/features/hermes/reaction';
import { handleSlashInteraction, registerSlashCommands } from '@/features/discord-bridge/slash';

/**
 * QQ 群 ⇄ Discord 频道互通模块。
 *
 * 配置（configs/features/discord-bridge.json，v1，ConfigStore 热重载）：
 * ```json
 * {
 *   "version": 1,
 *   "token": "DISCORD_BOT_TOKEN",
 *   "bridges": {
 *     "940551045929639949#general": {
 *       "group": "659356928",
 *       "need_reply": "false",
 *       "need_cmd": "false"
 *     }
 *   }
 * }
 * ```
 * - key 为 `"服务器ID#频道名称"`（频道名以 Discord 当前名为准，改名需同步改配置）；
 * - `group` 为互通的 QQ 群号；
 * - `need_reply=true`：Discord→QQ 全量转发；QQ→Discord 仅转发「回复桥消息」的回复内容；
 * - `need_cmd=true`：双向普通消息均不转发，仅 `/send <msg> [group|channel]` 与
 *   「回复桥消息」互通（回复会以回复形式回传到对侧）；
 * - `/send` 不填目标时默认发送到配置文件中第一个互通条目的对端。
 *
 * 附加能力：
 * - 机器人自身发出的 QQ 群消息转发到该群绑定的频道（经 QQBot.onGroupMessageSent
 *   钩子，fromBridge 标记防止回环）：与普通 QQ 消息同一套门控——need_cmd / need_reply
 *   频道仅放行「对该频道桥消息的回复」，webhook 推送（GitHub 订阅通知）一律不进；
 * - 机器人自己在互通频道发出的 Discord 消息（命令回复、AI 回复、GitHub 卡片、
 *   斜杠命令回复等）经 messageCreate 回推同步到 QQ（桥自身转发跳过防回环，
 *   门控与普通 Discord 消息一致），QQ 侧可看到完整对话；
 * - Discord 频道中可直接使用全部已注册命令（/ 或 ! 前缀），回复发在 Discord 频道；
 *   未注册命令的 /xxx 文本按普通消息转发，不会回发 Invalid command；
 * - 同时把命令树注册为 Discord 原生斜杠命令（guild 级、自动补全），交互经 token
 *   精确回放执行，回复发在 Discord 频道（需邀请链接含 applications.commands 权限）；
 * - Discord 消息中的 `#编号` / `owner/repo#编号` 会查询 GitHub Issue/PR 并以图片卡片
 *   回复在 Discord 频道（一条消息多个编号全部解析，与 QQ 侧同一套渲染）；
 * - 互通频道消息可触发 Hermes AI（审批回复 /@提及 / 关键词），频道是否启用由其桥接的
 *   QQ 群在 hermes.json groups 中决定，AI 回复发在 Discord 频道。
 *
 * 前置条件：Discord 开发者后台为 bot 开启 Message Content Intent，并邀请入对应服务器。
 */

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export interface BridgeEntry {
  /** QQ 群号（字符串形式，兼容配置里写成数字） */
  group: string;
  /** true 时 QQ→Discord 仅转发对桥消息的回复 */
  need_reply: string;
  /** true 时双向仅 /send 与对桥消息的回复互通 */
  need_cmd: string;
}

export interface DiscordBridgeConfig {
  version: number;
  token: string;
  /** key: "服务器ID#频道名称" */
  bridges: Record<string, BridgeEntry>;
}

function normalizeBridgeFlag(raw: unknown): string | null {
  if (typeof raw === 'boolean') return raw ? 'true' : 'false';
  if (raw === 'true' || raw === 'false') return raw;
  return null;
}

function normalizeDiscordBridgeConfig(raw: unknown): DiscordBridgeConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const token = typeof record.token === 'string' ? record.token : '';
  const bridges: Record<string, BridgeEntry> = {};
  if (record.bridges && typeof record.bridges === 'object' && !Array.isArray(record.bridges)) {
    for (const [key, value] of Object.entries(record.bridges as Record<string, unknown>)) {
      if (!/^\d+#.+$/.test(key)) continue;
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      let group: string;
      if (typeof entry.group === 'string' && /^\d+$/.test(entry.group)) group = entry.group;
      else if (typeof entry.group === 'number' && Number.isSafeInteger(entry.group)) group = String(entry.group);
      else continue;
      const needReply = normalizeBridgeFlag(entry.need_reply) ?? 'false';
      const needCmd = normalizeBridgeFlag(entry.need_cmd) ?? 'false';
      bridges[key] = { group, need_reply: needReply, need_cmd: needCmd };
    }
  }
  return { version: 1, token, bridges };
}

const bridgeStore = new ConfigStore<DiscordBridgeConfig>({
  path: 'configs/features/discord-bridge.json',
  version: 1,
  factory: () => ({ version: 1, token: '', bridges: {} }),
  normalize: normalizeDiscordBridgeConfig
});

/** 读取互通生效配置（热重载） */
export function getDiscordBridgeConfig(): DiscordBridgeConfig {
  return bridgeStore.get();
}

// ---------------------------------------------------------------------------
// 内存路由表（回复链映射）
// ---------------------------------------------------------------------------

/** 有界 FIFO 缓存：转发消息的 id 映射，容量封顶防止长期运行内存膨胀 */
class BoundedCache<V> {
  private readonly map = new Map<number, V>();

  public constructor(private readonly capacity: number = 2000) {}

  public get(key: number): V | undefined {
    return this.map.get(key);
  }

  public set(key: number, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
}

// ---------------------------------------------------------------------------
// DiscordBridge
// ---------------------------------------------------------------------------

const DISCORD_MESSAGE_LIMIT = 2000;
const SEND_COMMAND_PREFIX = '/send';

/** 已解析的互通条目（配置 key 拆分后的视图） */
interface ResolvedBridge {
  key: string;
  guildId: string;
  channelName: string;
  entry: BridgeEntry;
}

export class DiscordBridge {
  private static instance?: DiscordBridge;

  public static getInstance(): DiscordBridge {
    if (!DiscordBridge.instance) DiscordBridge.instance = new DiscordBridge();
    return DiscordBridge.instance;
  }

  private client?: Client;
  private bot?: QQBot;
  private started = false;

  /** QQ 消息 id →（bridge key → Discord 消息 id）：同群多频道时每个频道各有自己的转发，回复引用必须按频道取 */
  private readonly discordByQQ = new BoundedCache<Record<string, string>>();
  /** Discord 消息 id → QQ 消息 id */
  private readonly qqByDiscord = new BoundedCache<number>();
  /** 本桥转发到 QQ 的消息 id（回复链 & need_reply/need_cmd 判定） */
  private readonly qqFromBridge = new BoundedCache<true>();
  /** 本桥转发到 Discord 的消息 id（回复链 & need_cmd 判定） */
  private readonly dcFromBridge = new BoundedCache<true>();
  /** 转发到 QQ 的消息 id → 来源 bridge key（同群多频道时回复要回到原频道） */
  private readonly bridgeByQQForward = new BoundedCache<string>();
  /**
   * 桥发往 Discord 的待发消息计数（`${channelId}\n${content}` → 条数）。
   * messageCreate 回推可能先于 send() 返回（此时 dcFromBridge 尚未登记），
   * 发送前先登记、回推时核销，保证乱序下也不会把桥转发回传 QQ 形成回环。
   */
  private readonly pendingBridgeSends = new Map<string, number>();

  private constructor() {}

  /** 该群是否配置了互通条目（QQ 侧 /send 分发与桥接共用同一判定） */
  public static isSendTargetGroup(groupId: number | string): boolean {
    const group = String(groupId);
    return Object.values(getDiscordBridgeConfig().bridges).some(entry => entry.group === group);
  }

  /** after-start 钩子：启动 Discord 客户端（token 为空时禁用本功能） */
  public start(bot: QQBot): void {
    if (this.started) return;
    this.started = true;
    this.bot = bot;
    // 机器人自身发出的群消息（GitHub 通知、命令回复等）也转发到 Discord。
    // 注意：OneBot 不会把 bot 自己的消息回推为 message 事件，只能挂发送出口钩子。
    bot.onGroupMessageSent(event => {
      this.handleQQOutgoingMessage(event).catch(error => {
        bot.logger?.error(
          `[DiscordBridge] 机器人消息转发失败: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
        );
      });
    });
    const token = getDiscordBridgeConfig().token;
    if (!token) {
      bot.logger?.warn('[DiscordBridge] token 未配置（configs/features/discord-bridge.json），互通功能已禁用');
      return;
    }
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
    });
    this.client.on('messageCreate', message => {
      this.handleDiscordMessage(message).catch(error => {
        this.bot?.logger?.error(
          `[DiscordBridge] 处理 Discord 消息失败: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
        );
      });
    });
    this.client.on('error', error => {
      this.bot?.logger?.error(`[DiscordBridge] Discord 客户端错误: ${error.message}`);
    });
    this.client.once('clientReady', client => {
      this.bot?.logger?.info(`[DiscordBridge] 已登录 Discord：${client.user.tag}`);
      // 清理上次进程退出时残留的「AI 处理中」表情回应（Discord 侧）
      this.cleanupStaleHermesReactions(client).catch(error => {
        this.bot?.logger?.error(
          `[DiscordBridge] 残留表情回应清理失败: ${error instanceof Error ? error.message : String(error)}`
        );
      });
      // 注册原生斜杠命令（guild 级即时生效；bridges 配置去重的全部服务器）
      const guildIds = [...new Set(Object.keys(getDiscordBridgeConfig().bridges).map(key => key.split('#')[0]!))];
      registerSlashCommands(client, guildIds, bot).catch(error => {
        this.bot?.logger?.error(
          `[DiscordBridge] 注册斜杠命令异常: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
        );
      });
    });
    // 原生斜杠命令交互：经 token 精确回放交给 gugle-command 执行，回复发在 Discord
    this.client.on('interactionCreate', interaction => {
      if (!interaction.isChatInputCommand() || !this.bot) return;
      const bot = this.bot;
      handleSlashInteraction(bot, interaction, (guildId, channelName) => {
        const bridge = channelName ? this.resolveByChannel(guildId, channelName) : undefined;
        const group = bridge ? Number(bridge.entry.group) : NaN;
        return Number.isSafeInteger(group) ? group : undefined;
      }).catch(error => {
        bot.logger?.error(
          `[DiscordBridge] 斜杠命令交互失败: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
        );
      });
    });
    this.client.login(token).catch(error => {
      this.bot?.logger?.error(
        `[DiscordBridge] Discord 登录失败: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }

  /**
   * 启动清理：摘除上次进程在 AI 处理中退出时残留的 Discord 表情回应。
   * 记录由 HermesBridge 在贴表情时立即持久化（data/hermes-reactions.json）；
   * 消息已删除/频道不可达等失败仅清理记录，不做重试。
   */
  private async cleanupStaleHermesReactions(client: Client): Promise<void> {
    const reactions = ReactionManager.getInstance();
    const stale = reactions.listDiscord();
    for (const record of stale) {
      try {
        const channel = record.channelId ? await client.channels.fetch(record.channelId) : null;
        if (channel?.isTextBased()) {
          const message = await channel.messages.fetch(record.messageId);
          const reaction =
            message.reactions.resolve(record.emoji) ??
            message.reactions.cache.find(item => item.emoji.name === record.emoji);
          await reaction?.users.remove(client.user?.id);
        }
      } catch (error) {
        this.bot?.logger?.warn(
          `[DiscordBridge] 摘除残留表情回应失败（${record.key}）: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      reactions.drop(record.key);
    }
    if (stale.length > 0) {
      this.bot?.logger?.info(`[DiscordBridge] 已清理 ${stale.length} 条残留的 Discord 表情回应`);
    }
  }

  // -------------------------------------------------------------------------
  // QQ → Discord
  // -------------------------------------------------------------------------

  /** message-event-group 钩子：把 QQ 群消息转发到 Discord（或执行 /send） */
  public handleQQMessage(bot: QQBot, msg: GroupMessageWSMSG): void {
    try {
      // 同一 QQ 群可绑定多个频道：普通消息逐条门控并转发到所有放行的频道
      const bridges = this.resolveAllByGroup(msg.group_id);
      if (bridges.length === 0) return;

      // /send 命令（两个 need_cmd 状态都可用；与全局命令分发互斥，此处独立处理）
      // 仅拦截「/send + 空白/结尾」，/sendxxx 之类的消息仍按普通消息转发
      const raw = msg.raw_message ?? '';
      if (this.isSendCommand(raw)) {
        this.handleSendFromQQ(bot, msg, raw).catch(error => {
          bot.logger?.error(
            `[DiscordBridge] QQ /send 执行失败: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
          );
        });
        return;
      }

      const replyId = this.extractQQReplyId(msg);
      // 「对桥消息的回复」需定位到该桥消息来自的频道（回复要回到原频道）
      const replyBridge = replyId !== undefined ? this.bridgeByQQForward.get(replyId) : undefined;
      const isReplyToBridge = replyBridge !== undefined;

      for (const bridge of bridges) {
        // 门控：need_cmd / need_reply 任一开启时，仅放行「对（该频道）桥消息的回复」
        if (bridge.entry.need_cmd === 'true' || bridge.entry.need_reply === 'true') {
          if (!isReplyToBridge || replyBridge !== bridge.key) continue;
        }
        this.forwardQQToDiscord(bot, msg, bridge, replyId).catch(error => {
          bot.logger?.error(
            `[DiscordBridge] QQ→Discord 转发失败: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
          );
        });
      }
    } catch (error) {
      bot.logger?.error(
        `[DiscordBridge] QQ 消息处理异常: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
      );
    }
  }

  /** 提取 QQ 消息中的回复目标 id（reply 段不计入正文） */
  private extractQQReplyId(msg: GroupMessageWSMSG): number | undefined {
    if (!Array.isArray(msg.message)) return undefined;
    const reply = msg.message.find(segment => segment.type === 'reply');
    if (!reply) return undefined;
    const id = Number(reply.data.id);
    return Number.isSafeInteger(id) ? id : undefined;
  }

  /** QQ 消息段拆分：文本/附件分离（附件以 Discord 附件上传，文本不混入 URL） */
  private splitQQMessage(msg: GroupMessageWSMSG): { text: string; attachments: { url: string; name: string }[] } {
    const textParts: string[] = [];
    const attachments: { url: string; name: string }[] = [];
    if (Array.isArray(msg.message)) {
      for (const segment of msg.message) {
        switch (segment.type) {
          case 'text':
            textParts.push(segment.data.text);
            break;
          case 'at':
            textParts.push(`@${segment.data.qq}`);
            break;
          case 'face':
            textParts.push('[表情]');
            break;
          case 'image':
          case 'record':
          case 'video':
          case 'file': {
            const url = segment.data.url || segment.data.file;
            if (url && /^https?:\/\//.test(url)) {
              const fallback =
                segment.type === 'image'
                  ? 'image.png'
                  : segment.type === 'record'
                    ? 'audio.amr'
                    : segment.type === 'video'
                      ? 'video.mp4'
                      : 'file';
              attachments.push({ url, name: fallback });
            }
            break;
          }
          default:
            break;
        }
      }
    }
    return { text: textParts.join('').trim(), attachments };
  }

  /** 按字节内容识别常见图片格式，返回对应扩展名（识别不了返回 null） */
  private detectImageExt(buf: Buffer): string | null {
    if (buf.length < 12) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf.toString('ascii', 8, 12) === 'WEBP')
      return 'webp';
    if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
    return null;
  }

  /**
   * 下载附件为 Buffer 并修正扩展名。
   * NapCat 多媒体直链带 rkey 防盗链，由 bot 侧下载再上传比让 Discord 服务器抓取更可靠；
   * 文件名必须带真实图片扩展名，Discord 才会内嵌渲染而不是显示为附件卡片。
   */
  private async fetchAttachment(
    bot: QQBot,
    item: { url: string; name: string }
  ): Promise<{ attachment: Buffer; name: string } | undefined> {
    try {
      const res = await bot.axiosInstance.get<ArrayBuffer>(item.url, { responseType: 'arraybuffer', timeout: 30000 });
      const buf = Buffer.from(res.data);
      const ext = this.detectImageExt(buf);
      let name = item.name;
      if (ext) {
        // 图片：确保扩展名与真实格式一致（URL 里常是 download?fileid=... 没有扩展名）
        name = name.replace(/\.[a-z0-9]+$/i, '') + '.' + ext;
      }
      return { attachment: buf, name };
    } catch (error) {
      bot.logger?.error(
        `[DiscordBridge] 附件下载失败（${item.url.slice(0, 80)}…）: ${error instanceof Error ? error.message : String(error)}`
      );
      return undefined;
    }
  }

  /** QQ→Discord 转发主流程；bodyOverride 用于 /send（剥离命令前缀后的正文） */
  private async forwardQQToDiscord(
    bot: QQBot,
    msg: GroupMessageWSMSG,
    bridge: ResolvedBridge,
    replyId?: number,
    viaCommand: boolean = false,
    bodyOverride?: string
  ): Promise<void> {
    if (!this.client) return;
    const channel = await this.resolveDiscordChannel(bridge);
    if (!channel) return;

    const senderName = msg.sender.card || msg.sender.nickname;
    const header = `【${msg.group_name}|${msg.group_id}】${senderName}(${msg.sender.user_id})：`;
    const { text, attachments } =
      bodyOverride !== undefined ? { text: bodyOverride, attachments: [] as { url: string; name: string }[] } : this.splitQQMessage(msg);
    if (!text && attachments.length === 0) return;

    // QQ 消息符合 Discord markdown → 原文发送（Discord 原生渲染）；否则转义为 plain text
    // 注意：仅在文本非空时拼接换行，避免纯图片消息出现孤立的来源行
    const rendered = isDiscordMarkdown(text) ? text : escapeDiscord(text);
    const content = this.truncateDiscord(text ? `${header}\n${rendered}` : header);

    const referenceId = replyId !== undefined ? this.discordByQQ.get(replyId)?.[bridge.key] : undefined;
    // 附件由 bot 下载为 Buffer 上传（避免 Discord 服务器抓取 NapCat 防盗链直链失败/拿到非图片响应），
    // 并按字节内容修正扩展名，保证图片在 Discord 内嵌渲染
    const files = (
      await Promise.all(attachments.map(item => this.fetchAttachment(bot, item)))
    ).filter((item): item is { attachment: Buffer; name: string } => item !== undefined);
    const sent = await this.sendWithReference(channel, { content, files }, referenceId);
    this.registerDiscordMessage(sent.id, msg.message_id, bridge.key, viaCommand);
    bot.logger?.debug(`[DiscordBridge] QQ→Discord：${msg.group_id} → ${bridge.key}（${sent.id}）`);
  }

  /**
   * 机器人自身发出的群消息 → Discord（GitHub 通知、命令回复、AI 对话等）。
   *
   * 由 QQBot.onGroupMessageSent 钩子驱动（OneBot 不回推 bot 自己的 message 事件）。
   * 门控与普通 QQ 消息一致：need_cmd / need_reply 频道仅放行「对该频道桥消息的回复」
   * （如 AI 回复 /send 过来的消息），webhook 推送（GitHub 订阅通知）一律不进。
   */
  private async handleQQOutgoingMessage(event: GroupMessageSentEvent): Promise<void> {
    // 桥自身转发到 QQ 的消息必须跳过，否则「Discord→QQ→Discord」形成回环
    if (event.fromBridge) return;
    // 发送失败（无 messageId）说明消息根本没发出去，无需转发
    if (event.messageId === undefined) return;
    if (!this.client || !this.bot) return;
    const bot = this.bot;

    const bridges = this.resolveAllByGroup(event.groupId);
    if (bridges.length === 0) return;

    const loginInfo = bot.getLoginInfoSync();
    const senderName = loginInfo?.nickname ?? 'QQ Bot';
    const senderId = loginInfo?.user_id ?? 'unknown';
    const header = `【QQ群 ${event.groupId}】${senderName}(${senderId})：`;

    // 拆分发送载荷：文本 / 附件（base64 或直链）/ 回复引用
    const textParts: string[] = [];
    const downloads: { url: string; name: string }[] = [];
    const files: { attachment: Buffer; name: string }[] = [];
    let replyQQId: number | undefined;
    // QQ 侧 AI 长回复现在以聊天记录（node 段）形式发出，若直接跳过会导致这类消息完全不镜像到 Discord。
    // 因此这里把 node 内的文本拍平后追加到 textParts，再走下方既有门控正常转发。
    // 已知限制：node 内的图片/语音/视频/文件等附件不镜像（仅抽取 text/at/face 文本）。
    const nodeTexts: string[] = [];
    for (const segment of event.message) {
      if (segment.type === 'node') {
        const nodeText = this.flattenForwardNodeText(segment.data.content);
        if (nodeText) nodeTexts.push(nodeText);
        continue;
      }
      switch (segment.type) {
        case 'text':
          textParts.push(segment.data.text);
          break;
        case 'at':
          textParts.push(`@${segment.data.qq}`);
          break;
        case 'face':
          textParts.push('[表情]');
          break;
        case 'reply': {
          const id = Number(segment.data.id);
          if (Number.isSafeInteger(id)) replyQQId = id;
          break;
        }
        case 'image':
        case 'record':
        case 'video':
        case 'file': {
          const fallback =
            segment.type === 'image'
              ? 'image.png'
              : segment.type === 'record'
                ? 'audio.amr'
                : segment.type === 'video'
                  ? 'video.mp4'
                  : 'file';
          // bot 发送的图片多为 base64 载荷（GitHub 卡片、markdown 渲染图），直接解码为附件
          const base64 = this.extractBase64Payload(segment.data.file);
          if (base64) {
            files.push({ attachment: Buffer.from(base64, 'base64'), name: fallback });
            break;
          }
          const url = segment.data.url || segment.data.file;
          if (url && /^https?:\/\//.test(url)) downloads.push({ url, name: fallback });
          break;
        }
        default:
          break;
      }
    }
    for (const item of downloads) {
      const fetched = await this.fetchAttachment(bot, item);
      if (fetched) files.push(fetched);
    }

    // 聊天记录按节点分段展示：节点文本之间补换行，避免前一段末尾与后一段开头粘连
    if (nodeTexts.length > 0) {
      if (textParts.length > 0) textParts.push('\n');
      textParts.push(nodeTexts.join('\n'));
    }

    const text = textParts.join('').trim();
    if (!text && files.length === 0) return;

    const rendered = isDiscordMarkdown(text) ? text : escapeDiscord(text);
    const content = this.truncateDiscord(text ? `${header}\n${rendered}` : header);

    // 「对桥消息的回复」按桥定位来源频道（与普通 QQ 消息门控同一判定）：
    // AI 回复 /send 到 QQ 的消息等场景可回到原频道，其余机器人消息不进 need_cmd / need_reply 频道
    const replyBridgeKey = replyQQId !== undefined ? this.bridgeByQQForward.get(replyQQId) : undefined;

    for (const bridge of bridges) {
      if (!this.shouldForwardBotMessage(bridge, event.fromWebhook, replyBridgeKey)) continue;
      const channel = await this.resolveDiscordChannel(bridge);
      if (!channel) continue;
      try {
        // 回复引用按频道各自的转发映射取（同群多频道时同一 QQ 消息在每个频道各有转发）
        const referenceId = replyQQId !== undefined ? this.discordByQQ.get(replyQQId)?.[bridge.key] : undefined;
        const sent = await this.sendWithReference(channel, { content, files }, referenceId);
        // 登记映射：Discord 用户回复机器人消息时可按回复链回传到 QQ
        this.registerDiscordMessage(sent.id, event.messageId, bridge.key);
        bot.logger?.debug(`[DiscordBridge] 机器人消息→Discord：${event.groupId} → ${bridge.key}（${sent.id}）`);
      } catch (error) {
        bot.logger?.error(
          `[DiscordBridge] 机器人消息转发失败（${bridge.key}）: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  /** 聊天记录（node 段）内文本的递归深度上限：防御异常数据结构导致的无限递归 */
  private static readonly FORWARD_NODE_MAX_DEPTH = 4;

  /**
   * 抽取合并转发（聊天记录）节点内容里的文本。
   *
   * QQ 侧超长 AI 回复现在以聊天记录（node）形式发出，这里把节点内容递归拍平：
   * text → 原文、at → `@QQ号`、face → `[表情]`，嵌套的 node 继续下钻；
   * 达到深度上限、或遇到非数组/未知类型时安全跳过（不抛错）。
   * 已知限制：节点内的图片/语音/视频/文件等附件不镜像（仅回传文本）。
   *
   * @param content 节点内容（Message[]、纯文本字符串，或结构异常的未知值）
   * @param depth 当前递归深度，超过上限即停止下钻
   */
  private flattenForwardNodeText(content: unknown, depth: number = 0): string {
    if (depth >= DiscordBridge.FORWARD_NODE_MAX_DEPTH) return '';
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const parts: string[] = [];
    for (const raw of content) {
      if (!raw || typeof raw !== 'object') continue;
      const segment = raw as { type?: unknown; data?: unknown };
      const data = (segment.data ?? {}) as { text?: unknown; qq?: unknown; content?: unknown };
      switch (segment.type) {
        case 'text':
          if (typeof data.text === 'string') parts.push(data.text);
          break;
        case 'at':
          if (data.qq !== undefined && data.qq !== null) parts.push(`@${String(data.qq)}`);
          break;
        case 'face':
          parts.push('[表情]');
          break;
        case 'node':
          parts.push(this.flattenForwardNodeText(data.content, depth + 1));
          break;
        default:
          break;
      }
    }
    return parts.join('');
  }

  /**
   * 机器人消息门控（与普通 QQ 用户消息同一套语义）：
   * - 未开启门控的频道：全部放行；
   * - need_cmd / need_reply 频道：仅放行「对该频道桥消息的回复」
   *   （replyBridgeKey 为被回复的 QQ 桥消息来源频道）；webhook 推送一律不进。
   */
  private shouldForwardBotMessage(bridge: ResolvedBridge, fromWebhook: boolean, replyBridgeKey?: string): boolean {
    const gated = bridge.entry.need_cmd === 'true' || bridge.entry.need_reply === 'true';
    if (!gated) return true;
    if (fromWebhook) return false;
    return replyBridgeKey === bridge.key;
  }

  /**
   * 带回复引用发送；被引用消息已删除或不可见（MESSAGE_REFERENCE_UNKNOWN）时
   * 降级为无引用发送，保证消息不丢。
   */
  private async sendWithReference(
    channel: TextChannel,
    payload: { content: string; files: { attachment: Buffer; name: string }[] },
    referenceId?: string
  ): Promise<DiscordMessage> {
    // 发送前登记待发标记：messageCreate 回推可能先于本方法返回，接收侧据此识别桥转发
    const pendingKey = `${channel.id}\n${payload.content}`;
    if (this.pendingBridgeSends.size > 500) this.pendingBridgeSends.clear();
    this.pendingBridgeSends.set(pendingKey, (this.pendingBridgeSends.get(pendingKey) ?? 0) + 1);
    try {
      return await channel.send({
        ...payload,
        ...(referenceId ? { reply: { messageReference: referenceId } } : {}),
        allowedMentions: { parse: [], repliedUser: false }
      });
    } catch (error) {
      if (referenceId && error instanceof Error && error.message.includes('MESSAGE_REFERENCE_UNKNOWN')) {
        return await channel.send({ ...payload, allowedMentions: { parse: [], repliedUser: false } });
      }
      throw error;
    }
  }

  /** 从 OneBot 文件字段提取 base64 载荷（`base64://…` 或 `data:image/…;base64,…`），非 base64 返回 undefined */
  private extractBase64Payload(file: string): string | undefined {
    if (file.startsWith('base64://')) return file.slice('base64://'.length).trim();
    const match = /^data:image\/[a-z0-9.+-]+;base64,\s*(.+)$/i.exec(file);
    return match?.[1]?.trim();
  }

  // -------------------------------------------------------------------------
  // Discord → QQ
  // -------------------------------------------------------------------------

  /** messageCreate 回调：把 Discord 频道消息转发到 QQ（或执行 /send） */
  private async handleDiscordMessage(message: DiscordMessage): Promise<void> {
    if (message.webhookId) return;
    if (message.channel.type !== ChannelType.GuildText) return;
    const guildId = message.guildId;
    if (!guildId) return;

    const bridge = this.resolveByChannel(guildId, message.channel.name);
    if (!bridge) return;

    // messageCreate 同样回推 bot 自己的消息：机器人自己在互通频道发的消息（命令回复、
    // AI 回复、GitHub 卡片、斜杠命令回复等）同步到 QQ，让 QQ 侧看到完整对话；
    // 桥自身 QQ→Discord 的转发已在 handleOwnDiscordMessage 内跳过，不会回环
    if (message.author.bot) {
      if (message.author.id === this.client?.user?.id) {
        await this.handleOwnDiscordMessage(message, bridge);
      }
      return;
    }

    const raw = message.content ?? '';
    if (this.isSendCommand(raw)) {
      await this.handleSendFromDiscord(message, raw);
      return;
    }

    // 命令分发：/ 或 ! 前缀且首段命中已注册命令时，在 Discord 侧直接执行并把回复发在
    // Discord 频道；命令消息本身仍按后续流程转发到 QQ（QQ 侧看到的是 bot 代发的文本，
    // 不会二次执行）。未命中注册的 /xxx 文本同样按普通消息继续走转发流程
    await this.handleDiscordCommand(message, bridge, raw);

    const referenceId = message.reference?.messageId;
    const referenceKey = referenceId ? this.snowflakeToKey(referenceId) : undefined;
    const isReplyToBridge = referenceKey !== undefined && this.dcFromBridge.get(referenceKey) === true;

    // Discord 侧 #编号 查询 GitHub Issue/PR（与 QQ 侧共用同一套解析/渲染，回复发在 Discord
    // 频道）；不受 need_cmd 门控影响，消息本身仍按门控决定是否转发到 QQ
    if (this.bot) {
      const groupId = Number(bridge.entry.group);
      const results = await Github.processDiscordMessage(
        this.bot,
        raw,
        Number.isSafeInteger(groupId) ? groupId : undefined
      );
      for (const result of results) {
        await this.sendGithubResultToDiscord(message, result);
      }
    }

    // Hermes AI：互通频道消息可触发 AI（审批回复 / @提及 / 关键词，频道是否启用由其桥接的
    // QQ 群在 hermes.json groups 中决定）。AI 回复经注入的委托发在 Discord 频道；
    // 消息本身仍按门控决定是否转发到 QQ
    if (this.bot) {
      const bot = this.bot;
      const channel = message.channel as TextChannel;
      HermesBridge.getInstance().handleDiscordMessage(bot, message, {
        groupId: bridge.entry.group,
        ...(this.client?.user?.id ? { botUserId: this.client.user.id } : {}),
        guildName: message.guild?.name ?? bridge.guildId,
        channelName: channel.name,
        isAdmin: isDiscordAdmin(message),
        send: async (text, quote) => {
          // 委托侧兜底 2000 字上限（Hermes 已按 maxMessageLength 切分，通常不会触发）
          const chunks: string[] = [];
          let rest = text;
          while (rest.length > DISCORD_MESSAGE_LIMIT) {
            chunks.push(rest.slice(0, DISCORD_MESSAGE_LIMIT));
            rest = rest.slice(DISCORD_MESSAGE_LIMIT);
          }
          if (rest) chunks.push(rest);
          for (let index = 0; index < chunks.length; index++) {
            const content = chunks[index]!;
            try {
              if (quote && index === 0) {
                await message.reply({ content, allowedMentions: { parse: [], repliedUser: false } });
              } else {
                await channel.send({ content, allowedMentions: { parse: [] } });
              }
            } catch (error) {
              bot.logger?.error(
                `[DiscordBridge] Hermes 回复发送失败: ${error instanceof Error ? error.message : String(error)}`
              );
            }
          }
        },
        sendImage: async base64 => {
          await channel
            .send({ files: [{ attachment: Buffer.from(base64, 'base64'), name: 'image.png' }] })
            .catch(error => {
              bot.logger?.error(
                `[DiscordBridge] Hermes 图片发送失败: ${error instanceof Error ? error.message : String(error)}`
              );
            });
        },
        // 摘除机器人对触发消息的「AI 处理中」表情回应（完成/失败/停止时由 HermesBridge 调用）
        removeReaction: async () => {
          const emoji = getHermesConfig().reactionEmojiDiscord;
          const reaction =
            message.reactions.resolve(emoji) ?? message.reactions.cache.find(item => item.emoji.name === emoji);
          await reaction?.users.remove();
        }
      });
    }

    // 门控：need_cmd 开启时仅放行「对桥消息的回复」（need_reply 不限制此方向）
    if (bridge.entry.need_cmd === 'true' && !isReplyToBridge) return;

    await this.forwardDiscordToQQ(message, bridge, referenceId);
  }

  /**
   * 机器人自己在 Discord 互通频道发出的消息 → QQ（命令回复、AI 回复、GitHub 卡片、
   * 斜杠命令回复等，复用 forwardDiscordToQQ 的渲染/回复链/附件处理）。
   *
   * 防回环：桥自身 QQ→Discord 的转发在发送前登记待发标记（pendingBridgeSends，
   * 兼容 messageCreate 先于 send 返回的乱序）、发送后登记 dcFromBridge，双重识别后跳过；
   * 门控与普通 Discord 消息一致（need_cmd 频道仅放行「对桥消息的回复」）。
   * 转发到 QQ 的消息带 fromBridge 标记且登记为桥消息，QQ 侧回复它可路由回本频道。
   */
  private async handleOwnDiscordMessage(message: DiscordMessage, bridge: ResolvedBridge): Promise<void> {
    // 乱序防回环：messageCreate 先于 registerDiscordMessage 到达时 dcFromBridge 查不到，
    // 按「频道+正文」核销发送前登记的待发标记（仅桥转发走 sendWithReference，必然登记）
    const pendingKey = `${message.channelId}\n${message.content ?? ''}`;
    const pending = this.pendingBridgeSends.get(pendingKey) ?? 0;
    if (pending > 0) {
      if (pending === 1) this.pendingBridgeSends.delete(pendingKey);
      else this.pendingBridgeSends.set(pendingKey, pending - 1);
      return;
    }
    if (this.dcFromBridge.get(this.snowflakeToKey(message.id)) === true) return;
    // 交互延迟占位等无内容消息不同步
    if (!message.content && message.attachments.size === 0) return;
    const referenceId = message.reference?.messageId;
    const referenceKey = referenceId ? this.snowflakeToKey(referenceId) : undefined;
    const isReplyToBridge = referenceKey !== undefined && this.dcFromBridge.get(referenceKey) === true;
    if (bridge.entry.need_cmd === 'true' && !isReplyToBridge) return;
    await this.forwardDiscordToQQ(message, bridge, referenceId);
  }

  /**
   * Discord 命令分发：命中已注册命令根节点则执行并返回 true（消息不再转发），
   * 否则返回 false 交回普通转发流程。
   */
  private async handleDiscordCommand(message: DiscordMessage, bridge: ResolvedBridge, raw: string): Promise<boolean> {
    if (!this.bot) return false;
    const trimmed = raw.trim();
    if (!trimmed.startsWith('/') && !trimmed.startsWith('!')) return false;
    // Discord 客户端会把 / 开头内容当作斜杠命令输入，额外支持 ! 前缀兜底，统一归一化为 /
    const normalized = normalizeCommandText(trimmed);
    const rootName = normalized.slice(1).split(/\s/)[0];
    if (!rootName || !this.isRegisteredCommand(rootName)) return false;
    const groupId = Number(bridge.entry.group);
    const source = new DiscordMsgCommandSource(this.bot, message, Number.isSafeInteger(groupId) ? groupId : undefined);
    try {
      executeCommand(this.bot.getCommandManager(), source, normalized);
    } catch (error) {
      this.bot.logger?.error(
        `[DiscordBridge] Discord 命令执行失败: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
      );
    }
    return true;
  }

  /** 首段是否为已注册命令（遍历全部命名空间根节点的字面量子节点） */
  private isRegisteredCommand(name: string): boolean {
    const manager = this.bot?.getCommandManager();
    if (!manager) return false;
    for (const root of manager.roots.values()) {
      if (root.children.some(child => child.isLiteral() && child.toString() === name)) return true;
    }
    return false;
  }

  /** 把 GitHub Issue/PR 查询结果以 Discord 回复发回原频道（图片为附件，失败提示为文本） */
  private async sendGithubResultToDiscord(message: DiscordMessage, result: Message): Promise<void> {
    try {
      if (result.type === 'image') {
        const base64 = this.extractBase64Payload(result.data.file);
        if (!base64) return;
        await message.reply({
          files: [{ attachment: Buffer.from(base64, 'base64'), name: 'github.png' }],
          allowedMentions: { parse: [], repliedUser: false }
        });
        return;
      }
      if (result.type === 'text') {
        await message.reply({
          content: this.truncateDiscord(result.data.text),
          allowedMentions: { parse: [], repliedUser: false }
        });
      }
    } catch (error) {
      this.bot?.logger?.error(
        `[DiscordBridge] GitHub 卡片回复失败: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /** Discord→QQ 转发主流程；contentOverride 用于 /send（剥离命令前缀后的正文） */
  private async forwardDiscordToQQ(
    message: DiscordMessage,
    bridge: ResolvedBridge,
    referenceId?: string | null,
    viaCommand: boolean = false,
    contentOverride?: string
  ): Promise<void> {
    if (!this.bot) return;
    const bot = this.bot;
    const channel = message.channel as TextChannel;
    const guildName = message.guild?.name ?? bridge.guildId;
    const authorName = message.member?.displayName ?? message.author.username;
    const header = `【${guildName}|${channel.name}】${authorName}(${message.author.username})：`;

    const content = contentOverride ?? message.content ?? '';
    const segments: Message[] = [];

    // 回复链：转发到 QQ 时带 reply 引用
    const replyTarget = referenceId ? this.qqByDiscord.get(this.snowflakeToKey(referenceId)) : undefined;
    if (replyTarget !== undefined) {
      segments.push({ type: 'reply', data: { id: replyTarget } });
    }

    if (content) {
      if (isDiscordMarkdown(content)) {
        // 含 Discord markdown → 渲染为图片转发（头部并入图片）
        try {
          const base64 = await renderDiscordMessageToImage(header, content, message);
          segments.push({ type: 'image', data: { file: `base64://${base64}` } });
        } catch (error) {
          // 渲染失败降级为纯文本转发，保证消息不丢
          bot.logger?.error(
            `[DiscordBridge] markdown 渲染失败，降级纯文本: ${error instanceof Error ? error.message : String(error)}`
          );
          segments.push({ type: 'text', data: { text: `${header}\n${this.plainDiscordContent(message, content)}` } });
        }
      } else {
        segments.push({ type: 'text', data: { text: `${header}\n${this.plainDiscordContent(message, content)}` } });
      }
    } else if (segments.length === 0 || message.attachments.size > 0) {
      // 无文字但有附件/纯 embed：补头部行
      segments.push({ type: 'text', data: { text: header } });
    }

    // 附件：图片直接发图片段，其余类型以链接文本行转发
    for (const attachment of message.attachments.values()) {
      if (attachment.contentType?.startsWith('image/')) {
        segments.push({ type: 'image', data: { file: attachment.url } });
      } else {
        segments.push({ type: 'text', data: { text: `\n[附件] ${attachment.name}: ${attachment.url}` } });
      }
    }

    // 纯 embed 消息兜底
    if (!content && message.attachments.size === 0 && message.embeds.length > 0) {
      const embed = message.embeds[0];
      segments.push({ type: 'text', data: { text: `\n[Embed] ${embed?.title ?? ''} ${embed?.url ?? ''}`.trim() } });
    }

    if (segments.length === 0) return;
    // fromBridge：标记为桥自身发出的消息，发送出口钩子据此跳过，避免回环
    const qqMessageId = await bot.sendGroupMsg(bridge.entry.group, segments, { fromBridge: true });
    if (qqMessageId !== undefined) {
      this.registerQQMessage(qqMessageId, message.id, bridge.key, viaCommand);
      this.bridgeByQQForward.set(qqMessageId, bridge.key);
      bot.logger?.debug(`[DiscordBridge] Discord→QQ：${bridge.key} → ${bridge.entry.group}（${qqMessageId}）`);
    }
  }

  /** Discord 消息正文纯文本化（提及/频道/表情 → 可读文本）；contentOverride 用于 /send 剥离前缀后的正文 */
  private plainDiscordContent(message: DiscordMessage, contentOverride?: string): string {
    let text = contentOverride ?? message.content;
    text = text.replace(/<@!?(\d+)>/g, (_match, id: string) => {
      const name = message.mentions.members?.get(id)?.displayName ?? message.mentions.users.get(id)?.username;
      return `@${name ?? id}`;
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

  // -------------------------------------------------------------------------
  // /send <msg> [group|channel]
  // -------------------------------------------------------------------------

  /** 判断文本是否为 /send 命令（/send 后必须为空白或结尾，避免误吞 /sendxxx 消息） */
  private isSendCommand(raw: string): boolean {
    return raw.startsWith(SEND_COMMAND_PREFIX) && (raw.length === SEND_COMMAND_PREFIX.length || /\s/.test(raw[SEND_COMMAND_PREFIX.length]!));
  }

  /**
   * 解析 /send 参数：尾部 token 命中某个 bridge 的 QQ 群号或频道 key
   * （`guildId#channel`，或 `#channel` 后缀唯一匹配）时作为目标，其余为消息正文。
   * 不填目标时默认发送到配置文件中第一个互通条目的对端。
   */
  private parseSendArgs(text: string): { message: string; target?: string } | null {
    const body = text.slice(SEND_COMMAND_PREFIX.length).trim();
    if (!body) return null;
    const tokens = body.split(/\s+/);
    const bridges = getDiscordBridgeConfig().bridges;
    const keys = Object.keys(bridges);
    if (tokens.length >= 2) {
      const last = tokens[tokens.length - 1]!;
      // QQ 群号
      const byGroup = keys.find(key => bridges[key]!.group === last);
      if (byGroup) return { message: tokens.slice(0, -1).join(' ').trim(), target: byGroup };
      // 完整 key
      if (keys.includes(last)) return { message: tokens.slice(0, -1).join(' ').trim(), target: last };
      // #频道名 后缀（唯一匹配）
      if (last.startsWith('#')) {
        const channelName = last.slice(1);
        const matched = keys.filter(key => key.split('#')[1] === channelName);
        const only = matched[0];
        if (matched.length === 1 && only) return { message: tokens.slice(0, -1).join(' ').trim(), target: only };
      }
    }
    return { message: body };
  }

  /** QQ 侧 /send：发送到目标 Discord 频道（或目标 QQ 群） */
  private async handleSendFromQQ(bot: QQBot, msg: GroupMessageWSMSG, raw: string): Promise<void> {
    const parsed = this.parseSendArgs(raw);
    if (!parsed || !parsed.message) {
      bot.sendGroupMsg(msg.group_id, [
        { type: 'reply', data: { id: msg.message_id } },
        { type: 'text', data: { text: `用法：${SEND_COMMAND_PREFIX} <消息> [QQ群号|服务器ID#频道名]` } }
      ]);
      return;
    }
    const targetKey = parsed.target ?? Object.keys(getDiscordBridgeConfig().bridges)[0];
    if (!targetKey) {
      bot.sendGroupMsg(msg.group_id, [{ type: 'text', data: { text: '[DiscordBridge] 尚未配置任何互通频道' } }]);
      return;
    }
    const bridge = this.resolveByKey(targetKey);
    if (!bridge) return;
    await this.forwardQQToDiscord(bot, msg, bridge, undefined, true, parsed.message);
  }

  /** Discord 侧 /send：发送到目标 QQ 群（或目标 Discord 频道） */
  private async handleSendFromDiscord(message: DiscordMessage, raw: string): Promise<void> {
    const parsed = this.parseSendArgs(raw);
    if (!parsed || !parsed.message) {
      await message.reply(`用法：${SEND_COMMAND_PREFIX} <消息> [QQ群号|服务器ID#频道名]`).catch(() => undefined);
      return;
    }
    const targetKey = parsed.target ?? Object.keys(getDiscordBridgeConfig().bridges)[0];
    if (!targetKey) {
      await message.reply('[DiscordBridge] 尚未配置任何互通频道').catch(() => undefined);
      return;
    }
    const bridge = this.resolveByKey(targetKey);
    if (!bridge) return;
    // 来源频道即目标频道时按普通消息处理，避免同频道复读
    await this.forwardDiscordToQQ(message, bridge, null, true, parsed.message);
  }

  // -------------------------------------------------------------------------
  // 路由表与频道解析
  // -------------------------------------------------------------------------

  /** 登记一次 QQ→Discord 转发的 id 映射（回复链用；按 bridge key 分别记录，同群多频道互不覆盖） */
  private registerDiscordMessage(discordId: string, qqId: number, bridgeKey: string, viaCommand: boolean = false): void {
    const key = this.snowflakeToKey(discordId);
    const entry = this.discordByQQ.get(qqId) ?? {};
    entry[bridgeKey] = discordId;
    this.discordByQQ.set(qqId, entry);
    this.qqByDiscord.set(key, qqId);
    this.dcFromBridge.set(key, true);
  }

  /** 登记一次 Discord→QQ 转发的 id 映射（回复链用；按 bridge key 分别记录，同群多频道互不覆盖） */
  private registerQQMessage(qqId: number, discordId: string, bridgeKey: string, viaCommand: boolean = false): void {
    this.qqByDiscord.set(this.snowflakeToKey(discordId), qqId);
    const entry = this.discordByQQ.get(qqId) ?? {};
    entry[bridgeKey] = discordId;
    this.discordByQQ.set(qqId, entry);
    this.qqFromBridge.set(qqId, true);
  }

  /**
   * Discord snowflake 是 19 位十进制数，超出 JS Number 安全整数范围。
   * 回复链映射用十进制字符串数值化（按模 2^42 折叠）。模数取 2^42 而非 2^53：
   * 折叠的中间值 value*10+d 必须小于 2^53 才不损失精度（2^53 模数会让中间值
   * 达到 ~9e16 > 2^53，相邻 id 折叠后相撞）；2^42 下中间值 ~4.4e13，全程精确。
   * 不依赖 BigInt（target < ES2020 无 BigInt 类型）。
   */
  private snowflakeToKey(id: string): number {
    let value = 0;
    const MODULUS = 2 ** 42;
    for (const char of id) {
      value = (value * 10 + (char.charCodeAt(0) - 48)) % MODULUS;
    }
    return value;
  }

  private resolveByKey(key: string): ResolvedBridge | undefined {
    const entry = getDiscordBridgeConfig().bridges[key];
    if (!entry) return undefined;
    const [guildId, channelName] = key.split('#');
    if (!guildId || !channelName) return undefined;
    return { key, guildId, channelName, entry };
  }

  /** 该 QQ 群绑定的全部互通条目（同群可绑多个频道，普通消息逐条门控） */
  private resolveAllByGroup(groupId: number | string): ResolvedBridge[] {
    const group = String(groupId);
    const bridges = getDiscordBridgeConfig().bridges;
    return Object.keys(bridges)
      .filter(key => bridges[key]!.group === group)
      .map(key => this.resolveByKey(key)!);
  }

  private resolveByChannel(guildId: string, channelName: string): ResolvedBridge | undefined {
    return this.resolveByKey(`${guildId}#${channelName}`);
  }

  /** 解析配置条目对应的 Discord 文本频道（缓存优先，未缓存时按频道名抓取） */
  private async resolveDiscordChannel(bridge: ResolvedBridge): Promise<TextChannel | undefined> {
    if (!this.client) return undefined;
    const guild: Guild | undefined = this.client.guilds.cache.get(bridge.guildId);
    if (!guild) {
      this.bot?.logger?.warn(`[DiscordBridge] 未找到 Discord 服务器 ${bridge.guildId}（${bridge.key}）`);
      return undefined;
    }
    const channel = guild.channels.cache.find(
      item => item.type === ChannelType.GuildText && item.name === bridge.channelName
    );
    if (channel) return channel as TextChannel;
    try {
      const fetched = await guild.channels.fetch();
      const target = fetched?.find(
        item => item?.type === ChannelType.GuildText && item.name === bridge.channelName
      );
      if (target) return target as TextChannel;
    } catch (error) {
      this.bot?.logger?.error(
        `[DiscordBridge] 拉取频道列表失败（${bridge.key}）: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    this.bot?.logger?.warn(`[DiscordBridge] 未找到 Discord 频道 ${bridge.key}（频道改名需同步配置）`);
    return undefined;
  }

  private truncateDiscord(text: string): string {
    if (text.length <= DISCORD_MESSAGE_LIMIT) return text;
    return `${text.slice(0, DISCORD_MESSAGE_LIMIT - 16)}\n…（消息过长已截断）`;
  }
}
