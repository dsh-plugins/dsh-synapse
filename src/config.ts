import { defineConfig, validateValues } from "@dsh-plugin/dsh-loader/config";
import type { ConfigField } from "@dsh-plugin/dsh-loader/config";
import type { SynapseConfig } from "./types.js";
import { panels } from "./operation-panels.js";
import {
  text,
  flag,
  num,
  object,
  array,
  strings,
  select,
  moduleFields,
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
    "聊天、审查和自总结使用当前 DSH 的默认模型与 Agent 运行时。各功能由 dsh-loader 在此卡片内统一配置和保存。",
  fields: [
    flag("enabled", "启用机器人"),
    text("profileDir", "当前 profile 绝对路径（自动定位失败时填写）"),
    text("homeDir", "DSH Home 绝对路径（默认 profile 上两级）"),
    {
      type: "group",
      label: "OneBot · NapCat / Snowluma",
      fields: [
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
      ],
    },
    {
      type: "group",
      label: "任务运行限制",
      fields: [
        num("timeoutSec", "单次任务超时（秒）", 120, 5, 600),
        num("maxToolRounds", "单次任务最大步骤数", 6, 1, 20),
      ],
    },
    {
      type: "group",
      label: "GitHub Webhook",
      fields: [
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
      ],
    },
    {
      type: "group",
      label: "RAG / Skill 自总结",
      fields: [
        flag("ragEnabled", "启用本地混合记忆", true),
        num("recallK", "初步召回数量", 50, 1, 200),
        num("memoryK", "上下文记忆条数", 8, 1, 50),
        flag("reranker", "启用本地 bge-reranker-base"),
        flag("learnMemory", "总结重要事项到长期记忆", true),
        flag("learnSkills", "自动总结 Skill", true),
        num("maxMemories", "最大记忆条数", 20000, 100, 1000000),
      ],
    },
    object("modules", "聊天与通知功能", moduleFields),
    array(
      "mcpServers",
      "MCP 服务",
      object("item", "服务", [
        {
          type: "text",
          key: "name",
          label: "名称",
          required: true,
          pattern: "^[a-zA-Z0-9_-]{1,32}$",
        },
        flag("enabled", "启用", true),
        select("transport", "传输", [
          ["stdio", "stdio"],
          ["http", "Streamable HTTP"],
          ["sse", "SSE"],
        ]),
        text("command", "启动命令"),
        strings("args", "命令参数（每项一个参数）"),
        pairs("env", "环境变量"),
        text("url", "服务 URL"),
        pairs("headers", "HTTP 请求头"),
        strings("allowedTools", "允许自动调用的工具名称"),
      ]),
    ),
  ] satisfies ConfigField[],
  panels,
});

export function validateConfig(c: SynapseConfig) {
  validateValues(template.fields, c as any);
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
