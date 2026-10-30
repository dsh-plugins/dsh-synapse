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
export const object = (
  key: string,
  label: string,
  fields: ConfigField[],
): ConfigField => ({ type: "object", key, label, fields });
export const array = (
  key: string,
  label: string,
  item: ConfigField,
): ConfigField => ({ type: "array", key, label, item });
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

const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const moduleFields: ConfigField[] = [
  object("management", "群管理与管理员", [
    ids(),
    ids("operators", "QQ 管理员"),
    strings("discordOperators", "Discord 管理员 ID"),
  ]),
  ...[
    ["parentheses", "括号匹配"],
    ["poke", "戳一戳"],
    ["minecraft", "Minecraft 查询"],
    ["modrinth", "Modrinth 查询"],
    ["command", "命令入口"],
  ].map(([id, label]) => object(id, label, [ids()])),
  object("bili", "B 站视频与订阅", [ids(), ids("follow", "关注的 B 站 UID")]),
  object("github", "GitHub 仓库通知", [
    array(
      "subscriptions",
      "仓库订阅",
      object("item", "订阅", [text("repository", "owner/repo"), ids()]),
    ),
  ]),
  object("welcome", "新人欢迎", [
    array(
      "welcomes",
      "欢迎规则",
      object("item", "规则", [
        ids("group", "适用 QQ 群"),
        text(
          "msg",
          "欢迎语（${at} 表示新成员）",
          "欢迎 ${at} 加入群聊",
          "textarea",
        ),
      ]),
    ),
  ]),
  object("discord", "Discord 跨平台桥接", [
    text("token", "Discord Bot Token", "", "password"),
    array(
      "bridges",
      "频道与 QQ 群映射",
      object("item", "桥接", [
        text("guildId", "Discord 服务器 ID"),
        text("channelName", "Discord 频道名称"),
        text("group", "QQ 群号"),
        flag("needReply", "QQ → Discord 仅转发对桥消息的回复"),
        flag("needCmd", "双向仅转发 /send 与桥消息回复"),
      ]),
    ),
  ]),
  object("chat", "QQ / Discord 消息行为", [
    text("botName", "机器人展示名称", "小喵"),
    ids(),
    ids("admins", "对话管理员 QQ"),
    ids("allowedUsers", "允许对话的 QQ 用户（空为全部）"),
    ids("blockedUsers", "屏蔽的 QQ 用户"),
    flag("requireMention", "群聊需要 @机器人", true),
    strings("keywordTriggers", "触发关键词"),
    num("progressRateLimitSec", "进度更新最小间隔（秒）", 15),
    flag("progressAsImage", "进度使用图片卡片", true),
    num("progressMaxTools", "进度卡片最多工具数", 12),
    num("maxMessageLength", "单条消息最大字符数", 1200, 1),
    flag("forwardImages", "转发图片到 DSH", true),
    flag("replyPerSentence", "逐句发送回复", true),
    num("compactMaxChars", "合并转发字符阈值（0 关闭）", 300),
    num("compactMaxLines", "合并转发行数阈值（0 关闭）", 5),
    num("localHistoryMaxMessages", "首次创建 DSH 会话时导入的旧历史条数", 24),
    flag("persistHistoryEnabled", "保存会话历史", true),
    num("persistHistoryMax", "历史保留消息数", 100),
    flag("approvalEnabled", "在聊天通道显示 DSH 审批", true),
    num("approvalTimeoutSec", "审批超时自动拒绝（秒，0 不超时）", 300),
    flag("reactionEnabled", "处理期间使用表情回应", true),
    text("reactionEmojiQq", "QQ 回应表情 ID", "76"),
    text("reactionEmojiDiscord", "Discord 回应表情", "👀"),
    flag("privateReactionFallbackText", "私聊表情失败时发送文字回执", true),
    text("privateReceiptText", "私聊文字回执", "🤔 收到，正在思考…"),
  ]),
  object("peakValley", "峰谷时段提醒", [
    ids(),
    select("mode", "默认时段类型", [
      ["peak", "峰"],
      ["valley", "谷"],
    ]),
    {
      ...array(
        "time",
        "时段",
        object("item", "时段", [
          {
            ...text("start", "开始时间", "09:00"),
            pattern: "^([01]?\\d|2[0-3]):[0-5]\\d$",
          },
          {
            ...text("end", "结束时间", "12:00"),
            pattern: "^([01]?\\d|2[0-3]):[0-5]\\d$",
          },
          {
            type: "multiselect",
            key: "days",
            label: "重复日期",
            default: days.slice(0, 5),
            options: days.map((value, i) => ({
              value,
              label: ["周一", "周二", "周三", "周四", "周五", "周六", "周日"][
                i
              ],
            })),
          },
          select("mode", "时段类型", [
            ["", "使用默认类型"],
            ["peak", "峰"],
            ["valley", "谷"],
          ]),
          text("msg", "此时段提醒（留空使用默认）", "", "textarea"),
        ]),
      ),
      default: [
        {
          start: "09:00",
          end: "12:00",
          days: days.slice(0, 5),
          mode: "",
          msg: "",
        },
        {
          start: "14:00",
          end: "18:00",
          days: days.slice(0, 5),
          mode: "",
          msg: "",
        },
      ],
    },
    text(
      "peak_msg",
      "峰时段提醒",
      "梁文峰时间到！\n当前时间是${time}",
      "textarea",
    ),
    text(
      "valley_msg",
      "谷时段提醒",
      "梁文谷时间到！\n当前时间是${time}",
      "textarea",
    ),
    text(
      "cmd_peak_msg",
      "峰时段查询回复",
      "当前时间是${time}，梁文峰时间！",
      "textarea",
    ),
    text(
      "cmd_valley_msg",
      "谷时段查询回复",
      "当前时间是${time}，梁文谷时间！",
      "textarea",
    ),
  ]),
];

