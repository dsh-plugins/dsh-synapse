import MarkdownIt from 'markdown-it';
// @ts-ignore markdown-it-emoji 未提供默认导出类型声明（full 预设，同时支持 :name: 与 Unicode emoji）
import emoji from 'markdown-it-emoji';
import { Message } from 'discord.js';
import { Template, tryGenerateImage } from '@/image';

/**
 * Discord markdown 工具：
 * - isDiscordMarkdown：启发式判断一段文本是否使用了 Discord markdown 语法
 * - escapeDiscord：发送纯文本前转义 markdown 特殊字符，避免被 Discord 误渲染
 * - renderDiscordMessageToImage：把 Discord 消息内容渲染为图片（base64），转发到 QQ 用
 */

/** 启发式判定文本是否包含 Discord markdown 语法 */
const DISCORD_MARKDOWN_PATTERNS: RegExp[] = [
  /\*\*[^*\n]+\*\*/, // **粗体**
  /(^|[\s（(>])\*[^*\s][^*\n]*\*(?![*\w])/, // *斜体*（避免把 a*b*c 误判为 markdown）
  /__[^_\n]+__/, // __下划线__（CommonMark 会渲染为粗体，属已知偏差）
  /(^|[\s（(>])_[^_\s][^_\n]*_(?![_\w])/, // _斜体_
  /~~[^~\n]+~~/, // ~~删除线~~
  /\|\|[^|\n]+\|\|/, // ||剧透||
  /```[\s\S]*?```/, // 代码块
  /`[^`\n]+`/, // 行内代码
  /^#{1,3}\s+\S/m, // # 标题（行首）
  /^>\s+\S/m, // > 引用（行首）
  /^\s*[-*+]\s+\S/m, // 无序列表
  /^\s*\d+\.\s+\S/m, // 有序列表
  /\[[^\]\n]+\]\([^)\n]+\)/, // [文字](链接)
  /<[@#][!&]?\d+>/, // <@id> / <@!id> / <#id>
  /<a?:\w{2,32}:\d+>/, // <a?:name:id> 自定义表情
  /^-{3,}\s*$/m // 分割线
];

export function isDiscordMarkdown(text: string): boolean {
  return DISCORD_MARKDOWN_PATTERNS.some(pattern => pattern.test(text));
}

/** 转义 Discord markdown 特殊字符，使文本按原样（plain text）显示 */
export function escapeDiscord(text: string): string {
  return text.replace(/([\\*_~`|>#-])/g, '\\$1');
}

/** HTML 转义（注入模板/渲染前处理用户文本） */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true
}).use(emoji.full ?? emoji);

/**
 * 把 Discord 消息文本渲染为 HTML 片段。
 * 先 HTML 转义，再把 Discord 特有语法（提及/频道/自定义表情/剧透）替换为等价 HTML，
 * 最后交给 markdown-it 渲染公共 markdown 部分。
 */
export function renderDiscordMarkdownToHtml(content: string, message?: Message): string {
  let text = escapeHtml(content);
  // 剧透 ||x|| → 黑块（markdown-it 不认识该语法，先替换为 HTML）
  text = text.replace(/\|\|([\s\S]+?)\|\|/g, '<span class="spoiler">$1</span>');
  // 自定义表情 <a?:name:id>
  text = text.replace(/&lt;a?:(\w{2,32}):\d+&gt;/g, ':$1:');
  // 频道提及 <#id> → #频道名
  text = text.replace(/&lt;#(\d+)&gt;/g, (_match, id: string) => {
    const name = message?.guild?.channels.cache.get(id)?.name;
    return `<span class="mention">#${escapeHtml(name ?? id)}</span>`;
  });
  // 用户提及 <@id> / <@!id> → @昵称
  text = text.replace(/&lt;@!?(\d+)&gt;/g, (_match, id: string) => {
    const name =
      message?.mentions.members?.get(id)?.displayName ?? message?.mentions.users.get(id)?.username;
    return `<span class="mention">@${escapeHtml(name ?? id)}</span>`;
  });
  // 角色提及 <@&id> → @角色名
  text = text.replace(/&lt;@&amp;(\d+)&gt;/g, (_match, id: string) => {
    const name = message?.guild?.roles.cache.get(id)?.name;
    return `<span class="mention">@${escapeHtml(name ?? id)}</span>`;
  });
  return md.render(text);
}

/**
 * 把 Discord markdown 消息渲染成 PNG 图片（base64）。
 * header 为图片顶部来源行（【服务器|频道】昵称(用户名)），content 为消息正文。
 * 复用 src/image/index.ts 的共享 Chrome 截图队列。
 */
export function renderDiscordMessageToImage(header: string, content: string, message?: Message): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const htmlFragment = renderDiscordMarkdownToHtml(content, message);
    const template = Template.load('message', 'src/features/discord-bridge/template')
      .arg('header', escapeHtml(header))
      .arg('content', htmlFragment);
    const templateFile = template.file();
    template
      .handler()
      .then(html => tryGenerateImage(resolve, reject, html, 640, templateFile))
      .catch(reject);
  });
}
