import * as fs from 'node:fs';
import { readOrCreate } from '@/config/manager';

export class EventDataManager {
  private static readonly FILE: string = './configs/event-data.json';
  private static readonly LEGACY_FILE: string = './config/event-data.json';
  private static readonly LEGACY_DIRECTORY: string = './config';
  private static listeners: {
    [key: string]: { roomId: string; channelId: string }[];
  } = {};

  private static storage: {
    [key: string]: {
      [key: string]: any;
    };
  } = {};

  static {
    EventDataManager.load().then();
  }

  public static async addListener(event: string, roomId: string, channelId: string): Promise<void> {
    if (!EventDataManager.listeners[event]) EventDataManager.listeners[event] = [];
    EventDataManager.listeners[event].push({ roomId, channelId });
    await EventDataManager.save();
  }

  public static async containListener(event: string, roomId: string, channelId: string): Promise<boolean> {
    if (!EventDataManager.listeners[event]) return false;
    return EventDataManager.listeners[event].some(
      listener => listener.roomId === roomId && listener.channelId === channelId
    );
  }

  public static async removeListener(event: string, roomId: string, channelId: string): Promise<void> {
    if (!EventDataManager.listeners[event]) return;
    EventDataManager.listeners[event] = EventDataManager.listeners[event].filter(
      listener => listener.roomId !== roomId && listener.channelId !== channelId
    );
    await EventDataManager.save();
  }

  public static async getListeners(event: string): Promise<{ roomId: string; channelId: string }[]> {
    return EventDataManager.listeners[event] || [];
  }

  public static async setStorage(event: string, key: string, value: any): Promise<void> {
    if (!EventDataManager.storage[event]) EventDataManager.storage[event] = {};
    EventDataManager.storage[event][key] = value;
    await EventDataManager.save();
  }

  public static async getStorage(event: string, key: string): Promise<any> {
    if (!EventDataManager.storage[event]) return undefined;
    return EventDataManager.storage[event][key];
  }

  public static async clearStorage(event: string): Promise<void> {
    delete EventDataManager.storage[event];
    await EventDataManager.save();
  }

  /**
   * 从磁盘重新加载事件数据（/reload 用）。
   * 现有 storage 会被磁盘内容覆盖，因此同时清空已删除的键。
   */
  public static async reload(): Promise<void> {
    EventDataManager.listeners = {};
    EventDataManager.storage = {};
    await EventDataManager.load();
  }

  private static migrateLegacyFile(): void {
    if (!fs.existsSync(EventDataManager.LEGACY_DIRECTORY)) return;

    fs.mkdirSync('./configs', { recursive: true });
    if (fs.existsSync(EventDataManager.LEGACY_FILE) && !fs.existsSync(EventDataManager.FILE)) {
      fs.renameSync(EventDataManager.LEGACY_FILE, EventDataManager.FILE);
    }
    fs.rmSync(EventDataManager.LEGACY_DIRECTORY, { recursive: true, force: true });
  }

  public static async checkAndCreateFile(): Promise<void> {
    EventDataManager.migrateLegacyFile();
    readOrCreate<{ listeners: Record<string, never>; storage: Record<string, never> }>({
      path: EventDataManager.FILE,
      factory: () => ({ listeners: {}, storage: {} })
    });
  }

  public static async load(): Promise<void> {
    await EventDataManager.checkAndCreateFile();
    const data = readOrCreate<{
      listeners?: Record<string, { roomId: string; channelId: string }[]>;
      storage?: Record<string, Record<string, unknown>>;
    }>({
      path: EventDataManager.FILE,
      factory: () => ({ listeners: {}, storage: {} })
    }).data;
    EventDataManager.listeners = {
      ...EventDataManager.listeners,
      ...(data.listeners || {})
    };
    EventDataManager.storage = {
      ...EventDataManager.storage,
      ...(data.storage || {})
    };
  }

  public static async save(): Promise<void> {
    await EventDataManager.checkAndCreateFile();
    const { writeConfigFile } = await import('@/config/manager');
    writeConfigFile(EventDataManager.FILE, {
      listeners: EventDataManager.listeners,
      storage: EventDataManager.storage
    });
  }
}