/** Only this boundary translates the visual form to the upstream file formats. */
export function featureFiles(c: SynapseConfig): { id: string; value: any }[] {
  const m = c.modules;
  return [
    ...[
      "management",
      "parentheses",
      "poke",
      "minecraft",
      "modrinth",
      "command",
    ].map((id) => ({ id, value: { version: 1, ...m[id] } })),
    {
      id: "bili",
      value: {
        version: 1,
        groups: m.bili.groups,
        extra: { follow: m.bili.follow },
      },
    },
    {
      id: "github",
      value: {
        version: 2,
        groups: Object.fromEntries(
          m.github.subscriptions.map((s) => [s.repository, s.groups]),
        ),
      },
    },
    { id: "welcome", value: { version: 1, welcomes: m.welcome.welcomes } },
    {
      id: "discord-bridge",
      value: {
        version: 1,
        token: m.discord.token,
        bridges: Object.fromEntries(
          m.discord.bridges.map((b) => [
            `${b.guildId}#${b.channelName}`,
            {
              group: b.group,
              need_reply: String(b.needReply),
              need_cmd: String(b.needCmd),
            },
          ]),
        ),
      },
    },
    { id: "hermes", value: { version: 1, ...m.chat, systemPrompt: "" } },
    {
      id: "peak-valley-timer",
      value: {
        ...m.peakValley,
        time: m.peakValley.time.map((t) => ({
          ...t,
          ...(t.mode ? {} : { mode: undefined }),
        })),
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
    if (
      [
        "management",
        "parentheses",
        "poke",
        "minecraft",
        "modrinth",
        "command",
      ].includes(id)
    )
      m[id] = { ...m[id], ...v };
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
      m.chat = { ...m.chat, ...behavior };
    } else if (id === "peak-valley-timer")
      m.peakValley = {
        ...m.peakValley,
        ...v,
        time: (v.time ?? m.peakValley.time).map(timeRange),
      };
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
