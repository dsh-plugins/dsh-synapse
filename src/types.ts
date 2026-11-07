import type { HostAPI, CordisContext } from "@dsh-plugin/dsh-loader";
import type { ConfigModelValue } from "@dsh-plugin/dsh-loader/config";
import type { ActivityConfig } from "./activity-config.js";
export type Channel = "chat" | "review";
/** 聊天网关提供的发送者信息，工具执行时用于限定群号和管理权限。 */
export interface ChatRoute {
  type: "user" | "group" | "discord";
  userId: string;
  groupId?: string;
  channelId?: string;
  name: string;
  admin: boolean;
}
/** 通道提供的会话展示信息与聊天权限，不接受模型工具参数覆盖。 */
export interface RunContext {
  title?: string;
  route?: ChatRoute;
  submission?: NativeSubmission;
  tools?: AvailableTool[];
}
/** 原生输入的可恢复提交标识；只有持久化成功后才确认背景批次。 */
export interface NativeSubmission {
  batchId: string;
  background: string;
  source?: "system" | "user";
  read?(): { input: string; background: string };
  prepared(sessionId: string, messageId: string): void;
  committed(sessionId: string, messageId: string): void;
}
export interface PluginPaths {
  profile: string;
  home: string;
  data: string;
  skills: string;
}
export interface McpSpec {
  name: string;
  enabled: boolean;
  transport: "stdio" | "http" | "sse";
  command: string;
  args: string[];
  env: { name: string; value: string }[];
  url: string;
  headers: { name: string; value: string }[];
  allowedTools: string[];
}
/** 记忆模型可独立选择本地推理或在线服务，dimensions 只用于嵌入请求。 */
export interface MemoryModelConfig {
  source: "local" | "online";
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions?: number;
}
/** OneBot 连接参数；HTTP 与 WebSocket 令牌由机器人分别用于两条连接。 */
export interface ConnectionConfig {
  httpUrl: string;
  wsUrl: string;
  httpToken: string;
  wsToken: string;
  chromePath: string;
  userAgent: string;
  tokenParams: string;
  logLevel: string;
}
/** 新建会话的运行限制，已有会话保留原权限。 */
export interface LimitsConfig {
  sessionPermission:
    "read-only" | "workspace-write" | "danger-full-access" | "auto";
  timeoutSec: number;
  maxToolRounds: number;
}
/** 仓库连接的独立功能开关，仓库名可使用 owner/* 匹配组织。 */
export interface GithubRepository {
  repository: string;
  reviewPr: boolean;
  triageIssues: boolean;
  sendCards: boolean;
}

