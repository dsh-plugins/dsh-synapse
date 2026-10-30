import { QQBot } from '@/index';
import { GroupMessageWSMSG, Message } from '@/type';
import { ViewData } from '@/type/bili';
import { BiliImage } from '@/features/bili/image';

const BV_REG_EXP = /^BV[a-zA-Z0-9]{10}$/;
const AV_REG_EXP = /^av(\d+)$/;
const B23_REG_EXP = /^(https:\/\/)?(b23.tv\/[a-zA-Z0-9]{7})$/;

export class Bili {
  public static processMessage(bot: QQBot, msg: GroupMessageWSMSG, sentMessage: Message[]): Promise<void> {
    const bv = msg.raw_message.match(BV_REG_EXP);
    if (bv) {
      return Bili.getVideoInfo(bot, msg, bv[0], sentMessage);
    }
    const av = msg.raw_message.match(AV_REG_EXP);
    if (av) {
      return Bili.getVideoInfo(bot, msg, av[0], sentMessage);
    }
    return Promise.resolve();
  }

  public static getVideoInfo(bot: QQBot, msg: GroupMessageWSMSG, vid: string, sentMessage: Message[]): Promise<void> {
    return Bili.renderVideoCard(bot, vid).then(result => {
      sentMessage.push({
        type: 'image',
        data: {
          file: `data:image/png;base64, ${result}`
        }
      });
    });
  }

  /**
   * 渲染视频信息卡片（供 AI 技能等程序化调用）：支持 BV 号 / av 号 / b23.tv 短链，
   * 返回 base64 图片；失败抛错由调用方统一处理。
   */
  public static async renderVideoCard(bot: QQBot, input: string): Promise<string> {
    let vid = input.trim();
    const shortLink = vid.match(B23_REG_EXP);
    if (shortLink) {
      // b23 短链：跟随 302 跳转，从最终 URL 提取 BV/av 号
      const url = `https://${shortLink[2]}`;
      const res = await bot.axiosInstance.get(url);
      const finalUrl: string = res.request?.res?.responseUrl ?? '';
      const resolved = finalUrl.match(/BV[a-zA-Z0-9]{10}/) ?? finalUrl.match(/av\d+/);
      if (!resolved) throw new Error(`无法从短链 ${shortLink[2]} 解析出视频`);
      vid = resolved[0];
    }
    if (!BV_REG_EXP.test(vid) && !AV_REG_EXP.test(vid)) {
      throw new Error(`无法识别的视频号：${input}（支持 BV 号 / av 号 / b23.tv 短链）`);
    }
    const params = vid.startsWith('BV') ? { bvid: vid } : { aid: vid.slice(2) };
    const res = await bot.axiosInstance.get<{ code: number; message: string; data: ViewData }>(
      'https://api.bilibili.com/x/web-interface/view',
      { params }
    );
    const { code, message, data } = res.data;
    // B 站业务错误（如 -412 请求被拦截、-404 视频不存在）抛错，由调用方统一处理
    if (code !== 0) {
      throw new Error(`B 站接口返回错误（${code}）：${message || '未知错误'}`);
    }
    return BiliImage.videoHandler(bot, data, bot.logger);
  }
}
