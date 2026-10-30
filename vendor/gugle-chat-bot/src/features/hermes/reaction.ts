import fs from 'node:fs';
import path from 'node:path';
import { QQBot } from '@/index';
import { getHermesConfig } from '@/features/hermes/config';
import { writeConfigFile } from '@/config/manager';

/**
 * AI「处理中」表情回应管理。
 *
 * 用户消息触发 Hermes 运行时，给触发消息贴上表情回应（QQ 走 NapCat
 * set_msg_emoji_like，Discord 走 message.react）；完整回复完成（含查询技能的
 * 回喂轮）后摘除。
 *
 * 记录立即持久化到 data/hermes-reactions.json：若回应期间进程重启/宕机，
 * 下次启动时按残留记录逐条摘除并清空（cleanupQQ 由 after-start 钩子调用，
 * Discord 残留由 DiscordBridge 在 clientReady 后调用 listDiscord/drop 处理），
 * 避免「处理中」表情永久残留。
 */

/** 一条待摘除的表情回应记录 */
export interface PendingReaction {
  /** 唯一键：`qq:{messageId}` / `discord:{channelId}:{messageId}` */
  key: string;
  platform: 'qq' | 'discord';
  /** QQ: OneBot message_id 字符串；Discord: 消息 snowflake */
  messageId: string;
  /** Discord 频道 snowflake（QQ 记录无此字段） */
  channelId?: string;
  /** QQ: emoji_id；Discord: unicode emoji */
  emoji: string;
  createdAt: number;
}

interface ReactionStoreFile {
  version: number;
  reactions: PendingReaction[];
}

export class ReactionManager {
  private static instance?: ReactionManager;

  public static getInstance(): ReactionManager {
    if (!ReactionManager.instance) ReactionManager.instance = new ReactionManager();
    return ReactionManager.instance;
  }

  private readonly file = path.resolve(process.cwd(), 'data', 'hermes-reactions.json');
  private readonly records = new Map<string, PendingReaction>();
  private loaded = false;

  private constructor() {}

  /** 懒加载持久化记录（损坏按空处理） */
  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as ReactionStoreFile;
      if (!Array.isArray(raw?.reactions)) return;
      for (const record of raw.reactions) {
        if (record && typeof record.key === 'string' && typeof record.messageId === 'string') {
          this.records.set(record.key, record);
        }
      }
    } catch {
      // 文件损坏或格式错误，按空记录处理
    }
  }

  /** 立即落盘（原子写，复用 config/manager 的 writeConfigFile） */
  private persist(): void {
    try {
      writeConfigFile(this.file, { version: 1, reactions: [...this.records.values()] } satisfies ReactionStoreFile);
    } catch {
      // 持久化失败不阻塞主流程
    }
  }

  /**
   * QQ：给消息贴「处理中」表情，成功后立即持久化记录并返回记录键。
   * 返回 null 表示没贴上（功能关闭或 NapCat 拒绝，例如私聊消息通常不支持表情回应），
   * 调用方据此决定是否改用文字回执；具体原因写入日志便于排查。
   */
  public async addQQ(bot: QQBot, messageId: number): Promise<string | null> {
    const config = getHermesConfig();
    if (!config.reactionEnabled) {
      bot.logger?.debug(`[Hermes] 表情回应已关闭，跳过（message ${messageId}）`);
      return null;
    }
    try {
      await bot.axiosInstance.post('/set_msg_emoji_like', {
        message_id: messageId,
        emoji_id: config.reactionEmojiQq,
        set: true
      });
    } catch (error) {
      bot.logger?.warn(
        `[Hermes] 表情回应失败（message ${messageId}）: ${(error as Error).message}` +
          `；NapCat 对私聊消息通常不支持 set_msg_emoji_like`
      );
      return null;
    }
    const key = `qq:${messageId}`;
    this.load();
    this.records.set(key, {
      key,
      platform: 'qq',
      messageId: String(messageId),
      emoji: config.reactionEmojiQq,
      createdAt: Date.now()
    });
    this.persist();
    return key;
  }

  /**
   * Discord：message.react 成功后调用，立即持久化记录并返回记录键。
   */
  public persistDiscord(channelId: string, messageId: string, emoji: string): string {
    const key = `discord:${channelId}:${messageId}`;
    this.load();
    this.records.set(key, { key, platform: 'discord', messageId, channelId, emoji, createdAt: Date.now() });
    this.persist();
    return key;
  }

  /**
   * QQ：摘除表情（set=false）。无论摘除成败都移除持久化记录
   * （失败多为消息已被撤回等不可重试原因，残留记录只会在下次启动时再次失败）。
   */
  public async removeQQ(bot: QQBot | undefined, key: string): Promise<void> {
    this.load();
    const record = this.records.get(key);
    if (this.records.delete(key)) this.persist();
    if (!record || !bot) return;
    try {
      await bot.axiosInstance.post('/set_msg_emoji_like', {
        message_id: Number(record.messageId),
        emoji_id: record.emoji,
        set: false
      });
    } catch (error) {
      bot.logger?.warn(`[Hermes] 摘除表情回应失败（${key}）: ${(error as Error).message}`);
    }
  }

  /** 移除一条记录（Discord 摘除动作由调用方完成后调用） */
  public drop(key: string): void {
    this.load();
    if (this.records.delete(key)) this.persist();
  }

  /** 全部残留的 Discord 记录（启动清理用，摘除后逐条 drop） */
  public listDiscord(): PendingReaction[] {
    this.load();
    return [...this.records.values()].filter(record => record.platform === 'discord');
  }

  /** 启动清理：摘除全部残留的 QQ 表情回应并清空对应记录 */
  public async cleanupQQ(bot: QQBot): Promise<void> {
    this.load();
    const stale = [...this.records.values()].filter(record => record.platform === 'qq');
    for (const record of stale) {
      try {
        await bot.axiosInstance.post('/set_msg_emoji_like', {
          message_id: Number(record.messageId),
          emoji_id: record.emoji,
          set: false
        });
      } catch {
        // 消息已撤回/不存在等：放弃摘除，仅清理记录
      }
      this.records.delete(record.key);
    }
    if (stale.length > 0) {
      this.persist();
      bot.logger?.info(`[Hermes] 已清理 ${stale.length} 条残留的 QQ 表情回应`);
    }
  }
}
