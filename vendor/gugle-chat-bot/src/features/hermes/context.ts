import { HistoryEntry, RouteInfo } from '@/features/hermes/types';

/**
 * 会话上下文组装（纯函数）。
 *
 * 群聊/互通频道的会话历史是多人共享的，若原样平铺提交，模型分不清「谁在跟我
 * 说话、哪些是背景闲聊、我之前回复的是谁」，容易串台认错人。这里在提交时按
 * 当前对话者动态标注归属（存储层保持原样）：
 * - 当前对话者的消息：保持 `发送者: 内容` 原样（对话主线）；
 * - 其他成员的消息：加 [群聊背景] 前缀（旁听内容，不是对 AI 说的话）；
 * - AI 回复过其他成员的话：加 [你回复 xxx 的话] 前缀（避免误认为是对当前
 *   对话者说的）。
 */

/** 背景消息前缀：其他成员的闲聊 */
export const BG_PREFIX = '[群聊背景]';

/** 组装提交给 Hermes 的 conversation_history（按当前对话者标注归属） */
export function buildConversationHistory(
  history: HistoryEntry[],
  currentUserId: string
): Array<{ role: string; content: string }> {
  return history.map(entry => {
    if (entry.role === 'user') {
      if (entry.userId !== undefined && entry.userId !== currentUserId) {
        return { role: 'user', content: `${BG_PREFIX} ${entry.content}` };
      }
      return { role: 'user', content: entry.content };
    }
    if (entry.role === 'assistant') {
      if (entry.userId !== undefined && entry.userId !== currentUserId) {
        return { role: 'assistant', content: `[你回复 ${entry.label ?? entry.userId} 的话] ${entry.content}` };
      }
      return { role: 'assistant', content: entry.content };
    }
    return { role: entry.role, content: entry.content };
  });
}

/**
 * 群聊/互通频道的上下文系统提示（QQ 群与 Discord 路由统一口径）。
 * 显式声明当前对话者与历史标注约定，配合 buildConversationHistory 使用。
 */
export function buildGroupContext(route: RouteInfo, senderLabel: string): string {
  const where =
    route.type === 'group'
      ? `你正在 QQ 群 ${route.groupId} 中（该群与 Discord 频道互通，消息也可能来自 Discord 用户）。`
      : `你正在 QQ 群 ${route.groupId} 互通的 Discord 频道 #${route.discord?.channelName ?? ''} 中（频道与 QQ 群消息互通）。`;
  return [
    where,
    '群聊有多个成员，发送者标识格式为「昵称 (ID)」：纯数字 ID 是 QQ 号，dc: 前缀的是 Discord 用户，请据此区分不同的人。',
    `历史消息中带 ${BG_PREFIX} 前缀的是其他成员的闲聊，不是对你说的话，仅供你了解上下文，不要回应、也不要当成你自己的记忆；带 [你回复 xxx 的话] 前缀的是你之前回复其他成员的内容。`,
    `当前与你对话的是 ${senderLabel}，只需回应 TA 的消息。回复简短口语化，符合聊天风格。`
  ].join('\n');
}

/**
 * 消息中的 Issue/PR 编号会被消息管道自动渲染卡片时，给 AI 输入追加注记，
 * 避免 AI 再调用查Issue技能重复发同一张卡片（autoCardCount=0 时原样返回）。
 */
export function appendAutoCardNote(text: string, autoCardCount: number): string {
  if (autoCardCount <= 0) return text;
  return (
    `${text}\n（系统提示：本条消息中的 ${autoCardCount} 个 Issue/PR 编号已由系统自动生成信息卡片并发出，` +
    `请直接据此回答，不要再调用查Issue技能重复发送卡片）`
  );
}
