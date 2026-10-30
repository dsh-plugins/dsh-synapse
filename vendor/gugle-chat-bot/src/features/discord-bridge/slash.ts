import {
  ApplicationCommandOptionType,
  ChatInputCommandInteraction,
  Client,
  PermissionFlagsBits,
  SlashCommandBuilder,
  SlashCommandSubcommandBuilder
} from 'discord.js';
import { Arguments, CommandManager, CommandNode } from 'gugle-command';
import { BotCommandSource, executeCommandTokens } from '@/command';
import { isDiscordOperator } from '@/config/features';
import { QQBot } from '@/index';

/**
 * Discord 原生斜杠命令：把 gugle-command 已注册的命令树转换为 Discord application
 * commands（guild 级注册，即时生效），交互经 token 精确回放交给同一套命令实现。
 *
 * 映射规则：
 * - 根字面量（help/mcv/server/...）→ 顶命令；其二层字面量（github→bind 等）→ 子命令；
 * - 参数节点 → options，类型按 decode 识别（NUMBER→Number、BOOLEAN→Boolean、其余 String）；
 * - 必填规则：参数节点的祖先（到父节点为止）都没有 exec 则必填，否则选填
 *   （/server <ip> [port]：ip 必填、port 选填，天然保证必填在选填之前）；
 * - 字面量与参数混排、三层以上字面量嵌套不支持（当前命令树无此情况，出现时告警跳过）。
 *
 * 前置条件：bot 邀请链接需包含 applications.commands 权限范围（否则注册报错并告警）。
 */

/** option 规格（交互时按声明顺序回放 token 用） */
export interface SlashOptionSpec {
  /** 小写 option 名 */
  name: string;
  type: ApplicationCommandOptionType.String | ApplicationCommandOptionType.Number | ApplicationCommandOptionType.Boolean;
  required: boolean;
}

/** 命令规格：一个顶命令或一个子命令 */
export interface SlashCommandSpec {
  name: string;
  subcommand?: string;
  options: SlashOptionSpec[];
}

export interface BuiltSlashCommands {
  builders: SlashCommandBuilder[];
  specs: SlashCommandSpec[];
}

/** 命令/参数描述（Discord 必填项；未收录时回退通用文案） */
const DESCRIPTIONS: Record<string, string> = {
  help: '帮助',
  mcv: '获取 Minecraft 版本信息',
  server: '获取 Minecraft 服务器状态',
  wiki: '搜索 Minecraft 维基',
  github: 'GitHub 绑定/订阅/授权',
  pardon: '把用户移出黑名单（管理员）',
  reload: '重载配置与数据文件（管理员）',
  reboot: '重启应用（管理员）',
  shutdown: '关闭应用（管理员）',
  pvtime: '查询当前是梁文峰时间还是梁文谷时间',
  bind: '绑定 GitHub 用户名',
  subscribe: '订阅仓库消息推送',
  allow: '授权仓库访问（管理员）',
  ip: '服务器地址',
  port: '端口',
  query: '搜索词',
  username: 'GitHub 用户名',
  repository: 'owner/repo',
  target: 'owner 或 owner/repo',
  userid: 'QQ 号'
};

function describe(name: string): string {
  return DESCRIPTIONS[name] ?? `参数 ${name}`;
}

/** Discord chat-input 名称约束：小写字母数字 _ -，1-32 字符 */
const DISCORD_NAME_RE = /^[a-z0-9_-]{1,32}$/;

/** 参数节点 → option 名（`<userId>` → `userid`） */
function optionName(node: CommandNode): string {
  const raw = node.toString().replace(/^<(.+)>$/, '$1');
  return raw.toLowerCase();
}

/** 参数节点 → option 类型（按构造时存入的 decorator 身份识别） */
function optionType(node: CommandNode): SlashOptionSpec['type'] {
  const decorator = (node as unknown as { decorator?: unknown }).decorator;
  if (decorator === Arguments.NUMBER) return ApplicationCommandOptionType.Number;
  if (decorator === Arguments.BOOLEAN) return ApplicationCommandOptionType.Boolean;
  return ApplicationCommandOptionType.String;
}

/**
 * 收集节点的参数链（沿第一个参数子节点下行）。
 * 必填规则：祖先（rootLiteral 到父节点）都没有 exec 则必填。
 */
