import { EventManager } from 'gugle-event';
import { Logger } from 'winston';
import http from 'node:http';
import { QQBot } from '@/index';
import { AllIssueEvent, AllPullRequestEvent, AllReleaseEvent, Issue, PullRequest } from '@/type/github';
import { GroupMessageWSMSG, Message, SentMessage, TextMessage } from '@/type';
import { GitHubImage } from '@/features/github/image';
import { botConfig } from '@/config';
import { getGithubSubscribers, isGithubEnabledGroup } from '@/config/features';
import { GitHubBindingManager } from '@/features/github/binding';
import { fetchGithubApi } from '@/features/github/api';
import { shouldPushRelease } from '@/features/github/image/impl/release';
import axios, { AxiosInstance } from 'axios';

/** 一条 Issue/PR 引用（`owner/repo#123`，repo 省略时为默认仓库） */
export interface IssueReference {
  repository: string;
  number: number;
}

export class Github {
  private readonly bot: QQBot;
  private readonly logger: Logger;
  private readonly eventManager: EventManager;
  private httpServer: http.Server<typeof http.IncomingMessage, typeof http.ServerResponse>;

  public static readonly axiosInstance: AxiosInstance = axios.create({
    timeout: 15000,
    baseURL: botConfig.httpUrl,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': botConfig.userAgent
    }
  });

  /**
   * 请求 GitHub API（经 ghapi.anvilcraft.dev 反代），供 processMessage 使用。
   * @param apiPath GitHub API 路径（不含域名），如 /repos/owner/repo/issues/123
   */
  public static fetchGithubApi<T>(bot: QQBot, apiPath: string): Promise<T> {
    return fetchGithubApi<T>(apiPath, bot.logger);
  }

  public constructor(bot: QQBot) {
    this.bot = bot;
    this.logger = bot.logger!;
    this.eventManager = new EventManager();
    this.eventManager.listen('github-issues', this.listenIssueEvent.bind(this));
    this.eventManager.listen('github-pull_request', this.listenPullRequestEvent.bind(this));
    this.eventManager.listen('github-release', this.listenReleaseEvent.bind(this));
    this.httpServer = http.createServer((req, res) => {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
          body += chunk.toString(); // 将数据块拼接成字符串
        });
        req.on('end', () => {
          try {
            const event = (req.headers['x-github-event'] as string) || '';
            body = JSON.parse(body);
            bot.logger?.debug(`Receive Github Event: github-${event}`);
            this.post(`github-${event}`, bot, body);
            res.statusCode = 202;
            res.setHeader('Content-Type', 'text/plain');
            res.end('Accepted');
          } catch (e) {
            bot.logger?.error(e);
          }
        });
        return;
      }
      res.statusCode = 202;
      res.setHeader('Content-Type', 'text/plain');
      res.end('Accepted');
    });
  }

  private listenIssueEvent(bot: QQBot, msg: AllIssueEvent) {
    let promise: Promise<string> | undefined = undefined;
    if (msg.action === 'opened' || msg.action === 'reopened') {
      promise = GitHubImage.issuesOpened(msg, this.logger);
    } else if (msg.action === 'closed') {
      promise = GitHubImage.issuesClosed(msg, this.logger);
    }
    const repository = msg.repository.full_name;
    this.sendGeneratedImage(bot, repository, 'issue', promise);
  }

  private listenPullRequestEvent(bot: QQBot, msg: AllPullRequestEvent) {
    let promise: Promise<string> | undefined = undefined;
    if (msg.action === 'opened' || msg.action === 'reopened') {
      promise = GitHubImage.prOpened(msg, this.logger);
    } else if (msg.action === 'closed') {
      promise = GitHubImage.prClosed(msg, this.logger);
    }
    const repository = msg.repository.full_name;
    this.sendGeneratedImage(bot, repository, 'pull request', promise);
  }

  /**
   * 处理仓库发布 release 的 webhook 事件。
   *
   * GitHub 对同一次发布会投递多个 action（实测同一 release id 会在数秒内先后收到
   * created + released、published + created + prereleased 等组合，且组合不固定），
   * 因此按 action 过滤并不能避免重复，这里以 release id 在时间窗口内去重。
   */
  private listenReleaseEvent(bot: QQBot, msg: AllReleaseEvent) {
    const decision = shouldPushRelease(msg);
    if (!decision.push) {
      this.logger?.debug(`Skip release event ${msg.release?.id} (${msg.action}): ${decision.reason}`);
      return;
    }
    const repository = msg.repository.full_name;
    this.sendGeneratedImage(bot, repository, 'release', GitHubImage.releasePublished(msg, this.logger));
  }

  /**
   * 把生成的图片推送给订阅了该仓库的群（仓库级路由）。
   * 只发给 github.json 中 repository → 订阅群列表对应的群。
   */
  private sendGeneratedImage(bot: QQBot, repository: string, type: string, result: Promise<string> | undefined = undefined) {
    const subscribers = getGithubSubscribers(repository);
    if (subscribers.length === 0) {
      this.logger?.debug(`No subscribers for repository ${repository}, skip ${type} message...`);
      return;
    }
    result
      ?.then(base64 => {
        const msg: SentMessage = [
          {
            type: 'image',
            data: {
              file: `data:image/png;base64, ${base64}`
            }
          }
        ];
        subscribers.forEach(group => {
          // fromWebhook：标记为 webhook 推送，互通桥据此不转发到 need_cmd/need_reply 频道
          bot.sendGroupMsg(group, msg, { fromWebhook: true });
        });
        this.logger?.debug(`Sent process ${type} message of ${repository} to ${subscribers.length} group(s)...`);
      })
      .catch(e => {
        this.logger?.error(e);
      });
  }

  public post(event: string, ...args: any): Promise<any[]> {
    return this.eventManager.post(event, ...args);
  }

  public start(port: number): void {
    const self = this;
    this.httpServer.listen(port, () => {
      self.logger?.info(`http server listen on port ${port}`);
    });
  }

  /**
   * 判断仓库是否允许被访问：owner 已绑定 GitHub 账号，或命中允许列表配置。
   * 消息查询与订阅共用该判定，保证「能查」与「能订阅」口径一致。
   */
  public static isAllowedRepository(repository: string): boolean {
    const [owner] = repository.split('/');
    if (owner && GitHubBindingManager.isBoundUsername(owner)) return true;

    return botConfig.githubAllowedRepositories.some(pattern => {
      if (pattern.endsWith('/*')) return repository.startsWith(`${pattern.slice(0, -2)}/`);
      return repository === pattern;
    });
  }

  /** 单条消息最多解析的 Issue/PR 引用数（防止刷屏，超出部分忽略） */
  public static readonly MAX_REFERENCES_PER_MESSAGE = 10;

  /**
   * 解析文本中的全部 Issue/PR 引用（`owner/repo#123` 或 `#123`）。
   * 按出现顺序去重（`repository#number`），最多返回 MAX_REFERENCES_PER_MESSAGE 条。
   */
  public static parseReferences(text: string, defaultRepository: string = 'Anvil-Dev/AnvilCraft'): IssueReference[] {
    const pattern = /(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#(\d+)/g;
    const references: IssueReference[] = [];
    const seen = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const repository = match[1] || defaultRepository;
      const number = Number.parseInt(match[2]!, 10);
      const key = `${repository}#${number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      references.push({ repository, number });
      if (references.length >= Github.MAX_REFERENCES_PER_MESSAGE) break;
    }
    return references;
  }

  /**
   * 渲染单个 Issue/PR 引用为 QQ 消息段：成功为图片段，失败为文本说明段。
   * 仓库不在允许列表时返回提示文本（不发请求）。
   */
  public static async renderReference(bot: QQBot, reference: IssueReference): Promise<Message> {
    const { repository, number } = reference;
    if (!this.isAllowedRepository(repository)) {
      return {
        type: 'text',
        data: {
          text: `仓库 ${repository} 不在允许访问的仓库列表中`
        }
      };
    }

    const issueApiPath = `/repos/${repository}/issues/${number}`;
    const pullApiPath = `/repos/${repository}/pulls/${number}`;

    // 经 ghapi 反代获取 issue 数据
    let issueData: Issue & { pull_request?: unknown };
    try {
      issueData = await Github.fetchGithubApi<Issue & { pull_request?: unknown }>(bot, issueApiPath);
    } catch (e) {
      bot.logger?.error(e);
      return {
        type: 'text',
        data: {
          text: `请求失败，原因：${(e as Error)?.message ?? e}`
        }
      };
    }

    try {
      if (issueData.pull_request) {
        // 如果是 PR，经 ghapi 反代获取 PR 数据
        const prData = await Github.fetchGithubApi<PullRequest>(bot, pullApiPath);
        const imageData = await GitHubImage.prHandler(prData, bot.logger);
        return {
          type: 'image',
          data: {
            file: `data:image/png;base64, ${imageData}`
          }
        };
      }
      // 处理 issue
      const imageData = await GitHubImage.issuesHandler(issueData as Issue, bot.logger);
      return {
        type: 'image',
        data: {
          file: `data:image/png;base64, ${imageData}`
        }
      };
    } catch (e) {
      bot.logger?.error(e);
      return {
        type: 'text',
        data: {
          text: `图片处理失败，原因：${(e as Error)?.message ?? e}`
        }
      };
    }
  }

  /**
   * QQ 群消息入口：解析消息中的全部 Issue/PR 引用并逐个渲染。
   * 第一个引用的结果并入 sentMessage（随调用方的回复消息一起发出）；
   * 其余引用各自作为独立群消息发送（用户要求多编号时分多条消息发送）。
   * 渲染串行执行以保证消息顺序与编号顺序一致。
   */
  public static async processMessage(bot: QQBot, msg: GroupMessageWSMSG, sentMessage: Message[]): Promise<void> {
    if (!isGithubEnabledGroup(msg.group_id)) return;

    const receivedMessage: TextMessage[] = [];
    msg.message.forEach(message => {
      if (message.type != 'text') return;
      receivedMessage.push(message);
    });

    const strMsg = receivedMessage.map(msg => msg.data.text).join(' ');
    const references = Github.parseReferences(strMsg);
    if (references.length === 0) return;

    for (let index = 0; index < references.length; index++) {
      const rendered = await Github.renderReference(bot, references[index]!);
      if (index === 0) {
        sentMessage.push(rendered);
      } else {
        await bot.sendGroupMsg(msg.group_id, [rendered]);
      }
    }
  }

  /**
   * Discord 侧入口：解析文本中的全部 Issue/PR 引用并渲染为消息段列表（由调用方发送）。
   * groupId 为 Discord 频道桥接的 QQ 群号，用于复用「该群是否启用 github 功能」的判定。
   */
  public static async processDiscordMessage(bot: QQBot, text: string, groupId?: number): Promise<Message[]> {
    if (groupId !== undefined && !isGithubEnabledGroup(groupId)) return [];
    const references = Github.parseReferences(text);
    const results: Message[] = [];
    for (const reference of references) {
      results.push(await Github.renderReference(bot, reference));
    }
    return results;
  }
}
