import { defineConfig, validateValues } from "@dsh-plugin/dsh-loader/config";
import type { ConfigField } from "@dsh-plugin/dsh-loader/config";
import type { SynapseConfig } from "./types.js";
import { panels } from "./operation-panels.js";
import { activityField, validateActivity } from "./activity-config.js";
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
export const template = defineConfig({
  id: "dsh-synapse",
  packageName: "@dsh-plugin/dsh-synapse",
  title: "Synapse · 通道与记忆",
  description:
    "聊天、审查和自总结使用所选模型与 DSH Agent 运行时。各功能由 dsh-loader 在此卡片内统一配置和保存。",
  fields: [
    flag("enabled", "启用机器人"),
    {
      type: "model",
      key: "chatModel",
      label: "默认聊天模型",
      description: "用于聊天及聊天自总结，留空时使用 DSH 默认模型。",
      default: null,
    },
    {
      type: "model",
      key: "reviewModel",
      label: "默认审查模型",
      description: "用于 GitHub 审查及审查自总结，留空时使用 DSH 默认模型。",
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
      flag("ragEnabled", "启用本地混合记忆", true),
      num("recallK", "初步召回数量", 50, 1, 200),
      num("memoryK", "上下文记忆条数", 8, 1, 50),
      flag("reranker", "启用本地 bge-reranker-base"),
      flag("learnMemory", "总结重要事项到长期记忆", true),
      {
        ...text("memoryPrompt", "主动记录记忆的提示词", "你应主动判断对话或审查中哪些信息值得长期保留，包括已核实的重要事实、用户偏好、长期约束和关键决定。发现这些内容时，先调用 synapse_memory_search 检查已有记忆，再调用 synapse_memory_save 将新信息写入当前通道的 RAG 库，无需等待用户要求记住。记忆应简洁、具体且有依据，必要时说明适用对象与条件；不要记录密钥、凭据、未经证实的推测或短暂状态。只有工具确认写入成功后才能声称已保存；无需为普通闲聊制造记忆。", "textarea"),
        description: "用于主模型主动委派记忆子代理及其总结规则，保存后对下一次请求生效。",
        dialog: { id: "memory-prompt-editor", label: "编辑记忆提示词" },
      },
      flag("learnSkills", "自动总结 Skill", true),
      {
        ...text("skillPrompt", "主动总结 Skill 的提示词", "你应主动识别本次任务中已经验证成功、以后可复用的操作步骤，并在完成任务时总结为 Skill。先调用 synapse_skill_list 和 synapse_skill_read 查找可复用或需要更新的内容，再调用 synapse_skill_save 保存；新增 Skill 使用当前通道的 auto-chat- 或 auto-review- 名称前缀，更新时提供读取到的 revision。写明适用场景、前提、具体步骤、验证方法和已确认的注意事项，避免重复创建。不要把猜测、未经验证的方案、密钥或一次性聊天内容保存为 Skill，也不要借 Skill 扩大工具权限。只有工具成功返回后才能确认已保存。", "textarea"),
        description: "用于主模型主动委派 Skill 子代理及其总结规则，保存后对下一次请求生效。",
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
