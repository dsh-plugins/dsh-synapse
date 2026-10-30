import { CommandManager, CommandSource } from 'gugle-command';

/**
 * 平台无关的命令源抽象。
 *
 * 背景：`gugle-command` 的 `CommandSource` 只有 success/fail/getName/hasPermission 四个方法，
 * 命令实现若直接 `instanceof GroupMsgCommandSource` 判定，就只能服务 QQ 群消息。
 * 这里扩展出跨平台需要的最小能力集，让同一套命令实现既能在 QQ 群、也能在 Discord 频道执行。
 */
export interface BotCommandSource extends CommandSource {
  /**
   * 调用者平台内唯一标识：
   * - QQ 群消息：纯数字 QQ 号字符串（如 `2308465862`）
   * - Discord 消息：`dc:<用户ID>`（如 `dc:123456789012345678`）
   *
   * 用于 GitHub 绑定等需要持久化用户身份的场景；`dc:` 前缀保证与纯数字 QQ 号不会冲突。
   */
  getUserId(): string;

  /**
   * 消息所在群/频道在当前平台上对应的互通 QQ 群号。
   * QQ 群消息返回自身群号；Discord 频道返回该频道桥接配置里的 QQ 群号；
   * 无归属群（未配置互通的 Discord 频道等）返回 undefined。
   */
  getGroupId(): number | undefined;

  /**
   * 是否为管理员：QQ 侧复用 management operators 白名单；
   * Discord 侧为服务器拥有者或拥有管理服务器/管理员权限者。
   */
  isAdmin(): boolean;
}

/** 判断命令源是否具备 BotCommandSource 能力（鸭子类型，跨模块实例也成立） */
export function isBotCommandSource(source: CommandSource | undefined): source is BotCommandSource {
  if (!source) return false;
  const candidate = source as Partial<BotCommandSource>;
  return (
    typeof candidate.getUserId === 'function' &&
    typeof candidate.getGroupId === 'function' &&
    typeof candidate.isAdmin === 'function'
  );
}

/**
 * 由命令源推导「操作者标识」，供需要区分平台的管理逻辑使用。
 *
 * 背景：`executeCommand` 会把命令源包进 `FailOnceCommandSource` 代理，
 * 命令实现里 `source instanceof GroupMsgCommandSource` 恒为 false——曾因此让
 * QQ 管理员执行 /pardon 被误判成 Discord 用户而失败。这里改为按 BotCommandSource
 * 的 id 约定判定，不依赖实例类型：
 * - 纯数字 → QQ 号，返回 number（Management 内部再校验 operators 白名单）；
 * - `dc:<用户ID>` → Discord 用户，原样返回字符串（服务器管理员身份已在命令源层校验）。
 */
export function resolveOperatorId(source: BotCommandSource): number | string {
  const userId = source.getUserId();
  return /^\d+$/.test(userId) ? Number(userId) : userId;
}

/**
 * 把命令文本规范化为 gugle-command 可执行的形式。
 *
 * gugle-command 固定使用 `/` 前缀；Discord 客户端会把以 `/` 开头的内容当作斜杠命令输入，
 * 因此 Discord 侧额外支持 `!` 前缀作为兜底，统一在这里转换。
 */
export function normalizeCommandText(text: string): string {
  return text.startsWith('!') ? `/${text.slice(1)}` : text;
}

/**
 * 失败去重代理：同一命令执行周期内，`fail` 只向用户上报第一次。
 *
 * 背景：gugle-command 的 `CommandNode.parse()` 在深层匹配失败时已调用一次
 * `source.fail('Invalid command')`，`CommandManager.execute()` 遍历完所有命名空间后
 * 又兜底调用一次——`/help abc` 这类「命令存在但参数多余」的输入会向用户回复两条
 * Invalid command。代理只放行第一次 fail（success 不受影响），修复重复回复。
 *
 * 注意：getUserId/getGroupId/isAdmin 按内部源是否有该方法条件绑定，
 * 保证 isBotCommandSource 鸭子类型检查对代理前后结果一致。
 */
class FailOnceCommandSource implements CommandSource {
  private readonly inner: CommandSource;
  private failed = false;

  public getUserId?: () => string;
  public getGroupId?: () => number | undefined;
  public isAdmin?: () => boolean;

  public constructor(inner: CommandSource) {
    this.inner = inner;
    if (isBotCommandSource(inner)) {
      this.getUserId = () => inner.getUserId();
      this.getGroupId = () => inner.getGroupId();
      this.isAdmin = () => inner.isAdmin();
    }
  }

  public success(message: string): void {
    this.inner.success(message);
  }

  public fail(message: string): void {
    if (this.failed) return;
    this.failed = true;
    this.inner.fail(message);
  }

  public getName(): string {
    return this.inner.getName();
  }

  public hasPermission(permission: string): boolean {
    return this.inner.hasPermission(permission);
  }
}

/**
 * 执行命令文本（经 FailOnce 代理，重复失败提示只上报一次）。
 * 所有命令分发入口（QQ 群、Discord 文本、Discord 交互）统一走这里。
 */
export function executeCommand(manager: CommandManager, source: CommandSource, command: string): void {
  manager.execute(new FailOnceCommandSource(source), command);
}

/**
 * 以精确 token 序列执行命令（不经字符串切分）。
 *
 * 用途：Discord 原生斜杠命令交互——参数值由 Discord 客户端按 option 给出，
 * 可能包含空格（如 /wiki 的查询词），若拼回字符串再经 gugle-command 按空格切分
 * 会被打散。这里把 token 逆序后直接喂给各命名空间根节点的 parse：
 * parse 逐 token 弹出匹配，字符串参数保持完整。
 *
 * @param tokens 完整 token 序列，如 ['github', 'bind', 'Gugle'] 或 ['wiki', '下界 合金']
 */
export function executeCommandTokens(manager: CommandManager, source: CommandSource, tokens: string[]): void {
  const wrapped = new FailOnceCommandSource(source);
  for (const root of manager.roots.values()) {
    if (root.parse([...tokens].reverse(), wrapped)) return;
  }
  wrapped.fail('Invalid command');
}
