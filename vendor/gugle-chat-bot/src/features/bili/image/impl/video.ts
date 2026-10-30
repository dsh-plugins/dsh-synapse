import { ViewData } from '@/type/bili';
import { Template, tryGenerateImage } from '@/image';
import { Logger } from 'winston';
import { convertDuration, convertStat, getPicB64 } from '@/features/bili/image';
import { QQBot } from '@/index';
import dayjs from 'dayjs';

export function videoHandler(bot: QQBot, viewData: ViewData, logger?: Logger): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    Promise.all([
      getPicB64(bot, viewData.pic).then(cover => {
        viewData.pic = cover;
      }),
      getPicB64(bot, viewData.owner.face).then(cover => {
        viewData.owner.face = cover;
      })
    ]).then(() => {
      const description = `<p>${viewData.desc.split('\n').join('</p>\n<p>')}</p>`;
      const template = Template.load('video', 'src/features/bili/template')
        .arg('title', viewData.title)
        .arg('description', description)
        .arg('cover', viewData.pic)
        .arg('avatar', viewData.owner.face)
        .arg('name', viewData.owner.name)
        .arg('date', dayjs(viewData.ctime * 1000).format('YYYY-MM-DD HH:mm'))
        .arg('duration', convertDuration(viewData.duration))
        .arg('view', convertStat(viewData.stat.view))
        .arg('like', convertStat(viewData.stat.like))
        .arg('reply', convertStat(viewData.stat.reply));
      const templateFile = template.file();
      template
        .handler()
        .then(video => {
          logger?.debug(`Start process video message...`);
          tryGenerateImage(resolve, reject, video, 820, templateFile);
        });
    });
  });
}
