/**
 * 视频/专栏等内容的概要信息
 */
export interface ViewData {
  /** 封面图片URL */
  pic: string;
  /** 标题 */
  title: string;
  /** 创建时间戳（秒） */
  ctime: number;
  /** 描述文字 */
  desc: string;
  /** 视频时长（秒） */
  duration: number;
  /** 作者信息 */
  owner: {
    mid: number; // 作者UID
    name: string; // 作者昵称
    face: string; // 作者头像URL
  };
  /** 统计数据 */
  stat: {
    view: number; // 播放量
    like: number; // 点赞数
    reply: number; // 评论数
  };
}

// ==================== 空间动态项（SpaceDataItem）相关类型 ====================

/**
 * 点赞图标
 */
export interface LikeIcon {
  id: string;
  start_url: string;
  action_url: string;
  end_url: string;
}

/**
 * 图片资源（用于头像、装饰等）
 */
export interface ImageResource {
  res_type: number; // 资源类型，通常为3表示图片
  res_image: {
    image_src: {
      src_type: number; // 1=远程，2=本地占位
      placeholder: number; // 占位图类型
      remote?: {
        url: string; // 图片URL
        bfs_style?: string; // BFS样式
      };
      local?: number; // 本地资源标识
    };
  };
}

/**
 * 头像图层
 */
export interface AvatarLayer {
  layer_id: string;
  visible: boolean;
  general_spec: {
    pos_spec: {
      coordinate_pos: number;
      axis_x: number;
      axis_y: number;
    };
    size_spec: {
      width: number;
      height: number;
    };
    render_spec: {
      opacity: number;
    };
  };
  layer_config: {
    tags: Record<string, any>; // 标签配置，如AVATAR_LAYER、GENERAL_CFG等
    is_critical: boolean;
    allow_over_paint: boolean;
    layer_mask: null | any;
  };
  resource: ImageResource;
}

/**
 * 头像备用图层组
 */
export interface FallbackLayers {
  group_id: string;
  layers: AvatarLayer[];
  group_mask: null | any;
  is_critical_group: boolean;
}

/**
 * 头像信息（合成头像）
 */
export interface AvatarInfo {
  container_size: {
    width: number;
    height: number;
  };
  layers: any[]; // 实际数据中为空数组，可能预留
  fallback_layers: FallbackLayers;
  mid: string; // 作者mid
}

/**
 * NFT信息（可能为null，若有则定义）
 */
export interface NftInfo {
  // 根据实际数据结构补充，目前JSON中为null
}

/**
 * 名称渲染信息（可能为null，若有则定义）
 */
export interface NameRender {
  // 根据实际数据结构补充，目前JSON中为null
}

/**
 * 头像挂件
 */
export interface Pendant {
  pid: number;
  name: string;
  image: string;
  expire: string;
  image_enhance: string;
  image_enhance_frame: string;
  n_pid: string;
}

/**
 * 大会员标签
 */
export interface VipLabel {
  path: string;
  text: string;
  label_theme: string;
  text_color: string;
  bg_style: number;
  bg_color: string;
  border_color: string;
  use_img_label: boolean;
  img_label_uri_hans: string;
  img_label_uri_hant: string;
  img_label_uri_hans_static: string;
  img_label_uri_hant_static: string;
}

/**
 * 头像图标
 */
export interface AvatarIcon {
  icon_type: number;
  icon_resource: {
    type: number;
    url: string;
  };
}

/**
 * 大会员信息
 */
export interface VipInfo {
  type: number; // 会员类型，0=无，1=月会员，2=年会员等
  status: number; // 状态，0=无，1=有
  due_date: string; // 到期时间戳
  vip_pay_type: number; // 支付类型
  theme_type: number;
  label: VipLabel;
  avatar_subscript: number;
  nickname_color: string;
  role: string;
  avatar_subscript_url: string;
  tv_vip_status: number;
  tv_vip_pay_type: number;
  tv_due_date: string;
  avatar_icon: AvatarIcon;
}

/**
 * 官方认证信息
 */
export interface OfficialVerify {
  type: number; // -1=未认证，0=个人认证，1=企业认证
  desc: string;
}

