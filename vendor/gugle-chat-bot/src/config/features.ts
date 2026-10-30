import path from 'node:path';
import Constants from '@/constants';
import { readConfigFile, writeConfigFile, ConfigStore, MigrationStep } from '@/config/manager';

// ---------------------------------------------------------------------------
// 功能模块独立配置文件注册表
//
// 历史背景：所有功能的群聊/操作人白名单原先挤在 bot-config.json 的
// `function*` 字段里。现已拆分为各功能自己的配置文件（configs/features/*.json），
// 每个文件带 version 字段，未来的结构变更通过 versions/migrations 升级。
//
// 本模块职责：
//  1. 声明每个功能的独立配置文件路径、默认值、版本与迁移步骤
//  2. 提供 getFeatureConfig / getFeatureGroups 访问生效配置（ConfigStore 热重载）
//  3. 提供 migrateLegacyFunctionFields() 把 bot-config.json 里的旧 function*
//     字段一次性拆进各功能配置文件，并从 bot-config.json 移除
// ---------------------------------------------------------------------------

export interface FeatureConfig {
  version: number;
  /** 生效群聊 */
  groups: number[];
  /** 操作人白名单（如管理功能的管理员 QQ） */
  operators?: number[];
  /**
   * Discord 管理员白名单（Discord 用户 ID，可带 `dc:` 前缀）。
   *
   * 用途：桥接频道里执行管理员命令时，除「服务器拥有者/管理员权限」外，
   * 额外允许这些用户。Discord 用户 ID 为 snowflake 字符串，不能塞进 operators（number[]）。
   *
   * 示例（configs/features/management.json）：
   * ```jsonc
   * {
   *   "version": 1,
   *   "groups": [703453948],
   *   "operators": [2308465862],          // QQ 管理员
   *   "discordOperators": ["123456789012345678"]  // Discord 管理员（可写 dc: 前缀）
   * }
   * ```
   */
  discordOperators?: string[];
  /** 其他自定义字段（如 Bili 关注列表） */
  extra?: Record<string, unknown>;
}

export interface FeatureDefinition {
  /** 功能 id，对应 configs/features/<id>.json */
  id: string;
  /** 默认群聊 */
  defaultGroups: number[];
  /** 默认操作人白名单 */
  defaultOperators?: number[];
  /** bot-config.json 中的旧字段名（迁移用） */
  legacyGroupsFields: string[];
  /** bot-config.json 中旧操作人字段名（迁移用） */
  legacyOperatorsField?: string;
  /** 其他旧字段名 → 迁移到 extra 的键 */

  legacyExtraFields?: Record<string, string>;
  /** 当前配置版本 */
  version?: number;
  /** 迁移步骤 */
  migrations?: import('@/config/manager').MigrationStep[];
}

/**
 * GitHub 功能配置（v2）。
 *
 * groups 从 v1 的 `number[]`（全仓库白名单群）升级为
 * `Record<仓库 full_name, 订阅该仓库的群号[]>`——webhook 事件只推送到
 * 对应仓库订阅的群，实现"仓库级订阅"。
 */
export interface GithubFeatureConfig {
  version: number;
  /** 仓库 full_name（如 Anvil-Dev/AnvilCraft）→ 订阅群号列表 */
  groups: Record<string, number[]>;
}

/**
 * 新人欢迎配置（v1）。
 *
 * configs/features/welcome.json：
 * ```json
 * {
 *   "version": 1,
 *   "welcomes": [
 *     {
 *       "group": [123456, 234567],
 *       "msg": ["欢迎 ${at} 加入群聊", "请查看群公告"]
 *     }
 *   ]
 * }
 * ```
 * `msg` 可以是字符串或字符串数组（数组每项一行，发送时按换行拼接）。
 */
export interface WelcomeFeatureConfig {
  version: number;
  welcomes: WelcomeEntry[];
}

/** 单条欢迎配置：适用的群列表 + 欢迎语模板（${at} 替换为 @新成员；支持多行数组） */
export interface WelcomeEntry {
  group: number[];
  msg: string | string[];
}

