import { bot, QQBot } from '@/index';
import {
  GroupDecreaseNoticeWSMSG,
  GroupIncreaseNoticeWSMSG,
  GroupMessageWSMSG,
  GroupRequestWSMSG,
  Message,
  NotifyNoticeWSMSG,
  PrivateMessageWSMSG
} from '@/type';
import { EventDataManager } from '@/event';
import { ParenthesesMatching } from '@/features/parentheses';
import { Github } from '@/features/github';
import { GitHubBindingManager } from '@/features/github/binding';
import { Poke } from '@/features/poke';
import { Arguments, CommandManager, CommandSource } from 'gugle-command';
import { isBotCommandSource, resolveOperatorId } from '@/command';
import { MinecraftAPI } from '@/features/minecraft';
import { ModrinthAPI } from '@/features/modrinth';
import {
  getFeatureGroups,
  isValidRepositoryName,
  isValidRepositoryOwner,
  subscribeGithubRepository
} from '@/config/features';
import { addGithubAllowedRepository, isGithubAllowedPattern } from '@/config';
import { checkReleasedVersion } from '@/features/version-tracker';
import { Bili } from '@/features/bili';
import { Management } from '@/features/management';
import { Welcome } from '@/features/welcome';
import { PeakValleyTimer } from '@/features/peak-valley-timer';
import {
  isRestartedByCommand,
  isRestartInProgress,
  reloadRuntime,
  restartApplication,
  restartStartDelayMs,
  shutdownApplication
} from '@/features/admin';
import { DiscordBridge } from '@/features/discord-bridge';
import { HermesBridge } from '@/features/hermes';

class CustomBot {
  private static readonly peakValleyTimer: PeakValleyTimer = PeakValleyTimer.getInstance();

  /** 重启/关停在发送确认消息后的延迟，确保回执先发出再动进程 */
  private static readonly REBOOT_CONFIRM_DELAY_MS = 500;

  public static helpCommand(source: CommandSource) {
    source.success(`帮助
· /mcv：获取 Minecraft 版本信息
· /server <ip> <port?>：获取 Minecraft 服务器状态
· /wiki <query>：搜索 Minecraft 维基
· /github bind <Username>：绑定 GitHub 用户名
· /github subscribe <owner/repo>：订阅仓库消息推送
· /github allow <owner|owner/repo>：授权仓库访问（管理员）
· /pardon <QQ号>：把用户移出黑名单（管理员）
· /send <msg> [group|channel]：向互通的 Discord 频道/QQ 群发送消息（不填目标时发送到第一个互通条目的对端）
· /pvtime：查询当前是梁文峰时间还是梁文谷时间
· /reload：从磁盘重载配置与数据文件（管理员）
· /reboot：重启应用（管理员）
· /shutdown：关闭应用（管理员）
以上命令均可在互通的 Discord 频道中使用（/ 或 ! 前缀），回复发在 Discord 频道
在启用的群/互通频道 @机器人 或命中关键词即可与 AI 对话（停止 / 清除上下文 为控制指令）`);
  }

  public static peakValleyTimeCommand(source: CommandSource) {
    source.success(CustomBot.peakValleyTimer.getCommandMessage());
  }

  public static minecraftVersionCommand(source: CommandSource) {
    MinecraftAPI.getVersion().then(version => {
      source.success(
        `Minecraft 版本信息
· 最新正式版：${version.latest.release}
· 最新快照版：${version.latest.snapshot}`
      );
    });
  }

  public static serverCommand(source: CommandSource, ip: string, port: number = 25565) {
    MinecraftAPI.getMinecraftServerStatus(ip, port).then(status => {
      if (!status.online) {
        source.success('服务器已离线');
        return;
      }
      let onlinePlayers = '';
      for (const player of status.players.list) {
        if (onlinePlayers) onlinePlayers += '\n';
        onlinePlayers += `  - ${player}`;
      }
      source.success(
        `${status.motd}
· 游戏版本：${status.version}
· 在线玩家：${status.players.online}/${status.players.max}
· 在线列表：\n` + onlinePlayers
      );
    });
  }

  public static wikiCommand(source: CommandSource, query: string) {
    MinecraftAPI.getMinecraftWiki(query).then(wiki => {
      if (!wiki.success) {
        source.success('未找到相关结果！');
        return;
      }
      source.success(`${wiki.title}
${wiki.desc}
${wiki.url}`);
    });
  }