/**
 * 粉丝装扮卡片
 */
export interface DecorationCard {
  id: string;
  item_id: string;
  name: string;
  card_url: string;
  big_card_url: string;
  card_type: string; // 如"2"
  expire_time: string;
  card_type_name: string; // 如"免费"
  jump_url: string;
  fan: {
    is_fan: string; // "1"或"0"
    number: string; // 粉丝数
    color: string; // 颜色
    name: string; // 粉丝团名称
    num_desc: string; // 数字描述
    num_prefix: string;
    color_format: {
      start_point: string;
      end_point: string;
      colors: string[];
      gradients: string[];
    };
  };
  image_enhance: string;
  image_group: null | any;
}

/**
 * 装饰信息（可能为null，若有则定义）
 */
export interface Decorate {
  // 根据实际数据结构补充，目前JSON中为null
}

/**
 * 图标徽章（可能为null，若有则定义）
 */
export interface IconBadge {
  // 根据实际数据结构补充，目前JSON中为null
}

/**
 * 作者模块信息
 */
export interface SpaceDataItemAuthor {
  /** 作者类型，如"AUTHOR_TYPE_NORMAL" */
  type: string;
  /** 头像详细结构 */
  avatar: AvatarInfo;
  /** 头像URL */
  face: string;
  /** 是否为NFT头像 */
  face_nft: boolean;
  /** NFT相关信息 */
  nft_info: NftInfo | null;
  /** 作者昵称 */
  name: string;
  /** 昵称渲染信息（如特殊样式） */
  name_render: NameRender | null;
  /** 作者标签（如"UP主认证"） */
  label: string;
  /** 作者UID */
  mid: number;
  /** 空间跳转链接 */
  jump_url: string;
  /** 当前用户是否关注该作者 */
  following: boolean;
  /** 发布时间戳（字符串形式） */
  pub_ts: string;
  /** 发布相对时间描述，如"3天前" */
  pub_time: string;
  /** 发布动作描述，如"投稿了视频" */
  pub_action: string;
  /** 发布位置文本 */
  pub_location_text: string;
  /** 头像挂件信息 */
  pendant: Pendant;
  /** 大会员信息 */
  vip: VipInfo;
  /** 官方认证信息 */
  official_verify: OfficialVerify;
  /** 装饰信息 */
  decorate: Decorate | null;
  /** 粉丝装扮卡片信息 */
  decoration_card: DecorationCard | null;
  /** 是否置顶 */
  is_top: boolean;
  /** 图标徽章 */
  icon_badge: IconBadge | null;
}

/**
 * 三点菜单项的操作参数（联合类型，根据type不同）
 */
export type ThreePointParams =
  | { dynamic_id: string; status: boolean } // 置顶/取消置顶
  | { dyn_id_str: string; dyn_type: number; rid_str: string } // 删除
  | Record<string, any>; // 其他未知类型

/**
 * 三点菜单项
 */
export interface SpaceDataItemThreePointItem {
  /** 菜单项文本 */
  label: string;
  /** 类型，如"THREE_POINT_TOP"（置顶）、"THREE_POINT_DELETE"（删除） */
  type: string;
  /** 操作参数 */
  params: ThreePointParams;
  /** 弹窗配置（如果有点击弹窗） */
  modal: {
    title: string; // 弹窗标题
    content: string; // 弹窗内容
    confirm: string; // 确认按钮文本
    cancel: string; // 取消按钮文本
  } | null;
  /** 跳转链接 */
  jump_url: string;
}

/**
 * 更多操作模块
 */
export interface SpaceDataItemMore {
  /** 推荐文本 */
  rcmd_text: string;
  /** 三点菜单项列表 */
  three_point_items: SpaceDataItemThreePointItem[];
}

/**
 * 话题信息
 */
export interface SpaceDataItemTopic {
  /** 话题ID */
  id: string;
  /** 话题名称 */
  name: string;
  /** 话题跳转链接 */
  jump_url: string;
}

/**
 * 富文本节点类型
 */
