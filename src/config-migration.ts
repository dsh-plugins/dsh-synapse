import { readFile } from "node:fs/promises";
import { validateValues } from "@dsh-plugin/dsh-loader/config";
import { template, validateConfig } from "./config.js";
import {
  GROUP_FEATURES,
  presentationFields,
  featureFiles,
  modulesFromFiles,
} from "./feature-config.js";
import { pathsFor, safePath, atomicWrite } from "./files.js";
import type { SynapseConfig, SynapseContext } from "./types.js";

/** 平铺布局的顶层字段；出现任一字段即需要迁移到分组结构。 */
const FLAT_KEYS = [
  "httpUrl", "wsUrl", "httpToken", "wsToken", "chromePath", "userAgent", "logLevel", "tokenParams",
  "sessionPermission", "timeoutSec", "maxToolRounds",
  "githubEnabled", "githubToken", "webhookSecret", "repositories", "publishReviews", "maxDiffChars",
  "ragEnabled", "embeddingModel", "rerankModel", "recallK", "memoryK", "reranker", "learnMemory",
  "learnSkills", "memoryPrompt", "skillPrompt", "maxMemories",
];
const PRESENTATION_KEYS = presentationFields.map((field) => field.key!);

function legacy(raw: any): boolean {
  return raw.features?.length > 0 || raw.mcp?.length > 0 ||
    Boolean(raw.botJson && raw.botJson !== "{}") || Boolean(raw.llmUrl) || Boolean(raw.externalHermes);
}

function flat(raw: any): boolean {
  const m = raw.modules ?? {};
  return FLAT_KEYS.some((key) => key in raw) || GROUP_FEATURES.some((id) => id in m) ||
    PRESENTATION_KEYS.some((key) => key in (m.chat ?? {})) || "peak_msg" in (m.peakValley ?? {});
}

/**
 * 把平铺布局逐项搬到分组结构，缺失的字段留给模板默认值补齐。
 * 只读取原配置，不修改输入对象。
 */
export function restructureConfig(raw: any): any {
  const m = raw.modules ?? {};
  const chat = { ...m.chat };
  const presentation = {};
  for (const key of PRESENTATION_KEYS) {
    if (key in chat) {
      presentation[key] = chat[key];
      delete chat[key];
    }
  }
  const { peak_msg, valley_msg, cmd_peak_msg, cmd_valley_msg, ...peakValley } = m.peakValley ?? {};
  // JSON 往返去掉值为 undefined 的键，loader 的校验只接受 JSON 值，缺失的字段由模板默认值补齐。
  return JSON.parse(JSON.stringify({
    enabled: raw.enabled,
    chatModel: raw.chatModel,
    reviewModel: raw.reviewModel,
    connection: {
      httpUrl: raw.httpUrl, wsUrl: raw.wsUrl, httpToken: raw.httpToken, wsToken: raw.wsToken,
      chromePath: raw.chromePath, userAgent: raw.userAgent, tokenParams: raw.tokenParams, logLevel: raw.logLevel,
    },
    limits: { sessionPermission: raw.sessionPermission, timeoutSec: raw.timeoutSec, maxToolRounds: raw.maxToolRounds },
    github: {
      enabled: raw.githubEnabled,
      token: raw.githubToken,
      webhookSecret: raw.webhookSecret,
      // 旧版多行文本不校验格式；格式不对的项会让机器人整组作废，这里只保留合法项，原值留在备份文件里。
      allowedRepositories: typeof raw.repositories === "string"
        ? raw.repositories.split(/\s+/).filter((item) => /^[\w.-]+\/(?:[\w.-]+|\*)$/.test(item))
        : undefined,
      publishReviews: raw.publishReviews,
      maxDiffChars: raw.maxDiffChars,
    },
    memory: {
      enabled: raw.ragEnabled, embeddingModel: raw.embeddingModel, rerankModel: raw.rerankModel,
      recallCount: raw.recallK, contextCount: raw.memoryK, reranker: raw.reranker,
      learnMemory: raw.learnMemory, learnSkills: raw.learnSkills,
      memoryPrompt: raw.memoryPrompt, skillPrompt: raw.skillPrompt, maxItems: raw.maxMemories,
    },
    modules: {
      management: m.management,
      groupFeatures: Object.fromEntries(GROUP_FEATURES.map((id) => [id, m[id]?.groups])),
      bili: m.bili,
      github: m.github,
      welcome: m.welcome,
      discord: m.discord,
      chat,
      presentation,
      peakValley: {
        ...peakValley,
        peakMessage: peak_msg, valleyMessage: valley_msg, peakReply: cmd_peak_msg, valleyReply: cmd_valley_msg,
      },
    },
    activity: raw.activity,
    mcpServers: raw.mcpServers,
  }));
}

