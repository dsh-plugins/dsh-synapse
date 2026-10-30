import { EventDataManager } from '@/event';

/**
 * 版本发布的时间戳单调性跟踪器。
 *
 * 背景：Minecraft / Modrinth 的版本清单接口经过 CDN 缓存，缓存刷新不是
 * 全量原子的，同一"最新版本"可能在几次请求间反复出现/消失（例如
 * 1.21.10 → 1.21.9 → 1.21.10）。若只按"值变化即发送"会重复通知。
 *
 * 方案：利用各数据源自带的权威时间戳判断新版本，而不是观察窗口——
 * - Minecraft version_manifest_v2.json 的 versions[].releaseTime：各版本
 *   发布时间恒定，CDN 只缓存真实数据，同一版本号的时间戳永远不变。
 * - Modrinth Maven maven-metadata.xml 的 <lastUpdated>：metadata 文件更新
 *   时间，单调递增（只有发布新版本才更新）；CDN 回退返回的旧缓存其
 *   lastUpdated 必然更小。
 *
 * 因此记录"已确认版本 + 时间戳"：仅当观察到的时间戳严格晚于已记录值
 * 才判定为新发布并通知。CDN 抖动期间版本号来回跳动，但时间戳不会往前
 * 跳——旧缓存时间戳更小，自然不触发通知。
 */

export interface ReleasedVersionState {
  version: string;
  /** 权威发布时间（毫秒时间戳）：Minecraft 用 releaseTime，Modrinth 用 lastUpdated */
  timestamp: number;
}

/**
 * 检查一个版本是否为新发布、需要通知。
 *
 * @param storageKey EventDataManager storage 键（各资源独立，如 mcupdate:release / modrinth:sodium）
 * @param version    本次观察到的版本号（空串忽略）
 * @param timestamp  版本权威发布时间（毫秒）；0 或缺失时保守忽略（不误报）
 * @returns true = 该版本时间戳严格晚于已记录的版本，确认为新发布
 */
export async function checkReleasedVersion(storageKey: string, version: string, timestamp: number): Promise<boolean> {
  if (!version || !timestamp) return false;

  const last = (await EventDataManager.getStorage(storageKey, 'released')) as ReleasedVersionState | undefined;

  // 首次使用（冷启动 / 升级引入新键）：只记录当前版本，不通知，
  // 避免部署/重启后立即对既有版本轰炸；此后版本变化才正常通知。
  if (!last || !last.version) {
    await EventDataManager.setStorage(storageKey, 'released', { version, timestamp });
    return false;
  }

  // 已确认过的版本：忽略（永不重复通知）
  if (version === last.version) return false;

  // 时间戳严格更晚：真实新发布 → 记录并通知
  if (timestamp > last.timestamp) {
    await EventDataManager.setStorage(storageKey, 'released', { version, timestamp });
    return true;
  }

  // CDN 回退到更旧的数据（旧缓存时间戳更小）：忽略，不更新记录
  return false;
}

/**
 * 解析 Maven <lastUpdated> 为毫秒时间戳。
 * 兼容两种格式：标准 Maven 14 位 YYYYMMDDHHmmss，以及 13 位毫秒时间戳。
 * 无法解析时返回 0（调用方按"无时间戳"保守处理，不误报）。
 */
export function parseMavenLastUpdated(raw: string): number {
  const trimmed = (raw || '').trim();
  if (/^\d{14}$/.test(trimmed)) {
    const t = Date.parse(
      `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}T` +
        `${trimmed.slice(8, 10)}:${trimmed.slice(10, 12)}:${trimmed.slice(12, 14)}Z`
    );
    return Number.isNaN(t) ? 0 : t;
  }
  if (/^\d{13}$/.test(trimmed)) return parseInt(trimmed, 10);
  const t = Date.parse(trimmed);
  return Number.isNaN(t) ? 0 : t;
}