function collectOptions(rootLiteral: CommandNode, warn: (msg: string) => void): SlashOptionSpec[] {
  const options: SlashOptionSpec[] = [];
  let ancestorHasExec = rootLiteral.exec !== undefined;
  let current: CommandNode = rootLiteral;
  for (;;) {
    const literals = current.children.filter(child => child.isLiteral());
    const args = current.children.filter(child => !child.isLiteral());
    if (args.length === 0) return options;
    if (literals.length > 0) {
      warn(`参数链中出现字面量分支（${rootLiteral.toString()}），斜杠命令不支持，已截断`);
      return options;
    }
    if (args.length > 1) {
      warn(`同一层级有多个参数节点（${rootLiteral.toString()}），只取第一个`);
    }
    const arg = args[0]!;
    const required = !ancestorHasExec;
    options.push({ name: optionName(arg), type: optionType(arg), required });
    ancestorHasExec = ancestorHasExec || arg.exec !== undefined;
    current = arg;
  }
}

function applyOptions(
  target: SlashCommandBuilder | SlashCommandSubcommandBuilder,
  options: SlashOptionSpec[]
): void {
  for (const option of options) {
    if (option.type === ApplicationCommandOptionType.Number) {
      target.addNumberOption(builder =>
        builder.setName(option.name).setDescription(describe(option.name)).setRequired(option.required)
      );
    } else if (option.type === ApplicationCommandOptionType.Boolean) {
      target.addBooleanOption(builder =>
        builder.setName(option.name).setDescription(describe(option.name)).setRequired(option.required)
      );
    } else {
      target.addStringOption(builder =>
        builder.setName(option.name).setDescription(describe(option.name)).setRequired(option.required)
      );
    }
  }
}

let cachedSpecs: SlashCommandSpec[] = [];

/** 把 gugle-command 命令树转换为 Discord 斜杠命令构建器与回放规格 */
export function buildSlashCommands(manager: CommandManager, warn: (msg: string) => void = () => undefined): BuiltSlashCommands {
  const builders: SlashCommandBuilder[] = [];
  const specs: SlashCommandSpec[] = [];

  for (const root of manager.roots.values()) {
    for (const literal of root.children) {
      if (!literal.isLiteral()) continue;
      const name = literal.toString();
      if (!DISCORD_NAME_RE.test(name)) {
        warn(`命令名 ${name} 不符合 Discord 命名约束，已跳过`);
        continue;
      }

      const literalChildren = literal.children.filter(child => child.isLiteral());
      const argumentChildren = literal.children.filter(child => !child.isLiteral());
      const builder = new SlashCommandBuilder().setName(name).setDescription(describe(name));

      if (literalChildren.length > 0 && argumentChildren.length > 0) {
        warn(`命令 ${name} 字面量与参数混排，斜杠命令不支持，已跳过`);
        continue;
      }

      if (literalChildren.length > 0) {
        // 二层字面量 → 子命令
        for (const sub of literalChildren) {
          const subName = sub.toString();
          if (!DISCORD_NAME_RE.test(subName)) {
            warn(`子命令名 ${name} ${subName} 不符合 Discord 命名约束，已跳过`);
            continue;
          }
          if (sub.children.some(child => child.isLiteral())) {
            warn(`命令 ${name} ${subName} 存在三层嵌套，斜杠命令不支持，已跳过`);
            continue;
          }
          const options = collectOptions(sub, warn);
          builder.addSubcommand(subBuilder => {
            subBuilder.setName(subName).setDescription(describe(subName));
            applyOptions(subBuilder, options);
            return subBuilder;
          });
          specs.push({ name, subcommand: subName, options });
        }
      } else {
        const options = collectOptions(literal, warn);
        applyOptions(builder, options);
        specs.push({ name, options });
      }

      builders.push(builder);
    }
  }

  cachedSpecs = specs;
  return { builders, specs };
}

/**
 * 对 bridges 配置去重后的每个 guild 注册斜杠命令（guild 级，即时生效）。
 * 配置热重载新增的 guild 需重启后才会注册。
 */
export async function registerSlashCommands(client: Client<true>, guildIds: string[], bot: QQBot): Promise<void> {
  const { builders } = buildSlashCommands(bot.getCommandManager(), msg => bot.logger?.warn(`[DiscordBridge] ${msg}`));
  if (builders.length === 0) return;
  for (const guildId of guildIds) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      bot.logger?.warn(`[DiscordBridge] 注册斜杠命令：未找到服务器 ${guildId}`);
      continue;
    }
    try {
      await guild.commands.set(builders);
      bot.logger?.info(`[DiscordBridge] 已在 ${guild.name} 注册 ${builders.length} 个斜杠命令`);
    } catch (error) {
      bot.logger?.error(
        `[DiscordBridge] 注册斜杠命令失败（${guild.name}）: ${error instanceof Error ? error.message : String(error)}` +
          `。请确认 bot 邀请链接包含 applications.commands 权限范围（需在开发者后台重新生成邀请并授权）`
      );
    }
  }
}

/**
 * Discord 交互命令源：回复经 interaction 的 deferReply → editReply/followUp 完成。
 * 身份与权限映射与 DiscordMsgCommandSource 一致（dc: 前缀用户标识、服务器权限即管理员）。
 */