export type RichTextNodeType =
  | 'RICH_TEXT_NODE_TYPE_TEXT' // 纯文本
  | 'RICH_TEXT_NODE_TYPE_AT' // @用户
  | 'RICH_TEXT_NODE_TYPE_EMOJI' // 表情
  | 'RICH_TEXT_NODE_TYPE_VOTE' // 投票
  | 'RICH_TEXT_NODE_TYPE_LOTTERY' // 抽奖
  | 'RICH_TEXT_NODE_TYPE_TOPIC'; // 话题

/**
 * 表情信息
 */
export interface EmojiInfo {
  type: string; // 表情类型，如"1"（普通）、"11"（充电）
  size: number; // 尺寸
  text: string; // 表情文本
  icon_url: string; // 图标URL
  gif_url: string; // GIF URL
  webp_url: string; // WebP URL
  jump_url: string; // 点击跳转链接
  jump_title: string; // 跳转标题
}

/**
 * 商品信息（可能为null，若有则定义）
 */
export interface GoodsInfo {
  // 根据实际数据结构补充，目前JSON中为null
}

/**
 * 样式信息
 */
export interface TextStyle {
  color?: string;
  bg_color?: string;
  font_size?: number;
  font_level?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
}

/**
 * 富文本节点
 */
export interface RichTextNode {
  /** 原始文本 */
  text: string;
  /** 原始文本（可能与text相同） */
  orig_text: string;
  /** 节点类型 */
  type: RichTextNodeType;
  /** 跳转链接 */
  jump_url: string;
  /** 图标URL */
  icon_url: string;
  /** 图标名称 */
  icon_name: string;
  /** 资源ID（如被@用户的UID） */
  rid: string;
  /** 表情信息（仅当type为EMOJI时存在） */
  emoji: EmojiInfo | null;
  /** 商品信息 */
  goods: GoodsInfo | null;
  /** 样式 */
  style: TextStyle | null;
  /** 图片列表 */
  pics: any[]; // 实际数据中为空，暂保留any
  /** 视频信息 */
  video: any | null;
}

/**
 * 文本节点中的单词节点
 */
export interface TextNodeWord {
  words: string;
  font_size: number;
  color: string;
  dark_color: string;
  style: {
    bold: boolean;
    italic: boolean;
    strikethrough: boolean;
    underline: boolean;
    background: string;
  };
  font_level: string;
  translated_words: string;
  bili_theme: string;
  [key: string]: any; // 额外未知字段
}

/**
 * 文本节点
 */
export interface TextNode {
  type: 'TEXT_NODE_TYPE_WORD' | 'TEXT_NODE_TYPE_RICH' | string;
  word?: TextNodeWord;
  rich?: RichTextNode;
  formula?: any;
  user?: any;
}

/**
 * 段落（用于富文本描述）
 */
export interface Paragraph {
  /** 段落类型，如1表示普通段落 */
  para_type: number;
  /** 对齐方式 */
  align: number;
  /** 格式信息（可能为null） */
  format: null | any;
  /** 文本内容（若为文本段落） */
  text?: {
    nodes: TextNode[];
  };
  /** 图片内容（若为图片段落） */
  pic?: null | any;
  /** 列表内容（若为列表段落） */
  list?: null | ParagraphList;
  /** 链接卡片（若为链接段落） */
  link_card?: null | any;
  /** 代码块（若为代码段落） */
  code?: null | any;
  /** 标题（若为标题段落） */
  heading?: null | any;
  /** 引用块（若为引用段落） */
  blockquote?: null | any;
}

/**
 * 列表段落结构
 */
export interface ParagraphList {
  style: number; // 列表样式，如2
  start: number; // 起始序号
  items: any[]; // 列表项（可能有内容）
  children: Array<{
    order_style: null | any;
    level: number;
    order: number;
    children: Paragraph[];
  }>;
  theme: string;
}

/**
 * 动态描述（文本+富文本）
 */
export interface SpaceDataItemDesc {
  /** 纯文本描述 */
  text: string;
  /** 富文本节点数组 */
  rich_text_nodes: RichTextNode[];
  /** 段落数组（结构化描述） */
  paragraphs: Paragraph[];
  /** 是否有更多内容（需展开） */
  has_more: boolean;
}

/**
 * 视频稿件信息（MAJOR_TYPE_ARCHIVE）
 */
