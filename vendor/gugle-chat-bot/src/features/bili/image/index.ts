import { QQBot } from '@/index';
import { ViewData } from '@/type/bili';
import { Logger } from 'winston';
import { videoHandler } from '@/features/bili/image/impl/video';

const B64_IMG_PREFIX = 'data:image/jpg;base64,';

export class BiliImage {
  public static videoHandler(bot: QQBot, viewData: ViewData, logger?: Logger): Promise<string> {
    return videoHandler(bot, viewData, logger);
  }
}

export function getPicB64(bot: QQBot, url: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    bot.axiosInstance
      .get(url, { responseType: 'arraybuffer' })
      .then(res => resolve(B64_IMG_PREFIX + Buffer.from(res.data, 'binary').toString('base64')))
      .catch(reject);
  });
}

export function convertDuration(duration: number): string {
  const hour = Math.floor(duration / 3600);
  const min = Math.floor((duration % 3600) / 60);
  const sec = Math.floor(duration % 60);
  if (hour > 0) return `${hour}:${min}:${sec}`;
  if (min > 0) return `${min}:${sec}`;
  return `${sec}秒`;
}

export function convertStat(stat: number) {
  if (Math.floor(stat / 10000) > 0) {
    return `${Math.floor(stat / 10000)}.${Math.floor((stat % 10000) / 1000)}万`;
  }
  return `${stat}`;
}
