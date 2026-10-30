import { QQBot } from '@/index';
import { GroupDecreaseNoticeWSMSG, GroupIncreaseNoticeWSMSG, GroupRequestWSMSG } from '@/type';
import { EventDataManager } from '@/event';
import { getFeatureConfig } from '@/config/features';

function handleGroupDecreaseNotice(bot: QQBot, msg: GroupDecreaseNoticeWSMSG) {
  if (!getFeatureConfig('management').groups.includes(msg.group_id)) return;
  EventDataManager.getStorage('management', 'ban_list').then(raw => {
    // 归一化后再判重：兼容历史字符串条目，避免同一用户被写成两份（数字 + 字符串）
    const banList = Management.normalizeBanList(raw);
    const userId = Number(msg.user_id);
    if (!Number.isSafeInteger(userId) || userId <= 0) return;
    // 已归一化集合里存在即视为已拉黑；顺带把归一化结果写回，清理历史脏数据
    const alreadyBanned = banList.includes(userId);
    if (alreadyBanned && JSON.stringify(banList) === JSON.stringify(raw)) return;
    if (!alreadyBanned) banList.push(userId);
    EventDataManager.setStorage('management', 'ban_list', banList).then(() => {
      if (alreadyBanned) return; // 仅做数据清理，不再重复播报
      const reason = msg.sub_type === 'kick' ? '被管理员移出群聊' : '退出群聊';
      bot.getUserInfo(msg.user_id).then(userInfo => {
        bot.sendGroupMsg(msg.group_id, [
          {
            type: 'text',
            data: {
              text: `用户 ${userInfo.nickname}(${userInfo.user_id}) 已${reason}，现已加入黑名单，将自动拒绝后续加群申请！`
            }
          }
        ]);
      });
    });
  });
}

function handleGroupIncreaseNotice(bot: QQBot, msg: GroupIncreaseNoticeWSMSG) {
  if (!getFeatureConfig('management').groups.includes(msg.group_id)) return;
  EventDataManager.getStorage('management', 'ban_list').then(raw => {
    const banList = Management.normalizeBanList(raw);
    const userId = Number(msg.user_id);
    if (!banList.includes(userId)) return;
    if (msg.sub_type === 'invite' && getFeatureConfig('management').operators?.includes(msg.operator_id)) {
      // 管理员主动邀请 = 视为赦免：移出黑名单
      EventDataManager.setStorage(
        'management',
        'ban_list',
        banList.filter(id => id !== userId)
      ).then();
      return;
    }
    bot.kick(msg.group_id, msg.user_id);
    bot.getUserInfo(msg.user_id).then(userInfo => {
      bot.sendGroupMsg(msg.group_id, [
        {
          type: 'text',
          data: {
            text: `黑名单用户 ${userInfo.nickname}(${userInfo.user_id}) 加群，已自动移出！`
          }
        }
      ]);
    });
  });
}

function handleGroupRequest(bot: QQBot, msg: GroupRequestWSMSG) {
  if (!getFeatureConfig('management').groups.includes(msg.group_id)) return;
  if (msg.sub_type !== 'add') return;
  EventDataManager.getStorage('management', 'ban_list').then(raw => {
    const banList = Management.normalizeBanList(raw);
    if (!banList.includes(Number(msg.user_id))) return;
    bot.denyGroupAddRequest(msg.flag, '你已被拉入黑名单，系统自动拒绝！');
    bot.getUserInfo(msg.user_id).then(userInfo => {
      bot.sendGroupMsg(msg.group_id, [
        {
          type: 'text',
          data: {
            text: `黑名单用户 ${userInfo.nickname}(${userInfo.user_id}) 申请加群，已自动拒绝！`
          }
        }
      ]);
    });
  });
}

export class Management {
  public static handleGroupDecreaseNotice(bot: QQBot, msg: GroupDecreaseNoticeWSMSG) {
    handleGroupDecreaseNotice(bot, msg);
  }

  public static handleGroupIncreaseNotice(bot: QQBot, msg: GroupIncreaseNoticeWSMSG) {
    handleGroupIncreaseNotice(bot, msg);
  }

  public static handleGroupRequest(bot: QQBot, msg: GroupRequestWSMSG) {
    handleGroupRequest(bot, msg);
  }

  /**
   * /pardon <QQ号>：把用户从黑名单移除（赦免）。
   * 仅限 management 功能启用的群 + 管理员使用。
   *
   * 权限校验（**全部在此处完成**，不依赖调用方）：
   * - QQ 侧 operatorId 为 number → 必须在 management.json `operators` 白名单内；
   * - Discord 侧 operatorId 为 `dc:<用户ID>` → 必须是 management.json `discordOperators`
   *   白名单成员。注意：此前仅校验 `dc:` 前缀即放行，导致被桥接频道里任意成员都能赦免黑名单用户。
   *
   * @returns true=已移除；false=不在黑名单/无权限
   */
  public static async pardon(groupId: number, operatorId: number | string, userId: number): Promise<boolean> {
    const config = getFeatureConfig('management');
    if (!config.groups.includes(groupId)) return false;
    if (!this.isOperatorAllowed(operatorId)) return false;

    // 黑名单历史数据/不同 OneBot 实现可能写入字符串形态的 QQ 号，
    // 统一按数值比较，避免「明明在黑名单里却删不掉」。
    const banList = this.normalizeBanList(await EventDataManager.getStorage('management', 'ban_list'));
    if (!banList.includes(userId)) return false;

    const next = banList.filter(id => id !== userId);
    await EventDataManager.setStorage('management', 'ban_list', next);
    return true;
  }

  /**
   * 操作者是否有权执行管理操作。
   *
   * - number（QQ 号）→ operators 白名单；
   * - `dc:` 前缀 → discordOperators 白名单（必须是显式配置的用户）；
   * - 其他形态 → 拒绝。
   */
  public static isOperatorAllowed(operatorId: number | string): boolean {
    const config = getFeatureConfig('management');
    if (typeof operatorId === 'number') {
      return config.operators?.includes(operatorId) ?? false;
    }
    if (typeof operatorId === 'string' && /^dc:/i.test(operatorId)) {
      const target = operatorId.slice(3).trim();
      if (!target) return false;
      return (config.discordOperators ?? []).some(item => item.replace(/^dc:/i, '').trim() === target);
    }
    return false;
  }

  /**
   * 归一化黑名单：字符串数字转 number、剔除非法项、去重。
   * 兼容历史脏数据（如被写成 `"2017065007"` 的条目），避免「明明在黑名单里却删不掉」。
   */
  public static normalizeBanList(raw: unknown): number[] {
    if (!Array.isArray(raw)) return [];
    const result: number[] = [];
    for (const item of raw) {
      const value = typeof item === 'string' ? Number(item.trim()) : item;
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) continue;
      if (!result.includes(value)) result.push(value);
    }
    return result;
  }
}
