import fs from 'node:fs';
import path from 'node:path';
import { HistoryEntry } from '@/features/hermes/types';

/**
 * 聊天记录持久化存储（移植自 qq-hermes-bridge src/history.ts，MIT 协议，原作者 Amorter）。
 * 每个会话以 JSON 文件形式存储在 data/hermes-history/，最多保留 N 条消息，
 * 进程重启后自动恢复。
 */
export class ChatHistoryStore {
  private readonly dir: string;
  private readonly maxMessages: number;
  private readonly enabled: boolean;

  /** 内存缓存：key → 历史消息数组 */
  private readonly cache = new Map<string, HistoryEntry[]>();

  /**
   * @param maxMessages 每个会话最多保留的消息条数
   * @param enabled 是否启用持久化
   */
  public constructor(maxMessages: number, enabled: boolean) {
    this.dir = path.resolve(process.cwd(), 'data', 'hermes-history');
    this.maxMessages = maxMessages;
    this.enabled = enabled;
    if (enabled) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  /**
   * 加载会话历史。
   * 优先从内存缓存读取，缓存未命中时从磁盘加载。
   */
  public load(key: string): HistoryEntry[] {
    if (!this.enabled) return [];
    if (this.cache.has(key)) return this.cache.get(key)!;

    try {
      const filePath = this.filePath(key);
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as HistoryEntry[];
        if (Array.isArray(data)) {
          this.cache.set(key, data);
          return data;
        }
      }
    } catch {
      // 文件损坏或格式错误，忽略
    }
    return [];
  }

  /**
   * 保存会话历史。
   * 自动裁剪到 maxMessages 条，先写内存缓存再落盘。
   */
  public save(key: string, history: HistoryEntry[]): void {
    if (!this.enabled) return;
    const trimmed = history.slice(-this.maxMessages);
    this.cache.set(key, trimmed);
    try {
      fs.writeFileSync(this.filePath(key), JSON.stringify(trimmed, null, 2), 'utf-8');
    } catch {
      // 写入失败不阻塞主流程（磁盘满等极端情况）
    }
  }

  /** 清除会话的持久化历史 */
  public clear(key: string): void {
    if (!this.enabled) return;
    this.cache.delete(key);
    try {
      const filePath = this.filePath(key);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      // 忽略
    }
  }

  /** 根据会话键生成安全的文件名（group:123456 → group_123456.json） */
  private filePath(key: string): string {
    const safe = key.replace(/[<>:"/\\|?*]/g, '_');
    return path.join(this.dir, `${safe}.json`);
  }
}
