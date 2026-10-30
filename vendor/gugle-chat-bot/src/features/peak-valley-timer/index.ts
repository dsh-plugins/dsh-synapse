import dayjs from 'dayjs';
import { QQBot } from '@/index';
import { getFeatureGroups } from '@/config/features';
import { readOrCreate } from '@/config/manager';
import { Message } from '@/type';

export type PeakValleyMode = 'peak' | 'valley';

export type DayToken = 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';

export interface PeakValleyTimerTimeRange {
  start: string;
  end: string;
  days: DayToken[];
  mode?: PeakValleyMode;
  msg?: string;
}

export interface PeakValleyTimerConfig {
  groups?: number[];
  mode?: PeakValleyMode;
  time: Array<string | PeakValleyTimerTimeRange>;
  peak_msg?: string;
  valley_msg?: string;
  cmd_peak_msg?: string;
  cmd_valley_msg?: string;
}

interface NormalizedTimeRange {
  startMinutes: number;
  endMinutes: number;
  days: number[];
  msg: string;
  mode?: PeakValleyMode;
  key: string;
}

const DAY_MAP: Record<DayToken, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 0
};

const DAY_ORDER: DayToken[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const TIME_PATTERN: RegExp = /^([01]?\d|2[0-3]):([0-5]\d)$/;

const CHECK_INTERVAL_MS = 30 * 1000;
const CATCH_UP_WINDOW_SECONDS = 90;

const defaultConfig: PeakValleyTimerConfig = {
  groups: getFeatureGroups('command'),
  mode: 'peak',
  time: ['9:00-12:00 Mon-Fri', '14:00-18:00 Mon-Fri'],
  peak_msg: '梁文峰时间到！\n当前时间是${time}',
  valley_msg: '梁文谷时间到！\n当前时间是${time}',
  cmd_peak_msg: '当前时间是${time}，梁文峰时间！',
  cmd_valley_msg: '当前时间是${time}，梁文谷时间！'
};

function isPeakValleyMode(value: unknown): value is PeakValleyMode {
  return value === 'peak' || value === 'valley';
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(item => typeof item === 'number' && Number.isSafeInteger(item));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseTimeToMinutes(time: string): number | null {
  if (!TIME_PATTERN.test(time)) return null;
  const [hour, minute] = time.split(':');
  const hourValue = Number.parseInt(hour || '0', 10);
  const minuteValue = Number.parseInt(minute || '0', 10);
  if (Number.isNaN(hourValue) || Number.isNaN(minuteValue)) return null;
  return hourValue * 60 + minuteValue;
}

function expandDayToken(token: string): DayToken[] | null {
  const trimmed = token.trim();
  if (!trimmed) return null;
  const hyphenIndex = trimmed.indexOf('-');
  if (hyphenIndex === -1) {
    if (!(trimmed in DAY_MAP)) return null;
    return [trimmed as DayToken];
  }
  const from = trimmed.slice(0, hyphenIndex) as DayToken;
  const to = trimmed.slice(hyphenIndex + 1) as DayToken;
  if (!(from in DAY_MAP) || !(to in DAY_MAP)) return null;
  const fromIndex = DAY_ORDER.indexOf(from);
  const toIndex = DAY_ORDER.indexOf(to);
  const days: DayToken[] = [];
  let index = fromIndex;
  while (true) {
    const current = DAY_ORDER[index % DAY_ORDER.length];
    if (!current) break;
    days.push(current);
    if (current === to) break;
    index = (index + 1) % DAY_ORDER.length;
  }
  return days;
}

function parseDaysToken(daysToken: string): DayToken[] | null {
  if (!daysToken.trim()) return [];
  const tokens = daysToken.split(',').map(token => token.trim()).filter(token => token.length > 0);
  const result: DayToken[] = [];
  for (const token of tokens) {
    const expanded = expandDayToken(token);
    if (!expanded) return null;
    result.push(...expanded);
  }
  return Array.from(new Set(result));
}

function parseTimeRangeToken(token: string): PeakValleyTimerTimeRange | null {
  const parts = token.trim().split(/\s+/);
  const timePart = parts[0];
  if (!timePart) return null;
  const dashIndex = timePart.indexOf('-');
  if (dashIndex === -1) return null;
  const start = timePart.slice(0, dashIndex).trim();
  const end = timePart.slice(dashIndex + 1).trim();
  if (parseTimeToMinutes(start) === null || parseTimeToMinutes(end) === null) return null;
  const daysToken = parts.slice(1).join(' ');
  const days = parseDaysToken(daysToken);
  if (days === null) return null;
  return { start, end, days };
}

function normalizeTimeRange(time: unknown): NormalizedTimeRange | null {
  let resolved: PeakValleyTimerTimeRange | null = null;
  if (typeof time === 'string') {
    resolved = parseTimeRangeToken(time);
  } else if (time && typeof time === 'object' && !Array.isArray(time)) {
    const candidate = time as Record<string, unknown>;
    if (isNonEmptyString(candidate.start) && isNonEmptyString(candidate.end)) {
      const daysValue = candidate.days;
      let days: DayToken[] = [];
      if (daysValue !== undefined) {
        if (!Array.isArray(daysValue) || !daysValue.every(isNonEmptyString)) return null;
        const parsedDays = parseDaysToken(daysValue.join(','));
        if (parsedDays === null) return null;
        days = parsedDays;
      }
      const parsedMode = isPeakValleyMode(candidate.mode) ? candidate.mode : undefined;
      const parsedMsg = isNonEmptyString(candidate.msg) ? candidate.msg : undefined;
      if (parsedMode || parsedMsg) {
        resolved = {
          start: candidate.start,
          end: candidate.end,
          days,
          ...(parsedMode ? { mode: parsedMode } : {}),
          ...(parsedMsg ? { msg: parsedMsg } : {})
        };
      } else {
        resolved = {
          start: candidate.start,
          end: candidate.end,
          days
        };
      }
    }
  }
  if (!resolved) return null;

  const startMinutes = parseTimeToMinutes(resolved.start);
  const endMinutes = parseTimeToMinutes(resolved.end);
  if (startMinutes === null || endMinutes === null) return null;

  const mode = resolved.mode;
  const msg = resolved.msg;
  const key = `${resolved.start}-${resolved.end}-${resolved.days.join(',')}-${mode || ''}-${msg || ''}`;
  return {
    startMinutes: startMinutes,
    endMinutes: endMinutes,
    days: resolved.days.map(day => DAY_MAP[day]),
    msg: msg || '',
    ...(mode ? { mode: mode } : {}),
    key
  };
}

function normalizeConfig(raw: PeakValleyTimerConfig | null): {
  groups: number[];
  mode: PeakValleyMode;
  time: NormalizedTimeRange[];
  peak_msg: string;
  valley_msg: string;
  cmd_peak_msg: string;
  cmd_valley_msg: string;
} {
  const groups =
    raw && raw.groups !== undefined ? (isNumberArray(raw.groups) ? raw.groups : defaultConfig.groups!) : defaultConfig.groups!;
  const mode = raw && raw.mode !== undefined ? (isPeakValleyMode(raw.mode) ? raw.mode : 'peak') : 'peak';

  let time: NormalizedTimeRange[] = [];
  if (raw && Array.isArray(raw.time)) {
    time = raw.time.map(normalizeTimeRange).filter((range): range is NormalizedTimeRange => range !== null);
  }
  if (time.length === 0) {
    time = defaultConfig.time.map(normalizeTimeRange).filter((range): range is NormalizedTimeRange => range !== null);
  }

  const peak_msg =
    raw && raw.peak_msg !== undefined
      ? isNonEmptyString(raw.peak_msg)
        ? raw.peak_msg
        : defaultConfig.peak_msg!
      : defaultConfig.peak_msg!;
  const valley_msg =
    raw && raw.valley_msg !== undefined
      ? isNonEmptyString(raw.valley_msg)
        ? raw.valley_msg
        : defaultConfig.valley_msg!
      : defaultConfig.valley_msg!;
  const cmd_peak_msg =
    raw && raw.cmd_peak_msg !== undefined
      ? isNonEmptyString(raw.cmd_peak_msg)
        ? raw.cmd_peak_msg
        : defaultConfig.cmd_peak_msg!
      : defaultConfig.cmd_peak_msg!;
  const cmd_valley_msg =
    raw && raw.cmd_valley_msg !== undefined
      ? isNonEmptyString(raw.cmd_valley_msg)
        ? raw.cmd_valley_msg
        : defaultConfig.cmd_valley_msg!
      : defaultConfig.cmd_valley_msg!;
  return { groups, mode, time, peak_msg, valley_msg, cmd_peak_msg, cmd_valley_msg };
}

function normalizeRawConfig(raw: unknown): PeakValleyTimerConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const time = record.time;
  if (time !== undefined && !Array.isArray(time)) return null;
  return raw as PeakValleyTimerConfig;
}

function loadConfig(): ReturnType<typeof normalizeConfig> {
  const { data } = readOrCreate<PeakValleyTimerConfig>({
    path: 'configs/peak-valley-timer.json',
    factory: () => defaultConfig,
    version: 1,
    normalize: normalizeRawConfig
  });
  return normalizeConfig(data);
}

export class PeakValleyTimer {
  private static instance?: PeakValleyTimer = undefined;

  public static getInstance(): PeakValleyTimer {
    if (!PeakValleyTimer.instance) {
      PeakValleyTimer.instance = new PeakValleyTimer();
    }
    return PeakValleyTimer.instance;
  }

  private groups: number[];
  private mode: PeakValleyMode;
  private time: NormalizedTimeRange[];
  private peakMsg: string;
  private valleyMsg: string;
  private cmdPeakMsg: string;
  private cmdValleyMsg: string;
  private readonly reportedToday: Set<string> = new Set();
  private timer: NodeJS.Timeout | undefined = undefined;

  public constructor() {
    const config = loadConfig();
    this.groups = config.groups;
    this.mode = config.mode;
    this.time = config.time;
    this.peakMsg = config.peak_msg;
    this.valleyMsg = config.valley_msg;
    this.cmdPeakMsg = config.cmd_peak_msg;
    this.cmdValleyMsg = config.cmd_valley_msg;
  }

  /**
   * 从磁盘重新读取配置（/reload 用）。
   * 本类在构造时把配置读进字段（非 ConfigStore 热重载），故需显式重载入口。
   */
  public reloadConfig(): void {
    const config = loadConfig();
    this.groups = config.groups;
    this.mode = config.mode;
    this.time = config.time;
    this.peakMsg = config.peak_msg;
    this.valleyMsg = config.valley_msg;
    this.cmdPeakMsg = config.cmd_peak_msg;
    this.cmdValleyMsg = config.cmd_valley_msg;
  }

  public start(bot: QQBot): void {
    bot.logger?.info(
      `PeakValleyTimer started: ${this.time.length} time range(s), ${this.groups.length} group(s), mode=${this.mode}`
    );
    this.timer = setInterval(() => this.check(bot), CHECK_INTERVAL_MS);
    setTimeout(() => this.check(bot), 1000);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * /pvtime 命令处理：根据当前时间是否处于某个 peak/valley 区间返回对应消息。
   * 命中区间 → 该区间类型（自身 mode 优先，否则全局 mode）的 cmd 消息；
   * 未命中任何区间 → 全局 mode 相反类型的 cmd 消息。
   */
  public getCommandMessage(): string {
    const now = dayjs();
    const weekday = now.day();
    const nowMinutes = now.hour() * 60 + now.minute();
    const currentTime = now.format('HH:mm');

    for (const range of this.time) {
      if (this.isInRange(range, weekday, nowMinutes)) {
        const rangeMode: PeakValleyMode = range.mode ?? this.mode;
        return this.renderMessage(rangeMode === 'peak' ? this.cmdPeakMsg : this.cmdValleyMsg, currentTime);
      }
    }
    const opposite: PeakValleyMode = this.mode === 'peak' ? 'valley' : 'peak';
    return this.renderMessage(opposite === 'peak' ? this.cmdPeakMsg : this.cmdValleyMsg, currentTime);
  }

  /**
   * 判断某时刻是否处于区间内。区间归属日：不跨天区间当天在 days 中；
   * 跨天区间（end <= start）[start, 24:00) 当天在 days，[0, end) 前一天在 days。
   */
  private isInRange(range: NormalizedTimeRange, weekday: number, nowMinutes: number): boolean {
    if (range.endMinutes > range.startMinutes) {
      return range.days.includes(weekday) && nowMinutes >= range.startMinutes && nowMinutes < range.endMinutes;
    }
    if (nowMinutes >= range.startMinutes && range.days.includes(weekday)) return true;
    if (nowMinutes < range.endMinutes && range.days.includes((weekday + 6) % 7)) return true;
    return false;
  }

  private renderMessage(template: string, currentTime: string): string {
    return template.replace(/\$\{time\}/g, currentTime);
  }

  private check(bot: QQBot): void {
    const now = dayjs();
    const today = now.format('YYYY-MM-DD');
    const weekday = now.day();
    const secondsIntoDay = now.hour() * 3600 + now.minute() * 60 + now.second();
    const nowMinutes = now.hour() * 60 + now.minute();

    for (const range of this.time) {
      this.checkStart(bot, range, today, weekday, secondsIntoDay, now, nowMinutes);
      this.checkEnd(bot, range, today, weekday, secondsIntoDay, now, nowMinutes);
    }
  }

  /**
   * 区间开始触发：当天在 days 中且到达 start 时刻 → 报区间类型"到"。
   */
  private checkStart(
    bot: QQBot,
    range: NormalizedTimeRange,
    today: string,
    weekday: number,
    secondsIntoDay: number,
    now: dayjs.Dayjs,
    nowMinutes: number
  ): void {
    if (!range.days.includes(weekday)) return;
    const elapsed = secondsIntoDay - range.startMinutes * 60;
    if (elapsed < 0 || elapsed >= CATCH_UP_WINDOW_SECONDS) return;
    const reportKey = `${today}:${range.key}:start`;
    if (this.reportedToday.has(reportKey)) return;
    this.reportedToday.add(reportKey);
    bot.logger?.info(`PeakValleyTimer start triggered: ${range.key} at ${nowMinutes}`);
    const rangeMode: PeakValleyMode = range.mode ?? this.mode;
    const message = this.buildMessage(rangeMode, range.msg, now);
    this.broadcast(bot, message);
  }

  /**
   * 区间结束触发：到达 end 时刻 → 报相反类型"到"（离开该类型时段）。
   * 不跨天：end 触发日在 days 中当天；跨天（end <= start）：start 在
   * 开始日 D 的 startMinutes，end 在 D+1 的 endMinutes，因此要求
   * 前一天在 days 中，且此刻尚未到今天的 start。
   */
  private checkEnd(
    bot: QQBot,
    range: NormalizedTimeRange,
    today: string,
    weekday: number,
    secondsIntoDay: number,
    now: dayjs.Dayjs,
    nowMinutes: number
  ): void {
    if (range.endMinutes > range.startMinutes) {
      if (!range.days.includes(weekday)) return;
    } else {
      // 跨天区间：end 在开始日的次日凌晨
      const prevWeekday = (weekday + 6) % 7;
      if (!range.days.includes(prevWeekday)) return;
      if (nowMinutes >= range.startMinutes) return; // 今天已到 start，属于新一轮区间
    }
    const elapsed = secondsIntoDay - range.endMinutes * 60;
    if (elapsed < 0 || elapsed >= CATCH_UP_WINDOW_SECONDS) return;
    const reportKey = `${today}:${range.key}:end`;
    if (this.reportedToday.has(reportKey)) return;
    this.reportedToday.add(reportKey);
    bot.logger?.info(`PeakValleyTimer end triggered: ${range.key} at ${nowMinutes}`);
    const rangeMode: PeakValleyMode = range.mode ?? this.mode;
    const opposite: PeakValleyMode = rangeMode === 'peak' ? 'valley' : 'peak';
    const message = this.buildMessage(opposite, range.msg, now);
    this.broadcast(bot, message);
  }

  private broadcast(bot: QQBot, message: string): void {
    for (const groupId of this.groups) {
      const sentMessage: Message[] = [
        {
          type: 'text',
          data: {
            text: message
          }
        }
      ];
      bot.sendGroupMsg(groupId, sentMessage);
    }
  }

  private buildMessage(rangeMode: PeakValleyMode, customMsg: string | undefined, now: dayjs.Dayjs): string {
    const currentTime = now.format('HH:mm');
    let template: string;
    if (customMsg) {
      template = customMsg;
    } else {
      template = rangeMode === 'valley' ? this.valleyMsg : this.peakMsg;
    }
    return template.replace(/\$\{time\}/g, currentTime);
  }
}