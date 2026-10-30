export interface Sender {
  user_id: number;
  nickname: string;
  card: string;
}

export type GroupSender = Sender & {
  role: 'member' | 'owner' | 'admin';
};

export interface TextMessage {
  type: 'text';
  data: {
    text: string;
  };
}

export interface AtMessage {
  type: 'at';
  data: {
    qq: number;
  };
}

export interface ImageMessage {
  type: 'image';
  data: {
    file: string;
    /** NapCat/OneBot 下发的可访问直链（接收消息时存在，转发用） */
    url?: string;
  };
}

export interface FaceMessage {
  type: 'face';
  data: {
    id: number;
  };
}

export interface JsonMessage {
  type: 'json';
  data: {
    data: string;
  };
}

export interface RecordMessage {
  type: 'record';
  data: {
    file: string;
    /** NapCat/OneBot 下发的可访问直链（接收消息时存在，转发用） */
    url?: string;
  };
}

export interface VideoMessage {
  type: 'video';
  data: {
    file: string;
    /** NapCat/OneBot 下发的可访问直链（接收消息时存在，转发用） */
    url?: string;
  };
}

export interface ReplyMessage {
  type: 'reply';
  data: {
    id: number;
  };
}

export interface EnumMusicMessageData {
  type: '163' | 'qq';
  id: string;
}

export interface CustomMusicMessageData {
  type: 'custom';
  url: string;
  audio: string;
  title: string;
  image: string;
}

export type MusicMessageData = EnumMusicMessageData | CustomMusicMessageData;

export interface MusicMessage {
  type: 'music';
  data: MusicMessageData;
}

export interface DiceMessage {
  type: 'dice';
}

export interface RpsMessage {
  type: 'rps';
}

export interface FileMessage {
  type: 'file';
  data: {
    file: string;
    /** NapCat/OneBot 下发的可访问直链（接收消息时存在，转发用） */
    url?: string;
  };
}

export type Message =
  | TextMessage
  | AtMessage
  | FaceMessage
  | JsonMessage
  | RecordMessage
  | VideoMessage
  | ImageMessage
  | ReplyMessage
  | MusicMessage
  | DiceMessage
  | RpsMessage
  | FileMessage;

export interface NodeMessage {
  type: 'node';
  data: {
    user_id: number;
    nickname: string;
    content: Message[];
  };
}

export interface ForwardMessage {
  type: 'forward';
  data: {
    id: string;
  };
}

export type SentMessage = Message[] | NodeMessage[];

export type ReceiveMessage = Message[] | ForwardMessage[];

export interface MetaEventWSMSG {
  post_type: 'meta_event';
  time: number;
  self_id: number;
}

export type HeartbeatMetaEventWSMSG = MetaEventWSMSG & {
  meta_event_type: 'heartbeat';
  status: { online: boolean; good: boolean };
  interval: number;
};

export type LifecycleMetaEventWSMSG = MetaEventWSMSG & {
  meta_event_type: 'lifecycle';
  sub_type: 'connect';
};

export type AllMetaEventWSMSG = LifecycleMetaEventWSMSG | HeartbeatMetaEventWSMSG;

export interface MessageWSMSG {
  post_type: 'message';
  self_id: number;
  user_id: number;
  time: number;
  message_id: number;
  message_seq: number;
  real_id: number;
  real_seq: string;
  raw_message: string;
  font: number;
  sub_type: 'friend' | 'normal';
  message: ReceiveMessage;
}

export type GroupMessageWSMSG = MessageWSMSG & {
  message_type: 'group';
  sender: GroupSender;
  group_id: number;
  group_name: string;
};

export type PrivateMessageWSMSG = MessageWSMSG & {
  message_type: 'private';
  sender: Sender;
  target_id: number;
};

export type AllMessageWSMSG = GroupMessageWSMSG | PrivateMessageWSMSG;

export type NoticeWSMSG = {
  post_type: 'notice';
};

export type NotifyNoticeWSMSG = NoticeWSMSG & {
  notice_type: 'notify';
  sub_type: 'poke' | string;
  group_id?: number;
  target_id: number;
  self_id: number;
  user_id: number;
};

export type GroupDecreaseNoticeWSMSG = NoticeWSMSG & {
  notice_type: 'group_decrease';
  self_id: number;
  group_id: number;
  user_id: number;
  sub_type: 'kick' | 'leave';
  operator_id: number;
};

export type GroupIncreaseNoticeWSMSG = NoticeWSMSG & {
  notice_type: 'group_increase';
  self_id: number;
  group_id: number;
  user_id: number;
  sub_type: 'invite' | 'approve';
  operator_id: number;
};

export type AllNoticeWSMSG = NotifyNoticeWSMSG | GroupDecreaseNoticeWSMSG | GroupIncreaseNoticeWSMSG;

export type RequestWSMSG = {
  post_type: 'request';
};

export type GroupRequestWSMSG = RequestWSMSG & {
  request_type: 'group';
  self_id: number;
  group_id: number;
  user_id: number;
  comment: string;
  flag: string;
  sub_type: 'add';
};

export type AllRequestWSMSG = GroupRequestWSMSG;

export type WSMSG = AllMetaEventWSMSG | AllMessageWSMSG | AllNoticeWSMSG | AllRequestWSMSG;

export interface LoginInfoData {
  user_id: number;
  nickname: string;
}

export interface LoginInfo {
  retcode: number;
  data: LoginInfoData;
  message: string;
  wording: string;
}
