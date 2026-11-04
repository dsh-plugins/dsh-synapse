import type { ConfigField } from "@dsh-plugin/dsh-loader/config";
import type { SynapseConfig } from "./types.js";

export const text = (
  key: string,
  label: string,
  value = "",
  type: ConfigField["type"] = "text",
): ConfigField => ({ type, key, label, default: value });
export const flag = (
  key: string,
  label: string,
  value = false,
): ConfigField => ({ type: "boolean", key, label, default: value });
export const num = (
  key: string,
  label: string,
  value: number,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): ConfigField => ({ type: "number", key, label, default: value, min, max });

export interface CollapseOptions {
  collapsible?: boolean;
  defaultCollapsed?: boolean;
}
export const object = (
  key: string,
  label: string,
  fields: ConfigField[],
  options?: CollapseOptions,
): ConfigField => ({ type: "object", key, label, fields, ...options });
export const array = (
  key: string,
  label: string,
  item: ConfigField,
): ConfigField => ({ type: "array", key, label, item });
export const group = (
  label: string,
  fields: ConfigField[],
  options?: CollapseOptions,
): ConfigField => ({ type: "group", label, fields, ...options });
/** 配置表单布局分组默认全部折叠，保持卡片首屏紧凑。 */
export const collapsibleGroup = (
  label: string,
  fields: ConfigField[],
): ConfigField =>
  group(label, fields, { collapsible: true, defaultCollapsed: true });
export const strings = (key: string, label: string): ConfigField =>
  array(key, label, text("item", "值"));
export const ids = (key = "groups", label = "启用的 QQ 群"): ConfigField =>
  array(key, label, num("item", "号码", 1, 1));
export const select = (
  key: string,
  label: string,
  options: [string, string][],
  value = options[0][0],
): ConfigField => ({
  type: "select",
  key,
  label,
  options: options.map(([value, label]) => ({ value, label })),
  default: value,
});

