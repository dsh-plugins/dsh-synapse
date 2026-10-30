import { randomInt } from 'node:crypto';
import path from 'node:path';
import axios from 'axios';
import { readOrCreate, writeConfigFile } from '@/config/manager';

interface PendingBinding {
  code: string;
  username: string;
}

interface GitHubBindings {
  bindings: Record<string, string[]>;
  githubToQq: Record<string, string>;
  pending: Record<string, PendingBinding>;
}

interface GitHubUserProfile {
  login: string;
  bio: string | null;
}

export class GitHubBindingManager {
  private static readonly FILE = path.resolve(process.cwd(), 'configs', 'github-bind.json');
  private static readonly CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  private static bindings: GitHubBindings | undefined;

  /**
   * 绑定 GitHub 用户名。
   * @param qqUserId 平台内用户标识：QQ 号为 number；Discord 用户为 `dc:<用户ID>` 字符串
   *                 （`dc:` 前缀保证与纯数字 QQ 号不冲突，共用同一套绑定存储）
   */
  public static async bind(qqUserId: number | string, username: string): Promise<{ state: 'pending' | 'bound'; code?: string }> {
    const normalizedUsername = GitHubBindingManager.normalizeUsername(username);
    const bindings = GitHubBindingManager.load();
    const qqUserIdText = String(qqUserId);

    const boundQqUserId = bindings.githubToQq[normalizedUsername.toLowerCase()];
    if (boundQqUserId && boundQqUserId !== qqUserIdText) {
      throw new Error(`GitHub 用户 ${normalizedUsername} 已被其他用户绑定`);
    }
    if (GitHubBindingManager.hasBinding(qqUserIdText, normalizedUsername)) {
      return { state: 'bound' };
    }

    const pendingKey = `${qqUserIdText}:${normalizedUsername.toLowerCase()}`;
    const pending = bindings.pending[pendingKey];
    if (!pending) {
      const code = GitHubBindingManager.generateCode();
      bindings.pending[pendingKey] = { code, username: normalizedUsername };
      GitHubBindingManager.save();
      return { state: 'pending', code };
    }

    const profile = await GitHubBindingManager.getUserProfile(pending.username);
    if (!profile.bio?.includes(pending.code)) {
      return { state: 'pending', code: pending.code };
    }

    const boundUsernames = bindings.bindings[qqUserIdText] || [];
    const normalizedProfileUsername = profile.login.toLowerCase();
    const profileBoundQqUserId = bindings.githubToQq[normalizedProfileUsername];
    if (profileBoundQqUserId && profileBoundQqUserId !== qqUserIdText) {
      throw new Error(`GitHub 用户 ${profile.login} 已被其他用户绑定`);
    }
    if (!boundUsernames.some(boundUsername => boundUsername.toLowerCase() === normalizedProfileUsername)) {
      boundUsernames.push(profile.login);
      bindings.bindings[qqUserIdText] = boundUsernames;
    }
    bindings.githubToQq[normalizedProfileUsername] = qqUserIdText;
    delete bindings.pending[pendingKey];
    GitHubBindingManager.save();
    return { state: 'bound' };
  }

  public static isBoundUsername(username: string): boolean {
    const normalizedUsername = username.toLowerCase();
    return Boolean(GitHubBindingManager.load().githubToQq[normalizedUsername]);
  }

  private static normalizeUsername(username: string): string {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(username)) {
      throw new Error('GitHub 用户名格式无效');
    }
    return username;
  }

  private static generateCode(): string {
    let code = '';
    for (let index = 0; index < 12; index++) {
      code += GitHubBindingManager.CODE_ALPHABET[randomInt(GitHubBindingManager.CODE_ALPHABET.length)];
    }
    return code;
  }

  private static async getUserProfile(username: string): Promise<GitHubUserProfile> {
    try {
      const response = await axios.get<GitHubUserProfile>(`https://api.github.com/users/${username}`, {
        timeout: 10000,
        headers: { Accept: 'application/vnd.github+json' }
      });
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        throw new Error(`未找到 GitHub 用户 ${username}`);
      }
      throw new Error(`无法查询 GitHub 用户 ${username}`);
    }
  }

  private static hasBinding(qqUserId: string, username: string): boolean {
    return (GitHubBindingManager.load().bindings[qqUserId] || []).some(
      boundUsername => boundUsername.toLowerCase() === username.toLowerCase()
    );
  }

  /** 重新从磁盘加载绑定数据（/reload 用；清空内存缓存后懒加载） */
  public static reload(): void {
    GitHubBindingManager.bindings = undefined;
  }

  private static load(): GitHubBindings {
    if (GitHubBindingManager.bindings) return GitHubBindingManager.bindings;

    const { data } = readOrCreate<GitHubBindings>({
      path: GitHubBindingManager.FILE,
      factory: () => ({ bindings: {}, githubToQq: {}, pending: {} }),
      normalize: raw => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        const parsed = raw as Partial<GitHubBindings>;
        const bindings: Record<string, string[]> =
          parsed.bindings && typeof parsed.bindings === 'object' ? (parsed.bindings as Record<string, string[]>) : {};
        const githubToQq: Record<string, string> =
          parsed.githubToQq && typeof parsed.githubToQq === 'object' ? (parsed.githubToQq as Record<string, string>) : {};

        for (const [qqUserId, usernames] of Object.entries(bindings)) {
          if (!Array.isArray(usernames)) continue;
          for (const username of usernames) {
            if (typeof username !== 'string') continue;
            const normalizedUsername = username.toLowerCase();
            if (!githubToQq[normalizedUsername]) {
              githubToQq[normalizedUsername] = qqUserId;
            }
          }
        }

        return {
          bindings,
          githubToQq,
          pending: parsed.pending && typeof parsed.pending === 'object' ? (parsed.pending as Record<string, PendingBinding>) : {}
        };
      }
    });
    GitHubBindingManager.bindings = data;
    return GitHubBindingManager.bindings;
  }

  private static save(): void {
    if (!GitHubBindingManager.bindings) return;
    writeConfigFile(GitHubBindingManager.FILE, GitHubBindingManager.bindings);
  }
}