/** GitHub Webhook 的验签、仓库连接及审查输出设置。 */
export interface GithubReviewConfig {
  enabled: boolean;
  token: string;
  webhookSecret: string;
  allowUnsignedCards: boolean;
  repositories: GithubRepository[];
  publishReviews: boolean;
  maxDiffChars: number;
}
/** 混合记忆与 Skill 自总结，两个通道的记忆库相互隔离。 */
export interface MemorySettings {
  enabled: boolean;
  embeddingModel: MemoryModelConfig;
  rerankModel: MemoryModelConfig;
  recallCount: number;
  contextCount: number;
  reranker: boolean;
  learnMemory: boolean;
  learnSkills: boolean;
  memoryPrompt: string;
  skillPrompt: string;
  maxItems: number;
}
/** 语音合成使用独立凭据，音色与模型由配置限定，不接受模型更改服务地址。 */
export interface SpeechConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  voiceId: string;
  modelId: string;
  languageCode: string;
  instructions: string;
  maxCharacters: number;
  timeoutSec: number;
}
/** 只有平台确认消息 ID 后，语音工具才能报告发送成功。 */
export interface VoiceReceipt {
  platform: "qq" | "discord";
  messageId: string | number;
}
/** 发送目标绑定当前聊天路由；音频为 BreezeBlue 返回的完整 MP3。 */
export type VoiceSender = (route: ChatRoute, audio: Buffer, signal: AbortSignal) => Promise<VoiceReceipt>;
/** 进度卡片、审批与表情回应，写入机器人配置时并回聊天配置。 */
export interface PresentationConfig {
  progressRateLimitSec: number;
  progressAsImage: boolean;
  progressMaxTools: number;
  approvalEnabled: boolean;
  approvalTimeoutSec: number;
  reactionEnabled: boolean;
  reactionEmojiQq: string;
  reactionEmojiDiscord: string;
  privateReactionFallbackText: boolean;
  privateReceiptText: string;
}
/** 只按群号启用的五个功能，写入机器人配置时拆回各自的文件。 */
export interface GroupFeatures {
  parentheses: number[];
  poke: number[];
  minecraft: number[];
  modrinth: number[];
  command: number[];
}
export interface SynapseConfig {
  activity: ActivityConfig;
  enabled: boolean;
  chatModel: ConfigModelValue | null;
  reviewModel: ConfigModelValue | null;
  connection: ConnectionConfig;
  limits: LimitsConfig;
  github: GithubReviewConfig;
  memory: MemorySettings;
  speech: SpeechConfig;
  modules: {
    management: {
      groups: number[];
      operators: number[];
      discordOperators: string[];
    };
    groupFeatures: GroupFeatures;
    bili: { groups: number[]; follow: number[] };
    github: { subscriptions: { repository: string; groups: number[] }[] };
    welcome: { welcomes: { group: number[]; msg: string }[] };
    discord: {
      token: string;
      bridges: {
        guildId: string;
        channelName: string;
        group: string;
        needReply: boolean;
        needCmd: boolean;
      }[];
    };
    chat: {
      botName: string;
      groups: number[];
      admins: number[];
      allowedUsers: number[];
      blockedUsers: number[];
      requireMention: boolean;
      keywordTriggers: string[];
      maxMessageLength: number;
      forwardImages: boolean;
      replyPerSentence: boolean;
      compactMaxChars: number;
      compactMaxLines: number;
      localHistoryMaxMessages: number;
      persistHistoryEnabled: boolean;
      persistHistoryMax: number;
    };
    presentation: PresentationConfig;
    peakValley: {
      groups: number[];
      mode: string;
      time: {
        start: string;
        end: string;
        days: string[];
        mode: string;
        msg: string;
      }[];
      peakMessage: string;
      valleyMessage: string;
      peakReply: string;
      valleyReply: string;
    };
  };
  mcpServers: McpSpec[];
}
export type ConfigSource = () => SynapseConfig;
export type ErrorSink = (error: Error) => void;
export interface SynapseContext extends CordisContext {
  dshLoader: HostAPI;
  baseUrl?: string;
}
export interface MemoryItem {
  channel: Channel;
  source: string;
  text: string;
}
export interface MemoryRow extends MemoryItem {
  id: number;
  hash: string;
  created: string;
  score?: number;
}
/** 记忆层的模型能力，允许批量生成文档向量并传递调用方取消信号。 */
export interface Embeddings {
  embed(text: string, query?: boolean, signal?: AbortSignal): Promise<number[]>;
  embedMany?(texts: string[], signal?: AbortSignal): Promise<number[][]>;
  rerank(query: string, documents: string[], signal?: AbortSignal): Promise<number[]>;
}
export interface Skill {
  name: string;
  content: string;
  revision: string;
  inherited: boolean;
}
export interface AvailableTool {
  server: string;
  rawName: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** parent 由宿主工具回调绑定，只供原生子代理委派使用，不接受模型覆盖。 */
  execute?: (args: Record<string, unknown>, signal: AbortSignal, parent?: any) => Promise<unknown>;
  /** 原始 API 回执需要完整交给模型，避免默认文本摘要截断分页字段。 */
  render?: (value: unknown) => { type: "text"; text: string }[];
}
export interface ChatMessage {
  role: string;
  content?: any;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}
export type AgentEvent = (
  event: string,
  payload: Record<string, unknown>,
) => void;
export interface Delivery {
  id: string;
  event: string;
  payload: string;
  state: string;
  attempts: number;
  error?: string;
  result?: string;
}