export const GROUP_FEATURES = ["parentheses", "poke", "minecraft", "modrinth", "command"];
const HERMES_KEYS = [
  "botName", "groups", "admins", "allowedUsers", "blockedUsers", "requireMention", "keywordTriggers",
  "progressRateLimitSec", "progressAsImage", "progressMaxTools", "maxMessageLength", "forwardImages",
  "replyPerSentence", "compactMaxChars", "compactMaxLines", "localHistoryMaxMessages", "persistHistoryEnabled",
  "persistHistoryMax", "approvalEnabled", "approvalTimeoutSec", "reactionEnabled", "reactionEmojiQq",
  "reactionEmojiDiscord", "privateReactionFallbackText", "privateReceiptText",
];
const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const COLLAPSED: CollapseOptions = { collapsible: true, defaultCollapsed: true };
/** 回复呈现从聊天配置拆出，写入 hermes.json 时再合并回去。 */
export const presentationFields: ConfigField[] = [
  { ...num("progressRateLimitSec", "进度更新最小间隔（秒）", 15, 0), description: "两次进度卡片之间至少间隔这么久，0 表示不限制。" },
  flag("progressAsImage", "进度使用图片卡片", true),
  num("progressMaxTools", "进度卡片最多显示的工具数", 12),
  flag("approvalEnabled", "在聊天中显示工具审批", true),
  { ...num("approvalTimeoutSec", "审批超时自动拒绝（秒）", 300, 0), description: "0 表示一直等待，不自动拒绝。" },
  flag("reactionEnabled", "处理期间给消息加表情回应", true),
  { ...text("reactionEmojiQq", "QQ 回应表情 ID", "76"), description: "NapCat set_msg_emoji_like 使用的表情 ID，76 为「👍 强」。" },
  text("reactionEmojiDiscord", "Discord 回应表情", "👀"),
  flag("privateReactionFallbackText", "私聊表情失败时改发文字回执", true),
  text("privateReceiptText", "私聊文字回执", "🤔 收到，正在思考…"),
];
const groupFeatureFields: ConfigField[] = [
  ["parentheses", "括号匹配", "消息里有未闭合的括号或引号时，机器人补上缺失的右括号，或指出不匹配的位置。"],
  ["poke", "戳一戳回应", "21:00 到次日 08:00 期间戳机器人，会收到一句回复并被禁言 1–5 分钟。"],
  ["minecraft", "Minecraft 版本推送", "Minecraft 发布新正式版或快照时推送到这些群。"],
  ["modrinth", "Modrinth 模组更新推送", "跟踪的 Modrinth 模组发布新版本时推送到这些群。当前内置机器人没有启用任何模组跟踪，填写后暂不会收到推送。"],
  ["command", "聊天命令", "响应以 / 开头的命令，例如 /help；未加入的群不处理命令。"],
].map(([key, label, description]) => ({ ...ids(key, label), description }));
export const moduleFields: ConfigField[] = [
  object("chat", "对话行为", [
    text("botName", "机器人展示名称", "小喵"),
    ids("groups", "启用对话的 QQ 群"),
    ids("admins", "对话管理员 QQ"),
    { ...ids("allowedUsers", "允许对话的 QQ 用户"), description: "留空表示所有人都可以对话。" },
    ids("blockedUsers", "AI 忽略的 QQ 用户"),
    { ...flag("requireMention", "群聊需要 @机器人 才回复", true), description: "关闭后，群里的普通消息也会进入回复判定。" },
    { ...strings("keywordTriggers", "触发关键词"), description: "消息包含其中任一关键词时触发回复，不区分大小写。" },
    { ...num("maxMessageLength", "单条消息最大字符数", 1200, 1), description: "超过后拆成多条发送。" },
    flag("forwardImages", "把图片交给 DSH 识别", true),
    flag("replyPerSentence", "按句子逐条发送回复", true),
    { ...num("compactMaxChars", "合并转发的字符阈值", 300, 0), description: "同一 QQ 会话排队待发的消息合并后超过该字符数，就改用聊天记录（合并转发）发送；群聊按句发送时，单句超过该字符数也会这样发送。0 表示不按字符数判断。" },
    { ...num("compactMaxLines", "合并转发的行数阈值", 5, 0), description: "规则同上，按行数判断。0 表示不按行数判断。" },
    { ...num("localHistoryMaxMessages", "新会话导入的历史消息数", 24, 0), description: "第一次为该会话创建 DSH 对话时，导入多少条之前保存的聊天记录；0 表示不导入。" },
    flag("persistHistoryEnabled", "保存会话历史", true),
    num("persistHistoryMax", "历史保留的消息数", 100),
  ], COLLAPSED),
  object("presentation", "回复呈现", presentationFields, COLLAPSED),
  object("groupFeatures", "按群启用的功能", groupFeatureFields, COLLAPSED),
  object("management", "群管理与管理员", [
    ids("groups", "启用群管理的 QQ 群"),
    ids("operators", "群管理员 QQ"),
    strings("discordOperators", "Discord 管理员 ID"),
  ], COLLAPSED),
  object("bili", "B 站订阅（保留）", [
    { ...ids("groups", "推送订阅的 QQ 群"), description: "当前内置机器人不读取这一项，B 站视频卡片对所有群生效。保留它只为兼容旧配置文件。" },
    ids("follow", "关注的 B 站 UID"),
  ], COLLAPSED),
  object("github", "GitHub 仓库通知", [
    array("subscriptions", "仓库订阅", object("item", "订阅", [
      { ...text("repository", "仓库"), description: "格式为 owner/repo，仓库动态会推送到下面的群。" },
      ids("groups", "推送的 QQ 群"),
    ])),
  ], COLLAPSED),
  object("welcome", "新人欢迎", [
    array("welcomes", "欢迎规则", object("item", "规则", [
      ids("group", "适用的 QQ 群"),
      { ...text("msg", "欢迎语", "欢迎 ${at} 加入群聊", "textarea"), description: "${at} 会替换为新成员的 @。" },
    ])),
  ], COLLAPSED),
  object("discord", "Discord 跨平台桥接", [
    text("token", "Discord Bot Token", "", "password"),
    array("bridges", "频道与 QQ 群的对应关系", object("item", "桥接", [
      text("guildId", "Discord 服务器 ID"),
      text("channelName", "Discord 频道名称"),
      text("group", "QQ 群号"),
      { ...flag("needReply", "QQ 到 Discord 只转发对桥接消息的回复"), description: "开启后，QQ 里的普通消息不再发到 Discord。" },
      { ...flag("needCmd", "双向都只转发 /send 和对桥接消息的回复"), description: "开启后，两边的普通消息都不再转发。" },
    ])),
  ], COLLAPSED),
  object("peakValley", "峰谷时段提醒", [
    ids("groups", "启用提醒的 QQ 群"),
    select("mode", "默认时段类型", [["peak", "峰"], ["valley", "谷"]]),
    {
      ...array("time", "时段", object("item", "时段", [
        { ...text("start", "开始时间", "09:00"), pattern: "^([01]?\\d|2[0-3]):[0-5]\\d$", description: "24 小时制，如 09:00。" },
        { ...text("end", "结束时间", "12:00"), pattern: "^([01]?\\d|2[0-3]):[0-5]\\d$" },
        {
          type: "multiselect", key: "days", label: "重复的星期", default: days.slice(0, 5),
          options: days.map((value, i) => ({ value, label: ["周一", "周二", "周三", "周四", "周五", "周六", "周日"][i] })),
        },
        { ...select("mode", "此时段的类型", [["", "跟随默认类型"], ["peak", "峰"], ["valley", "谷"]]), description: "选「跟随默认类型」时使用上面的默认时段类型。" },
        { ...text("msg", "此时段单独的提醒", "", "textarea"), description: "填写后，时段开始和结束都发送这一条。留空时，开始发送本类型的默认提醒，结束发送相反类型的默认提醒。${time} 会替换为当前时间。" },
      ])),
      default: [
        { start: "09:00", end: "12:00", days: days.slice(0, 5), mode: "", msg: "" },
        { start: "14:00", end: "18:00", days: days.slice(0, 5), mode: "", msg: "" },
      ],
    },
    { ...text("peakMessage", "峰时段提醒", "梁文峰时间到！\n当前时间是${time}", "textarea"), description: "${time} 会替换为当前时间。" },
    { ...text("valleyMessage", "谷时段提醒", "梁文谷时间到！\n当前时间是${time}", "textarea"), description: "${time} 会替换为当前时间。" },
    text("peakReply", "查询时的峰时段回复", "当前时间是${time}，梁文峰时间！", "textarea"),
    text("valleyReply", "查询时的谷时段回复", "当前时间是${time}，梁文谷时间！", "textarea"),
  ], COLLAPSED),
];

