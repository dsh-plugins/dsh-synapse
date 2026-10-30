import { ConfigStore } from '@/config/manager';
import { isOperator } from '@/config/features';

/**
 * Hermes Agent 桥接配置（移植自 qq-hermes-bridge 的 .env 配置，MIT 协议，原作者 Amorter）。
 *
 * 配置文件：configs/features/hermes.json（v1，ConfigStore 热重载）：
 * ```json
 * {
 *   "version": 1,
 *   "apiUrl": "http://127.0.0.1:8642",
 *   "apiKey": "",
 *   "botName": "小喵",
 *   "groups": [659356928],
 *   "admins": [],
 *   "requireMention": true,
 *   "keywordTriggers": ["小喵"],
 *   "replyPerSentence": true,
 *   "compactMaxChars": 300,
 *   "compactMaxLines": 5,
 *   "privateReactionFallbackText": true,
 *   "privateReceiptText": "🤔 收到，正在思考…"
 * }
 * ```
 * - `groups`：启用 AI 对话的 QQ 群（空=群聊不启用）；互通的 Discord 频道能否触发 AI
 *   也由其桥接的 QQ 群是否在此列表决定；私聊始终启用（受用户黑白名单约束）；
 * - `replyPerSentence`：QQ 群聊 AI 回复逐句发送；单条超过 compactMaxChars 字或
 *   compactMaxLines 行时改用聊天记录（合并转发）发送，任一项填 0 关闭该维度；
 * - `privateReactionFallbackText`：私聊贴表情失败时改发文字回执（NapCat 对私聊
 *   消息通常不支持 set_msg_emoji_like），AI 首条回复发出后自动撤回；
 * - Bot QQ 号无需配置，取 bot.getLoginInfoSync().user_id（@提及判定）；
 * - 系统提示词优先级：configs/SOUL.md > systemPrompt > 空。
 */

export interface HermesBridgeConfig {
  version: number;
  /** Hermes API Server 地址 */
  apiUrl: string;
  /** API Key（Hermes 配置了认证时填） */
  apiKey: string;
  /** Bot 名称（卡片落款、合并转发署名等展示用） */
  botName: string;
  /** 启用 AI 对话的 QQ 群（空数组=群聊不启用） */
  groups: number[];
  /** 管理员 QQ 号（与 management operators 合并生效） */
  admins: number[];
  /** 允许私聊/对话的用户（空=全部允许） */
  allowedUsers: number[];
  /** 屏蔽的用户 */
  blockedUsers: number[];
  /** 群聊中是否需要 @bot 才触发 */
  requireMention: boolean;
  /** 关键词触发列表（小写匹配） */
  keywordTriggers: string[];
  /** 进度卡片发送最小间隔（秒） */
  progressRateLimitSec: number;
  /** 是否以图片形式发送进度 */
  progressAsImage: boolean;
  /** 进度卡片最多显示的工具数量 */
  progressMaxTools: number;
  /** 单条消息最大长度（超出切分发送） */
  maxMessageLength: number;
  /** 是否将消息中的图片原图转发给 Hermes（多模态识别） */
  forwardImages: boolean;
  /** 是否按句拆分 AI 回复逐条发送（关闭则整段一次发出） */
  replyPerSentence: boolean;
  /** 单条回复超过该字数改用聊天记录（合并转发）发送；0=关闭该维度 */
  compactMaxChars: number;
  /** 单条回复超过该行数改用聊天记录（合并转发）发送；0=关闭该维度 */
  compactMaxLines: number;
  /** 系统提示词（被 configs/SOUL.md 覆盖） */
  systemPrompt: string;
  /** 保留的历史消息轮数 */
  localHistoryMaxMessages: number;
  /** 是否启用对话历史持久化存储 */
  persistHistoryEnabled: boolean;
  /** 持久化保留的最大消息数 */
  persistHistoryMax: number;
  /** 是否启用命令审批 */
  approvalEnabled: boolean;
  /** 审批超时自动拒绝（秒），0=不超时 */
  approvalTimeoutSec: number;
  /** 是否启用「AI 处理中」表情回应（QQ 贴表情 / Discord reaction，完成后摘除） */
  reactionEnabled: boolean;
  /** QQ 表情回应的 emoji_id（NapCat set_msg_emoji_like；76=👍 强） */
  reactionEmojiQq: string;
  /** Discord 表情回应（unicode emoji） */
  reactionEmojiDiscord: string;
  /**
   * 私聊贴表情失败时改用文字回执（默认 true）。
   * NapCat 对私聊消息通常不支持 set_msg_emoji_like，贴表情会失败；
   * 开启后改发一条简短提示，让用户知道 AI 已收到（群聊不受影响）。
   */
  privateReactionFallbackText: boolean;
  /** 私聊文字回执内容（privateReactionFallbackText 开启且贴表情失败时发送） */
  privateReceiptText: string;
}

