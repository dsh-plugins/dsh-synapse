import { ApprovalChoice } from '@/features/hermes/types';

/**
 * Hermes 触发判定与文本处理的纯函数（抽离自 HermesBridge 以便冒烟测试）。
 */

export interface GroupTriggerOptions {
  /** 消息纯文本 */
  text: string;
  /** 是否 @了 bot */
  mentioned: boolean;
  /** 群聊中是否需要 @bot 才触发 */
  requireMention: boolean;
  /** 关键词触发列表（需已转小写） */
  keywordTriggers: string[];
}

export interface TriggerDecision {
  triggered: boolean;
  reason?: string;
}

/**
 * 群聊触发判定。
 * 相对上游新增的守卫：以 / 或 ! 开头的消息视为命令（交给 gugle-command），
 * 除非显式 @bot，否则不触发 AI，避免与命令系统双重响应。
 */
export function decideGroupTrigger(options: GroupTriggerOptions): TriggerDecision {
  const text = options.text.trim();
  if (options.mentioned) return { triggered: true, reason: 'mention' };
  if (text.startsWith('/') || text.startsWith('!')) return { triggered: false };
  const lower = text.toLowerCase();
  for (const keyword of options.keywordTriggers) {
    if (lower.includes(keyword)) return { triggered: true, reason: `keyword:${keyword}` };
  }
  if (!options.requireMention) return { triggered: true, reason: 'bare' };
  return { triggered: false };
}

/**
 * 解析审批回复文本为审批选择。
 * 注意匹配顺序：始终允许 > 本次允许 > 拒绝 > 批准——
 * 「不允许/不批准」包含「允许/批准」，上游先匹配批准导致否定词不可达，此处修正。
 */
export function parseApprovalChoice(text: string): ApprovalChoice | null {
  const lower = text.toLowerCase().trim();
  if (['始终允许', 'always', '始终批准', '全部允许'].some(keyword => lower.includes(keyword))) return 'always';
  if (['本次允许', 'session'].some(keyword => lower.includes(keyword))) return 'session';
  if (['拒绝', 'deny', '不批准', '不允许'].some(keyword => lower.includes(keyword))) return 'deny';
  if (['批准', '通过', 'approve', 'ok', '允许'].some(keyword => lower.includes(keyword))) return 'once';
  return null;
}

/** 按最大长度切分消息（优先在换行/空格处断开） */
export function splitMessageText(text: string, maxLength: number): string[] {
  if (maxLength <= 0 || text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    let splitIndex = remaining.lastIndexOf('\n', maxLength);
    if (splitIndex < maxLength * 0.3) {
      splitIndex = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitIndex < maxLength * 0.3) {
      splitIndex = maxLength;
    }
    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }
  return chunks;
}

/** 判断文本是否为停止指令 */
export function isStopCommand(text: string): boolean {
  return text === '停止' || text.toLowerCase() === 'stop';
}

/** 判断文本是否为清除上下文指令 */
export function isResetCommand(text: string): boolean {
  const lower = text.toLowerCase();
  return text === '清除上下文' || text === '新对话' || lower === 'new' || lower === 'reset';
}