export interface SpaceDataItemArchive {
  /** 类型，通常为1 */
  type: number;
  /** BV号 */
  bvid: string;
  /** AV号 */
  aid: string;
  /** 封面图片URL */
  cover: string;
  /** 视频跳转链接 */
  jump_url: string;
  /** 视频统计数据 */
  stat: {
    danmaku: string; // 弹幕数
    play: string; // 播放量
    vt: string; // 未知字段
  };
  /** 时长文本，如"01:44" */
  duration_text: string;
  /** 视频标题 */
  title: string;
  /** 视频描述 */
  desc: string;
  /** 视频徽章（如"投稿视频"、"合作视频"） */
  badge: {
    icon_url: string;
    text: string;
    bg_color: string;
    color: string;
  };
  /** 未知字段 */
  enable_vt: number;
  /** 未知字段 */
  disable_preview: number;
  /** 首播在线信息 */
  premiere_online: string;
  /** 统计隐藏标志 */
  stat_hidden: number;
}

/**
 * Opus（专栏/图文）中的图片信息
 */
export interface OpusPic {
  url: string;
  width: number;
  height: number;
  size: number; // 文件大小(KB)
  live_url: string;
  aigc: number;
  warning: null | any;
}

/**
 * Opus（专栏/图文）的摘要信息（与SpaceDataItemDesc结构相同，复用）
 */
export type OpusSummary = SpaceDataItemDesc;

/**
 * Opus（专栏/图文）信息（MAJOR_TYPE_OPUS）
 */
export interface SpaceDataItemOpus {
  /** 跳转链接 */
  jump_url: string;
  /** 标题 */
  title: string;
  /** 摘要信息 */
  summary: OpusSummary;
  /** 样式 */
  style: number;
  /** 图片列表 */
  pics: OpusPic[];
  /** 折叠操作文本，如["全文"] */
  fold_action: string[];
}

/**
 * 主模块（动态核心内容）
 */
export interface SpaceDataItemMajor {
  /** 主类型，如"MAJOR_TYPE_ARCHIVE"（视频）、"MAJOR_TYPE_OPUS"（专栏/图文） */
  type: string;
  none: any | null;
  blocked: any | null;
  archive?: SpaceDataItemArchive; // 视频类型存在
  opus?: SpaceDataItemOpus; // Opus类型存在
  // 其他可能类型：draw（纯图文）、article（文章）、pgc（剧集）等，可根据需要扩展
}

/**
 * 投票模块
 */
export interface VoteAdditional {
  vote_id: string;
  choice_cnt: string;
  default_share: string;
  title: string;
  desc: string;
  end_time: string;
  join_num: string;
  status: string;
  type: string;
  uid: string;
  jump_url: string;
  button: {
    type: number;
    jump_style: {
      icon_url: string;
      text: string;
      interactive: null | any;
      bg_style: number;
      toast: string;
      disable: number;
    };
    jump_url: string;
    check: null | any;
    uncheck: null | any;
    status: number;
    click_type: number;
  };
  upower_action_state: number;
  upower_level: string;
}

/**
 * 通用附加模块（如游戏推广）
 */
export interface CommonAdditional {
  button: {
    type: number;
    jump_style: {
      icon_url: string;
      text: string;
      interactive: null | any;
      bg_style: number;
      toast: string;
      disable: number;
    };
    jump_url: string;
    check: null | any;
    uncheck: null | any;
    status: number;
    click_type: number;
  };
  sub_type: string; // 如"game"
  head_text: string; // 如"相关游戏"
  jump_url: string;
  id_str: string;
  cover: string;
  style: number;
  title: string;
  desc1: string;
  desc2: string;
}

/**
 * 附加模块（如投票、商品等）
 */
export interface SpaceDataItemAdditional {
  type: string; // 如"ADDITIONAL_TYPE_VOTE", "ADDITIONAL_TYPE_COMMON"
  goods: GoodsInfo | null;
  vote?: VoteAdditional;
  common?: CommonAdditional;
  match?: any | null;
  ugc?: any | null;
  reserve?: any | null;
  upower_lottery?: any | null;
}

/**
 * 动态模块（核心内容模块）
 */
