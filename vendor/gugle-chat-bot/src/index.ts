import process from 'node:process';
import { Logger } from 'winston';
import { RawData, WebSocket } from 'ws';
import { botConfig, BotConfig } from '@/config';
import { getFeatureGroups, isOperator } from '@/config/features';
import fs from 'node:fs';
import dayjs from 'dayjs';
import { LoggerFactory } from '@/logger';
import { EventManager } from 'gugle-event';
import { GroupMessageWSMSG, LoginInfo, LoginInfoData, Message, NodeMessage, SentMessage, WSMSG } from '@/type';
import axios, { AxiosInstance } from 'axios';
import { Github } from '@/features/github';
import * as cron from 'node-cron';
import { BotEvent, BotEventCancelable, EventCallback } from '@/type/event';
import { CommandManager, CommandSource } from 'gugle-command';
import { BotCommandSource, executeCommand } from '@/command';
import { restartStartDelayMs } from '@/features/admin';

/** bot.sendGroupMsg 的附加选项 */
export interface SendGroupMsgOptions {
  /**
   * 标记该消息由互通桥自身发出（Discord→QQ 转发、/send 结果等）。
   * 发送出口监听器据此跳过，避免「转发出去的消息又被转发回 Discord」形成回环。
   */
  fromBridge?: boolean;
  /**
   * 标记该消息由 webhook 事件推送（GitHub issue/PR/release 订阅通知）。
   * 互通桥据此尊重频道门控：不转发到 need_cmd / need_reply 为 true 的频道
   * （命令回复、AI 对话等交互式机器人消息不受此限）。
   */
  fromWebhook?: boolean;
}

/** bot.sendGroupForwardMsg 的合并转发节点 */
export interface ForwardNode {
  /** 节点署名（缺省用 bot 昵称/QQ 号由调用方决定） */
  name?: string;
  uin?: string | number;
  /** 节点内容：纯文本或消息段数组 */
  content: string | Message[];
}

/** bot.sendGroupMsg 成功后的通知负载（供互通桥把机器人自身消息转发到 Discord） */
export interface GroupMessageSentEvent {
  groupId: number;
  message: SentMessage;
  /** OneBot 返回的消息 id；失败时为 undefined */
  messageId: number | undefined;
  /** 是否由互通桥自身发出（true 时监听方应忽略） */
  fromBridge: boolean;
  /** 是否由 webhook 事件推送（true 时互通桥尊重频道门控） */
  fromWebhook: boolean;
}

export class GroupMsgCommandSource implements BotCommandSource {
  public readonly bot: QQBot;
  public readonly msg: GroupMessageWSMSG;
  private readonly replayMsg: Message[];

  public constructor(bot: QQBot, msg: GroupMessageWSMSG) {
    this.bot = bot;
    this.msg = msg;
    this.replayMsg = [
      {
        type: 'reply',
        data: {
          id: this.msg.message_id
        }
      }
    ];
  }

  public getUserId(): string {
    return String(this.msg.sender.user_id);
  }

  public getGroupId(): number | undefined {
    return this.msg.group_id;
  }

  public isAdmin(): boolean {
    return isOperator(this.msg.sender.user_id);
  }

  public success(message: string): void {
    bot.sendGroupMsg(this.msg.group_id, [
      ...this.replayMsg,
      {
        type: 'text',
        data: {
          text: message
        }
      }
    ]);
  }

  public fail(message: string): void {
    bot.sendGroupMsg(this.msg.group_id, [
      ...this.replayMsg,
      {
        type: 'text',
        data: {
          text: message
        }
      }
    ]);
    bot.logger?.error(`[${this.msg.sender.nickname}|${this.msg.sender.user_id}] ${message}: ${this.msg.raw_message}`);
  }

  public getName(): string {
    return this.msg.sender.nickname;
  }

  public hasPermission(permission: string): boolean {
    if (!permission) return true;
    const getPermissionLevel = (text: string): number => {
      const level = Number.parseInt(text);
      if (Number.isNaN(level)) {
        return text === 'owner' ? 2 : text === 'admin' ? 1 : 0;
      }
      return Number.parseInt(text);
    };
    const permissionLevel: number = getPermissionLevel(this.msg.sender.role);
    const needPermissionLevel: number = getPermissionLevel(permission);
    bot.logger?.debug(
      `permission: ${permission}, role: ${this.msg.sender.role}, permissionLevel: ${permissionLevel}, needPermissionLevel: ${needPermissionLevel}, ${permissionLevel >= needPermissionLevel}`
    );
    return permissionLevel >= needPermissionLevel;
  }
}