export interface LegacyFunctionValues {
  featureId: string;
  groups?: number[];
  operators?: number[];
  extra?: Record<string, unknown>;
}

const FEATURES_DIR = path.resolve(process.cwd(), 'configs', 'features');

// ---------------------------------------------------------------------------
// 功能定义表
// ---------------------------------------------------------------------------

export const FEATURE_DEFINITIONS: FeatureDefinition[] = [
  {
    id: 'github',
    defaultGroups: [],
    legacyGroupsFields: ['functionGithubGroup']
  },
  {
    id: 'management',
    defaultGroups: [],
    defaultOperators: [],
    legacyGroupsFields: ['functionManagementGroup'],
    legacyOperatorsField: 'functionManagementOperator'
  },
  {
    id: 'parentheses',
    defaultGroups: [],
    legacyGroupsFields: ['functionParenthesesGroup']
  },
  {
    id: 'poke',
    defaultGroups: [],
    legacyGroupsFields: ['functionPokeGroup']
  },
  {
    id: 'minecraft',
    defaultGroups: [],
    legacyGroupsFields: ['functionMinecraftGroup']
  },
  {
    id: 'modrinth',
    defaultGroups: [],
    legacyGroupsFields: ['functionModrinthGroup']
  },
  {
    id: 'bili',
    defaultGroups: [],
    legacyGroupsFields: ['functionBiliGroup'],
    legacyExtraFields: { functionBiliFollow: 'follow' }
  },
  {
    id: 'command',
    defaultGroups: [],
    legacyGroupsFields: ['functionCommandGroup']
  }
];

// ---------------------------------------------------------------------------
// 配置仓库（ConfigStore：独立文件 + 热重载）
// ---------------------------------------------------------------------------

const stores = new Map<string, ConfigStore<FeatureConfig>>();

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(item => typeof item === 'number' && Number.isSafeInteger(item));
}

function isGithubGroups(
  value: unknown
): value is Record<string, number[]> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.entries(value as Record<string, unknown>).every(
      ([repo, groups]) =>
        typeof repo === 'string' && repo.includes('/') && isNumberArray(groups)
    )
  );
}

/** github.json 的默认工厂：v2 空订阅（无仓库订阅） */
function githubFactory(): GithubFeatureConfig {
  return { version: 2, groups: {} };
}

/** github.json 的 v1 → v2 迁移：旧 groups 数组（全仓库白名单群）拆给默认仓库 */
function migrateGithubV1ToV2(data: Record<string, unknown>): Record<string, unknown> {
  const legacyGroups = isNumberArray(data.groups) ? data.groups : [];
  return {
    groups: legacyGroups.length > 0 ? { 'Anvil-Dev/AnvilCraft': legacyGroups } : {}
  };
}

/** github.json 规范化：接受 v2 Record；非法/损坏返回 null 触发备份重建 */
function normalizeGithubConfig(raw: unknown): GithubFeatureConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (isGithubGroups(record.groups)) {
    return { version: 2, groups: record.groups };
  }
  // v1 遗留（groups 为数组）：转为 v2 结构（不落盘，读取时动态转换）
  if (isNumberArray(record.groups)) {
    const groups: Record<string, number[]> =
      record.groups.length > 0 ? { 'Anvil-Dev/AnvilCraft': record.groups } : {};
    return { version: 2, groups };
  }
  return { version: 2, groups: {} };
}

function normalizeFeatureConfig(def: FeatureDefinition, raw: unknown): FeatureConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const groups = record.groups !== undefined && isNumberArray(record.groups) ? record.groups : def.defaultGroups;
  const operators =
    record.operators !== undefined
      ? isNumberArray(record.operators)
        ? record.operators
        : def.defaultOperators
      : def.defaultOperators;
  const extra =
    record.extra !== undefined && record.extra && typeof record.extra === 'object' && !Array.isArray(record.extra)
      ? (record.extra as Record<string, unknown>)
      : undefined;
  // Discord 用户 ID：snowflake 字符串，允许带 dc: 前缀；非法项剔除
  const discordOperators = Array.isArray(record.discordOperators)
    ? record.discordOperators
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map(item => normalizeDiscordUserId(item))
    : undefined;
  const config: FeatureConfig = {
    version: def.version ?? 1,
    groups,
    ...(operators ? { operators } : {}),
    ...(discordOperators ? { discordOperators } : {}),
    ...(extra ? { extra } : {})
  };
  return config;
}

