import { splitMessageText } from '@/features/hermes/trigger';

/**
 * QQ 侧 AI 回复的分句与「是否改用聊天记录（合并转发）发送」判定（纯函数，抽离自 HermesBridge 以便冒烟测试）。
 *
 * - `splitReplyIntoUnits`：一次性把完整回复切成语义单元（运行结束时使用）；
 * - `takeCompleteUnits`：流式场景下只取「已完整」的单元，未成形的内容留在 rest，
 *   尤其要保住 `[SKILL:` / `MEDIA:` 标签与未闭合的代码围栏，防止半截标签被原样发到群里。
 *
 * 本模块不产生任何 IO。
 */

export interface ReplyUnitOptions {
  /** 单元最大长度：超过则用既有 splitMessageText 二次切分（通常传 config.maxMessageLength） */
  maxUnitLength: number;
  /** 单条超过该字数改用聊天记录发送；0 = 关闭该维度 */
  compactMaxChars: number;
  /** 单条超过该行数改用聊天记录发送；0 = 关闭该维度 */
  compactMaxLines: number;
}

export interface ReplyUnit {
  text: string;
  asForward: boolean;
}

/** 句子结束标点：命中后连同其后的收尾引号/括号一起切走 */
const SENTENCE_ENDINGS = '。！？!?；;…';
/** 句末标点后可一并切走的收尾引号与括号 */
const CLOSING_MARKS = '”’"\'」』）)】]》〉';
/** 技能/媒体标签：命中即把该单元及其后的内容留在 rest，交由调用方在运行结束时统一处理 */
const RESERVED_LABEL_PATTERN = /\[SKILL:|MEDIA:/;

/** 单元在缓冲区中的位置（start/end 指向原始缓冲区下标，text 已裁剪首尾空白） */
interface ScannedUnit {
  text: string;
  start: number;
  end: number;
}

/** 是否为空白字符（\s 语义，含制表符/换行/不换行空格） */
function isWhitespace(char: string): boolean {
  return char !== '' && /\s/.test(char);
}

/** 是否为行内缩进字符（列表续行、围栏缩进判定用） */
function isIndent(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\r';
}

/** 从 from 起跳过全部空白，返回首个非空白字符下标 */
function skipWhitespace(source: string, from: number): number {
  let index = from;
  while (index < source.length && isWhitespace(source[index] ?? '')) index++;
  return index;
}

/** index 是否为行首内容位（其前缀只有缩进，即列表项/围栏可以出现的位置） */
function isLineHead(source: string, index: number): boolean {
  let cursor = index - 1;
  while (cursor >= 0 && isIndent(source[cursor] ?? '')) cursor--;
  return cursor < 0 || source[cursor] === '\n';
}

/** 列表项前缀长度（`- ` / `* ` / `+ ` / `1. ` / `1、` 等）；非列表项返回 0 */
function listPrefixLength(source: string, index: number): number {
  const char = source[index] ?? '';
  if (char === '-' || char === '*' || char === '+') {
    const next = source[index + 1] ?? '';
    return next === ' ' || next === '\t' ? 2 : 0;
  }
  if (char >= '0' && char <= '9') {
    let cursor = index;
    while (cursor < source.length && (source[cursor] ?? '') >= '0' && (source[cursor] ?? '') <= '9') cursor++;
    const separator = source[cursor] ?? '';
    if (separator !== '.' && separator !== '、' && separator !== ')' && separator !== '）') return 0;
    const after = source[cursor + 1] ?? '';
    return cursor - index + 1 + (after === ' ' || after === '\t' ? 1 : 0);
  }
  return 0;
}

/** 统计 index 起连续相同字符的长度 */
function countRun(source: string, index: number, char: string): number {
  let cursor = index;
  while (cursor < source.length && source[cursor] === char) cursor++;
  return cursor - index;
}

/**
 * ASCII 句点是否可作为句末边界。
 *
 * 只在「其后是空白或缓冲区末尾」且「前一字符不是数字」时成立，避免把小数（3.14）、
 * 版本号（v1.0）、IP（192.168.1.1）与域名（example.com）切碎——中文场景下这些比
 * 英文句末出现得更频繁。缓冲区末尾的句点视为完整句（下一段文本会重新拼接）。
 */
function isAsciiPeriodBoundary(source: string, index: number): boolean {
  const previous = index > 0 ? (source[index - 1] ?? '') : '';
  if (previous >= '0' && previous <= '9') return false;
  const next = source[index + 1];
  if (next === undefined) return true;
  return isWhitespace(next);
}

/** index 是否为围栏行首（Markdown 允许至多 3 个空格缩进） */
function isFenceHead(source: string, index: number): boolean {
  let cursor = index - 1;
  let spaces = 0;
  while (cursor >= 0 && isIndent(source[cursor] ?? '')) {
    if (source[cursor] !== '\r') spaces++;
    cursor--;
  }
  if (spaces > 3) return false;
  return cursor < 0 || source[cursor] === '\n';
}

/** start~stop 这一行是否为闭合围栏（同类标记且不少于开启长度，行内无其他内容） */
function isClosingFence(source: string, start: number, stop: number, marker: string, minLength: number): boolean {
  let cursor = start;
  while (cursor < stop && isIndent(source[cursor] ?? '')) cursor++;
  let count = 0;
  while (cursor < stop && source[cursor] === marker) {
    count++;
    cursor++;
  }
  if (count < minLength) return false;
  while (cursor < stop && isIndent(source[cursor] ?? '')) cursor++;
  return cursor >= stop;
}

/**
 * 查找围栏块结束下标（不含），未闭合或围栏行尚未结束时返回 -1。
 * 返回位置已包含闭合围栏行及其换行符。
 */
function findFenceEnd(source: string, index: number, marker: string, markerLength: number): number {
  const lineEnd = source.indexOf('\n', index);
  if (lineEnd < 0) return -1;
  let cursor = lineEnd + 1;
  while (cursor < source.length) {
    const stop = source.indexOf('\n', cursor);
    const lineStop = stop < 0 ? source.length : stop;
    if (isClosingFence(source, cursor, lineStop, marker, markerLength)) {
      return stop < 0 ? source.length : stop + 1;
    }
    if (stop < 0) return -1;
    cursor = stop + 1;
  }
  return -1;
}

/**
 * 查找连续列表块的结束下标（含最后一行的换行符）。
 * complete=false 表示列表块一直延伸到缓冲区末尾、仍可能继续增长（流式场景需留在 rest）。
 */
function findListBlockEnd(source: string, start: number): { end: number; complete: boolean } {
  const length = source.length;
  let cursor = start;
  while (cursor < length) {
    const lineEnd = source.indexOf('\n', cursor);
    if (lineEnd < 0) return { end: length, complete: false };
    const end = lineEnd + 1;
    const next = end;
    if (next >= length) return { end, complete: false };
    if ((source[next] ?? '') === '\n') return { end, complete: true };
    // 缩进续行或同类列表项 → 并入同一单元；普通新段落 → 列表块结束
    if (!isLineHead(source, next) || listPrefixLength(source, next) > 0) {
      cursor = next;
      continue;
    }
    return { end, complete: true };
  }
  return { end: length, complete: false };
}

/**
 * 扫描缓冲区并切出语义单元。
 *
 * 边界规则：句末标点（含其后收尾引号/括号）、空行、换行、代码围栏、连续列表块。
 * final=true 时末段即使没有边界也作为最后一个单元；final=false 时未成形内容全部留在
 * consumed 之后（由 takeCompleteUnits 作为 rest 返回），未闭合的围栏亦不下发。
 */
function scanUnits(source: string, final: boolean): { units: ScannedUnit[]; consumed: number } {
  const units: ScannedUnit[] = [];
  const length = source.length;
  let consumed = 0;
  let unitStart = skipWhitespace(source, 0);
  let index = unitStart;

  /** 把 [unitStart, end) 作为一个单元收下，并跳到其后的首个非空白字符 */
  const emit = (end: number): void => {
    const text = source.slice(unitStart, end).trim();
    if (text) units.push({ text, start: unitStart, end });
    index = skipWhitespace(source, end);
    unitStart = index;
    if (units.length > 0) consumed = index;
  };

  while (index < length) {
    const char = source[index] ?? '';

    // 代码围栏（``` / ~~~）：整块原子，未闭合时停止扫描（非最终模式留给 rest）
    if ((char === '`' || char === '~') && isFenceHead(source, index)) {
      const runLength = countRun(source, index, char);
      if (runLength >= 3) {
        const fenceEnd = findFenceEnd(source, index, char, runLength);
        if (fenceEnd >= 0) {
          emit(fenceEnd);
          continue;
        }
        if (final) emit(length);
        break;
      }
    }

    // 列表块：连续列表项行合并为一个单元，避免逐条刷屏
    if (
      (char === '-' || char === '*' || char === '+' || (char >= '0' && char <= '9')) &&
      isLineHead(source, index) &&
      listPrefixLength(source, index) > 0
    ) {
      const block = findListBlockEnd(source, index);
      if (block.complete || final) {
        emit(block.end);
        continue;
      }
      break;
    }

    // 句末标点：连同后续的收尾引号/括号一起切走
    if (SENTENCE_ENDINGS.includes(char) || (char === '.' && isAsciiPeriodBoundary(source, index))) {
      let end = index + 1;
      while (end < length && SENTENCE_ENDINGS.includes(source[end] ?? '')) end++;
      while (end < length && CLOSING_MARKS.includes(source[end] ?? '')) end++;
      emit(end);
      continue;
    }

    // 换行：段落边界；缓冲区以换行结尾时视为「尚未成形」，等后续内容一并判定
    if (char === '\n') {
      if (index + 1 < length || final) {
        emit(index);
        continue;
      }
      break;
    }

    index++;
  }

  // 最终模式：末段没有边界也作为最后一个单元（否则调用方会丢字）
  if (final && unitStart < length) {
    const text = source.slice(unitStart).trim();
    if (text) units.push({ text, start: unitStart, end: length });
    consumed = length;
  }

  return { units, consumed };
}

/** 单条是否应改用聊天记录（合并转发）发送：任一维度超限即命中，0 表示关闭该维度 */
export function shouldCompact(text: string, options: ReplyUnitOptions): boolean {
  if (options.compactMaxChars > 0 && text.length > options.compactMaxChars) return true;
  if (options.compactMaxLines > 0 && text.split('\n').length > options.compactMaxLines) return true;
  return false;
}

/** 超长单元先用既有 splitMessageText 二次切分（maxUnitLength<=0 时不切） */
function splitByLength(text: string, maxUnitLength: number): string[] {
  if (maxUnitLength <= 0) return [text];
  return splitMessageText(text, maxUnitLength);
}

/** 文本列表 → 回复单元：逐块独立判定 asForward，空块不产出单元 */
function toReplyUnits(texts: string[], options: ReplyUnitOptions): ReplyUnit[] {
  const units: ReplyUnit[] = [];
  for (const text of texts) {
    for (const piece of splitByLength(text, options.maxUnitLength)) {
      const trimmed = piece.trim();
      if (!trimmed) continue;
      units.push({ text: trimmed, asForward: shouldCompact(trimmed, options) });
    }
  }
  return units;
}

/**
 * 把完整回复切成回复单元（最终模式：运行结束、标签已处理完时使用）。
 *
 * 与 takeCompleteUnits 的区别是「末段一律成形」：缓冲区以未闭合围栏结尾时，整块（含围栏行）
 * 作为一个单元发出；末尾没有边界的残句也照发。调用方用它对 rest 做收尾 flush 时不会丢字，
 * 除非输入本身为空/纯空白（此时返回 []）。
 * 单元长度超过 maxUnitLength 时按 splitMessageText 二次切分，拼接结果与输入一致（仅裁剪空白）。
 */
export function splitReplyIntoUnits(text: string, options: ReplyUnitOptions): ReplyUnit[] {
  if (!text) return [];
  return toReplyUnits(
    scanUnits(text, true).units.map(unit => unit.text),
    options
  );
}

/**
 * 流式取「已完整」的回复单元：缓冲区末尾未成形的内容（含未闭合围栏）留在 rest，
 * 由调用方在运行结束时统一处理。
 *
 * 标签保留：一旦某个单元命中 `[SKILL:` 或 `MEDIA:`（子串匹配），从该单元起（含该单元）
 * 及其后的全部内容都留在 rest——宁可多留，也绝不让标签经流式路径被原样发到群里。
 * 注意 rest 只保证不丢字，不管标签是否闭合；标签的处理与最终下发由调用方负责。
 */
export function takeCompleteUnits(buffer: string, options: ReplyUnitOptions): { units: ReplyUnit[]; rest: string } {
  if (!buffer) return { units: [], rest: '' };
  const scanned = scanUnits(buffer, false);

  let cut = scanned.units.length;
  let restStart = scanned.consumed;
  for (let index = 0; index < scanned.units.length; index++) {
    const unit = scanned.units[index]!;
    if (!RESERVED_LABEL_PATTERN.test(unit.text)) continue;
    cut = index;
    restStart = unit.start;
    break;
  }

  return {
    units: toReplyUnits(
      scanned.units.slice(0, cut).map(unit => unit.text),
      options
    ),
    rest: buffer.slice(restStart)
  };
}
