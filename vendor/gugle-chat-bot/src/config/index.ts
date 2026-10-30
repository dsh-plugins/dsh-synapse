import fs from 'node:fs';
import path from 'node:path';
import Constants from '@/constants';

export type LogLevel = 'info' | 'error' | 'warn' | 'debug';

export interface BotConfig {
  userAgent: string;
  logLevel: LogLevel;
  chromePath: string;
  httpUrl: string;
  wsUrl: string;
  tokenParams: string;
  wsToken: string;
  httpToken: string;
  githubPort: number;
  githubAllowedRepositories: string[];
}

type ConfigFile = Partial<BotConfig>;

const defaultBotConfig: BotConfig = {
  userAgent: Constants.USER_AGENT,
  logLevel: Constants.LOG_LEVEL,
  chromePath: Constants.CHROME_PATH,
  httpUrl: Constants.HTTP_URL,
  wsUrl: Constants.WS_URL,
  tokenParams: Constants.TOKEN_PARAMS,
  wsToken: Constants.WS_TOKEN,
  httpToken: Constants.HTTP_TOKEN,
  githubPort: Constants.GITHUB_PORT,
  githubAllowedRepositories: Constants.GITHUB_ALLOWED_REPOSITORIES
};

const logLevels: readonly LogLevel[] = ['info', 'error', 'warn', 'debug'];

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isLogLevel(value: unknown): value is LogLevel {
  return isString(value) && logLevels.includes(value as LogLevel);
}

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535;
}

function isRepositoryPattern(value: unknown): value is string {
  return isString(value) && /^[A-Za-z0-9_.-]+\/(?:[A-Za-z0-9_.-]+|\*)$/.test(value);
}

function isRepositoryPatternArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isRepositoryPattern);
}

interface LoadedConfigFile {
  config: ConfigFile;
  contents: string;
}

interface NormalizedConfig {
  config: BotConfig;
  hasInvalidField: boolean;
  needsWrite: boolean;
}

function writeConfigFile(configPath: string, config: BotConfig): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function createDefaultConfigFile(configPath: string): void {
  writeConfigFile(configPath, defaultBotConfig);
}

function createBackupConfigFile(configPath: string, contents: string): void {
  const { dir, ext, name } = path.parse(configPath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  let backupPath = path.join(dir, `${name}.bak.${timestamp}${ext}`);
  let index = 1;

  while (fs.existsSync(backupPath)) {
    backupPath = path.join(dir, `${name}.bak.${timestamp}.${index}${ext}`);
    index++;
  }

  fs.writeFileSync(backupPath, contents, 'utf8');
}

function readConfigFile(configPath: string): LoadedConfigFile {
  if (!fs.existsSync(configPath)) createDefaultConfigFile(configPath);

  const contents = fs.readFileSync(configPath, 'utf8');
  try {
    const config = JSON.parse(contents) as unknown;
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('root must be an object');
    }
    return { config: config as ConfigFile, contents };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load bot configuration from ${configPath}: ${message}`);
  }
}

function normalizeConfig(config: ConfigFile): NormalizedConfig {
  let hasInvalidField = false;
  let needsWrite = false;

  function valueOrDefault<T>(value: unknown, validator: (value: unknown) => value is T, fallback: T): T {
    if (value === undefined) {
      needsWrite = true;
      return fallback;
    }
    if (!validator(value)) {
      hasInvalidField = true;
      needsWrite = true;
      return fallback;
    }
    return value;
  }

  return {
    config: {
      userAgent: valueOrDefault(config.userAgent, isString, defaultBotConfig.userAgent),
      logLevel: valueOrDefault(config.logLevel, isLogLevel, defaultBotConfig.logLevel),
      chromePath: valueOrDefault(config.chromePath, isString, defaultBotConfig.chromePath),
      httpUrl: valueOrDefault(config.httpUrl, isString, defaultBotConfig.httpUrl),
      wsUrl: valueOrDefault(config.wsUrl, isString, defaultBotConfig.wsUrl),
      tokenParams: valueOrDefault(config.tokenParams, isString, defaultBotConfig.tokenParams),
      wsToken: valueOrDefault(config.wsToken, isString, defaultBotConfig.wsToken),
      httpToken: valueOrDefault(config.httpToken, isString, defaultBotConfig.httpToken),
      githubPort: valueOrDefault(config.githubPort, isPort, defaultBotConfig.githubPort),
      githubAllowedRepositories: valueOrDefault(
        config.githubAllowedRepositories,
        isRepositoryPatternArray,
        defaultBotConfig.githubAllowedRepositories
      )
    },
    hasInvalidField,
    needsWrite
  };
}

export function loadBotConfig(configPath: string = path.resolve(process.cwd(), 'configs', 'bot-config.json')): BotConfig {
  const loadedConfig = readConfigFile(configPath);
  const normalizedConfig = normalizeConfig(loadedConfig.config);

  if (normalizedConfig.hasInvalidField) createBackupConfigFile(configPath, loadedConfig.contents);
  if (normalizedConfig.needsWrite) writeConfigFile(configPath, normalizedConfig.config);

  loadedConfigPath = configPath;
  return normalizedConfig.config;
}

/** 生效配置的加载路径，写回配置时复用（由 loadBotConfig 记录） */
let loadedConfigPath: string = path.resolve(process.cwd(), 'configs', 'bot-config.json');

export const botConfig = loadBotConfig();

/**
 * 把一个 GitHub 仓库或 owner 加入允许访问的仓库列表，并持久化到配置文件。
 *
 * 动机：管理员通过 /github allow 或 /github subscribe 授权仓库时，无需手工改配置文件。
 * 传入 owner 时写入 `owner/*`（覆盖该 owner 下全部仓库，含后续新建的）；
 * 传入 owner/repo 时写入精确条目，只授权该仓库。
 *
 * @param target GitHub owner（如 Anvil-Dev）或仓库全名（如 Anvil-Dev/AnvilCraft）
 * @returns 实际写入的允许列表条目
 */
export function addGithubAllowedRepository(target: string): string {
  const pattern = target.includes('/') ? target : `${target}/*`;
  if (botConfig.githubAllowedRepositories.includes(pattern)) return pattern;
  botConfig.githubAllowedRepositories.push(pattern);
  writeConfigFile(loadedConfigPath, botConfig);
  return pattern;
}

/** 判断某条目是否已在允许列表中（不做任何写入） */
export function isGithubAllowedPattern(target: string): boolean {
  const pattern = target.includes('/') ? target : `${target}/*`;
  return botConfig.githubAllowedRepositories.includes(pattern);
}