  public static githubBindCommand(source: CommandSource, username: string) {
    if (!isBotCommandSource(source)) {
      source.fail('GitHub 绑定仅支持在群聊或互通频道中使用');
      return;
    }

    GitHubBindingManager.bind(source.getUserId(), username)
      .then(result => {
        if (result.state === 'bound') {
          source.success(`GitHub 用户 ${username} 绑定成功`);
          return;
        }
        source.success(`请在 GitHub 用户 ${username} 的 Bio 中添加验证码：${result.code}\n添加后再次执行 /github bind ${username}`);
      })
      .catch(error => {
        source.fail(error instanceof Error ? error.message : String(error));
      });
  }

  public static githubSubscribeCommand(source: CommandSource, repository: string) {
    if (!isBotCommandSource(source)) {
      source.fail('GitHub 订阅仅支持在群聊或互通频道中使用');
      return;
    }
    if (!isValidRepositoryName(repository)) {
      source.fail(`仓库名格式错误：${repository}\n应为 owner/repo，例如 Anvil-Dev/AnvilCraft`);
      return;
    }
    const groupId = source.getGroupId();
    if (groupId === undefined) {
      source.fail('当前频道未绑定互通 QQ 群，无法订阅');
      return;
    }
    // 与消息查询同一套判定：owner 已绑定 GitHub 账号，或命中允许列表配置
    let allowedText = '';
    if (!Github.isAllowedRepository(repository)) {
      if (!source.isAdmin()) {
        source.fail(
          `仓库 ${repository} 不在允许访问的仓库列表中，无法订阅\n` +
            `如这是你自己的仓库，可先用 /github bind <用户名> 绑定 GitHub 账号，或联系管理员添加`
        );
        return;
      }
      // 管理员可自助开白：把该 owner 加入允许列表后继续订阅
      const owner = repository.split('/')[0]!;
      addGithubAllowedRepository(owner);
      allowedText = `· 已自动将 ${owner} 加入允许访问的仓库列表\n`;
    }
    const subscribers = subscribeGithubRepository(repository, groupId);
    const current = subscribers.includes(groupId) ? `已订阅仓库 ${repository} 的消息推送` : `订阅失败，请重试`;
    source.success(
      `${current}
· 当前订阅该仓库的群：${subscribers.length > 0 ? subscribers.join('、') : '（无）'}
${allowedText}· 若该仓库尚未配置 webhook，请在仓库页面 Settings → Webhooks → Add webhook 添加：
  · Payload URL：https://hook.example.com
  · Content type：application/json
  · Secret：留空
  · Which events would you like to trigger this webhook?：Send me everything.`
    );
  }

  /**
   * /github allow <owner|owner/repo>：把 GitHub owner 或仓库加入允许访问列表（管理员）。
   * 传入 owner 时授权其下全部仓库，传入 owner/repo 时只授权该仓库。
   */
  /** 管理员运维命令的公共权限校验（QQ 侧 operators / Discord 侧服务器管理员） */
  private static requireAdmin(source: CommandSource): boolean {
    if (!isBotCommandSource(source)) {
      source.fail('该命令仅支持在群聊或互通频道中使用');
      return false;
    }
    if (!source.isAdmin()) {
      source.fail('该命令仅限管理员使用');
      return false;
    }
    return true;
  }

  /** /reload：从磁盘重载配置与数据文件 */
  public static reloadCommand(source: CommandSource) {
    if (!CustomBot.requireAdmin(source)) return;
    reloadRuntime({
      eventData: () => EventDataManager.reload(),
      githubBindings: () => GitHubBindingManager.reload(),
      extra: [{ name: '峰谷时段计时器', run: () => CustomBot.peakValleyTimer.reloadConfig() }]
    })
      .then(report => {
        const lines = [
          '♻️ 配置与数据已从磁盘重载',
          `· 配置文件：${report.configStores} 个`,
          `· 事件数据（黑名单/版本记录）：${report.eventData ? '已重载' : '失败'}`,
          `· GitHub 绑定：${report.githubBindings ? '已重载' : '失败'}`
        ];
        if (report.extras.length > 0) lines.push(`· 其他模块：${report.extras.join('、')}`);
        lines.push('· bot-config.json 中的端口/Token 需重启才生效（/reboot）');
        source.success(lines.join('\n'));
      })
      .catch(error => {
        source.fail(`重载失败：${error instanceof Error ? error.message : String(error)}`);
      });
  }

