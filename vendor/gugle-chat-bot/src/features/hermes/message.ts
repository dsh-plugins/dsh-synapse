/**
 * QQ 消息段的深度解析（纯函数 + 注入式 resolver，抽离自 HermesBridge 以便冒烟测试）。
 *
 * 深度表（depth = 正在解析内容的层级，触发消息本身为 0）：
 * | 段类型           | depth 0            | depth 1    | depth 2                | depth ≥3        |
 * | 图片             | `[图片]` + 原图入 images | 同左  | `[图片]`，不下载       | `[图片]`，不下载 |
 * | reply / forward  | 拉取并解析（depth+1） | 同左      | 拉取但仅文字（不下载图片） | 不拉取，输出 `[聊天记录]` |
 * | text / at / video / record | 原样（at：群名片优先，缺失回退 `@QQ号`） | 同左 | 同左 | 同左 |
 *
 * 有意的取舍：交付物 5 中「引用里含聊天记录 → 节点内图片入 images」按深度表解释为
 * forward 处于 depth 0 时其节点图片入 images；若 forward 落在 depth 1，则节点文字展开、
 * 节点图片在 depth 2 不下载（深度表为准）。
 *
 * 本模块不产生任何 IO：拉取、图片下载、昵称与时间格式化全部由调用方经 MessageResolvers 注入。
 */

/** 聊天记录（合并转发）在文本中的占位符 */
export const FORWARD_PLACEHOLDER = '[聊天记录]';

/** 解析护栏：单次解析的段/节点/图片总量与深度上限，防超长消息与自环拖垮调用方 */
export const PARSE_LIMITS = {
  /** 单次解析处理的段总量上限（跨层级累计） */
  maxSegments: 500,
  /** 单个聊天记录展开的节点上限 */
  maxNodes: 50,
  /** 单次解析收集的图片上限 */
  maxImages: 10,
  /** 深度上限：处于该深度的 reply/forward 不再拉取，只留 `[聊天记录]` 占位 */
  maxDepth: 3,
  /** 下载图片的最大深度（depth 2 起只保留 `[图片]` 占位） */
  maxImageDepth: 1
} as const;

export interface MessageResolvers {
  /** get_msg，失败抛错 */
  getMsg(
    messageId: number
  ): Promise<{ sender?: { nickname?: string; user_id?: number }; time?: number; message: unknown }>;
  /** get_forward_msg，失败抛错 */
  getForward(forwardId: string): Promise<{ messages: unknown[] }>;
  /** 图片段 → base64 data URL；失败/不需要时返回 null */
  resolveImage(segment: { data: { file: string; url?: string } }): Promise<string | null>;
  /** @提及昵称解析（可选；缺省用 QQ 号） */
  resolveName?(qq: string): Promise<string | null>;
  /** 时间戳格式化（注入以保持纯净） */
  formatTime(unixTs: number): string;
  /** 是否下载/转发图片（config.forwardImages） */
  forwardImages: boolean;
}

export interface ParsedMessage {
  text: string;
  images: string[];
}

/**
 * 单次解析的共享状态：护栏计数、去重集合与 @提及昵称缓存。
 * 由 parseMessage 建立并传给各层 parseSegments；直接调用 parseSegments 时可省略。
 */
export interface ParseState {
  /** 已展开的引用/转发 id，防自环与重复展开 */
  visitedIds: Set<string>;
  /** 跨层级累计的段计数（护栏） */
  segmentCount: number;
  /** 已展开的转发节点计数（护栏） */
  nodeCount: number;
  /** 是否解析 @提及昵称（群聊上下文才解析，私聊直接回退 QQ 号） */
  resolveNames: boolean;
  /** @提及昵称缓存（qq → 昵称，空串表示解析失败） */
  nameCache: Map<string, string>;
}

/** 建立解析状态；resolveNames=false 时 @提及 一律回退 QQ 号 */
export function createParseState(resolveNames: boolean): ParseState {
  return { visitedIds: new Set<string>(), segmentCount: 0, nodeCount: 0, resolveNames, nameCache: new Map() };
}

/** 取消息段的数据体（非对象按空对象处理） */
function segmentData(segment: unknown): Record<string, unknown> {
  if (!segment || typeof segment !== 'object') return {};
  const data = (segment as { data?: unknown }).data;
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
}