/** 表单化之前的配置把功能 JSON、MCP 与机器人配置存为字符串，这里解析成分组结构。 */
function migrateLegacy(raw: any, c: any) {
  const base = JSON.parse(raw.botJson || "{}");
  for (const key of ["userAgent", "logLevel", "tokenParams"]) {
    if (base[key] !== undefined) {
      c.connection[key] = base[key];
    }
  }
  c.modules = modulesFromFiles(
    validateValues(template.fields, { modules: c.modules }).modules as unknown as SynapseConfig["modules"],
    (raw.features ?? []).map((f) => ({ id: f.id, value: JSON.parse(f.json || "{}") })),
  );
  c.mcpServers = (raw.mcp ?? []).map((s) => ({
    name: s.name,
    enabled: s.enabled ?? true,
    transport: s.transport ?? "stdio",
    command: s.command ?? "",
    url: s.url ?? "",
    args: JSON.parse(s.argsJson || "[]"),
    env: Object.entries(JSON.parse(s.envJson || "{}")).map(([name, value]) => ({ name, value })),
    headers: Object.entries(JSON.parse(s.headersJson || "{}")).map(([name, value]) => ({ name, value })),
    allowedTools: String(s.allowedTools ?? "").split(/\s+/).filter(Boolean),
  }));
}

function finish(c: any): SynapseConfig {
  return validateConfig(validateValues(template.fields, c) as unknown as SynapseConfig);
}

/** 迁移旧配置并返回新结构；已是分组结构时返回 undefined。 */
export function migrateConfig(raw: any): { value: SynapseConfig; legacy: boolean } | undefined {
  const isLegacy = legacy(raw);
  if (!isLegacy && !flat(raw)) {
    return undefined;
  }
  const c = restructureConfig(raw);
  if (isLegacy) {
    migrateLegacy(raw, c);
  }
  return { value: finish(c), legacy: isLegacy };
}

async function readRaw(profile: string): Promise<{ value: any; revision: number } | undefined> {
  const file = await safePath(profile, "config", "dsh-synapse", "config.json");
  try {
    const disk = JSON.parse(await readFile(file, "utf8"));
    return { value: disk.value ?? {}, revision: disk.revision };
  } catch (error) {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/** 从机器人当前的功能文件读回聊天命令修改过的设置，覆盖迁移结果中的对应模块。 */
async function mergeLiveFeatures(profile: string, c: SynapseConfig): Promise<SynapseConfig> {
  const live = [];
  for (const f of featureFiles(c)) {
    const file = await safePath(
      profile, "data", "dsh-synapse", "bot", "configs",
      ...(f.id === "peak-valley-timer" ? [] : ["features"]),
      `${f.id}.json`,
    );
    try {
      live.push({ id: f.id, value: JSON.parse(await readFile(file, "utf8")) });
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return finish({ ...c, modules: modulesFromFiles(c.modules, live) });
}

export async function registerConfig(ctx: SynapseContext) {
  const paths = pathsFor(ctx);
  // register 会等待上一实例未完成的写入；它按新模板丢弃旧字段，但磁盘文件保持原样，之后再读取原始内容。
  const handle = await ctx.dshLoader.config.register<SynapseConfig>(ctx, template);
  try {
    const snapshot = await readRaw(paths.profile);
    const migration = snapshot && migrateConfig(snapshot.value);
    if (migration) {
      const migrated = migration.legacy ? await mergeLiveFeatures(paths.profile, migration.value) : migration.value;
      const backup = await safePath(
        paths.profile, "data", "dsh-synapse",
        migration.legacy ? "config-before-forms.json" : "config-before-restructure.json",
      );
      await atomicWrite(backup, JSON.stringify(snapshot, null, 2));
      await handle.update(migrated, snapshot.revision);
    }
  } catch (error) {
    handle.dispose();
    throw error;
  }
  return handle;
}