/** 归一化 Discord 用户 ID：去掉 dc: 前缀与首尾空白，统一存裸 snowflake */
export function normalizeDiscordUserId(raw: string): string {
  return raw.trim().replace(/^dc:/i, '');
}

function createStore(def: FeatureDefinition): ConfigStore<FeatureConfig> {
  const filePath = path.join('configs', 'features', `${def.id}.json`);
  return new ConfigStore<FeatureConfig>({
    path: filePath,
    factory: () => ({
      version: def.version ?? 1,
      groups: def.defaultGroups,
      ...(def.defaultOperators ? { operators: def.defaultOperators } : {}),
      ...(def.legacyExtraFields ? { extra: {} } : {})
    }),
    version: def.version ?? 1,
    ...(def.migrations ? { migrations: def.migrations } : {}),
    normalize: raw => normalizeFeatureConfig(def, raw)
  });
}

function getStore(def: FeatureDefinition): ConfigStore<FeatureConfig> {
  let store = stores.get(def.id);
  if (!store) {
    store = createStore(def);
    stores.set(def.id, store);
  }
  return store;
}

/** 读取功能的生效配置（自动创建默认文件 + 热重载） */
export function getFeatureConfig(defId: string): FeatureConfig {
  const def = FEATURE_DEFINITIONS.find(item => item.id === defId);
  if (!def) throw new Error(`未注册的功能配置: ${defId}`);
  return getStore(def).get();
}

/** 读取功能的生效群聊白名单 */
export function getFeatureGroups(defId: string): number[] {
  return getFeatureConfig(defId).groups;
}

/** 订阅功能配置文件变化（外部改文件自动热重载） */
export function watchFeatureConfig(defId: string, listener: (config: FeatureConfig, source: import('@/config/manager').ConfigChangeSource) => void): () => void {
  const def = FEATURE_DEFINITIONS.find(item => item.id === defId);
  if (!def) throw new Error(`未注册的功能配置: ${defId}`);
  return getStore(def).onChange(listener);
}

// ---------------------------------------------------------------------------
// GitHub 配置（v2：仓库级订阅）
// 与通用 FeatureConfig 不同：groups 是 仓库 full_name → 订阅群号[]。
// 独立 store 管理（configs/features/github.json，v1 → v2 自动迁移）。
// ---------------------------------------------------------------------------

const githubStore = new ConfigStore<GithubFeatureConfig>({
  path: 'configs/features/github.json',
  version: 2,
  migrations: [{ from: 1, to: 2, migrate: migrateGithubV1ToV2 }],
  factory: githubFactory,
  normalize: normalizeGithubConfig
});

/** 读取 github 生效配置（v2：仓库 → 订阅群映射） */
export function getGithubConfig(): GithubFeatureConfig {
  return githubStore.get();
}

/** 读取某仓库的订阅群列表（无订阅返回空数组） */
export function getGithubSubscribers(repository: string): number[] {
  return getGithubConfig().groups[repository] || [];
}

/** 判断某群是否订阅了任意仓库（用于 processMessage 的启用判断） */
export function isGithubEnabledGroup(groupId: number): boolean {
  return Object.values(getGithubConfig().groups).some(list => list.includes(groupId));
}

/**
 * 订阅：把群加入仓库的订阅列表（幂等；写入后热生效）。
 * @returns 该仓库订阅后的完整群列表
 */
export function subscribeGithubRepository(repository: string, groupId: number): number[] {
  const current = getGithubConfig();
  const subscribers = Array.from(new Set([...(current.groups[repository] || []), groupId]));
  const next: GithubFeatureConfig = {
    version: 2,
    groups: { ...current.groups, [repository]: subscribers }
  };
  githubStore.update(next);
  return subscribers;
}

