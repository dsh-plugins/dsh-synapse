import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { configStoreCount, reloadAllConfigStores } from '@/config/manager';

/**
 * 管理员运维命令：/reboot、/reload、/shutdown。
 *
 * 设计要点：
 * - 仅管理员可用（QQ 侧 = management operators，Discord 侧 = 服务器管理员），
 *   权限校验由调用方（命令实现）在进入本模块前完成；
 * - `/reboot` 采用「进程内自重启」：先拉起一个脱离父进程的新实例，确认其存活后再退出当前进程。
 *   因此不依赖外部守护进程（本仓库无 pm2/Docker/systemd 配置）；
 *   若外部同时有守护进程拉起，会短暂出现两个实例抢同一 QQ 号，需避免混用；
 * - 重启/关停前先发一条确认消息，并等待其发送完成，避免「刚回复就被杀」导致用户收不到回执；
 * - 退出前留一小段缓冲，保证 QQ 侧消息已真正发出、且日志已落盘。
 *
 * 关于启动参数（2026-10-22 生产事故修复）：
 * 生产用 `tsx src/index.ts` 运行，tsx 的加载器参数位于 **process.execArgv**
 * （`--require .../preflight.cjs --import .../loader.mjs`），而未在 process.argv 中。
 * 早期实现只转发 process.argv，导致新进程变成裸 `node /data/src/index.ts`，
 * `@/` 路径别名无法解析（ERR_MODULE_NOT_FOUND: Cannot find package '@/config'），
 * 且父进程无条件退出 → 机器人直接离线。现在：
 * 1. buildRestartCommand() 重建命令时必须带上 execArgv；
 * 2. restartApplication() 在退出父进程前做健康检查，子进程秒退则回滚（父进程继续运行）；
 * 3. 子进程通过 QQBOT_START_DELAY_MS 延迟启动，避免与旧进程的 QQ 连接重叠互踢。
 *
 * 环境变量逃生口：若部署由外部托管（容器 restart policy / pm2 / systemd / shell 脚本），
 * 可用 QQBOT_RESTART_COMMAND 指定重启命令（shell 执行），例如 `pm2 restart gugle-qq-bot`；
 * 未设置时按 buildRestartCommand() 重建 argv（默认路径，已带 tsx 加载器）。
 */

/** 重启/关停前的缓冲时间：给发送队列留出发送 + 日志刷盘的时间 */
const SHUTDOWN_GRACE_MS = 800;

/** 重启时用于标记「本进程由 /reboot 拉起」，避免新进程继承同名环境变量造成误判 */
const RESTART_ENV_FLAG = 'QQBOT_RESTARTED_BY_COMMAND';

/**
 * 自定义重启命令的环境变量名（逃生口）。
 *
 * 用法：某些部署由外部托管（容器 restart policy、pm2、systemd、一段 shell 脚本），
 * 直接重建 argv 可能与宿主拉起方式不一致。设置该变量后改为用 shell 执行此命令串，例如：
 * ```
 * QQBOT_RESTART_COMMAND="pm2 restart gugle-qq-bot"
 * QQBOT_RESTART_COMMAND="docker restart qq_bot"
 * ```
 * 未设置时走 buildRestartCommand() 重建 argv（默认路径）。
 */
const RESTART_COMMAND_ENV = 'QQBOT_RESTART_COMMAND';

