import {
  AllReleaseEvent,
  ClosedIssueEvent,
  ClosedPullRequestEvent,
  Issue,
  OpenedIssueEvent,
  OpenedPullRequestEvent,
  PullRequest,
  Release,
  ReopenedIssueEvent,
  ReopenedPullRequestEvent,
  User
} from '@/type/github';
import { Logger } from 'winston';
import markdownit from 'markdown-it';
import hljs from 'highlight.js';
import { full as emoji } from 'markdown-it-emoji';
import { issuesClosed, issuesHandler, issuesOpened } from '@/features/github/image/impl/issue';
import { prClosed, prHandler, prOpened } from '@/features/github/image/impl/pr';
import { releaseHandler, releasePublished } from '@/features/github/image/impl/release';
import { fetchIssueDetail, LinkedIssueDetail, LinkedIssueStatus } from '@/features/github/api';

/**
 * 解析 PR/Issue 正文列表行中的 issue/PR 引用（如 "- resolved #4851"、
 * "- fixed owner/repo#4858"、自定义文字 "- 解决了 #4851"），
 * 只替换其中的 "#编号" 部分为 GitHub 风格的行内引用：
 * 状态图标 + 标题 + 链接色编号；行内其它文字原样保留。
 *
 * 与 GitHub 官方 markdown 渲染行为一致（列表保留、文字保留、#编号变链接），
 * 只是额外把标题与状态图标一并渲染出来。非列表行中的 #编号 不处理。
 */
/** 匹配列表行（无序标记 -、*、+ 或有序标记 1. / 1) ） */
const LIST_LINE = /^\s*(?:[-*+]|\d+[.)])\s+.*$/gm;
/** 匹配行内的引用：#1234 或 owner/repo#1234（不匹配单词/路径中间） */
const REF_IN_LINE = /(?<![\w/])((?:[\w.-]+\/[\w.-]+)?#\d+)(?!\w)/g;
/** 匹配 GitHub issue/PR 完整地址：https://github.com/owner/repo/(pull|issues)/1234 */
const ISSUE_URL = /(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/(\d+)/g;
/** 代码段（围栏代码块或行内代码）：缩短 URL 时跳过，避免破坏代码内容 */
const CODE_SEGMENT = /(```[\s\S]*?```|`[^`\n]*`)/g;

/** 占位符前缀/后缀：避开 markdown 特殊字符，渲染后再换回引用 HTML */
const PLACEHOLDER_PREFIX = 'GHILINKISSUEPILLZ';
const PLACEHOLDER_SUFFIX = 'ZLLIPISSUEKNILHG';
/** 纯链接（URL 缩短而来）的占位符，与引用分开编号避免冲突 */
const LINK_PLACEHOLDER_PREFIX = 'GHILINKSHORTURLZ';
const LINK_PLACEHOLDER_SUFFIX = 'ZLRUHTROHSKNILIHG';

interface LinkedIssueReference {
  /** 完整仓库（owner/repo），短引用用当前仓库展开 */
  repository: string;
  /** issue 编号 */
  number: number;
  /** 查询失败时回退显示的文本（owner/repo#编号） */
  label: string;
  /** 是否跨仓库引用（显式写了 owner/repo#编号） */
  crossRepo: boolean;
}

/** 由完整 GitHub 地址缩短而来的引用（只渲染为蓝色 #编号，不查询 API） */
interface ShortUrl {
  url: string;
  number: number;
  label: string;
}

/** 转义标题中的 HTML 特殊字符，避免注入/破坏模板 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 按状态返回对应的 SVG 图标（GitHub octicon 原版：彩色圆环+同色图标，颜色与卡片状态标签一致） */
function iconForStatus(status: LinkedIssueStatus): string {
  switch (status) {
    case 'open':
      // issue 进行中：绿色圆环+绿点（issue-opened）
      return `<svg class="issue-ref-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="#347d39"><path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z"/></svg>`;
    case 'completed':
      // issue 已完成关闭：紫色圆环+紫色对勾（issue-closed）
      return `<svg class="issue-ref-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="#8256d0"><path d="M11.28 6.78a.75.75 0 0 0-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l3.5-3.5Z"/><path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0Zm-1.5 0a6.5 6.5 0 1 0-13 0 6.5 6.5 0 0 0 13 0Z"/></svg>`;
    case 'not_planned':
      // issue 未计划等关闭：灰色圆环+灰色斜杠（skip）
      return `<svg class="issue-ref-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="#656c76"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm9.78-2.22-5.5 5.5a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l5.5-5.5a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042Z"/></svg>`;
    case 'pr_open':
      // PR 进行中：绿色 PR 图标（git-pull-request，原生无圆环）
      return `<svg class="issue-ref-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="#347d39"><path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0Z"/></svg>`;
    case 'pr_merged':
      // PR 已合并：紫色合并图标（git-merge，原生无圆环）
      return `<svg class="issue-ref-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="#8256d0"><path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z"/></svg>`;
    case 'pr_closed':
      // PR 关闭未合并：红色 PR 关闭图标（git-pull-request-closed，原生无圆环）
      return `<svg class="issue-ref-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="#cf222e"><path d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-2.03-5.273a.75.75 0 0 1 1.06 0l.97.97.97-.97a.748.748 0 0 1 1.265.332.75.75 0 0 1-.205.729l-.97.97.97.97a.75.75 0 0 1-1.06 1.061l-.97-.97-.97.97a.75.75 0 0 1-1.06-1.06l.97-.97-.97-.97a.75.75 0 0 1 0-1.06ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm0 9.5a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm9.5 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"/></svg>`;
    default:
      // 状态未知（查询失败回退，通常不显示）：灰色圆环+问号
      return `<svg class="issue-ref-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="#8b949e"><circle cx="8" cy="8" r="6.5" fill="none" stroke="#8b949e" stroke-width="1.5"/><text x="8" y="11" text-anchor="middle" font-size="9" font-family="sans-serif">?</text></svg>`;
  }
}

