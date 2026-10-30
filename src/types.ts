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
  argsJson: string;
  envJson: string;
  url: string;
  headersJson: string;
  allowedTools: string;
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
  botJson: string;
  llmUrl: string;
  llmKey: string;
  model: string;
  timeoutSec: number;
  maxToolRounds: number;
  externalHermes: boolean;
  hermesUrl: string;
  hermesKey: string;
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
  features: { id: string; json: string }[];
  mcp: McpSpec[];
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
