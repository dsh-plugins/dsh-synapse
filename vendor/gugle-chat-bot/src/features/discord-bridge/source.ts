import { Message as DiscordMessage, PermissionFlagsBits } from 'discord.js';
import { BotCommandSource } from '@/command';
import { isDiscordOperator } from '@/config/features';
import { QQBot } from '@/index';

const DISCORD_MESSAGE_LIMIT = 2000;

/**
 * Discord 侧管理员判定：服务器拥有者、拥有「管理服务器」/「管理员」权限的成员，
 * 或 management.json 里 `discordOperators` 白名单中的用户。
 * 命令源（DiscordMsgCommandSource）与 Hermes AI（审批/技能门控）共用同一口径。
 */
export function isDiscordAdmin(message: DiscordMessage): boolean {
  if (isDiscordOperator(message.author.id)) return true;
  if (message.guild?.ownerId === message.author.id) return true;
  const permissions = message.member?.permissions;
  if (!permissions) return false;
  return permissions.has(PermissionFlagsBits.Administrator) || permissions.has(PermissionFlagsBits.ManageGuild);
}

/**
 * Discord 频道命令源：让 gugle-command 已注册的全部命令都能在 Discord 频道中执行，
 * 命令回复（success/fail）以 Discord 回复的形式发回原频道。
 *
 * 身份与权限映射：
 * - getUserId() 返回 `dc:<Discord用户ID>`（`dc:` 前缀保证与纯数字 QQ 号不冲突，
 *   GitHub 绑定等按用户持久化的数据可安全共用同一套存储）；
 * - getGroupId() 返回该频道桥接配置里的 QQ 群号（订阅类命令作用于对应 QQ 群）；
 * - isAdmin() / hasPermission()：服务器拥有者视为 owner（2），
 *   拥有「管理服务器」或「管理员」权限的成员视为 admin（1），其余为 0。
 */
export class DiscordMsgCommandSource implements BotCommandSource {
  private readonly bot: QQBot;
  private readonly message: DiscordMessage;
  private readonly groupId: number | undefined;

  public constructor(bot: QQBot, message: DiscordMessage, groupId?: number) {
    this.bot = bot;
    this.message = message;
    this.groupId = groupId;
  }

  public getUserId(): string {
    return `dc:${this.message.author.id}`;
  }

  public getGroupId(): number | undefined {
    return this.groupId;
  }

  public isAdmin(): boolean {
    return isDiscordAdmin(this.message);
  }

  public success(message: string): void {
    this.reply(message);
  }

  public fail(message: string): void {
    this.reply(message);
    this.bot.logger?.error(`[Discord:${this.message.author.username}] ${message}: ${this.message.content}`);
  }

  public getName(): string {
    return this.message.member?.displayName ?? this.message.author.username;
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
    const isOwner = this.message.guild?.ownerId === this.message.author.id;
    const permissionLevel = isOwner ? 2 : this.isAdmin() ? 1 : 0;
    return permissionLevel >= getPermissionLevel(permission);
  }

  /** 命令回复发在 Discord 频道（回复原消息，不 @ 人，超长截断） */
  private reply(content: string): void {
    const text =
      content.length <= DISCORD_MESSAGE_LIMIT
        ? content
        : `${content.slice(0, DISCORD_MESSAGE_LIMIT - 16)}\n…（消息过长已截断）`;
    this.message
      .reply({ content: text, allowedMentions: { parse: [], repliedUser: false } })
      .catch(error => {
        this.bot.logger?.error(
          `[DiscordBridge] Discord 命令回复失败: ${error instanceof Error ? error.message : String(error)}`
        );
      });
  }
}
