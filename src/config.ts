import { defineConfig, validateValues } from "@dsh-plugin/dsh-loader/config";
import type { ConfigField } from "@dsh-plugin/dsh-loader/config";
import type { SynapseConfig } from "./types.js";
import { panels } from "./operation-panels.js";
import { activityField, validateActivity } from "./activity-config.js";
import { validateMemoryModel } from "./online-models.js";
import {
  text,
  flag,
  num,
  object,
  array,
  select,
  collapsibleGroup,
  moduleFields,
  mcpServerItem,
} from "./feature-config.js";
const pairs = (key: string, label: string) =>
  array(
    key,
    label,
    object("item", "条目", [
      text("name", "名称"),
      text("value", "值", "", "password"),
    ]),
  );
const memoryModel = (key: string, label: string, model: string, embedding = false): ConfigField => {
  const online = { path: [key, "source"], equals: "online" };
  return object(key, label, [
    select("source", "运行方式", [["local", embedding ? "本地 bge-small-zh-v1.5（CPU）" : "本地 bge-reranker-base（CPU）"], ["online", "在线服务"]]),
    { ...text("baseUrl", "服务 Base URL", "https://api.siliconflow.cn/v1"), visibleWhen: online },
    { ...text("apiKey", "API Key", "", "password"), visibleWhen: online },
    { ...text("model", "模型名称", model), visibleWhen: online },
    ...(embedding ? [{ ...num("dimensions", "输出维度（0 使用模型默认值）", 0, 0, 8192), visibleWhen: online,
      description: "仅在服务支持时指定；SiliconFlow 的 Qwen3 系列支持自定义维度。" }] : []),
  ], { collapsible: true, defaultCollapsed: true });
};
export const template = defineConfig({
  id: "dsh-synapse",
  packageName: "@dsh-plugin/dsh-synapse",
  title: "Synapse · 通道与记忆",
  description:
    "将 QQ、Discord 聊天与 GitHub 审查接入 DSH，支持本地混合记忆与 Skill 总结。",
  fields: [
    flag("enabled", "启用机器人"),
    {
      type: "model",
      key: "chatModel",
      label: "默认聊天模型",
      description: "用于聊天和总结任务，留空时使用 DSH 默认模型。",
      default: null,
    },
    {
      type: "model",
      key: "reviewModel",
      label: "默认审查模型",
      description: "用于 GitHub 审查和总结任务，留空时使用 DSH 默认模型。",
      default: null,
    },
    collapsibleGroup("OneBot · NapCat / Snowluma", [
      text("httpUrl", "HTTP 地址", "http://127.0.0.1:3000"),
      text("wsUrl", "WebSocket 地址", "ws://127.0.0.1:3001"),
      text("httpToken", "HTTP Token", "", "password"),
      text("wsToken", "WS Token", "", "password"),
      text("tokenParams", "WebSocket Token 查询参数前缀", "?access_token="),
      text("chromePath", "Chrome / Chromium 路径"),
      text("userAgent", "HTTP User-Agent", "Mozilla/5.0"),
      select("logLevel", "日志级别", [
        ["info", "信息"],
        ["warn", "警告"],
        ["error", "错误"],
        ["debug", "调试"],
      ]),
    ]),
    collapsibleGroup("任务运行限制", [
      {
        ...select("sessionPermission", "全部 Synapse 新会话的权限", [
          ["read-only", "仅查看"],
          ["workspace-write", "工作区修改"],
          ["danger-full-access", "完全权限"],
          ["auto", "自动审查"],
        ]),
        description:
          "仅在新建会话时应用，已有会话保留原权限。自动审查需要宿主启用 @deepseek-ai/dsh-experimental-auto-review。",
      },
      {
        ...num("timeoutSec", "单次任务超时（秒）", 120, -1, 600),
        description: "-1 表示无限制；0–600 表示本轮模型执行和工具调用的总时限（秒），0 表示立即超时。",
      },
      {
        ...num("maxToolRounds", "单次任务最大步骤数", 6, -1, 20),
        description: "-1 表示无限制；0–20 表示允许执行的步骤数，0 表示禁止执行步骤。",
      },
    ]),
    collapsibleGroup("GitHub Webhook", [
      flag("githubEnabled", "启用 Webhook 审查"),
      text("githubToken", "GitHub Token", "", "password"),
      text("webhookSecret", "Webhook Secret", "", "password"),
      text(
        "repositories",
        "允许的 owner/repo（每行一个，支持 owner/*）",
        "",
        "textarea",
      ),
      flag("publishReviews", "自动发布审查评论"),
      num("maxDiffChars", "最大差异字符数", 80000, 1000, 500000),
    ]),
    { ...collapsibleGroup("RAG / Skill 自总结", [
      flag("ragEnabled", "启用混合记忆", true),
      { ...memoryModel("embeddingModel", "嵌入模型", "BAAI/bge-m3", true),
        description: "在线模式会将记忆文本和检索词发送至所选服务。切换嵌入模型后，下次检索或写入会重建已有记忆的向量，可能产生服务费用。" },
      num("recallK", "初步召回数量", 50, 1, 200),
      num("memoryK", "上下文记忆条数", 8, 1, 50),
      flag("reranker", "启用重排"),
      memoryModel("rerankModel", "重排模型", "BAAI/bge-reranker-v2-m3"),
      flag("learnMemory", "总结重要事项到长期记忆", true),
      {
        ...text("memoryPrompt", "主动记录记忆的提示词", "在对话或审查中留意值得长期保留的信息，如已核实的事实、用户偏好、长期约束和关键决定。发现此类信息时，先调用 synapse_memory_search 查重，再调用 synapse_memory_save 写入当前通道的记忆库，不必等用户主动要求。记忆内容应简明具体，需要时注明适用范围；切勿记录密钥、凭据、未经核实的推测或临时状态。仅在工具返回写入成功后才告知用户已保存；日常闲聊不必记录。", "textarea"),
        description: "用于记忆总结的判断与执行规则，保存后对下一次请求生效。",
        dialog: { id: "memory-prompt-editor", label: "编辑记忆提示词" },
      },
      flag("learnSkills", "自动总结 Skill", true),
      {
        ...text("skillPrompt", "主动总结 Skill 的提示词", "在完成任务后，将本次已验证通过且后续可复用的操作步骤整理为 Skill。先调用 synapse_skill_list 和 synapse_skill_read 查阅现有内容，再调用 synapse_skill_save 保存；新建 Skill 使用当前通道的 auto-chat- 或 auto-review- 前缀，更新已有条目时传入读取到的 revision。写明适用场景、前置条件、操作步骤、验证方式与注意事项，避免重复创建。切勿将猜测、未验证方案、密钥或单次对话保存为 Skill，也不得借此扩大工具权限。仅在工具返回成功后才确认已保存。", "textarea"),
        description: "用于 Skill 总结的判断与执行规则，保存后对下一次请求生效。",
        dialog: { id: "skill-prompt-editor", label: "编辑 Skill 提示词" },
      },
      num("maxMemories", "最大记忆条数", 20000, 100, 1000000),
    ]), panel: "memory-import" },
    {
      ...object("modules", "聊天与通知功能", moduleFields),
      dialog: { id: "modules-editor", label: "编辑聊天与通知功能" },
    },
    activityField,
    {
      ...array("mcpServers", "MCP 服务", mcpServerItem),
      hidden: true,
    },
  ] satisfies ConfigField[],
  panels,
});

