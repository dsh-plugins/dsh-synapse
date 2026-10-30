import { defineConfig, type ConfigField } from "@dsh-plugin/dsh-loader/config";
const text = (
  key,
  label,
  value = "",
  type: ConfigField["type"] = "text",
): ConfigField => ({ type, key, label, default: value });
const flag = (key, label, value = false): ConfigField => ({
  type: "boolean",
  key,
  label,
  default: value,
});
const num = (
  key,
  label,
  value: number,
  min: number,
  max: number,
): ConfigField => ({ type: "number", key, label, default: value, min, max });
export const FEATURES = [
  "management",
  "parentheses",
  "poke",
  "minecraft",
  "modrinth",
  "bili",
  "command",
  "github",
  "welcome",
  "discord-bridge",
  "hermes",
  "peak-valley-timer",
];
export const template = defineConfig({
  id: "dsh-synapse",
  packageName: "@dsh-plugin/dsh-synapse",
  title: "Synapse · 通道与记忆",
  description:
    "保存后重新连接通道。Skill、MCP、Hermes 导入位于 Synapse 管理面板。密码仅保存在当前 profile。",
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
        text("chromePath", "Chrome / Chromium 路径"),
        text("botJson", "上游 bot-config 扩展 JSON", "{}", "textarea"),
      ],
    },
    {
      type: "group",
      label: "AI 对话 / 审查",
      fields: [
        text("llmUrl", "OpenAI 兼容 API 地址", "https://api.deepseek.com/v1"),
        text("llmKey", "API Key", "", "password"),
        text("model", "模型", "deepseek-chat"),
        num("timeoutSec", "请求超时（秒）", 120, 5, 600),
        num("maxToolRounds", "工具轮数上限", 6, 1, 20),
        flag("externalHermes", "使用外部 Hermes（保留其工具及审批）"),
        text("hermesUrl", "Hermes API 地址", "http://127.0.0.1:8642"),
        text("hermesKey", "Hermes Key", "", "password"),
      ],
    },
    {
      type: "group",
      label: "GitHub",
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
    {
      type: "array",
      key: "features",
      label: "gugle-chat-bot 全量功能配置（JSON）",
      default: FEATURES.map((id) => ({
        id,
        json: JSON.stringify(
          id === "github"
            ? { version: 2, groups: {} }
            : id === "welcome"
              ? { version: 1, welcomes: [] }
              : id === "discord-bridge"
                ? { version: 1, token: "", bridges: {} }
                : { version: 1, groups: [] },
          null,
          2,
        ),
      })),
      item: {
        type: "object",
        label: "功能",
        fields: [
          {
            type: "select",
            key: "id",
            label: "模块",
            options: FEATURES.map((value) => ({ label: value, value })),
          },
          text("json", "配置 JSON（可能含密钥）", "{}", "password"),
        ],
      },
    },
    {
      type: "array",
      key: "mcp",
      label: "MCP 服务",
      item: {
        type: "object",
        label: "服务",
        fields: [
          text("name", "名称"),
          flag("enabled", "启用", true),
          {
            type: "select",
            key: "transport",
            label: "传输",
            options: [
              { label: "stdio", value: "stdio" },
              { label: "Streamable HTTP", value: "http" },
              { label: "SSE", value: "sse" },
            ],
          },
          text("command", "命令"),
          text("argsJson", "参数 JSON", "[]", "textarea"),
          text("envJson", "环境变量 JSON", "{}", "password"),
          text("url", "URL"),
          text("headersJson", "HTTP 请求头 JSON", "{}", "password"),
          text(
            "allowedTools",
            "允许自动调用的工具名称（每行一个）",
            "",
            "textarea",
          ),
        ],
      },
    },
  ],
});
export function parseObject(raw) {
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("需要 JSON 对象");
  return value;
}
export function validateConfig(c) {
  parseObject(c.botJson);
  const ids = new Set();
  for (const f of c.features) {
    if (!FEATURES.includes(f.id) || ids.has(f.id))
      throw new Error("功能 ID 无效或重复");
    ids.add(f.id);
    parseObject(f.json);
  }
  const names = new Set();
  for (const s of c.mcp) {
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(s.name) || names.has(s.name))
      throw new Error("MCP 名称无效或重复");
    names.add(s.name);
    const args = JSON.parse(s.argsJson);
    if (!Array.isArray(args) || args.some((x) => typeof x !== "string"))
      throw new Error("MCP 参数必须是字符串数组");
    for (const raw of [s.envJson, s.headersJson])
      if (Object.values(parseObject(raw)).some((x) => typeof x !== "string"))
        throw new Error("MCP 环境变量和请求头必须是字符串");
    if (s.transport !== "stdio" && !/^https?:\/\//.test(s.url))
      throw new Error("MCP URL 无效");
  }
  if (
    c.githubEnabled &&
    (!c.webhookSecret || !c.githubToken || !c.repositories.trim())
  )
    throw new Error("启用 GitHub 需要 Secret、Token 和仓库允许列表");
  for (const k of [
    "recallK",
    "memoryK",
    "maxMemories",
    "maxToolRounds",
    "timeoutSec",
    "maxDiffChars",
  ])
    if (!Number.isInteger(c[k])) throw new Error(`${k} 必须是整数`);
  for (const key of ["httpUrl", "llmUrl", "hermesUrl"])
    if (!/^https?:\/\//.test(c[key]))
      throw new Error(`${key} 必须是 HTTP(S) URL`);
  if (!/^wss?:\/\//.test(c.wsUrl)) throw new Error("wsUrl 必须是 WS(S) URL");
  return c;
}
