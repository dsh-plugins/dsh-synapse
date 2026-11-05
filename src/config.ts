import { defineConfig, validateValues } from "@dsh-plugin/dsh-loader/config";
import type { ConfigField } from "@dsh-plugin/dsh-loader/config";
import type { SynapseConfig } from "./types.js";
import { panels } from "./operation-panels.js";
import { activityField, validateActivity } from "./activity-config.js";
import { validateMemoryModel } from "./online-models.js";
import { validateSpeech } from "./speech.js";
import {
  text,
  flag,
  num,
  object,
  array,
  select,
  group,
  moduleFields,
  mcpServerItem,
} from "./feature-config.js";

const COLLAPSED = { collapsible: true, defaultCollapsed: true };
const memoryModel = (key: string, label: string, model: string, embedding = false): ConfigField => {
  const online = { path: ["memory", key, "source"], equals: "online" };
  return object(key, label, [
    select("source", "运行方式", [["local", embedding ? "本机运行 bge-small-zh-v1.5（CPU）" : "本机运行 bge-reranker-base（CPU）"], ["online", "在线服务"]]),
    { ...text("baseUrl", "服务地址（Base URL）", "https://api.siliconflow.cn/v1"), visibleWhen: online },
    { ...text("apiKey", "API Key", "", "password"), visibleWhen: online },
    { ...text("model", "模型名称", model), visibleWhen: online },
    ...(embedding ? [{ ...num("dimensions", "输出维度", 0, 0, 8192), visibleWhen: online,
      description: "0 表示使用模型默认维度。只在服务支持时填写，例如 SiliconFlow 的 Qwen3 嵌入模型。" }] : []),
  ], COLLAPSED);
};
const MEMORY_PROMPT = "在对话或审查中留意值得长期保留的信息，如已核实的事实、用户偏好、长期约束和关键决定。发现此类信息时，先调用 synapse_memory_search 查重，再调用 synapse_memory_save 写入当前通道的记忆库，不必等用户主动要求。记忆内容应简明具体，需要时注明适用范围；切勿记录密钥、凭据、未经核实的推测或临时状态。仅在工具返回写入成功后才告知用户已保存；日常闲聊不必记录。";
const SKILL_PROMPT = "在完成任务后，将本次已验证通过且后续可复用的操作步骤整理为 Skill。先调用 synapse_skill_list 和 synapse_skill_read 查阅现有内容，再调用 synapse_skill_save 保存；新建 Skill 使用当前通道的 auto-chat- 或 auto-review- 前缀，更新已有条目时传入读取到的 revision。写明适用场景、前置条件、操作步骤、验证方式与注意事项，避免重复创建。切勿将猜测、未验证方案、密钥或单次对话保存为 Skill，也不得借此扩大工具权限。仅在工具返回成功后才确认已保存。";