export function hermesConfigFactory(): HermesBridgeConfig {
  return {
    version: 1,
    apiUrl: 'http://127.0.0.1:8642',
    apiKey: '',
    botName: '小喵',
    groups: [],
    admins: [],
    allowedUsers: [],
    blockedUsers: [],
    requireMention: true,
    keywordTriggers: [],
    progressRateLimitSec: 15,
    progressAsImage: true,
    progressMaxTools: 12,
    maxMessageLength: 1200,
    forwardImages: true,
    replyPerSentence: true,
    compactMaxChars: 300,
    compactMaxLines: 5,
    systemPrompt: '',
    localHistoryMaxMessages: 24,
    persistHistoryEnabled: true,
    persistHistoryMax: 100,
    approvalEnabled: true,
    approvalTimeoutSec: 300,
    reactionEnabled: true,
    reactionEmojiQq: '76',
    reactionEmojiDiscord: '👀',
    privateReactionFallbackText: true,
    privateReceiptText: '🤔 收到，正在思考…'
  };
}

function asString(raw: unknown, fallback: string): string {
  return typeof raw === 'string' ? raw : fallback;
}

function asBool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === 'boolean' ? raw : fallback;
}

function asPositiveNumber(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

function asQqList(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is number => typeof item === 'number' && Number.isSafeInteger(item) && item > 0);
}

function asStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

export function normalizeHermesConfig(raw: unknown): HermesBridgeConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const fallback = hermesConfigFactory();
  return {
    version: 1,
    apiUrl: asString(record.apiUrl, fallback.apiUrl),
    apiKey: asString(record.apiKey, fallback.apiKey),
    botName: asString(record.botName, fallback.botName),
    groups: asQqList(record.groups),
    admins: asQqList(record.admins),
    allowedUsers: asQqList(record.allowedUsers),
    blockedUsers: asQqList(record.blockedUsers),
    requireMention: asBool(record.requireMention, fallback.requireMention),
    keywordTriggers: asStringList(record.keywordTriggers).map(keyword => keyword.toLowerCase()),
    progressRateLimitSec: asPositiveNumber(record.progressRateLimitSec, fallback.progressRateLimitSec),
    progressAsImage: asBool(record.progressAsImage, fallback.progressAsImage),
    progressMaxTools: asPositiveNumber(record.progressMaxTools, fallback.progressMaxTools),
    maxMessageLength: asPositiveNumber(record.maxMessageLength, fallback.maxMessageLength),
    forwardImages: asBool(record.forwardImages, fallback.forwardImages),
    replyPerSentence: asBool(record.replyPerSentence, fallback.replyPerSentence),
    compactMaxChars: asPositiveNumber(record.compactMaxChars, fallback.compactMaxChars),
    compactMaxLines: asPositiveNumber(record.compactMaxLines, fallback.compactMaxLines),
    systemPrompt: asString(record.systemPrompt, fallback.systemPrompt),
    localHistoryMaxMessages: asPositiveNumber(record.localHistoryMaxMessages, fallback.localHistoryMaxMessages),
    persistHistoryEnabled: asBool(record.persistHistoryEnabled, fallback.persistHistoryEnabled),
    persistHistoryMax: asPositiveNumber(record.persistHistoryMax, fallback.persistHistoryMax),
    approvalEnabled: asBool(record.approvalEnabled, fallback.approvalEnabled),
    approvalTimeoutSec: asPositiveNumber(record.approvalTimeoutSec, fallback.approvalTimeoutSec),
    reactionEnabled: asBool(record.reactionEnabled, fallback.reactionEnabled),
    reactionEmojiQq: asString(record.reactionEmojiQq, fallback.reactionEmojiQq),
    reactionEmojiDiscord: asString(record.reactionEmojiDiscord, fallback.reactionEmojiDiscord),
    privateReactionFallbackText: asBool(record.privateReactionFallbackText, fallback.privateReactionFallbackText),
    privateReceiptText: asString(record.privateReceiptText, fallback.privateReceiptText)
  };
}

const hermesStore = new ConfigStore<HermesBridgeConfig>({
  path: 'configs/features/hermes.json',
  version: 1,
  factory: hermesConfigFactory,
  normalize: normalizeHermesConfig
});

/** 读取 Hermes 桥接生效配置（热重载） */
export function getHermesConfig(): HermesBridgeConfig {
  return hermesStore.get();
}

/**
 * 有效管理员判定：hermes 自有 admins ∪ management operators。
 * 与 /pardon、/github allow 等管理命令保持「谁是管理员」口径一致。
 */
export function isHermesAdmin(qqUserId: number): boolean {
  return getHermesConfig().admins.includes(qqUserId) || isOperator(qqUserId);
}
