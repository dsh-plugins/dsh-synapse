import type { HostAPI, CordisContext } from "@dsh-plugin/dsh-loader";
export type Channel = "chat" | "review";
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
export interface SynapseConfig {
  enabled: boolean;
  profileDir: string;
  homeDir: string;
  httpUrl: string;
  wsUrl: string;
  httpToken: string;
  wsToken: string;
  chromePath: string;
  userAgent: string;
  logLevel: string;
  tokenParams: string;
  sessionPermission:
    "read-only" | "workspace-write" | "danger-full-access" | "auto";
  timeoutSec: number;
  maxToolRounds: number;
  githubEnabled: boolean;
  githubToken: string;
  webhookSecret: string;
  repositories: string;
  publishReviews: boolean;
  maxDiffChars: number;
  ragEnabled: boolean;
  recallK: number;
  memoryK: number;
  reranker: boolean;
  learnMemory: boolean;
  learnSkills: boolean;
  maxMemories: number;
  modules: {
    management: {
      groups: number[];
      operators: number[];
      discordOperators: string[];
    };
    parentheses: { groups: number[] };
    poke: { groups: number[] };
    minecraft: { groups: number[] };
    modrinth: { groups: number[] };
    command: { groups: number[] };
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
      progressRateLimitSec: number;
      progressAsImage: boolean;
      progressMaxTools: number;
      maxMessageLength: number;
      forwardImages: boolean;
      replyPerSentence: boolean;
      compactMaxChars: number;
      compactMaxLines: number;
      localHistoryMaxMessages: number;
      persistHistoryEnabled: boolean;
      persistHistoryMax: number;
      approvalEnabled: boolean;
      approvalTimeoutSec: number;
      reactionEnabled: boolean;
      reactionEmojiQq: string;
      reactionEmojiDiscord: string;
      privateReactionFallbackText: boolean;
      privateReceiptText: string;
    };
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
      peak_msg: string;
      valley_msg: string;
      cmd_peak_msg: string;
      cmd_valley_msg: string;
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
export interface Embeddings {
  embed(text: string, query?: boolean): Promise<number[]>;
  rerank(query: string, documents: string[]): Promise<number[]>;
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
