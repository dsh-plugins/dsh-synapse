import type { ConfigField } from "@dsh-plugin/dsh-loader/config";
import { array, flag, num, object, text, strings, ids } from "./feature-config.js";

/** 群聊概率与空闲策略的可继承参数；概率以万分比整数持久化。 */
export interface ActivitySettings {
  probability: { baseBps: number; minBps: number; maxBps: number; cooldownSec: number; perMinute: number; perHour: number };
  idle: { probabilityBps: number; windowMinutes: number; jitterMinutes: number; cooldownSec: number; perHour: number; perDay: number; quietStart: string; quietEnd: string; timeZone: string; delayMinSec: number; delayMaxSec: number };
  words: { windowHours: number; halfLifeHours: number; maxBoostPercent: number };
  blockedWords: string[];
}

/** 群级白名单与继承关系；两个全局总开关仍需同时开启。 */
export interface ActivityGroup extends ActivitySettings {
  groupId: number;
  probabilityEnabled: boolean;
  idleEnabled: boolean;
  useDefaults: boolean;
}

/** 统一热更新的主动聊天配置，不保存身份凭据。 */
export interface ActivityConfig extends ActivitySettings {
  probabilityEnabled: boolean;
  idleEnabled: boolean;
  imageRetentionDays: number;
  logRetentionDays: number;
  botUsers: number[];
  groups: ActivityGroup[];
}

const settingsFields = (): ConfigField[] => [
  object("probability", "概率回复", [
    num("baseBps", "基础概率（万分比，300 即 3%）", 300, 0, 10000),
    num("minBps", "最低概率（万分比）", 0, 0, 10000),
    num("maxBps", "最高概率（万分比）", 1000, 0, 10000),
    num("cooldownSec", "发言后冷却（秒）", 300, 0, 604800),
    num("perMinute", "每分钟最多次数", 1, 1, 1000),
    num("perHour", "每小时最多次数", 6, 1, 10000),
  ]),
  object("idle", "空闲消息", [
    num("probabilityBps", "发言概率（万分比）", 2500, 0, 10000),
    num("windowMinutes", "安静多久后尝试（分钟）", 30, 1, 10080),
    num("jitterMinutes", "随机浮动（分钟）", 15, 0, 10079),
    num("cooldownSec", "发言后冷却（秒）", 1800, 0, 604800),
    num("perHour", "每小时最多次数", 1, 1, 10000),
    num("perDay", "每天最多次数", 3, 1, 100000),
    text("quietStart", "静默开始（HH:mm）", "00:00"),
    text("quietEnd", "静默结束（HH:mm）", "09:00"),
    text("timeZone", "时区", "Asia/Shanghai"),
    num("delayMinSec", "发送前最短等待（秒）", 30, 0, 86400),
    num("delayMaxSec", "发送前最长等待（秒）", 80, 0, 86400),
  ]),
  object("words", "热词加成", [
    num("windowHours", "统计最近多少小时", 48, 1, 168),
    num("halfLifeHours", "热度减半时间（小时）", 18, 1, 168),
    num("maxBoostPercent", "热词最大加成（%）", 200, 0, 200),
  ]),
  strings("blockedWords", "概率回复屏蔽词"),
];

export const activityField: ConfigField = {
  ...object("activity", "群聊上下文与主动回复", [
    flag("probabilityEnabled", "全局启用概率回复"),
    flag("idleEnabled", "全局启用空闲消息"),
    num("imageRetentionDays", "图片缓存保留天数", 7, 1, 365),
    num("logRetentionDays", "触发日志保留天数", 30, 1, 3650),
    ids("botUsers", "其他机器人 QQ 号"),
    ...settingsFields(),
    array("groups", "群级策略", object("item", "群", [
      num("groupId", "群号", 1, 1),
      flag("probabilityEnabled", "本群启用概率回复"),
      flag("idleEnabled", "本群启用空闲消息"),
      flag("useDefaults", "使用全局参数", true),
      ...settingsFields(),
    ])),
  ]),
  hidden: true,
};

export function groupSettings(config: ActivityConfig, groupId: string): ActivitySettings & { probabilityEnabled: boolean; idleEnabled: boolean } {
  const group = config.groups.find(item => String(item.groupId) === groupId);
  const settings = group && !group.useDefaults ? group : config;
  const { probability, idle, words, blockedWords } = settings;
  return { probability, idle, words, blockedWords, probabilityEnabled: Boolean(config.probabilityEnabled && group?.probabilityEnabled), idleEnabled: Boolean(config.idleEnabled && group?.idleEnabled) };
}

export function validateActivity(config: ActivityConfig) {
  const seen = new Set<number>();
  for (const group of config.groups) {
    if (seen.has(group.groupId)) { throw new Error("主动回复的群号不能重复"); }
    seen.add(group.groupId);
  }
  for (const settings of [config, ...config.groups]) {
    const { probability: p, idle } = settings;
    if (p.minBps > p.baseBps || p.baseBps > p.maxBps) { throw new Error("概率需要满足最低 ≤ 基础 ≤ 最高"); }
    if (idle.jitterMinutes >= idle.windowMinutes) { throw new Error("空闲浮动时间必须小于窗口中心"); }
    if (idle.delayMinSec > idle.delayMaxSec) { throw new Error("最短延迟不能大于最长延迟"); }
    for (const value of [idle.quietStart, idle.quietEnd]) {
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) { throw new Error("静默时段需要使用 HH:mm 格式"); }
    }
    try { new Intl.DateTimeFormat("zh-CN", { timeZone: idle.timeZone }).format(); }
    catch { throw new Error("空闲消息时区无效"); }
    if (settings.blockedWords.some(word => !word.trim() || word.length > 100) || settings.blockedWords.length > 1000) {
      throw new Error("屏蔽词应为 1–100 字符，至多 1000 个");
    }
  }
}
