import { QQBot } from '@/index';
import { GroupIncreaseNoticeWSMSG } from '@/type';
import { getWelcomeConfig } from '@/config/features';

/**
 * 新人欢迎模块。
 *
 * 配置（configs/features/welcome.json，v1）：
 * ```json
 * {
 *   "version": 1,
 *   "welcomes": [
 *     { "group": [123456, 234567], "msg": "欢迎 ${at} 加入群聊" },
 *     { "group": [888888], "msg": ["${at} 欢迎你！", "请查看群公告", "有问题找管理员"] }
 *   ]
 * }
 * ```
 * - `group`：适用群号列表（可多个群共用同一条欢迎语）
 * - `msg`：欢迎语模板（字符串或字符串数组，数组每项一行，\n 拼接），
 *   `${at}` 会被替换为 @新成员 消息段
 */
export class Welcome {
  /**
   * 处理 group_increase 通知，匹配到该群的欢迎配置后发送欢迎消息。
   */
  public static handleGroupIncreaseNotice(bot: QQBot, msg: GroupIncreaseNoticeWSMSG): void {
    const config = getWelcomeConfig();
    const entry = config.welcomes.find(item => item.group.includes(msg.group_id));
    if (!entry) return;
    const message = buildWelcomeMessage(msg.user_id, entry.msg);
    bot.sendGroupMsg(msg.group_id, message);
  }
}

/**
 * 将欢迎模板渲染成消息段数组：`${at}` 拆分为 @成员 消息段，
 * 其余文本保持文本段（避免以字符串拼接 CQ 码）。
 * `template` 可为字符串或字符串数组（数组按换行拼接为多行文本）。
 */
export function buildWelcomeMessage(qq: number, template: string | string[]): import('@/type').Message[] {
  const text = Array.isArray(template) ? template.join('\n') : template;
  const parts = text.split('${at}');
  const messages: import('@/type').Message[] = [];
  parts.forEach((part, index) => {
    if (part) {
      messages.push({ type: 'text', data: { text: part } });
    }
    // 在每段文本之后插入 @（除最后一段）
    if (index < parts.length - 1) {
      messages.push({ type: 'at', data: { qq } });
    }
  });
  // 模板中无 ${at} 时的兜底：把 QQ 号附在末尾
  if (messages.length === 0) {
    messages.push({ type: 'text', data: { text: `欢迎新成员 ${qq} 加入群聊` } });
  }
  return messages;
}