/** 是否用了自定义重启命令（供日志/回执说明） */
export function customRestartCommand(): string | undefined {
  const raw = process.env[RESTART_COMMAND_ENV];
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/** 子进程延迟启动时间的环境变量名（避免新旧进程 QQ 连接重叠） */
const START_DELAY_ENV = 'QQBOT_START_DELAY_MS';

/** 子进程延迟启动默认值（毫秒） */
const DEFAULT_START_DELAY_MS = 2500;

/** 新进程存活观察窗口默认值（毫秒） */
const DEFAULT_HEALTH_CHECK_MS = 2000;

/** 健康检查通过后，父进程退出前的延迟（毫秒） */
const DEFAULT_EXIT_DELAY_MS = 300;

/** 子进程日志保留的文件名前缀 */
const CHILD_LOG_PREFIX = 'reboot-child';

/** 读日志尾部的最大字节数 */
const CHILD_LOG_TAIL_BYTES = 4096;

/** 重启进行中标记：拒绝并发 /reboot */
let restartInProgress = false;

export interface ReloadReport {
  /** 从磁盘重载的 ConfigStore 数量 */
  configStores: number;
  /** 是否成功重载事件数据（ban_list 等） */
  eventData: boolean;
  /** 是否成功重载 GitHub 绑定数据 */
  githubBindings: boolean;
  /** 额外重载的模块（按需由调用方追加说明） */
  extras: string[];
}

/**
 * 重载配置与数据文件（/reload）。
 *
 * 覆盖范围：
 * - 全部 ConfigStore（features/*.json、hermes.json、discord-bridge.json 等）→ 磁盘重读；
 * - 事件数据（configs/event-data.json，含 ban_list 与版本跟踪记录）；
 * - GitHub 绑定数据（configs/github-bind.json）；
 * - 由调用方传入的额外重载动作（如 PeakValleyTimer 这类构造期读配置的模块）。
 *
 * 不覆盖：bot-config.json（进程启动时读取，改端口/token 需重启）。
 */
export async function reloadRuntime(options: {
  eventData?: () => Promise<void>;
  githubBindings?: () => void;
  extra?: Array<{ name: string; run: () => void }>;
}): Promise<ReloadReport> {
  const extras: string[] = [];
  const configStores = reloadAllConfigStores();

  let eventData = false;
  try {
    await options.eventData?.();
    eventData = options.eventData !== undefined;
  } catch {
    eventData = false;
  }

  let githubBindings = false;
  try {
    options.githubBindings?.();
    githubBindings = options.githubBindings !== undefined;
  } catch {
    githubBindings = false;
  }

  for (const item of options.extra ?? []) {
    try {
      item.run();
      extras.push(item.name);
    } catch {
      // 单个模块重载失败不影响其余部分
    }
  }

  return { configStores, eventData, githubBindings, extras };
}

/** 已登记的配置仓库数量（用于 /reload 回执展示） */
export function registeredConfigStoreCount(): number {
  return configStoreCount();
}

/** 重建出的启动命令 */
export interface RestartCommand {
  /** 可执行文件（通常是 node） */
  command: string;
  /** 传给可执行文件的参数（含 tsx 加载器等 node 选项） */
  args: string[];
}

/** 需要从 execArgv 中剔除的「一次性的 eval 模式」选项：不能传递给子进程 */
const EVAL_ARG_FLAGS = new Set(['--eval', '-e', '--print', '-p']);
/** 这些选项带值，若以 `=` 形式出现也要识别（如 --eval=xxx） */
const EVAL_ARG_PREFIXES = ['--eval=', '-e=', '--print=', '-p='];

/**
 * 过滤 execArgv 中与「当前进程以 eval 模式运行」相关的参数。
 * 这类参数（`-e` / `--eval` / `-p` / `--print`）不可传递给子进程，
 * 否则子进程会把入口路径当成 eval 的表达式。
 */
function filterEvalArgs(execArgv: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < execArgv.length; index++) {
    const arg = execArgv[index]!;
    if (EVAL_ARG_FLAGS.has(arg)) {
      // 跳过该 flag 及其值
      index++;
      continue;
    }
    if (EVAL_ARG_PREFIXES.some(prefix => arg.startsWith(prefix))) continue;
    result.push(arg);
  }
  return result;
}

