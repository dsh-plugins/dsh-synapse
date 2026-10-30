import axios, { AxiosResponse } from 'axios';
import { Message } from '@/type';
import { getFeatureGroups } from '@/config/features';
import { checkReleasedVersion, parseMavenLastUpdated } from '@/features/version-tracker';
import { QQBot } from '@/index';

export declare type ModrinthVersion = {
  success: boolean;
  latest: string;
  /** Maven <lastUpdated>（14 位 YYYYMMDDHHmmss）/ 13 位毫秒时间戳 / ISO，解析为毫秒；无则 0 */
  lastUpdated: number;
};

export class ModrinthAPI {
  public static async getModVersion(slug: string): Promise<ModrinthVersion> {
    try {
      const res: AxiosResponse<string> = await axios.get(
        `https://api.modrinth.com/maven/maven/modrinth/${slug}/maven-metadata.xml`
      );
      const xml = res.data;

      // Parse XML to extract latest version
      const latestMatch = xml.match(/<latest>(.*?)<\/latest>/);
      if (!latestMatch || !latestMatch[1]) {
        return {
          success: false,
          latest: '',
          lastUpdated: 0
        };
      }

      // Parse <lastUpdated>（标准 Maven 元数据时间戳，单调递增）
      const lastUpdatedMatch = xml.match(/<lastUpdated>(.*?)<\/lastUpdated>/);

      return {
        success: true,
        latest: latestMatch[1],
        lastUpdated: parseMavenLastUpdated(lastUpdatedMatch?.[1] || '')
      };
    } catch (_) {
      return {
        success: false,
        latest: '',
        lastUpdated: 0
      };
    }
  }

  public static checkVersion(bot: QQBot, slug: string, name: string) {
    ModrinthAPI.getModVersion(slug).then(version => {
      if (!version.success) return;
      // 用 Maven lastUpdated 时间戳单调性判断新发布，避免 CDN 缓存抖动重复发送
      checkReleasedVersion(`modrinth:${slug}`, version.latest, version.lastUpdated).then((shouldNotify: boolean) => {
        if (!shouldNotify) return;
        const msg: Message[] = [
          {
            type: 'text',
            data: {
              text: `${name}更新了！
· 最新版本：${version.latest}
· 下载直链：https://api.modrinth.com/maven/maven/modrinth/${slug}/${version.latest}/${slug}-${version.latest}.jar`
            }
          }
        ];
        for (const listener of getFeatureGroups('modrinth')) {
          bot.sendGroupMsg(listener, msg);
        }
      });
    });
  }
}