export class QQBot {
  /** 断线后的最大重连次数 */
  private static readonly MAX_RECONNECT_ATTEMPTS = 10;
  /** 重连基础退避时长（毫秒）：第 n 次重试等待 BASE * 2^(n-1) */
  private static readonly RECONNECT_BASE_DELAY_MS = 2000;
  /** 单次退避上限（毫秒）：指数增长到此值后不再增大，避免等待时间失控 */
  private static readonly RECONNECT_MAX_DELAY_MS = 60000;

  private loginInfo?: LoginInfoData = undefined;
  private path: string = process.cwd();
  logger?: Logger;
  private readonly config: BotConfig;
  public readonly axiosInstance: AxiosInstance;
  private ws?: WebSocket;
  private readonly eventManager: EventManager;
  private readonly commandManager: CommandManager;
  private wsOpened: boolean = false;
  private lastHeartbeatTime: number = 0;
  private checkHeartbeatFunc?: NodeJS.Timeout = undefined;
  private reconnectFunc?: NodeJS.Timeout = undefined;
  private reconnectAttempts: number = 0;
  private stopping: boolean = false;
  private operationQueue: (() => void)[] = [];
  private lastOperationHandle = -1;
  /** bot.sendGroupMsg 成功后的监听器（互通桥用它转发机器人自身消息到 Discord） */
  private groupMessageSentListeners: ((event: GroupMessageSentEvent) => void)[] = [];