/**
 * 重建「重启自身」所需的启动命令（纯函数，便于测试）。
 *
 * 关键点：必须保留 process.execArgv —— 生产用 tsx 运行 TS 入口时，
 * tsx 的加载器（`--require preflight.cjs` / `--import loader.mjs`）只存在于
 * execArgv；遗漏会导致子进程以裸 node 执行 .ts 文件、`@/` 别名解析失败。
 *
 * @param execPath 当前 node 可执行文件路径（默认 process.execPath）
 * @param execArgv 当前 node 选项（默认 process.execArgv）
 * @param argv 当前进程参数（默认 process.argv；第 0 项为可执行文件、第 1 项为入口）
 * @returns 可直接交给 spawn 的命令与参数
 */
export function buildRestartCommand(
  execPath: string = process.execPath,
  execArgv: string[] = process.execArgv,
  argv: string[] = process.argv
): RestartCommand {
  const scriptArgs = argv.slice(1);
  if (scriptArgs.length === 0) throw new Error('无法获取当前启动命令，暂不能自重启');
  return {
    command: execPath,
    args: [...filterEvalArgs(execArgv), ...scriptArgs]
  };
}

/** 重启结果 */
export interface RestartResult {
  /** 新进程 pid */
  pid: number;
  /** 健康检查是否通过（false 表示子进程在观察窗口内退出，父进程未退出） */
  alive: boolean;
  /** 子进程日志尾部（失败时用于回报原因） */
  logTail?: string;
}

/** restartApplication 的可注入选项（测试用） */
export interface RestartOptions {
  /** 自定义启动命令；字符串表示走 shell，未指定时按 buildRestartCommand 重建 */
  restartCommand?: RestartCommand | { shell: string };
  /** 子进程存活观察窗口（毫秒） */
  healthCheckMs?: number;
  /** 健康检查通过后父进程退出延迟（毫秒） */
  exitDelayMs?: number;
  /** 子进程启动延迟（毫秒），通过 env 传给子进程 */
  startDelayMs?: number;
  /** 注入退出函数（默认 process.exit） */
  exit?: (code: number) => void;
  /** 注入 spawn（默认 node:child_process.spawn） */
  spawnImpl?: typeof spawn;
  /** 注入日志目录（默认 <cwd>/logs） */
  logDir?: string;
  /** 子进程工作目录（默认 process.cwd()；tsx 依赖 cwd 下的 tsconfig 解析 @/ 别名） */
  cwd?: string;
}

/** 重启进行中（拒绝并发触发） */
export function isRestartInProgress(): boolean {
  return restartInProgress;
}