/**
 * 把单个引用渲染为 GitHub 风格的行内引用：
 * 查到标题时显示「状态图标 + 标题 + 链接色编号」；查询失败时回退为纯链接色编号。
 */
function renderInlineRef(ref: LinkedIssueReference, detail: LinkedIssueDetail): string {
  const numberLabel = ref.crossRepo ? `${ref.repository}#${ref.number}` : `#${ref.number}`;
  const url = ref.repository ? `https://github.com/${ref.repository}/issues/${ref.number}` : '';
  if (!detail.title) {
    return `<a class="issue-ref-number" href="${url}">${numberLabel}</a>`;
  }
  return (
    `<span class="issue-ref issue-ref-${detail.status}">${iconForStatus(detail.status)}` +
    `<a class="issue-ref-title" href="${url}">${escapeHtml(detail.title)}</a>` +
    `<a class="issue-ref-number" href="${url}">${numberLabel}</a></span>`
  );
}

/** 占位符 -> 引用索引 */
function placeholder(index: number): string {
  return `${PLACEHOLDER_PREFIX}${index}${PLACEHOLDER_SUFFIX}`;
}

/** 占位符 -> 缩短链接索引 */
function linkPlaceholder(index: number): string {
  return `${LINK_PLACEHOLDER_PREFIX}${index}${LINK_PLACEHOLDER_SUFFIX}`;
}

/**
 * 把正文中的 issue/PR 完整地址缩短为 "#编号"（渲染后为蓝色链接）。
 * 例如 https://github.com/owner/repo/pull/1234 -> #1234，
 * 不处理 compare/commit 等其他 GitHub 地址，代码段内的 URL 也跳过。
 * @param body 原始 markdown
 * @param repository 当前仓库（owner/repo），同仓库时只显示 #编号
 * @param links 收集缩短后的链接信息
 */
function shortenIssueUrls(body: string, repository: string, links: ShortUrl[]): string {
  // 先按代码段切分，只处理非代码段，避免破坏代码块中的 URL
  return body
    .split(CODE_SEGMENT)
    .map((segment, index) => {
      // 奇数索引是捕获到的代码段，原样保留
      if (index % 2 === 1) return segment;
      return segment.replace(ISSUE_URL, (match, owner: string, repo: string, kind: string, number: string) => {
        const fullName = `${owner}/${repo}`;
        const url = `https://github.com/${fullName}/${kind}/${number}`;
        const sameRepo = fullName.toLowerCase() === repository.toLowerCase();
        const index = links.length;
        links.push({ url, number: Number.parseInt(number, 10), label: sameRepo ? `#${number}` : `${fullName}#${number}` });
        return linkPlaceholder(index);
      });
    })
    .join('');
}

/**
 * 从正文的列表行中提取 issue/PR 引用，替换为占位符（行内替换，保留其它文字）。
 */
function extractReferences(
  body: string,
  repository: string,
  references: LinkedIssueReference[]
): string {
  const toRef = (reference: string): string => {
    // reference 形如 "#4851" 或 "owner/repo#4851"
    const hasRepo = reference.includes('/');
    const repo = (hasRepo ? reference.split('#')[0] : repository) ?? '';
    const numberText = reference.slice(reference.indexOf('#') + 1);
    const number = Number.parseInt(numberText, 10);
    if (!Number.isFinite(number)) return reference;
    const label = repo ? `${repo}#${number}` : `#${number}`;
    const index = references.length;
    references.push({ repository: repo, number, label, crossRepo: hasRepo });
    return placeholder(index);
  };
  // 只处理列表行；行内每个 #编号 独立替换为占位符，其余文字不动
  return body.replace(LIST_LINE, line => line.replace(REF_IN_LINE, (m: string) => toRef(m)));
}