/** 取消息段类型（缺失/非字符串返回空串） */
function segmentType(segment: unknown): string {
  if (!segment || typeof segment !== 'object') return '';
  const type = (segment as { type?: unknown }).type;
  return typeof type === 'string' ? type : '';
}

/** id 字段归一化为字符串（number/string 皆可，0 与空串视为无 id） */
function readId(raw: unknown): string {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw !== 0) return String(raw);
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return '';
}

/** 取首个非空字符串 */
function pickString(values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

/** 引用块 / 转发节点行的统一格式：`> {昵称}({id}) {时间}\n> {内容}\n` */
function quoteBlock(name: string, id: string, time: string, content: string): string {
  return `${`> ${name}(${id}) ${time}`.trimEnd()}\n> ${content}\n`;
}

/** 解析 @提及 昵称：群聊上下文经 resolver 查询并缓存，失败回退 null（调用方用 QQ 号） */
async function resolveAtName(qq: string, resolvers: MessageResolvers, state: ParseState): Promise<string | null> {
  if (!state.resolveNames || !resolvers.resolveName) return null;
  const cached = state.nameCache.get(qq);
  if (cached !== undefined) return cached || null;
  try {
    const name = await resolvers.resolveName(qq);
    state.nameCache.set(qq, name ?? '');
    return name ?? null;
  } catch {
    state.nameCache.set(qq, '');
    return null;
  }
}

/** 解析图片段为 base64 data URL；失败/不需要时返回 null（调用方保留 `[图片]` 占位） */
async function resolveImageSafe(segment: unknown, resolvers: MessageResolvers): Promise<string | null> {
  const data = segmentData(segment);
  const file = typeof data.file === 'string' ? data.file : '';
  const url = typeof data.url === 'string' ? data.url : '';
  if (!file && !url) return null;
  const target: { data: { file: string; url?: string } } = { data: { file } };
  if (url) target.data.url = url;
  try {
    return await resolvers.resolveImage(target);
  } catch {
    return null;
  }
}

/** 转发节点归一化结果（兼容 NapCat node 格式与 go-cqhttp 旧格式） */
interface ForwardNodeContent {
  segments: unknown;
  name: string;
  id: string;
  time: string;
}

/** 节点正文：message 非空取 message，否则取 content（content 可能是字符串） */
function pickNodeContent(data: Record<string, unknown>): unknown {
  const message = data.message;
  if (Array.isArray(message) && message.length > 0) return message;
  if (typeof message === 'string' && message.length > 0) return message;
  return data.content ?? [];
}

/**
 * 归一化转发节点：
 * - NapCat：`{ type: 'node', data: { user_id, nickname, card, time, message, content } }`
 * - go-cqhttp 旧格式：`{ sender, time, content }`
 */
function normalizeForwardNode(raw: unknown, resolvers: MessageResolvers): ForwardNodeContent {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const data =
    record.type === 'node' && record.data && typeof record.data === 'object'
      ? (record.data as Record<string, unknown>)
      : record;
  const sender = data.sender && typeof data.sender === 'object' ? (data.sender as Record<string, unknown>) : {};
  const rawTime = data.time ?? record.time;
  return {
    segments: pickNodeContent(data),
    name: pickString([data.nickname, data.card, sender.nickname, sender.card]) || '未知',
    id: pickString([data.user_id, sender.user_id]),
    time: typeof rawTime === 'number' && rawTime > 0 ? resolvers.formatTime(rawTime) : ''
  };
}

/** 展开转发（聊天记录）：逐节点输出引用块，节点正文按 depth+1 继续解析 */
async function parseForward(
  forwardId: string,
  depth: number,
  resolvers: MessageResolvers,
  images: string[],
  state: ParseState
): Promise<string> {
  try {
    const forward = await resolvers.getForward(forwardId);
    const parts: string[] = [];
    for (const raw of forward?.messages ?? []) {
      if (state.nodeCount >= PARSE_LIMITS.maxNodes) break;
      state.nodeCount++;
      const node = normalizeForwardNode(raw, resolvers);
      const content = await parseSegments(node.segments, depth + 1, resolvers, images, state);
      parts.push(quoteBlock(node.name, node.id, node.time, content));
    }
    return parts.join('');
  } catch {
    return '> [转发消息获取失败]\n';
  }
}

/** 展开引用：输出引用块，被引用消息按 depth+1 继续解析 */
async function parseReply(
  repliedId: string,
  depth: number,
  resolvers: MessageResolvers,
  images: string[],
  state: ParseState
): Promise<string> {
  try {
    const numericId = Number(repliedId);
    const original = await resolvers.getMsg(Number.isFinite(numericId) ? numericId : 0);
    const name = pickString([original?.sender?.nickname]) || '未知';
    const id = pickString([original?.sender?.user_id]);
    const time = typeof original?.time === 'number' && original.time > 0 ? resolvers.formatTime(original.time) : '';
    const content = await parseSegments(original?.message, depth + 1, resolvers, images, state);
    return quoteBlock(name, id, time, content);
  } catch {
    return '> [引用消息获取失败]\n';
  }
}

/**
 * 解析消息段数组为可读文本：
 * 文本 → 原文；@提及 → `@昵称`（群聊上下文，缺失回退 `@QQ号`，`all` → `@全体成员`）；
 * 图片 → `[图片]`（depth ≤ 1 且开启 forwardImages 时原图入 images）；
 * 视频/语音 → `[视频]` / `[语音]`；引用/转发 → 拉取并逐块展开（depth+1，见文件头深度表）。
 *
 * `images` 为调用方持有的收集数组（函数只追加）；`state` 省略时按单次解析新建（昵称解析开启）。
 */
export async function parseSegments(
  segments: unknown,
  depth: number,
  resolvers: MessageResolvers,
  images: string[],
  state?: ParseState
): Promise<string> {
  if (typeof segments === 'string') return segments;
  if (!Array.isArray(segments)) return '';
  const current = state ?? createParseState(true);
  const parts: string[] = [];

  for (const segment of segments) {
    if (current.segmentCount >= PARSE_LIMITS.maxSegments) break;
    current.segmentCount++;
    const data = segmentData(segment);

    switch (segmentType(segment)) {
      case 'text': {
        const text = data.text;
        if (typeof text === 'string') parts.push(text);
        break;
      }
      case 'at': {
        const qq = pickString([data.qq]);
        if (qq === 'all') parts.push('@全体成员');
        else if (qq) parts.push(`@${(await resolveAtName(qq, resolvers, current)) ?? qq}`);
        break;
      }
      case 'image': {
        parts.push('[图片]');
        if (!resolvers.forwardImages || depth > PARSE_LIMITS.maxImageDepth) break;
        if (images.length >= PARSE_LIMITS.maxImages) break;
        const url = await resolveImageSafe(segment, resolvers);
        if (url) images.push(url);
        break;
      }
      case 'video':
        parts.push('[视频]');
        break;
      case 'record':
        parts.push('[语音]');
        break;
      case 'reply':
      case 'forward': {
        const id = readId(data.id);
        if (!id) break;
        const key = `${segmentType(segment)}:${id}`;
        // depth ≥ 3 不拉取；已展开过的 id（含自环）不再进入，统一留占位
        if (depth >= PARSE_LIMITS.maxDepth || current.visitedIds.has(key)) {
          parts.push(FORWARD_PLACEHOLDER);
          break;
        }
        current.visitedIds.add(key);
        parts.push(
          segmentType(segment) === 'reply'
            ? await parseReply(id, depth, resolvers, images, current)
            : await parseForward(id, depth, resolvers, images, current)
        );
        break;
      }
      default:
        break;
    }
  }

  return parts.join('').trim();
}

/**
 * 解析整条消息（触发消息本身为 depth 0）：
 * - 非数组输入（string/undefined 等）→ text 为该字符串或 ''，images 为 []；
 * - `groupId` 为 undefined（私聊）时 @提及 不查昵称，直接回退 `@QQ号`；
 * - 图片收集上限、段/节点上限与 visitedIds 去重见 PARSE_LIMITS。
 */
export async function parseMessage(
  message: unknown,
  groupId: number | undefined,
  resolvers: MessageResolvers
): Promise<ParsedMessage> {
  const images: string[] = [];
  if (typeof message === 'string') return { text: message, images };
  if (!Array.isArray(message)) return { text: '', images };
  const state = createParseState(groupId !== undefined);
  const text = await parseSegments(message, 0, resolvers, images, state);
  return { text, images };
}