export function validateConfig(c: SynapseConfig) {
  validateValues(template.fields, c as any);
  validateActivity(c.activity);
  validateMemoryModel(c.embeddingModel);
  validateMemoryModel(c.rerankModel);
  const unique = (values: string[], label: string) => {
    if (new Set(values).size !== values.length)
      throw new Error(`${label}不能重复`);
  };
  unique(
    c.mcpServers.map((s) => s.name),
    "MCP 名称",
  );
  for (const s of c.mcpServers) {
    for (const [entries, label] of [
      [s.env, "环境变量"],
      [s.headers, "HTTP 请求头"],
    ] as const) {
      unique(
        entries.map((e) => e.name.toLowerCase()),
        label,
      );
      if (entries.some((e) => !e.name || /[\r\n=]/.test(e.name)))
        throw new Error(`${label}名称无效`);
    }
    if (s.enabled && s.transport === "stdio" && !s.command.trim())
      throw new Error("MCP 启动命令不能为空");
    if (s.transport !== "stdio" && !/^https?:\/\//.test(s.url))
      throw new Error("MCP URL 无效");
  }
  unique(
    c.modules.discord.bridges.map((b) => `${b.guildId}#${b.channelName}`),
    "Discord 频道映射",
  );
  for (const b of c.modules.discord.bridges)
    if (
      !/^\d+$/.test(b.guildId) ||
      !/^\d+$/.test(b.group) ||
      !b.channelName.trim()
    )
      throw new Error("Discord 桥接需要服务器 ID、频道名称和 QQ 群号");
  unique(
    c.modules.github.subscriptions.map((s) => s.repository.toLowerCase()),
    "GitHub 订阅仓库",
  );
  for (const s of c.modules.github.subscriptions)
    if (!/^[\w.-]+\/[\w.-]+$/.test(s.repository))
      throw new Error("GitHub 订阅仓库格式应为 owner/repo");
  if (
    c.githubEnabled &&
    (!c.webhookSecret || !c.githubToken || !c.repositories.trim())
  )
    throw new Error("启用 GitHub 需要 Secret、Token 和仓库允许列表");
  const integers = (value: unknown) => {
    if (typeof value === "number" && !Number.isSafeInteger(value))
      throw new Error("数量和号码必须是安全整数");
    if (value && typeof value === "object")
      Object.values(value).forEach(integers);
  };
  integers(c);
  if (!/^https?:\/\//.test(c.httpUrl))
    throw new Error("HTTP 地址必须是 HTTP(S) URL");
  if (!/^wss?:\/\//.test(c.wsUrl))
    throw new Error("WebSocket 地址必须是 WS(S) URL");
  return c;
}
