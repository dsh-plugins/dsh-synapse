import { Cancelable } from 'gugle-event';
import { QQBot } from '@/index';
import {
  GroupDecreaseNoticeWSMSG,
  GroupIncreaseNoticeWSMSG,
  GroupMessageWSMSG,
  GroupRequestWSMSG,
  NotifyNoticeWSMSG,
  PrivateMessageWSMSG
} from '@/type/index';
import { RawData } from 'ws';
import { CommandManager } from 'gugle-command';

/**
 * 定义机器人运行时事件类型的元组
 * 用于标识机器人在不同运行阶段所触发的事件
 */
export declare type BeforeStartEvent = 'before-start';
export declare type AfterStartEvent = 'after-start';
export declare type BeforeStopEvent = 'before-stop';
export declare type AfterStopEvent = 'after-stop';
export declare type CommandRegisterEvent = 'command-register';

export declare type BotRuntimeEvent =
  | BeforeStartEvent
  | AfterStartEvent
  | BeforeStopEvent
  | AfterStopEvent
  | CommandRegisterEvent;

/**
 * 定义HeyBox事件类型的元组
 * 用于标识HeyBox特定事件，如命令消息、用户表情反应等
 */
export declare type GroupMessageEvent = 'message-event-group';
export declare type PrivateMessageEvent = 'message-event-private';
export declare type NotifyNoticeEvent = 'notice-event-notify';
export declare type GroupDecreaseNoticeEvent = 'notice-event-group-decrease';
export declare type GroupIncreaseNoticeEvent = 'notice-event-group-increase';
export declare type GroupRequestEvent = 'request-event-group';

export declare type QQEvent =
  | GroupMessageEvent
  | PrivateMessageEvent
  | NotifyNoticeEvent
  | GroupDecreaseNoticeEvent
  | GroupIncreaseNoticeEvent
  | GroupRequestEvent;

/**
 * 定义机器人所有事件类型的元组
 * 用于标识机器人在不同阶段所触发的事件，包括运行时事件、WebSocket消息事件和HeyBox事件
 */
export declare type WebSocketMessageEvent = 'websocket-message';

export declare type BotEvent = BotRuntimeEvent | WebSocketMessageEvent | QQEvent | string;

/**
 * 定义事件是否可取消的类型
 * 用于指示事件处理函数是否支持取消事件的默认行为
 */
export declare type BotEventCancelable = boolean;

export declare type CommandRegisterEventCallback<C extends BotEventCancelable> = C extends true
  ? (cancelable: Cancelable, bot: QQBot, command: CommandManager) => void
  : (bot: QQBot, command: CommandManager) => void;

/**
 * 定义机器人运行时事件的回调函数类型
 * 根据事件类型和是否可取消，决定回调函数的参数和返回类型
 */
export declare type BotRuntimeEventCallback<
  T extends BotRuntimeEvent,
  C extends BotEventCancelable
> = T extends CommandRegisterEvent
  ? CommandRegisterEventCallback<C>
  : T extends BeforeStartEvent
    ? C extends true
      ? (cancelable: Cancelable, bot: QQBot, path: string) => void
      : (bot: QQBot, path: string) => void
    : C extends true
      ? (cancelable: Cancelable, bot: QQBot) => void
      : (bot: QQBot) => void;

declare type GroupMessageEventCallback<C extends BotEventCancelable> = C extends true
  ? (cancelable: Cancelable, bot: QQBot, message: GroupMessageWSMSG) => void
  : (bot: QQBot, message: GroupMessageWSMSG) => void;

declare type PrivateMessageEventCallback<C extends BotEventCancelable> = C extends true
  ? (cancelable: Cancelable, bot: QQBot, message: PrivateMessageWSMSG) => void
  : (bot: QQBot, message: PrivateMessageWSMSG) => void;

declare type NotifyNoticeEventCallback<C extends BotEventCancelable> = C extends true
  ? (cancelable: Cancelable, bot: QQBot, message: NotifyNoticeWSMSG) => void
  : (bot: QQBot, message: NotifyNoticeWSMSG) => void;

declare type GroupDecreaseNoticeEventCallback<C extends BotEventCancelable> = C extends true
  ? (cancelable: Cancelable, bot: QQBot, message: GroupDecreaseNoticeWSMSG) => void
  : (bot: QQBot, message: GroupDecreaseNoticeWSMSG) => void;

declare type GroupIncreaseNoticeEventCallback<C extends BotEventCancelable> = C extends true
  ? (cancelable: Cancelable, bot: QQBot, message: GroupIncreaseNoticeWSMSG) => void
  : (bot: QQBot, message: GroupIncreaseNoticeWSMSG) => void;

declare type GroupRequestEventCallback<C extends BotEventCancelable> = C extends true
  ? (cancelable: Cancelable, bot: QQBot, message: GroupRequestWSMSG) => void
  : (bot: QQBot, message: GroupRequestWSMSG) => void;

export type GeneralEventCallback<T extends BotEvent, C extends BotEventCancelable> = C extends true
  ? (cancelable: Cancelable, ...args: any) => void
  : (...args: any) => void;

/**
 * 定义QQ事件的回调函数类型
 * 根据事件类型和是否可取消，决定回调函数的参数和返回类型
 */
export declare type QQEventCallback<T extends QQEvent, C extends BotEventCancelable> = T extends GroupMessageEvent
  ? GroupMessageEventCallback<C>
  : T extends PrivateMessageEvent
    ? PrivateMessageEventCallback<C>
    : T extends NotifyNoticeEvent
      ? NotifyNoticeEventCallback<C>
      : T extends GroupDecreaseNoticeEvent
        ? GroupDecreaseNoticeEventCallback<C>
        : T extends GroupIncreaseNoticeEvent
          ? GroupIncreaseNoticeEventCallback<C>
          : T extends GroupRequestEvent
            ? GroupRequestEventCallback<C>
            : GeneralEventCallback<T, C>;

declare type WebSocketMessageEventCallback<
  T extends WebSocketMessageEvent,
  C extends BotEventCancelable
> = C extends true ? (cancelable: Cancelable, bot: QQBot, data: RawData) => void : (bot: QQBot, data: RawData) => void;

/**
 * 定义通用事件回调函数类型
 * 根据事件类型和是否可取消，决定回调函数的参数和返回类型
 */
export declare type EventCallback<T extends BotEvent, C extends BotEventCancelable> = T extends BotRuntimeEvent
  ? BotRuntimeEventCallback<T, C>
  : T extends WebSocketMessageEvent
    ? WebSocketMessageEventCallback<T, C>
    : T extends QQEvent
      ? QQEventCallback<T, C>
      : GeneralEventCallback<T, C>;