export interface SpaceDataItemDynamic {
  /** 关联话题 */
  topic: null | SpaceDataItemTopic;
  /** 描述内容（带富文本） */
  desc: null | SpaceDataItemDesc;
  /** 主内容（视频/专栏等） */
  major: null | SpaceDataItemMajor;
  /** 附加内容（如投票） */
  additional: null | SpaceDataItemAdditional;
}

/**
 * 统计详情（点赞/评论/转发）
 */
export interface SpaceDataItemStatDetail {
  /** 是否可用（如当前用户是否已点赞） */
  status: boolean;
  /** 计数 */
  count: number;
  /** 是否禁止操作 */
  forbidden: boolean;
  /** 是否禁用 */
  disabled: boolean;
  /** 是否静默 */
  silent: boolean;
  /** 是否隐藏 */
  hidden: boolean;
}

/**
 * 统计模块
 */
export interface SpaceDataItemStat {
  /** 转发统计 */
  forward: SpaceDataItemStatDetail;
  /** 评论统计 */
  comment: SpaceDataItemStatDetail;
  /** 点赞统计 */
  like: SpaceDataItemStatDetail;
}

/**
 * 互动项（如“xxx赞了”）
 */
export interface SpaceDataItemInteractionItem {
  /** 类型，0表示普通互动 */
  type: number;
  /** 互动描述 */
  desc: SpaceDataItemDesc;
}

/**
 * 互动模块
 */
export interface SpaceDataItemInteraction {
  items: SpaceDataItemInteractionItem[];
}

/**
 * 标签模块（如置顶）
 */
export interface ModuleTag {
  text: string;
}

/**
 * 动态的所有模块集合
 */
export interface SpaceDataItemModules {
  /** 标签模块（如“置顶”） */
  module_tag: null | ModuleTag;
  /** 作者模块 */
  module_author: SpaceDataItemAuthor;
  /** 更多操作模块 */
  module_more: SpaceDataItemMore;
  /** 争议模块（一般为null，如有则定义） */
  module_dispute: any | null;
  /** 核心动态模块 */
  module_dynamic: SpaceDataItemDynamic;
  /** 扩展模块（一般为null） */
  module_extend: any | null;
  /** 统计模块 */
  module_stat: SpaceDataItemStat;
  /** 互动模块（可能为null） */
  module_interaction: SpaceDataItemInteraction | null;
  /** 分享信息模块（一般为null） */
  module_share_info: any | null;
  /** 折叠模块（一般为null） */
  module_fold: any | null;
}

/**
 * 动态基础信息
 */
export interface SpaceDataItemBasic {
  /** 资源ID字符串（如稿件ID、专栏ID） */
  rid_str: string;
  /** 评论类型（1=视频，2=动态，12=专栏等） */
  comment_type: number;
  /** 评论ID字符串 */
  comment_id_str: string;
  /** 点赞图标 */
  like_icon: LikeIcon;
  /** 是否审核中 */
  in_audit: boolean;
  /** 是否仅粉丝可见 */
  is_only_fans: boolean;
  /** 是否可编辑 */
  editable: boolean;
  /** 打开App额外参数 */
  open_app_extra: string;
  /** 跳转链接 */
  jump_url: string;
  /** 是否AI生成内容 */
  aigc: boolean;
}

/**
 * 单个空间动态项
 */
export interface SpaceDataItem {
  /** 动态ID字符串 */
  id_str: string;
  /** 动态类型，如"DYNAMIC_TYPE_AV"（视频）、"DYNAMIC_TYPE_FORWARD"（转发）、"DYNAMIC_TYPE_ARTICLE"（专栏）、"DYNAMIC_TYPE_DRAW"（图文）等 */
  type: string;
  /** 基础信息 */
  basic: SpaceDataItemBasic;
  /** 是否可见 */
  visible: boolean;
  /** 各模块数据 */
  modules: SpaceDataItemModules;
  /** 原始动态（如果是转发，则orig为被转发的原动态） */
  orig: SpaceDataItem | null;
}

/**
 * 空间动态列表响应数据
 */
export interface SpaceData {
  /** 是否有更多 */
  has_more: boolean;
  /** 动态项列表 */
  items: SpaceDataItem[];
}