  public constructor(config: BotConfig) {
    this.config = config;
    this.eventManager = new EventManager();
    this.commandManager = new CommandManager();
    this.axiosInstance = axios.create({
      timeout: 15000,
      baseURL: config.httpUrl,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.httpToken}`,
        'User-Agent': config.userAgent
      }
    });
    setInterval(() => this.handlerOperationQueue(this), 2000);
  }

  /**
   * 建立 WebSocket 连接并注册事件处理。
   * 连接失败或断开时由 close 事件统一触发退避重连，因此这里可以安全地重复调用。
   */
  private connect(): void {
    const bot = this;
    bot.ws = new WebSocket(`${bot.config.wsUrl}/${bot.config.tokenParams}${bot.config.wsToken}`);
    bot.ws.on('open', () => {
      bot.wsOpened = true;
      bot.lastHeartbeatTime = Date.now();
      bot.logger?.info('WebSocket connected');
      bot.checkHeartbeatFunc = setTimeout(() => bot.checkHeartbeat(bot), 40000);
      bot
        .getLoginInfo()
        .then(info => {
          bot.loginInfo = info;
        })
        .catch((error: Error) => {
          bot.logger?.error(`获取登录信息失败：${error.message}`);
        });
    });
    bot.ws.on('message', rawData => {
      bot.post('websocket-message', bot, rawData).then();
    });
    bot.ws.on('error', (error: Error) => {
      if (error.message.endsWith('401')) {
        bot.logger?.error(`无法连接至 WebSocket 服务器，请检查你的 Token！${error.stack}`);
        return;
      }
      bot.logger?.error(`WebSocket error: ${error.stack ?? error.message}`);
    });
    bot.ws.on('close', (code: number, reason: Buffer) => {
      bot.wsOpened = false;
      clearTimeout(bot.checkHeartbeatFunc);
      bot.logger?.warn(`WebSocket closed: ${code} ${reason.toString('utf-8')}`);
      if (bot.stopping) return;
      bot.scheduleReconnect();
    });
  }

  /** 按指数退避安排下一次重连；达到上限后记录错误并停止重连 */
  private scheduleReconnect(): void {
    const bot = this;
    if (bot.reconnectAttempts >= QQBot.MAX_RECONNECT_ATTEMPTS) {
      bot.logger?.error(`WebSocket 重连已达上限（${QQBot.MAX_RECONNECT_ATTEMPTS} 次），停止重连`);
      return;
    }
    bot.reconnectAttempts++;
    const delay = Math.min(
      QQBot.RECONNECT_BASE_DELAY_MS * 2 ** (bot.reconnectAttempts - 1),
      QQBot.RECONNECT_MAX_DELAY_MS
    );
    bot.logger?.warn(
      `WebSocket 连接已断开，${delay}ms 后发起第 ${bot.reconnectAttempts}/${QQBot.MAX_RECONNECT_ATTEMPTS} 次重连`
    );
    bot.reconnectFunc = setTimeout(() => bot.connect(), delay);
  }

  public async start(path: string = process.cwd()): Promise<QQBot> {
    const bot = this;
    return new Promise(resolve => {
      bot.post('before-start', bot, path).then(args => {
        path = args[1];
        bot.path = path;
        const logPath = `${bot.path}/logs`;
        if (!fs.existsSync(logPath)) fs.mkdirSync(logPath);
        if (fs.existsSync(`${logPath}/latest.log`)) {
          let logName = `${logPath}/${dayjs().format('YYYY-MM-DD-HH-mm-ss')}.log`;
          let count = 0;
          while (fs.existsSync(logName)) {
            count++;
            logName = `${logPath}/${dayjs().format('YYYY-MM-DD-HH-mm-ss')}-${count}.log`;
          }
          fs.renameSync(`${logPath}/latest.log`, logName);
        }
        bot.logger = LoggerFactory.createLogger('QQBot', logPath, bot.config.logLevel || 'info');
        bot.logger.info(`QQ Bot starting...`);
        bot.listen('websocket-message', bot.onWebsocketMsg);
        bot.listen('meta-event-heartbeat', bot.onHeartbeat);
        bot.listen('message-event-group', bot.onGroupMsg);
        bot.connect();
        bot.post('command-register', bot, this.commandManager).then();
        bot.post('after-start', bot).then();
        resolve(bot);
      }).catch((error: Error) => {
        bot.logger?.error(`启动流程失败：${error.stack ?? error.message}`);
        resolve(bot);
      });
    });
  }

  public stop(): QQBot {
    this.stopping = true;
    clearTimeout(this.reconnectFunc);
    clearTimeout(this.checkHeartbeatFunc);
    // 在停止之前触发'before-stop'事件，传递当前实例
    this.post('before-stop', this).then(() => {
      // 如果WebSocket连接是打开的状态，关闭连接
      if (this.wsOpened) this.ws?.close();
      // 在停止之后触发'after-stop'事件，传递当前实例
      this.post('after-stop', this).then();
    });
    return this;
  }

  public async post(event: BotEvent, ...args: any): Promise<any[]> {
    return await this.eventManager.post(event, ...args);
  }

  /**
   * 心跳超时检测：超过 100 秒未收到心跳视为连接已断开，主动关闭以触发重连。
   * lastHeartbeatTime 记录的是「本次连接开始等待心跳的时刻」，避免刚连上就误判超时。
   */
  private checkHeartbeat(bot: QQBot) {
    if (Date.now() - bot.lastHeartbeatTime > 100000) {
      bot.logger?.error('WebSocket 心跳超时，重建连接...');
      bot.ws?.terminate();
    } else {
      bot.checkHeartbeatFunc = setTimeout(() => bot.checkHeartbeat(bot), 40000);
    }
  }

  private handlerOperationQueue(bot: QQBot) {
    const operation = bot.operationQueue.shift();
    if (!operation) return;
    this.lastOperationHandle = dayjs().valueOf();
    operation();
  }

  private operation(func: () => void) {
    const time = dayjs().valueOf();
    if (time - this.lastOperationHandle > 2000) {
      func();
      this.lastOperationHandle = time;
    } else {
      this.operationQueue.push(func);
    }
  }

  public listen<T extends BotEvent, C extends BotEventCancelable>(
    event: T,
    callback: EventCallback<T, C>,
    namespace: string = 'gugle-event',
    priority: number = 100,
    cancelable: C = false as C
  ) {
    this.eventManager.listen(event, callback, namespace, priority, cancelable);
  }

  private onWebsocketMsg(bot: QQBot, data: RawData) {
    let msg: WSMSG;
    try {
      msg = JSON.parse(data.toString('utf-8'));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      bot.logger?.error(`解析 WebSocket 消息失败：${reason}`);
      return;
    }
    bot.logger?.debug(`Received message: ${JSON.stringify(msg)}`);
    let eventName = 'unknown-event';
    if (msg.post_type == 'meta_event') {
      eventName = `meta-event-${msg.meta_event_type}`;
    }
    if (msg.post_type == 'message') {
      eventName = `message-event-${msg.message_type}`;
    }
    if (msg.post_type == 'notice') {
      eventName = `notice-event-${msg.notice_type}`;
    }
    if (msg.post_type == 'request') {
      eventName = `request-event-${msg.request_type}`;
    }
    eventName = eventName.toLowerCase().replace(/_/g, '-');
    bot.logger?.debug(`post notice event: ${eventName}`);
    bot.post(eventName, bot, msg).then();
  }

  private onHeartbeat(bot: QQBot, data: RawData) {
    bot.logger?.debug(`Received heartbeat: ${JSON.stringify(data)}`);
    // 收到心跳才说明对端确实在工作，此时才视为连接真正恢复并清零重连计数；
    // 仅握手成功（open）不足以判断，napcat 不可用时也会完成握手后立即断开。
    bot.reconnectAttempts = 0;
    bot.lastHeartbeatTime = Date.now();
    clearTimeout(bot.checkHeartbeatFunc);
    bot.checkHeartbeatFunc = setTimeout(() => bot.checkHeartbeat(bot), 40000);
  }

  private onGroupMsg(bot: QQBot, msg: GroupMessageWSMSG): void {
    if (!getFeatureGroups('command').includes(msg.group_id)) return;
    const command = msg.raw_message;
    if (!command.startsWith('/')) return;
    // 互通桥接的 /send 由 DiscordBridge 自行处理，不走命令分发
    // （否则 gugle-command 找不到 send 节点会回发 Invalid command）
    if (command.startsWith('/send')) {
      void import('@/features/discord-bridge')
        .then(module => {
          // /send 后必须是空白或结尾，/sendxxx 仍交给命令分发
          const rest = command.slice('/send'.length);
          if (rest && !/^\s/.test(rest)) {
            executeCommand(bot.commandManager, new GroupMsgCommandSource(bot, msg), command);
            return;
          }
          if (!module.DiscordBridge.isSendTargetGroup(msg.group_id)) {
            executeCommand(bot.commandManager, new GroupMsgCommandSource(bot, msg), command);
          }
        })
        .catch(e => {
          bot.logger?.error(`DiscordBridge /send dispatch failed: ${e?.message ?? e}`);
        });
      return;
    }
    executeCommand(bot.commandManager, new GroupMsgCommandSource(bot, msg), command);
  }

  // ------------------------------------------------
  // Decorators
  // ------------------------------------------------

  /**
   * 定义一个 cron 装饰器，用于根据给定的 cron 表达式调度任务
   *
   * @param _cron cron 表达式，六位格式：秒 分 时 日 月 周；秒与分使用步进语法（星号加斜杠步长）
   * @returns {(executor: (bot: QQBot) => void) => void} 返回一个函数，该函数接受一个执行器函数作为参数，并在指定时间执行该执行器函数
   *
   * @example
   * 每 30 秒执行一次：秒字段写步进 30，其余字段写星号
   */
  public cron(_cron: string): (executor: (bot: QQBot) => void) => void {
    // 保存当前实例的引用，以便在后续的执行器函数中使用
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self: QQBot = this;
    // 返回一个函数，该函数负责调度执行器函数
    return function (executor: (bot: QQBot) => void) {
      // 表达式非法时 cron.schedule 会直接抛出，这里记录带表达式的错误便于定位
      try {
        cron.schedule(_cron, () => {
          executor(self);
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        self.logger?.error(`cron 表达式非法（${_cron}）：${reason}`);
      }
    };
  }

  /**
   * 定义一个事件订阅装饰器，用于根据事件触发回调
   *
   * @param event {string} 事件名称
   * @param namespace {string} 命名空间，用于组织事件监听器
   * @param priority {number} 优先级，决定事件回调的执行顺序
   * @param cancelable {boolean} 是否可取消，决定是否可以取消事件，为 true 时，处理器第一个参数会传入 Cancelable
   * @returns {(callback: (...args: any) => void) => void} 一个函数，接受事件回调并注册该回调到指定事件
   *
   * @example
   * @ bot.subscribe('after-start', true)
   * public test(cancelable: Cancelable, bot: HeyBoxBot) {}
   */
  public subscribe<T extends BotEvent, C extends BotEventCancelable>(
    event: T,
    cancelable: C = false as C,
    namespace: string = 'gugle-event',
    priority: number = 100
  ): (callback: EventCallback<T, C>) => void {
    return this.eventManager.subscribe(event, namespace, priority, cancelable);
  }

  // ------------------------------------------------
  // API Methods
  // ------------------------------------------------

  public sendPrivateMsg(userID: string | number, message: SentMessage): Promise<number | undefined> {
    return new Promise(resolve => {
      this.operation(() => {
        this.axiosInstance
          .post(`/send_private_msg`, {
            user_id: userID,
            message: message
          })
          .then(res => resolve(res?.data?.data?.message_id))
          .catch(error => {
            this.logger?.error(`Failed to send private message to ${userID}: ${error.message}`);
            resolve(undefined);
          });
      });
    });
  }

  public sendGroupMsg(
    groupId: string | number,
    message: SentMessage,
    options?: SendGroupMsgOptions
  ): Promise<number | undefined> {
    return new Promise(resolve => {
      this.operation(() => {
        this.axiosInstance
          .post(`/send_group_msg`, {
            group_id: groupId,
            message: message
          })
          .then(res => {
            const messageId: number | undefined = res?.data?.data?.message_id;
            this.notifyGroupMessageSent({
              groupId: Number(groupId),
              message,
              messageId,
              fromBridge: options?.fromBridge === true,
              fromWebhook: options?.fromWebhook === true
            });
            resolve(messageId);
          })
          .catch(error => {
            this.logger?.error(`Failed to send group message to ${groupId}: ${error.message}`);
            resolve(undefined);
          });
      });
    });
  }

  /**
   * 以合并转发（聊天记录）形式发送群消息，用于超长 AI 回复等场景。
   *
   * 结构完全对齐 sendGroupMsg：同样走 operation 队列，失败只记录日志并回传 undefined（不 reject）；
   * 成功后照常通知互通桥，DiscordBridge 因而仍能镜像这条消息（它会把 node 段文本拍平后转发）。
   */
  public sendGroupForwardMsg(
    groupId: string | number,
    nodes: ForwardNode[],
    options?: SendGroupMsgOptions
  ): Promise<number | undefined> {
    return new Promise(resolve => {
      this.operation(() => {
        const message: NodeMessage[] = nodes.map(node => QQBot.toForwardNodeMessage(node));
        this.axiosInstance
          .post(`/send_group_forward_msg`, {
            group_id: groupId,
            message: message
          })
          .then(res => {
            const messageId: number | undefined = res?.data?.data?.message_id;
            this.notifyGroupMessageSent({
              groupId: Number(groupId),
              message,
              messageId,
              fromBridge: options?.fromBridge === true,
              fromWebhook: options?.fromWebhook === true
            });
            resolve(messageId);
          })
          .catch(error => {
            this.logger?.error(`Failed to send group forward message to ${groupId}: ${error.message}`);
            resolve(undefined);
          });
      });
    });
  }

  /** 把调用方的 ForwardNode 补成 OneBot 的 node 段（NapCat 口径：昵称与 QQ 号一律字符串化） */
  private static toForwardNodeMessage(node: ForwardNode): NodeMessage {
    // user_id 在类型里声明为 number，但 OneBot 实际接受/回传字符串（NapCat 口径即 String(uin)），这里按载荷需要断言
    return {
      type: 'node',
      data: {
        nickname: String(node.name ?? ''),
        user_id: String(node.uin ?? '') as unknown as number,
        content: typeof node.content === 'string' ? [{ type: 'text', data: { text: node.content } }] : node.content
      }
    };
  }

  /**
   * 注册「群消息发送成功」监听器。
   * 互通桥借此把机器人自身发出的消息（GitHub 通知、命令回复等）转发到 Discord。
   * 注意：监听器必须忽略 `fromBridge === true` 的事件，避免回环。
   */
  public onGroupMessageSent(listener: (event: GroupMessageSentEvent) => void): void {
    this.groupMessageSentListeners.push(listener);
  }

  private notifyGroupMessageSent(event: GroupMessageSentEvent): void {
    for (const listener of this.groupMessageSentListeners) {
      try {
        listener(event);
      } catch (e) {
        this.logger?.error(`groupMessageSent listener failed: ${(e as Error)?.message ?? e}`);
      }
    }
  }

  /** 暴露命令管理器（Discord 侧命令分发需要复用同一套命令树） */
  public getCommandManager(): CommandManager {
    return this.commandManager;
  }

  // 设置禁言
  public ban(groupId: number, userId: number, duration: number) {
    const bot = this;
    this.operation(() => {
      bot.logger?.info(`ban ${userId} in group ${groupId} for ${duration} seconds`);
      bot.axiosInstance
        .post(`/set_group_ban`, {
          group_id: `${groupId}`,
          user_id: `${userId}`,
          duration: duration
        })
        .then();
    });
  }

  // 踢出群聊
  public kick(groupId: number, userId: number) {
    const bot = this;
    this.operation(() => {
      bot.logger?.info(`kick ${userId} in group`);
      bot.axiosInstance
        .post(`/set_group_kick`, {
          group_id: `${groupId}`,
          user_id: `${userId}`,
          reject_add_request: false
        })
        .then();
    });
  }

  public getLoginInfo(): Promise<LoginInfoData> {
    return new Promise<LoginInfoData>((resolve, reject) => {
      if (!this.loginInfo) {
        this.axiosInstance
          .get<LoginInfo>(`/get_login_info`)
          .then(res => resolve(res.data.data))
          .catch(reject);
      } else {
        resolve(this.loginInfo);
      }
    });
  }

  public getUserInfo(userId: number) {
    const bot = this;
    return new Promise<{ user_id: string; nickname: string; qid: string }>((resolve, reject) => {
      this.operation(() => {
        bot.axiosInstance
          .post(`/get_stranger_info`, {
            user_id: `${userId}`
          })
          .then(res => resolve(res.data.data))
          .then();
      });
    });
  }

  public getLoginInfoSync(): LoginInfoData | undefined {
    return this.loginInfo;
  }

  public approveGroupAddRequest(flag: string) {
    const bot = this;
    this.operation(() => {
      bot.axiosInstance
        .post(`/set_group_add_request`, {
          flag: flag,
          sub_type: 'add',
          approve: true
        })
        .then();
    });
  }

  public denyGroupAddRequest(flag: string, reason?: string) {
    const bot = this;
    this.operation(() => {
      bot.axiosInstance
        .post(`/set_group_add_request`, {
          flag: flag,
          sub_type: 'add',
          approve: false,
          reason: reason
        })
        .then();
    });
  }
}

export const bot = new QQBot(botConfig);

// 全局兜底：单个异步任务失败（如 B 站返回 412、网络超时）不应终止机器人进程。
// 未处理的 Promise rejection 与未捕获异常统一记录日志后继续运行。
process.on('unhandledRejection', reason => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  (bot.logger ?? console).error(`Unhandled promise rejection: ${error.stack ?? error.message}`);
});

process.on('uncaughtException', error => {
  (bot.logger ?? console).error(`Uncaught exception: ${error.stack ?? error.message}`);
});

require('@/custom');

/**
 * 启动机器人（含 /reboot 拉起时的延迟启动）。
 *
 * /reboot 会先拉起新进程再退出旧进程；若新进程立刻连接 NapCat，会与旧进程的
 * 同号连接冲突（互踢 / 消息丢失）。因此被 /reboot 拉起时按 QQBOT_START_DELAY_MS
 * 延迟启动，给旧进程留出断开时间。正常启动该延迟为 0，行为不变。
 */
async function startBot(): Promise<void> {
  const restartDelay = restartStartDelayMs();
  if (restartDelay > 0) {
    (bot.logger ?? console).info(
      `[Admin] 本进程由 /reboot 拉起，延迟 ${restartDelay}ms 启动以避免与旧连接重叠`
    );
    await new Promise(resolve => setTimeout(resolve, restartDelay));
  }
  const started = await bot.start();
  const github = new Github(started);
  github.start(botConfig.githubPort);
}

startBot().catch(error => {
  (bot.logger ?? console).error(`启动失败: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
});