export class DiscordInteractionCommandSource implements BotCommandSource {
  private readonly bot: QQBot;
  private readonly interaction: ChatInputCommandInteraction;
  private readonly groupId: number | undefined;
  private responded = false;

  public constructor(bot: QQBot, interaction: ChatInputCommandInteraction, groupId?: number) {
    this.bot = bot;
    this.interaction = interaction;
    this.groupId = groupId;
  }

  public getUserId(): string {
    return `dc:${this.interaction.user.id}`;
  }

  public getGroupId(): number | undefined {
    return this.groupId;
  }

  public isAdmin(): boolean {
    if (isDiscordOperator(this.interaction.user.id)) return true;
    if (this.interaction.guild?.ownerId === this.interaction.user.id) return true;
    const permissions = this.interaction.memberPermissions;
    if (!permissions) return false;
    return permissions.has(PermissionFlagsBits.Administrator) || permissions.has(PermissionFlagsBits.ManageGuild);
  }

  /** 立即 deferReply（交互 3 秒时限），后续 success/fail 用 editReply/followUp */
  public async defer(): Promise<void> {
    await this.interaction.deferReply().catch(error => {
      this.bot.logger?.error(
        `[DiscordBridge] 交互 deferReply 失败: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }

  public success(message: string): void {
    this.reply(message);
  }

  public fail(message: string): void {
    this.reply(message);
    this.bot.logger?.error(
      `[Discord:${this.interaction.user.username}] ${message}: /${this.interaction.commandName}`
    );
  }

  public getName(): string {
    return this.interaction.user.displayName ?? this.interaction.user.username;
  }

  public hasPermission(permission: string): boolean {
    if (!permission) return true;
    const getPermissionLevel = (text: string): number => {
      const level = Number.parseInt(text);
      if (Number.isNaN(level)) {
        return text === 'owner' ? 2 : text === 'admin' ? 1 : 0;
      }
      return level;
    };
    const isOwner = this.interaction.guild?.ownerId === this.interaction.user.id;
    const permissionLevel = isOwner ? 2 : this.isAdmin() ? 1 : 0;
    return permissionLevel >= getPermissionLevel(permission);
  }

  /** 首次回复 editReply，其后 followUp；2000 字截断 */
  private reply(message: string): void {
    const content = message.length <= 2000 ? message : `${message.slice(0, 1984)}\n…（消息过长已截断）`;
    if (!this.responded) {
      this.responded = true;
      this.interaction.editReply({ content }).catch(error => {
        this.bot.logger?.error(
          `[DiscordBridge] 交互回复失败: ${error instanceof Error ? error.message : String(error)}`
        );
      });
      return;
    }
    this.interaction.followUp({ content }).catch(error => {
      this.bot.logger?.error(
        `[DiscordBridge] 交互 followUp 失败: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }
}

/**
 * 斜杠命令交互分发：把 option 值按声明顺序回放为精确 token（不经字符串切分，
 * 带空格的字符串参数保持完整），交给 gugle-command 执行。
 *
 * @param resolveGroupId 由 DiscordBridge 注入的频道 → 桥接 QQ 群解析
 */
export async function handleSlashInteraction(
  bot: QQBot,
  interaction: ChatInputCommandInteraction,
  resolveGroupId: (guildId: string, channelName: string | undefined) => number | undefined
): Promise<void> {
  if (!interaction.guildId) return;
  const specs = cachedSpecs.length > 0 ? cachedSpecs : buildSlashCommands(bot.getCommandManager()).specs;
  const subcommand = interaction.options.getSubcommand(false) ?? undefined;
  const spec = specs.find(item => item.name === interaction.commandName && item.subcommand === subcommand);
  if (!spec) {
    await interaction.reply({ content: '未知命令（可能刚更新，请稍后重试）', ephemeral: true }).catch(() => undefined);
    return;
  }

  // 按声明顺序回放 token；可选参数缺失即截断（位置参数必须连续）
  const tokens = [spec.name];
  if (spec.subcommand) tokens.push(spec.subcommand);
  for (const option of spec.options) {
    const value = interaction.options.get(option.name)?.value;
    if (value === undefined || value === null) break;
    tokens.push(String(value));
  }

  const channel = interaction.channel;
  const channelName = channel && 'name' in channel ? (channel.name ?? undefined) : undefined;
  const source = new DiscordInteractionCommandSource(bot, interaction, resolveGroupId(interaction.guildId, channelName));
  await source.defer();
  try {
    executeCommandTokens(bot.getCommandManager(), source, tokens);
  } catch (error) {
    bot.logger?.error(
      `[DiscordBridge] 斜杠命令执行失败: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
    );
  }
}