  /**
   * /reboot：重启应用（拉起新进程 → 健康检查通过后才退出当前进程）。
   *
   * 关键：健康检查失败时**不退出**当前进程（机器人保持在线），并向触发者回报失败原因。
   * 早期实现 spawn 后无条件 exit，一旦新进程启动失败（如丢失 tsx 加载器导致别名解析失败）
   * 就会让机器人直接离线。
   */
  public static async rebootCommand(source: CommandSource) {
    if (!CustomBot.requireAdmin(source)) return;
    if (isRestartInProgress()) {
      source.fail('已有重启正在进行中，请稍候');
      return;
    }
    source.success('🔄 正在重启应用，请稍候…');
    // 先让确认消息发出去，再执行重启（restartApplication 内部含健康检查与退出缓冲）
    await new Promise(resolve => setTimeout(resolve, CustomBot.REBOOT_CONFIRM_DELAY_MS));
    try {
      const result = await restartApplication();
      if (!result.alive) {
        const detail = result.logTail ? `\n${result.logTail.split('\n').slice(-6).join('\n')}` : '';
        bot.logger?.error(`[Admin] /reboot 失败：新进程 ${result.pid} 已退出，当前进程继续运行${detail}`);
        source.fail(`重启失败（当前进程继续运行）：新进程启动后立即退出${detail}`);
        return;
      }
      bot.logger?.info(`[Admin] /reboot 由 ${source.getName()} 触发，新进程 pid=${result.pid}，当前进程即将退出`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      bot.logger?.error(`[Admin] /reboot 失败: ${message}`);
      source.fail(`重启失败（当前进程继续运行）：${message}`);
    }
  }

  /** /shutdown：关闭应用 */
  public static shutdownCommand(source: CommandSource) {
    if (!CustomBot.requireAdmin(source)) return;
    source.success('🛑 正在关闭应用…');
    bot.logger?.warn(`[Admin] /shutdown 由 ${source.getName()} 触发`);
    setTimeout(() => shutdownApplication(() => bot.stop()), CustomBot.REBOOT_CONFIRM_DELAY_MS);
  }

  public static githubAllowCommand(source: CommandSource, target: string) {
    if (!isBotCommandSource(source)) {
      source.fail('GitHub allow 仅支持在群聊或互通频道中使用');
      return;
    }
    if (!source.isAdmin()) {
      source.fail('该命令仅限管理员使用');
      return;
    }
    const repositoryTarget = target.includes('/');
    if (repositoryTarget ? !isValidRepositoryName(target) : !isValidRepositoryOwner(target)) {
      source.fail(
        `目标格式错误：${target}\n` +
          `应为 owner（授权其下全部仓库，如 Anvil-Dev）或 owner/repo（仅授权该仓库，如 Anvil-Dev/AnvilCraft）`
      );
      return;
    }
    const existed = isGithubAllowedPattern(target);
    const pattern = addGithubAllowedRepository(target);
    if (existed) {
      source.success(`${pattern} 已在允许访问的仓库列表中`);
      return;
    }
    source.success(
      repositoryTarget
        ? `已将仓库 ${pattern} 加入允许访问的仓库列表`
        : `已将 ${pattern} 加入允许访问的仓库列表，其下全部仓库均可访问`
    );
  }

  public static pardonCommand(source: CommandSource, userId: string) {
    if (!isBotCommandSource(source)) {
      source.fail('只支持在群聊或互通频道中使用');
      return;
    }
    // 命令层先拦一道：非管理员直接拒绝（QQ = operators 白名单；Discord = 服务器管理员或 dc 白名单）
    if (!source.isAdmin()) {
      source.fail('该命令仅限管理员使用');
      return;
    }
    const groupId = source.getGroupId();
    if (groupId === undefined) {
      source.fail('当前频道未绑定互通 QQ 群，无法赦免');
      return;
    }
    const qq = Number(userId);
    if (!Number.isSafeInteger(qq) || qq <= 0) {
      source.fail(`QQ 号格式错误：${userId}`);
      return;
    }
    // 命令源经 FailOnceCommandSource 代理后不再是 GroupMsgCommandSource 实例，
    // 因此不能用 instanceof 区分平台（否则 QQ 管理员会被当成 Discord 用户判失败）。
    // 改为按 BotCommandSource 的 id 约定推导（纯数字=QQ 号，dc: 前缀=Discord 用户）。
    const operatorId = resolveOperatorId(source);
    Management.pardon(groupId, operatorId, qq)
      .then(removed => {
        if (removed) {
          source.success(`已从黑名单中移除用户 ${qq}`);
        } else {
          source.fail('用户不在黑名单中，或你没有赦免权限');
        }
      })
      .catch(error => {
        source.fail(error instanceof Error ? error.message : String(error));
      });
  }

  @bot.subscribe('notice-event-notify', false)
  public listenPokeMsg(bot: QQBot, msg: NotifyNoticeWSMSG): void {
    if (!msg.sub_type || msg.sub_type != 'poke') return;
    const sentMessage: Message[] = [
      {
        type: 'at',
        data: {
          qq: msg.user_id
        }
      },
      {
        type: 'text',
        data: {
          text: ' '
        }
      }
    ];
    Poke.processPokeMsg(bot, msg, sentMessage);
    if (sentMessage.length > 2) {
      if (msg.group_id) {
        bot.sendGroupMsg(msg.group_id, sentMessage);
      } else {
        bot.sendPrivateMsg(msg.user_id, sentMessage);
      }
    }
  }

  @bot.subscribe('message-event-group', false)
  public listenGroupMsg(bot: QQBot, msg: GroupMessageWSMSG): void {
    const sentMessage: Message[] = [
      {
        type: 'reply',
        data: {
          id: msg.message_id
        }
      }
    ];
    ParenthesesMatching.parenthesesMatching(msg, sentMessage);
    // 各处理器失败只记录日志：既不能产生未处理的 rejection（会终止进程），
    // 也不能中断后续处理器与最终的消息发送
    Github.processMessage(bot, msg, sentMessage)
      .catch(e => {
        bot.logger?.error(`Github message process failed: ${e?.message ?? e}`);
      })
      .then(() => Bili.processMessage(bot, msg, sentMessage))
      .catch(e => {
        bot.logger?.error(`Bili message process failed: ${e?.message ?? e}`);
      })
      .then(() => {
        if (sentMessage.length > 1) {
          bot.sendGroupMsg(msg.group_id, sentMessage);
        }
      });
  }

  @bot.subscribe('message-event-group', false)
  public listenDiscordBridgeMsg(bot: QQBot, msg: GroupMessageWSMSG): void {
    // QQ ⇄ Discord 互通：转发与 /send 分发（不依赖 command 白名单，内部自行门控）
    DiscordBridge.getInstance().handleQQMessage(bot, msg);
  }

  @bot.subscribe('message-event-group', false)
  public listenHermesGroupMsg(bot: QQBot, msg: GroupMessageWSMSG): void {
    // QQ ⇄ Hermes Agent 桥接：@提及/关键词触发 AI 对话（内部自行门控：hermes.json groups）
    HermesBridge.getInstance().handleGroupMessage(bot, msg);
  }

  @bot.subscribe('message-event-private', false)
  public listenHermesPrivateMsg(bot: QQBot, msg: PrivateMessageWSMSG): void {
    // Hermes 私聊始终可触发（受 hermes.json 用户黑白名单约束）
    HermesBridge.getInstance().handlePrivateMessage(bot, msg);
  }

  @bot.subscribe('notice-event-group-decrease', false)
  public listenGroupDecreaseNotice(bot: QQBot, msg: GroupDecreaseNoticeWSMSG): void {
    Management.handleGroupDecreaseNotice(bot, msg);
  }

  @bot.subscribe('notice-event-group-increase', false)
  public listenGroupIncreaseNotice(bot: QQBot, msg: GroupIncreaseNoticeWSMSG): void {
    Management.handleGroupIncreaseNotice(bot, msg);
    Welcome.handleGroupIncreaseNotice(bot, msg);
  }

  @bot.subscribe('request-event-group', false)
  public listenGroupRequest(bot: QQBot, msg: GroupRequestWSMSG): void {
    Management.handleGroupRequest(bot, msg);
  }

  @bot.subscribe('command-register', false)
  public cmd(bot: QQBot, command: CommandManager) {
    command.register('gugle-command', CommandManager.literal('help').execute(CustomBot.helpCommand));
    command.register('gugle-command', CommandManager.literal('mcv').execute(CustomBot.minecraftVersionCommand));
    command.register(
      'gugle-command',
      CommandManager.literal('server').then(
        CommandManager.argument('ip', Arguments.STRING)
          .execute(CustomBot.serverCommand)
          .then(CommandManager.argument('port', Arguments.NUMBER).execute(CustomBot.serverCommand))
      )
    );
    command.register(
      'gugle-command',
      CommandManager.literal('wiki').then(
        CommandManager.argument('query', Arguments.STRING).execute(CustomBot.wikiCommand)
      )
    );
    command.register(
      'gugle-command',
      CommandManager.literal('github')
        .then(
          CommandManager.literal('bind').then(
            CommandManager.argument('username', Arguments.STRING).execute(CustomBot.githubBindCommand)
          )
        )
        .then(
          CommandManager.literal('subscribe').then(
            CommandManager.argument('repository', Arguments.STRING).execute(CustomBot.githubSubscribeCommand)
          )
        )
        .then(
          CommandManager.literal('allow').then(
            CommandManager.argument('target', Arguments.STRING).execute(CustomBot.githubAllowCommand)
          )
        )
    );
    command.register(
      'gugle-command',
      CommandManager.literal('pardon').then(
        CommandManager.argument('userId', Arguments.STRING).execute(CustomBot.pardonCommand)
      )
    );
    command.register('gugle-command', CommandManager.literal('pvtime').execute(CustomBot.peakValleyTimeCommand));
    // 管理员运维命令：权限在命令实现内校验（QQ operators / Discord 服务器管理员）
    command.register('gugle-command', CommandManager.literal('reboot').execute(CustomBot.rebootCommand));
    command.register('gugle-command', CommandManager.literal('reload').execute(CustomBot.reloadCommand));
    command.register('gugle-command', CommandManager.literal('shutdown').execute(CustomBot.shutdownCommand));
  }

  @bot.subscribe('after-start', false)
  public startPeakValleyTimer(bot: QQBot): void {
    if (isRestartedByCommand()) {
      bot.logger?.info('[Admin] 本进程由 /reboot 拉起（上一进程已退出）');
    }
    CustomBot.peakValleyTimer.start(bot);
    DiscordBridge.getInstance().start(bot);
    // 清理上次进程在 AI 处理中退出时残留的 QQ 表情回应（Discord 残留在 clientReady 后清理）
    HermesBridge.getInstance().cleanupStaleQQReactions(bot).catch(error => {
      bot.logger?.error(`[Hermes] 残留表情回应清理失败: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  @bot.cron('*/30 * * * * *')
  public cronCheckMinecraftVersion() {
    MinecraftAPI.getVersion().then(version => {
      if (!version.success) return;
      // 从 manifest 中按 id 查找 release / snapshot 的权威 releaseTime，
      // 用时间戳单调性判断新发布，避免 CDN 缓存抖动重复发送
      const releaseId = version.latest.release;
      const snapshotId = version.latest.snapshot;
      const releaseTime = version.versions.find(v => v.id === releaseId)?.releaseTime || '';
      const snapshotTime = version.versions.find(v => v.id === snapshotId)?.releaseTime || '';
      Promise.all([
        checkReleasedVersion('mcupdate:release', releaseId, Date.parse(releaseTime) || 0),
        checkReleasedVersion('mcupdate:snapshot', snapshotId, Date.parse(snapshotTime) || 0)
      ]).then(([releaseNew, snapshotNew]) => {
        const msg: Message[] = [
          {
            type: 'text',
            data: {
              text: '发现新版本！\n'
            }
          }
        ];
        if (releaseNew) {
          msg.push({
            type: 'text',
            data: {
              text: `· 最新正式版：${version.latest.release}\n`
            }
          });
          msg.push({
            type: 'text',
            data: {
              text: `https://www.minecraft.net/en-us/article/minecraft-java-edition-${version.latest.release.replace('.', '-')}`
            }
          });
        }
        if (snapshotNew) {
          msg.push({
            type: 'text',
            data: {
              text: `· 最新快照版：${version.latest.snapshot}\n`
            }
          });
          let snapshot = version.latest.snapshot;
          if (snapshot.includes('pre')) {
            snapshot = snapshot.replace('pre', 'pre-release');
          } else if (snapshot.includes('rc')) {
            snapshot = snapshot.replace('rc', 'release-candidate');
          }
          snapshot = snapshot.replace('.', '-');
          msg.push({
            type: 'text',
            data: {
              text: `https://www.minecraft.net/en-us/article/minecraft-${snapshot}`
            }
          });
        }
        // 只有 release 或 snapshot 任一被确认为新发布才发送
        if (!releaseNew && !snapshotNew) return;
        for (const listener of getFeatureGroups('minecraft')) {
          bot.sendGroupMsg(listener, msg);
        }
      });
    });
  }

  // @bot.cron('0/30 * * * * *')
  // public cronCheckAeronauticsVersion() {
  //   ModrinthAPI.checkVersion(bot, 'create-aeronautics', '航空学');
  // }
}

export default function run() {
  return new CustomBot();
}