/**
 * 取消订阅：把群从仓库的订阅列表移除。
 * @returns 该仓库订阅后的完整群列表（群号不存在则不变）
 */
export function unsubscribeGithubRepository(repository: string, groupId: number): number[] {
  const current = getGithubConfig();
  const subscribers = (current.groups[repository] || []).filter(id => id !== groupId);
  const nextGroups: Record<string, number[]> = { ...current.groups };
  if (subscribers.length > 0) nextGroups[repository] = subscribers;
  else delete nextGroups[repository];
  const next: GithubFeatureConfig = { version: 2, groups: nextGroups };
  githubStore.update(next);
  return subscribers;
}

/** 仓库名格式校验（owner/name，均允许字母数字 . _ -） */
export function isValidRepositoryName(repository: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository);
}

/** GitHub owner 格式校验（字母数字 . _ -，不含斜杠） */
export function isValidRepositoryOwner(owner: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(owner);
}

/**
 * 判断某 QQ 用户是否为管理员（操作人白名单）。
 *
 * 白名单复用 management 功能的 operators 配置，使「谁是管理员」在全项目只有一个定义，
 * 与 /pardon 等管理命令保持一致。
 *
 * @param qqUserId 发送者 QQ 号
 */
export function isOperator(qqUserId: number): boolean {
  return getFeatureConfig('management').operators?.includes(qqUserId) ?? false;
}

/**
 * 判断某 Discord 用户是否为管理员（配置白名单）。
 *
 * 与「服务器拥有者/管理员权限」互补：Discord 侧命令源用 isDiscordAdmin() 判定服务器权限，
 * 这里额外允许 management.json 的 `discordOperators` 名单成员（便于不加服务器权限也能管理）。
 *
 * @param discordUserId Discord 用户 ID（裸 snowflake 或带 `dc:` 前缀）
 */
export function isDiscordOperator(discordUserId: string): boolean {
  const list = getFeatureConfig('management').discordOperators;
  if (!list || list.length === 0) return false;
  const target = normalizeDiscordUserId(discordUserId);
  return list.some(item => normalizeDiscordUserId(item) === target);
}

// ---------------------------------------------------------------------------
// 新人欢迎配置（v1：welcomes 数组）
// ---------------------------------------------------------------------------

function welcomeFactory(): WelcomeFeatureConfig {
  return { version: 1, welcomes: [] };
}

function normalizeWelcomeConfig(raw: unknown): WelcomeFeatureConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const welcomes = Array.isArray(record.welcomes) ? record.welcomes : [];
  const normalized: WelcomeEntry[] = [];
  for (const item of welcomes) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    if (!Array.isArray(entry.group)) continue;
    const msg = normalizeWelcomeMsg(entry.msg);
    if (msg === null) continue;
    const group = entry.group.filter(g => typeof g === 'number' && Number.isSafeInteger(g));
    normalized.push({ group, msg });
  }
  return { version: 1, welcomes: normalized };
}

/** 规范化 msg 字段：字符串或字符串数组（数组元素须全为字符串），否则返回 null */
function normalizeWelcomeMsg(raw: unknown): string | string[] | null {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    if (raw.every(item => typeof item === 'string')) return raw;
    return null;
  }
  return null;
}

const welcomeStore = new ConfigStore<WelcomeFeatureConfig>({
  path: 'configs/features/welcome.json',
  version: 1,
  factory: welcomeFactory,
  normalize: normalizeWelcomeConfig
});

/** 读取新人欢迎生效配置（v1：welcomes 数组） */
export function getWelcomeConfig(): WelcomeFeatureConfig {
  return welcomeStore.get();
}

// ---------------------------------------------------------------------------
// 旧字段迁移：bot-config.json 的 function* → 各功能配置文件
// ---------------------------------------------------------------------------

const BOT_CONFIG_PATH = path.resolve(process.cwd(), 'configs', 'bot-config.json');