const pairs = (key: string, label: string) =>
  array(
    key,
    label,
    object("item", "条目", [
      text("name", "名称"),
      text("value", "值", "", "password"),
    ]),
  );

/** MCP 服务数组的条目模板；同时用于宿主表单与配置弹窗，避免两处定义漂移。 */
export const mcpServerItem = object("item", "服务", [
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
]);

/** 配置表单与 gugle-chat-bot 功能文件之间的唯一翻译层，文件字段名保持上游格式。 */
export function featureFiles(c: SynapseConfig): { id: string; value: any }[] {
  const m = c.modules;
  // 键顺序与上游 hermes.json 一致，bot.ts 依赖序列化结果判断表单是否修改过。
  const chatFile: Record<string, unknown> = { version: 1 };
  for (const key of HERMES_KEYS) {
    chatFile[key] = key in m.chat ? m.chat[key] : m.presentation[key];
  }
  chatFile.systemPrompt = "";
  return [
    { id: "management", value: { version: 1, ...m.management } },
    ...GROUP_FEATURES.map((id) => ({ id, value: { version: 1, groups: m.groupFeatures[id] } })),
    { id: "bili", value: { version: 1, groups: m.bili.groups, extra: { follow: m.bili.follow } } },
    {
      id: "github",
      value: { version: 2, groups: Object.fromEntries(m.github.subscriptions.map((s) => [s.repository, s.groups])) },
    },
    { id: "welcome", value: { version: 1, welcomes: m.welcome.welcomes } },
    {
      id: "discord-bridge",
      value: {
        version: 1,
        token: m.discord.token,
        bridges: Object.fromEntries(m.discord.bridges.map((b) => [
          `${b.guildId}#${b.channelName}`,
          { group: b.group, need_reply: String(b.needReply), need_cmd: String(b.needCmd) },
        ])),
      },
    },
    { id: "hermes", value: chatFile },
    {
      id: "peak-valley-timer",
      value: {
        groups: m.peakValley.groups,
        mode: m.peakValley.mode,
        time: m.peakValley.time.map((t) => ({ ...t, ...(t.mode ? {} : { mode: undefined }) })),
        peak_msg: m.peakValley.peakMessage,
        valley_msg: m.peakValley.valleyMessage,
        cmd_peak_msg: m.peakValley.peakReply,
        cmd_valley_msg: m.peakValley.valleyReply,
      },
    },
  ];
}