/**
 * 渲染 PR/Issue 正文 markdown。列表行中的 "#编号" 引用替换为
 * 随 issue/PR 状态变化的行内引用（图标 + 标题 + 链接色编号），
 * 行内其它文字（resolved / fixed / 自定义文字）原样保留；
 * 异步查询状态与标题，失败回退为纯链接色编号。
 * @param body 原始 markdown 正文
 * @param repository 当前仓库（owner/repo），用于展开 "#1234" 形式的短引用
 * @param logger 可选日志器
 */
export async function renderIssueBody(body?: string, repository: string = '', logger?: Logger): Promise<any> {
  const references: LinkedIssueReference[] = [];
  const links: ShortUrl[] = [];
  // 先把完整 issue/PR 地址缩短为占位符（不查 API），再处理 #编号 引用
  const shortened = shortenIssueUrls(body || '', repository, links);
  const withPlaceholders = extractReferences(shortened, repository, references);
  let html = renderMarkdown(withPlaceholders);

  // 缩短链接 -> 蓝色 #编号（纯链接，不查询状态与标题）
  links.forEach((link, i) => {
    const shortHtml = `<a class="issue-ref-number" href="${link.url}">${link.label}</a>`;
    html = html.split(linkPlaceholder(i)).join(shortHtml);
  });

  if (references.length === 0) {
    return html;
  }

  // 并发查询所有引用的 issue 状态与标题；单个失败回退为 unknown（无标题），不阻塞其他
  const details = await Promise.all(
    references.map(ref => fetchIssueDetail(ref.repository, ref.number, logger))
  );

  // 占位符 -> 行内引用 HTML（列表结构与其余文字已由 markdown 渲染保留）
  let replaced = html;
  references.forEach((ref, i) => {
    const refHtml = renderInlineRef(ref, details[i] ?? { status: 'unknown' });
    replaced = replaced.split(placeholder(i)).join(refHtml);
  });
  return replaced;
}

export function renderMarkdown(body?: string): any {
  const taskLists = require('markdown-it-task-lists');
  const abbr = require('markdown-it-abbr');
  const container = require('markdown-it-container');
  const footnote = require('markdown-it-footnote');
  const ins = require('markdown-it-ins');
  const mark = require('markdown-it-mark');
  const sup = require('markdown-it-sup');
  const sub = require('markdown-it-sub');
  const renderer = markdownit({
    html: true,
    linkify: true,
    breaks: true,
    xhtmlOut: true,
    highlight: function (str, lang): any {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return (
            '<pre><code class="hljs">' +
            hljs.highlight(str, { language: lang, ignoreIllegals: true }).value +
            '</code></pre>'
          );
        } catch (__) {}
      }

      return '<pre><code class="hljs">' + renderer.utils.escapeHtml(str) + '</code></pre>';
    }
  })
    .use(taskLists)
    .use(abbr)
    .use(container)
    .use(emoji)
    .use(footnote)
    .use(ins)
    .use(mark)
    .use(sup)
    .use(sub);
  return renderer.render(body || '');
}

export class GitHubImage {
  public static issuesHandler(
    issue: Issue,
    logger?: Logger,
    operation?: string,
    sender?: User,
    extra?: string
  ): Promise<string> {
    return issuesHandler(issue, logger, operation, sender, extra);
  }

  public static prHandler(
    pr: PullRequest,
    logger?: Logger,
    operation?: string,
    sender?: User,
    extra?: string
  ): Promise<string> {
    return prHandler(pr, logger, operation, sender, extra);
  }

  public static issuesOpened(issue: OpenedIssueEvent | ReopenedIssueEvent, logger?: Logger): Promise<string> {
    return issuesOpened(issue, logger);
  }

  public static issuesClosed(issue: ClosedIssueEvent, logger?: Logger): Promise<string> {
    return issuesClosed(issue, logger);
  }

  public static prOpened(pr: OpenedPullRequestEvent | ReopenedPullRequestEvent, logger?: Logger): Promise<string> {
    return prOpened(pr, logger);
  }

  public static prClosed(pr: ClosedPullRequestEvent, logger?: Logger): Promise<string> {
    return prClosed(pr, logger);
  }

  public static releaseHandler(
    release: Release,
    repository?: string,
    logger?: Logger,
    sender?: User
  ): Promise<string> {
    return releaseHandler(release, repository, logger, sender);
  }

  public static releasePublished(event: AllReleaseEvent, logger?: Logger): Promise<string> {
    return releasePublished(event, logger);
  }
}