function readLegacyValues(def: FeatureDefinition, legacyRaw: Record<string, unknown>): LegacyFunctionValues | undefined {
  const groupsValue = def.legacyGroupsFields
    .map(field => legacyRaw[field])
    .find(value => value !== undefined);
  const groups = groupsValue !== undefined && isNumberArray(groupsValue) ? groupsValue : undefined;

  let operators: number[] | undefined = undefined;
  if (def.legacyOperatorsField) {
    const operatorValue = legacyRaw[def.legacyOperatorsField];
    if (operatorValue !== undefined && isNumberArray(operatorValue)) operators = operatorValue;
  }

  let extra: Record<string, unknown> | undefined = undefined;
  if (def.legacyExtraFields) {
    const extras: Record<string, unknown> = {};
    let extrasAny = false;
    for (const [legacyField, extraKey] of Object.entries(def.legacyExtraFields)) {
      const value = legacyRaw[legacyField];
      if (value !== undefined) {
        extras[extraKey] = value;
        extrasAny = true;
      }
    }
    if (extrasAny) extra = extras;
  }

  if (groups === undefined && operators === undefined && extra === undefined) return undefined;
  return {
    featureId: def.id,
    ...(groups !== undefined ? { groups } : {}),
    ...(operators !== undefined ? { operators } : {}),
    ...(extra !== undefined ? { extra } : {})
  };
}

function applyLegacyToStore(def: FeatureDefinition, legacy: LegacyFunctionValues): void {
  // github 使用专用 store（v2 仓库级订阅），旧 groups 数组拆给默认仓库
  if (def.id === 'github') {
    const legacyGroups = legacy.groups || [];
    const current = githubStore.get();
    const nextGroups: Record<string, number[]> = { ...current.groups };
    if (legacyGroups.length > 0 && Object.keys(nextGroups).length === 0) {
      nextGroups['Anvil-Dev/AnvilCraft'] = legacyGroups;
    }
    githubStore.update({ version: 2, groups: nextGroups });
    return;
  }
  const store = getStore(def);
  const current = store.get();
  const next: FeatureConfig = {
    version: def.version ?? 1,
    groups: legacy.groups ?? current.groups,
    ...(legacy.operators || current.operators ? { operators: legacy.operators ?? current.operators } : {}),
    ...(legacy.extra || current.extra ? { extra: legacy.extra ?? current.extra } : {})
  };
  store.update(next);
}

/**
 * 把 bot-config.json 里的旧 `function*` 字段一次性拆进各功能配置文件。
 * 迁移完成后从 bot-config.json 删除这些字段。幂等：无旧字段时直接返回。
 */
export function migrateLegacyFunctionFields(): boolean {
  const legacyRaw = readConfigFile<Record<string, unknown>>(BOT_CONFIG_PATH);
  if (!legacyRaw) return false;

  let anyMigrated = false;
  for (const def of FEATURE_DEFINITIONS) {
    const legacy = readLegacyValues(def, legacyRaw);
    if (legacy) {
      applyLegacyToStore(def, legacy);
      anyMigrated = true;
    }
  }

  if (!anyMigrated) return false;

  // 从 bot-config.json 删除已迁移的 function* 字段并写回
  const next = { ...legacyRaw };
  for (const def of FEATURE_DEFINITIONS) {
    for (const field of def.legacyGroupsFields) delete next[field];
    if (def.legacyOperatorsField) delete next[def.legacyOperatorsField];
    if (def.legacyExtraFields) {
      for (const legacyField of Object.keys(def.legacyExtraFields)) delete next[legacyField];
    }
  }
  writeConfigFile(BOT_CONFIG_PATH, next);
  return true;
}

/** 供 ConfigStore 观察者使用的内部导出（测试用） */
export function __featureStores(): Map<string, ConfigStore<FeatureConfig>> {
  return stores;
}

export type { MigrationStep };
export { FEATURES_DIR };

// 模块加载时立即执行一次旧字段迁移：
// 保证任何功能模块首次 getFeatureConfig() 之前，bot-config.json 的
// function* 旧字段已拆入各自的 features/*.json 配置文件。
migrateLegacyFunctionFields();