export function modulesFromFiles(
  base: SynapseConfig["modules"],
  files: { id: string; value: any }[],
): SynapseConfig["modules"] {
  const m = structuredClone(base);
  for (const { id, value: v } of files) {
    if (id === "management")
      m.management = { ...m.management, ...v };
    else if (GROUP_FEATURES.includes(id))
      m.groupFeatures = { ...m.groupFeatures, [id]: v.groups ?? m.groupFeatures[id] };
    else if (id === "bili")
      m.bili = { groups: v.groups ?? [], follow: v.extra?.follow ?? [] };
    else if (id === "github")
      m.github.subscriptions = Object.entries(
        Array.isArray(v.groups)
          ? { "Anvil-Dev/AnvilCraft": v.groups }
          : (v.groups ?? {}),
      ).map(([repository, groups]) => ({
        repository,
        groups: groups as number[],
      }));
    else if (id === "welcome")
      m.welcome.welcomes = (v.welcomes ?? []).map((w) => ({
        group: w.group,
        msg: Array.isArray(w.msg) ? w.msg.join("\n") : w.msg,
      }));
    else if (id === "discord-bridge")
      m.discord = {
        token: v.token ?? "",
        bridges: Object.entries(v.bridges ?? {}).map(
          ([key, entry]: [string, any]) => ({
            guildId: key.slice(0, key.indexOf("#")),
            channelName: key.slice(key.indexOf("#") + 1),
            group: String(entry.group),
            needReply: String(entry.need_reply) === "true",
            needCmd: String(entry.need_cmd) === "true",
          }),
        ),
      };
    else if (id === "hermes") {
      const { apiUrl, apiKey, systemPrompt, version, ...behavior } = v;
      const presentation = {};
      for (const field of presentationFields) {
        if (field.key! in behavior) {
          presentation[field.key!] = behavior[field.key!];
          delete behavior[field.key!];
        }
      }
      m.chat = { ...m.chat, ...behavior };
      m.presentation = { ...m.presentation, ...presentation };
    } else if (id === "peak-valley-timer") {
      const { peak_msg, valley_msg, cmd_peak_msg, cmd_valley_msg, ...rest } = v;
      m.peakValley = {
        ...m.peakValley,
        ...rest,
        ...(peak_msg === undefined ? {} : { peakMessage: peak_msg }),
        ...(valley_msg === undefined ? {} : { valleyMessage: valley_msg }),
        ...(cmd_peak_msg === undefined ? {} : { peakReply: cmd_peak_msg }),
        ...(cmd_valley_msg === undefined ? {} : { valleyReply: cmd_valley_msg }),
        time: (v.time ?? m.peakValley.time).map(timeRange),
      };
    }
  }
  return m;
}
function timeRange(raw: any) {
  if (typeof raw !== "string")
    return { ...raw, mode: raw.mode ?? "", msg: raw.msg ?? "" };
  const match = raw.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})(?:\s+(.+))?$/);
  if (!match) throw new Error(`无法迁移时段：${raw}`);
  const selected = new Set<string>();
  for (const token of (match[3] ?? "Mon-Sun").split(/[,\s]+/)) {
    const [start, end = start] = token.split("-");
    let i = days.indexOf(start);
    if (i < 0 || !days.includes(end)) throw new Error(`无法迁移日期：${token}`);
    for (let n = 0; n < 7; n++, i = (i + 1) % 7) {
      selected.add(days[i]);
      if (days[i] === end) break;
    }
  }
  return {
    start: match[1],
    end: match[2],
    days: [...selected],
    mode: "",
    msg: "",
  };
}
