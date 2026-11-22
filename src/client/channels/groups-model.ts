import type { ActivityGroup } from "../../activity-config.js";
import type { SynapseConfig } from "../../types.js";

export type GroupEntry = { id: string; name: string };
export type Bridge = SynapseConfig["modules"]["discord"]["bridges"][number];
type Welcome = SynapseConfig["modules"]["welcome"]["welcomes"][number];
export const featureLabels = {
  chat: "对话", command: "群命令", management: "群管理", parentheses: "括号匹配",
  poke: "戳一戳", minecraft: "Minecraft 推送", modrinth: "Modrinth 推送",
  peakValley: "峰谷提醒", bili: "B 站订阅（兼容）",
} as const;
export type Feature = keyof typeof featureLabels;

function featureGroups(c: SynapseConfig, key: Feature): number[] {
  switch (key) {
    case "chat": case "management": case "peakValley": case "bili": return c.modules[key].groups;
    default: return c.modules.groupFeatures[key];
  }
}
export function enabledFeatures(c: SynapseConfig, id: string) {
  return (Object.keys(featureLabels) as Feature[]).filter(key => featureGroups(c, key).includes(Number(id)));
}
export function listGroups(c: SynapseConfig): GroupEntry[] {
  const names = new Map<string, string>((c.groupDirectory ?? []).map(g => [g.id, g.name]));
  function collect(ids: readonly (number | string)[]) {
    for (const raw of ids) {
      const id = String(raw);
      if (!names.has(id)) names.set(id, "");
    }
  }
  for (const key of Object.keys(featureLabels) as Feature[]) collect(featureGroups(c, key));
  for (const welcome of c.modules.welcome.welcomes) collect(welcome.group);
  for (const subscription of c.modules.github.subscriptions) collect(subscription.groups);
  collect(c.modules.discord.bridges.map(b => b.group));
  collect(c.activity.groups.map(g => g.groupId));
  return [...names].map(([id, name]) => ({ id, name }));
}

export function addGroup(c: SynapseConfig, group: GroupEntry): SynapseConfig {
  if (!/^[1-9]\d*$/.test(group.id) || !Number.isSafeInteger(Number(group.id)) || !group.name.trim()) {
    throw new Error("群号或 OneBot 群名无效。");
  }
  if (listGroups(c).some(item => item.id === group.id)) throw new Error("这个群已经添加。");
  const next = structuredClone(c);
  (next.groupDirectory ??= []).push({ id: group.id, name: group.name.trim() });
  next.modules.chat.groups.push(Number(group.id));
  next.modules.groupFeatures.command.push(Number(group.id));
  return next;
}

export function policyFor(c: SynapseConfig, id: string): ActivityGroup {
  const saved = c.activity.groups.find(row => String(row.groupId) === id);
  if (saved) return structuredClone(saved);
  const { probability, idle, words, blockedWords } = c.activity;
  return structuredClone({ groupId: Number(id), useDefaults: true, probabilityEnabled: false, idleEnabled: false, probability, idle, words, blockedWords });
}

export interface GroupDraft {
  features: Feature[];
  welcomes: { index: number; msg: string }[];
  bridges: { index: number; value: Bridge }[];
  policy: ActivityGroup;
}
export function readGroup(c: SynapseConfig, id: string): GroupDraft {
  return {
    features: enabledFeatures(c, id),
    welcomes: c.modules.welcome.welcomes.flatMap((row, index) => row.group.includes(Number(id)) ? [{ index, msg: row.msg }] : []),
    bridges: c.modules.discord.bridges.flatMap((row, index) => row.group === id ? [{ index, value: { ...row } }] : []),
    policy: policyFor(c, id),
  };
}

// 仅改变此群的条目。多个群共用一条欢迎规则时，修改内容会拆分该项，保留原执行顺序。
function mergeWelcomes(rules: Welcome[], id: number, draft: GroupDraft["welcomes"]): Welcome[] {
  const result: Welcome[] = [];
  const edited = new Map(draft.map(row => [row.index, row.msg]));
  rules.forEach((row, index) => {
    const msg = edited.get(index);
    if (!row.group.includes(id) || msg === row.msg) { result.push(row); return; }
    const other = row.group.filter(value => value !== id);
    if (other.length) result.push({ ...row, group: other });
    if (msg !== undefined) result.push({ ...row, group: [id], msg });
  });
  for (const row of draft) if (row.index < 0) result.push({ group: [id], msg: row.msg });
  return result;
}

export function validateBridges(routes: Bridge[]) {
  const keys = new Set<string>();
  for (const route of routes) {
    if (!/^\d+$/.test(route.guildId) || !route.channelName.trim() || !/^\d+$/.test(route.group)) throw new Error("桥接需要服务器 ID、频道名称和 QQ 群号。");
    const key = route.guildId + "#" + route.channelName;
    if (keys.has(key)) throw new Error("这个 Discord 频道已有桥接。");
    keys.add(key);
  }
}

export function applyGroup(c: SynapseConfig, group: GroupEntry, draft: GroupDraft): SynapseConfig {
  const next = structuredClone(c), id = Number(group.id);
  for (const key of Object.keys(featureLabels) as Feature[]) {
    const members = featureGroups(next, key), enabled = draft.features.includes(key);
    if (enabled && !members.includes(id)) members.push(id);
    if (!enabled) for (let i = members.length - 1; i >= 0; i--) if (members[i] === id) members.splice(i, 1);
  }
  next.modules.welcome.welcomes = mergeWelcomes(next.modules.welcome.welcomes, id, draft.welcomes);
  const edited = new Map(draft.bridges.map(row => [row.index, row.value]));
  next.modules.discord.bridges = next.modules.discord.bridges.flatMap((row, index) => {
    if (row.group !== group.id) return [row];
    const value = edited.get(index);
    return value ? [{ ...value }] : [];
  }).concat(draft.bridges.filter(row => row.index < 0).map(row => ({ ...row.value })));
  validateBridges(next.modules.discord.bridges);
  const index = next.activity.groups.findIndex(row => row.groupId === id);
  if (index >= 0) next.activity.groups[index] = structuredClone(draft.policy);
  else if (draft.policy.probabilityEnabled || draft.policy.idleEnabled || !draft.policy.useDefaults) next.activity.groups.push(structuredClone(draft.policy));
  // 原配置没有独立群目录，关闭最后一个功能后仍须能管理这个群。
  const directory = next.groupDirectory ??= [];
  const known = directory.find(g => g.id === group.id);
  if (known && group.name) known.name = group.name;
  if (!known && (group.name || !listGroups(next).some(g => g.id === group.id))) directory.push({ ...group });
  return next;
}

export function removeGroup(c: SynapseConfig, group: GroupEntry): SynapseConfig {
  const cleared = readGroup(c, group.id);
  const next = applyGroup(c, group, { ...cleared, features: [], welcomes: [], bridges: [] });
  next.groupDirectory = next.groupDirectory.filter(row => row.id !== group.id);
  next.activity.groups = next.activity.groups.filter(row => String(row.groupId) !== group.id);
  for (const row of next.modules.github.subscriptions) row.groups = row.groups.filter(id => String(id) !== group.id);
  return next;
}