/** 读取文件尾部文本（失败返回空串） */
function readTail(filePath: string, maxBytes: number = CHILD_LOG_TAIL_BYTES): string {
  try {
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString('utf-8').trim();
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * 进程内自重启：拉起新实例 → 健康检查 → 通过后才退出当前进程。
 *
 * 失败语义（重要）：只要子进程在观察窗口内退出 / spawn 抛错，就**不退出父进程**，
 * 返回 alive=false 与日志尾部，由调用方回报管理员。这样单次重启失败不会让机器人离线。
 *
 * @returns 新进程 pid 与健康检查结果
 */
export async function restartApplication(options: RestartOptions = {}): Promise<RestartResult> {
  if (restartInProgress) throw new Error('已有重启正在进行中，请稍候');
  restartInProgress = true;

  const {
    restartCommand: explicitRestartCommand,
    healthCheckMs = DEFAULT_HEALTH_CHECK_MS,
    exitDelayMs = DEFAULT_EXIT_DELAY_MS,
    startDelayMs = DEFAULT_START_DELAY_MS,
    exit = (code: number) => process.exit(code),
    spawnImpl = spawn,
    logDir = path.resolve(process.cwd(), 'logs'),
    cwd = process.cwd()
  } = options;

  // 优先级：显式传入 > QQBOT_RESTART_COMMAND 环境变量 > 按 execArgv 重建
  const shellCommand = customRestartCommand();
  const restartCommand: RestartCommand | { shell: string } | undefined =
    explicitRestartCommand ?? (shellCommand !== undefined ? { shell: shellCommand } : undefined);

  // 子进程日志：detached + inherit 时父进程退出会关闭管道，子进程后续写入可能 EPIPE，
  // 因此改为写入独立日志文件，同时保证启动失败的原因可查。
  let logPath = '';
  let logFd: number | undefined;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    logPath = path.join(logDir, `${CHILD_LOG_PREFIX}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
    logFd = fs.openSync(logPath, 'a');
  } catch {
    logFd = undefined; // 日志目录不可写时退化为忽略输出，健康检查仍生效
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [RESTART_ENV_FLAG]: '1',
    [START_DELAY_ENV]: String(Math.max(0, startDelayMs))
  };

  /** 清理日志 fd */
  const closeLog = (): void => {
    if (logFd !== undefined) {
      try {
        fs.closeSync(logFd);
      } catch {
        // 忽略
      }
      logFd = undefined;
    }
  };

  let child: ChildProcess;
  try {
    const stdio: Array<'ignore' | number> =
      logFd !== undefined ? ['ignore', logFd, logFd] : ['ignore', 'ignore', 'ignore'];
    if (typeof restartCommand === 'string') {
      child = spawnImpl(restartCommand, { cwd, env, detached: true, stdio, shell: true } as never);
    } else if (restartCommand !== undefined && 'shell' in restartCommand) {
      child = spawnImpl(restartCommand.shell, { cwd, env, detached: true, stdio, shell: true } as never);
    } else {
      const command = restartCommand ?? buildRestartCommand();
      child = spawnImpl(command.command, command.args, {
        cwd,
        env,
        detached: true,
        stdio
      });
    }
  } catch (error) {
    closeLog();
    restartInProgress = false;
    throw error;
  }

  const pid = child.pid;
  if (pid === undefined) {
    closeLog();
    restartInProgress = false;
    throw new Error('新进程启动失败（未获得 pid），已取消重启');
  }

  // ── 健康检查：观察窗口内退出 = 启动失败 ──
  const alive = await new Promise<boolean>(resolve => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      resolve(value);
    };
    const onExit = (): void => finish(false);
    const onError = (): void => finish(false);
    const timer = setTimeout(() => finish(true), Math.max(0, healthCheckMs));
    child.once('exit', onExit);
    child.once('error', onError);
  });

  if (!alive) {
    const logTail = logPath ? readTail(logPath) : '';
    closeLog();
    restartInProgress = false;
    return { pid, alive: false, ...(logTail ? { logTail } : {}) };
  }

  // 存活：脱离父进程后安排退出（关闭日志 fd 交给子进程继续持有写入）
  try {
    child.unref();
  } catch {
    // 忽略
  }
  setTimeout(() => {
    // 生产语义：进程即将退出，标记无需释放；但若 exit 被注入（测试/自定义退出），
    // 进程不会真的退出，必须释放标记，否则后续 /reboot 会被永久拒绝。
    restartInProgress = false;
    exit(0);
  }, Math.max(0, exitDelayMs));
  // 注意：不关闭 logFd —— 子进程仍在写同一个 fd
  return { pid, alive: true };
}

/**
 * 关闭应用：优雅停服后退出进程。
 *
 * @param stopBot 停止机器人（断开 WebSocket、触发 before-stop/after-stop）
 * @param delayMs 退出前的缓冲时间
 */
export function shutdownApplication(stopBot: () => void, delayMs: number = SHUTDOWN_GRACE_MS): void {
  try {
    stopBot();
  } finally {
    // 无论停服是否抛错都要退出，否则 /shutdown 形同虚设
    setTimeout(() => process.exit(0), delayMs);
  }
}

/** 本进程是否由 /reboot 拉起（用于启动日志标注） */
export function isRestartedByCommand(): boolean {
  return process.env[RESTART_ENV_FLAG] === '1';
}

/**
 * 本进程被 /reboot 拉起时要求的启动延迟（毫秒）。
 * 用于避免新旧进程同时连接 NapCat 造成同号互踢；非重启启动返回 0。
 */
export function restartStartDelayMs(): number {
  if (!isRestartedByCommand()) return 0;
  const raw = process.env[START_DELAY_ENV];
  if (!raw) return 0;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}