export const template = defineConfig({
  id: "dsh-synapse",
  packageName: "@dsh-plugin/dsh-synapse",
  title: "Synapse · 通道与记忆",
  description:
    "将 QQ、Discord 聊天与 GitHub 审查接入 DSH，支持本地混合记忆与 Skill 总结。",
  fields: [
    { ...flag("enabled", "启用机器人"), description: "开启后启动 QQ / Discord 机器人进程。填好下方「QQ 连接」后再开启。" },
    {
      type: "model",
      key: "chatModel",
      label: "聊天模型",
      description: "QQ、Discord 对话和总结任务使用的模型，留空时使用 DSH 默认模型。",
      default: null,
    },
    {
      type: "model",
      key: "reviewModel",
      label: "审查模型",
      description: "GitHub PR 审查和 Issue 分诊使用的模型，留空时使用 DSH 默认模型。",
      default: null,
    },
    object("connection", "QQ 连接（OneBot）", [
      { ...text("httpUrl", "HTTP 地址", "http://127.0.0.1:3000"), description: "NapCat 或 Snowluma 的 OneBot 11 HTTP 服务地址。" },
      { ...text("wsUrl", "正向 WebSocket 地址", "ws://127.0.0.1:3001"), description: "同一客户端的正向 WebSocket 服务地址，用于接收消息。" },
      { ...text("httpToken", "HTTP 访问令牌", "", "password"), description: "OneBot HTTP 服务的 access token，未设置时留空。" },
      { ...text("wsToken", "WebSocket 访问令牌", "", "password"), description: "正向 WebSocket 服务的 access token。NapCat 两个服务通常使用同一个令牌，未设置时留空。" },
      { ...text("chromePath", "Chrome / Chromium 路径"), description: "生成进度卡片、GitHub 与 B 站图片卡片时需要，填写可执行文件的完整路径，例如 C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe。" },
      group("高级", [
        { ...text("tokenParams", "WebSocket 令牌参数前缀", "?access_token="), description: "令牌拼接在 WebSocket 地址后的查询参数，客户端要求其他参数名时再修改。" },
        { ...text("userAgent", "HTTP User-Agent", "Mozilla/5.0"), description: "机器人请求 OneBot 与外部网站时使用的 User-Agent。" },
        { ...select("logLevel", "机器人日志级别", [["info", "信息"], ["warn", "警告"], ["error", "错误"], ["debug", "调试"]]), description: "只影响机器人进程写入的日志。" },
      ], COLLAPSED),
    ], COLLAPSED),
    object("limits", "任务限制与权限", [
      {
        ...select("sessionPermission", "新会话的权限", [
          ["read-only", "仅查看：只能读取文件"],
          ["workspace-write", "工作区修改：可修改通道工作区内的文件"],
          ["danger-full-access", "完全权限：可访问整台机器"],
          ["auto", "自动审查：由审查代理逐项批准"],
        ]),
        description: "只对之后新建或重置的会话生效，已有会话保留原权限。「自动审查」需要在当前 profile 启用 @deepseek-ai/dsh-experimental-auto-review。",
      },
      {
        ...num("timeoutSec", "单轮超时（秒）", 120, -1, 600),
        description: "一轮回复中模型推理与工具调用的总时长上限。-1 表示不限时；0 表示立即超时。",
      },
      {
        ...num("maxToolRounds", "单轮最多步骤数", 6, -1, 20),
        description: "一轮回复最多执行多少个模型步骤，也用于记忆与 Skill 总结子代理。-1 表示不限制；0 表示不执行任何步骤。",
      },
    ], COLLAPSED),
    object("github", "GitHub 审查", [
      { ...flag("enabled", "启用 Webhook 审查"), description: "开启前需要填写 Webhook Secret、Token 和至少一个允许的仓库。" },
      { ...text("webhookSecret", "Webhook Secret", "", "password"), description: "与 GitHub Webhook 设置中的 Secret 保持一致。" },
      { ...text("token", "GitHub Token", "", "password"), description: "需要仓库读取权限；自动发布评论还需要 Issues 与 Pull requests 写权限。" },
      {
        // 机器人只要发现一项格式不对就整组作废并改用内置白名单，所以每一项都在保存时校验。
        ...array("allowedRepositories", "允许的仓库", { type: "text", key: "item", label: "仓库", pattern: "^[\\w.-]+\\/(?:[\\w.-]+|\\*)$" }),
        description: "每项填写一个 owner/repo，或用 owner/* 允许该账号下的全部仓库；不能留空项或带空格。",
      },
      flag("publishReviews", "把审查结果发布为评论"),
      { ...num("maxDiffChars", "差异内容上限（字符）", 80000, 1000, 500000), description: "PR 差异超过该长度后截断，审查结果会注明覆盖不完整。" },
    ], COLLAPSED),
    object("speech", "语音合成（BreezeBlue）", [
      { ...flag("enabled", "允许 Bot 主动发送语音"), description: "开启后模型可调用语音工具回复当前 QQ 群、私聊或 Discord 频道；合成内容会发送给 BreezeBlue 并消耗账户额度。" },
      text("baseUrl", "服务地址（Base URL）", "https://api.breeze.blue/v1"),
      text("apiKey", "API Key", "", "password"),
      { ...text("voiceId", "音色 ID"), description: "填写 BreezeBlue 音色库中的 voice_id，使用你有权使用的音色。" },
      text("modelId", "语音模型 ID", "breeze-tts-2"),
      { ...text("languageCode", "语言代码", "zh"), description: "中文 zh、英文 en；留空时由所选模型处理语言。模型和语言须相互兼容。" },
      { ...text("instructions", "默认朗读风格", "自然、亲切地说话，语速适中。", "textarea"), description: "用与正文相同的语言描述语气和情绪，模型可以针对本次朗读调整，最多 2000 字符。" },
      { ...num("maxCharacters", "单条语音最多字符数", 1000, 1, 2000), description: "默认 1000。超过 1000 需要 BreezeBlue 为账户批准更高限制；超长内容会拒绝合成。" },
      num("timeoutSec", "合成超时（秒）", 60, 1, 300),
    ], COLLAPSED),
    object("memory", "长期记忆与 Skill", [
      { ...flag("enabled", "启用长期记忆", true), description: "按通道保存事实与偏好，聊天与审查的记忆相互独立。" },
      { ...num("contextCount", "每次放进上下文的记忆条数", 8, 1, 50), description: "从检索结果中取前几条作为回复的背景参考。" },
      { ...num("recallCount", "初步检索条数", 50, 1, 200), description: "向量与全文检索各自先取的条数，之后合并排序。" },
      { ...num("maxItems", "记忆库容量", 20000, 100, 1000000), description: "超过后删除最早写入的记忆。" },
      { ...memoryModel("embeddingModel", "嵌入模型", "BAAI/bge-m3", true),
        description: "在线模式会把记忆正文和检索词发送到所选服务，并可能产生费用。更换模型或维度后，下次检索或写入时会重建全部记忆向量。" },
      { ...flag("reranker", "检索后重新排序"), description: "用重排模型对检索结果重新打分，提高相关性，会增加一次模型调用。" },
      { ...memoryModel("rerankModel", "重排模型", "BAAI/bge-reranker-v2-m3"), visibleWhen: { path: ["memory", "reranker"], equals: true } },
      flag("learnMemory", "自动记录重要信息", true),
      {
        ...text("memoryPrompt", "记录规则", MEMORY_PROMPT, "textarea"),
        description: "告诉模型什么信息值得记录、如何去重，保存后对下一次请求生效。",
        dialog: { id: "memory-prompt-editor", label: "编辑记录规则" },
        visibleWhen: { path: ["memory", "learnMemory"], equals: true },
      },
      flag("learnSkills", "自动总结可复用的 Skill", true),
      {
        ...text("skillPrompt", "总结规则", SKILL_PROMPT, "textarea"),
        description: "告诉模型什么步骤值得整理为 Skill，保存后对下一次请求生效。",
        dialog: { id: "skill-prompt-editor", label: "编辑总结规则" },
        visibleWhen: { path: ["memory", "learnSkills"], equals: true },
      },
      { ...group("从 Hermes 导入记忆", []), panel: "memory-import" },
    ], COLLAPSED),
    {
      ...object("modules", "聊天与通知功能", moduleFields),
      description: "QQ 群、私聊与 Discord 的对话行为，以及订阅、欢迎语、峰谷提醒等群功能。",
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
  validateMemoryModel(c.memory.embeddingModel);
  validateMemoryModel(c.memory.rerankModel);
  validateSpeech(c.speech);
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
    c.github.enabled &&
    (!c.github.webhookSecret || !c.github.token || !c.github.allowedRepositories.length)
  )
    throw new Error("启用 GitHub 需要 Secret、Token 和仓库允许列表");
  const integers = (value: unknown) => {
    if (typeof value === "number" && !Number.isSafeInteger(value))
      throw new Error("数量和号码必须是安全整数");
    if (value && typeof value === "object")
      Object.values(value).forEach(integers);
  };
  integers(c);
  if (!/^https?:\/\//.test(c.connection.httpUrl))
    throw new Error("HTTP 地址必须是 HTTP(S) URL");
  if (!/^wss?:\/\//.test(c.connection.wsUrl))
    throw new Error("WebSocket 地址必须是 WS(S) URL");
  return c;
}
