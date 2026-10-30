import { Release, ReleaseAsset, ReleaseEvent, User } from '@/type/github';
import { Logger } from 'winston';
import { Template, tryGenerateImage } from '@/image';
import dayjs from 'dayjs';
import { renderIssueBody } from '@/features/github/image';

/**
 * 解析仓库 owner/name。
 * 优先使用 webhook 载荷中的 repository.full_name（最可靠），
 * 其次从 html_url（https://github.com/owner/repo/releases/tag/x）解析。
 * 注意：不能用 release.url——它是 API 地址
 * (https://api.github.com/repos/owner/repo/releases/123)，末两段是 releases/123。
 */
function getRepositoryParts(repositoryFullName?: string, htmlUrl?: string): { owner: string; name: string } {
  if (repositoryFullName) {
    const parts = repositoryFullName.split('/').filter(Boolean);
    if (parts.length === 2) return { owner: parts[0]!, name: parts[1]! };
  }
  if (htmlUrl) {
    const parts = htmlUrl.split('/').filter(Boolean);
    const githubIndex = parts.indexOf('github.com');
    const repositoryParts = githubIndex >= 0 ? parts.slice(githubIndex + 1, githubIndex + 3) : [];
    if (repositoryParts.length === 2) return { owner: repositoryParts[0]!, name: repositoryParts[1]! };
  }
  return { owner: 'GitHub', name: '' };
}

/** 格式化为 GitHub 风格的体积文本（如 23.8 MB） */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 Bytes';
  const units = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  if (bytes === 0) return '0 Bytes';
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exponent);
  // GitHub 展示保留 1 位小数（整数体积不显示小数）
  const text = exponent === 0 || Number.isInteger(value) ? String(value) : value.toFixed(1);
  return `${text} ${units[exponent]}`;
}

/** 转义 HTML 特殊字符，避免标题/文件名破坏模板 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 「Latest」/「Pre-release」徽章 */
function getReleaseBadge(release: Release): string {
  if (release.prerelease) {
    return `<span class="release_badge release_badge_prerelease"><svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm4.25-3.25v6.5a.75.75 0 0 1-1.5 0v-6.5a.75.75 0 0 1 1.5 0Zm3.5 0v6.5a.75.75 0 0 1-1.5 0v-6.5a.75.75 0 0 1 1.5 0Z"/></svg>Pre-release</span>`;
  }
  if (release.draft) {
    return `<span class="release_badge release_badge_prerelease">Draft</span>`;
  }
  return `<span class="release_badge"><svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M8 16A8 8 0 1 1 8 0a8 8 0 0 1 0 16Zm3.78-9.72a.751.751 0 0 0-.018-1.042.751.751 0 0 0-1.042-.018L6.75 9.19 5.28 7.72a.751.751 0 0 0-1.042.018.751.751 0 0 0-.018 1.042l2 2a.75.75 0 0 0 1.06 0Z"/></svg>Latest</span>`;
}

/** 渲染 Assets 列表（GitHub release 页面的附件行） */
function renderAssets(assets: ReleaseAsset[]): string {
  if (!assets || assets.length === 0) {
    return '<div class="empty_assets">No assets uploaded.</div>';
  }
  return assets
    .map(asset => {
      const downloadCount = asset.download_count > 0 ? `${asset.download_count} downloads` : '0 downloads';
      return (
        `<div class="asset_item">` +
        `<svg class="asset_icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.75 1A1.75 1.75 0 0 0 1 2.75v10.5c0 .966.784 1.75 1.75 1.75h10.5c.966 0 1.75-.784 1.75-1.75V2.75A1.75 1.75 0 0 0 13.25 1Zm-.25 1.75a.25.25 0 0 1 .25-.25h10.5a.25.25 0 0 1 .25.25v10.5a.25.25 0 0 1-.25.25H2.75a.25.25 0 0 1-.25-.25Z"/><path d="M9.5 4.5v3.293l1.146-1.147a.75.75 0 1 1 1.061 1.061l-2.5 2.5a.75.75 0 0 1-1.06 0l-2.5-2.5a.75.75 0 0 1 1.06-1.06L8 7.792V4.5a.75.75 0 0 1 1.5 0Z"/></svg>` +
        `<a class="asset_name" href="${asset.browser_download_url}">${escapeHtml(asset.name)}</a>` +
        `<span class="asset_spacer"></span>` +
        `<span class="asset_size">${formatBytes(asset.size)}</span>` +
        `<span class="asset_downloads">${downloadCount}</span>` +
        `</div>`
      );
    })
    .join('\n');
}

export function releaseHandler(release: Release, repositoryFullName?: string, logger?: Logger, sender?: User) {
  let headerExtra: string | undefined = undefined;
  if (sender) {
    headerExtra = `<div class="message">用户<div class="user">${sender.login}</div>发布了 </div>`;
  }
  const repository = getRepositoryParts(repositoryFullName, release.html_url);
  const repoFullName = `${repository.owner}/${repository.name}`;
  // release 标题为空时回退为 tag 名
  const title = release.name || release.tag_name;
  return new Promise<string>((resolve, reject) => {
    renderIssueBody(release.body || '', repoFullName, logger)
      .then(bodyHtml => {
        const publishedAt = release.published_at || release.created_at;
        const template = Template.load('release', 'src/features/github/template')
          .arg('header extra', headerExtra || '')
          .arg('repository owner', repository.owner)
          .arg('repository name', repository.name)
          .arg('release badge', getReleaseBadge(release))
          .arg('release title', title)
          .arg('release tag', release.tag_name)
          .arg('release commitish', release.target_commitish)
          .arg('release author', release.author?.login || 'unknown')
          .arg('release published at', dayjs(publishedAt).format('YYYY-MM-DD HH:mm:ss'))
          .arg('release body', bodyHtml || '<p><em>No description provided.</em></p>')
          .arg('release asset count', release.assets?.length || 0)
          .arg('release assets', renderAssets(release.assets || []));
        const templateFile = template.file();
        template
          .handler()
          .then(html => {
            logger?.debug(`Start process release message...`);
            tryGenerateImage(resolve, reject, html, 820, templateFile);
          })
          .catch(reject);
      })
      .catch(reject);
  });
}

export function releasePublished(event: ReleaseEvent, logger?: Logger): Promise<string> {
  return releaseHandler(event.release, event.repository?.full_name, logger, event.sender);
}

/** 视为「发布」的 release action（其余如 edited / deleted / unpublished 不推送） */
const RELEASE_PUBLISH_ACTIONS = new Set(['created', 'published', 'released', 'prereleased']);
/** 同一次发布的多次投递会集中在数秒内到达，用该窗口折叠 */
export const RELEASE_DEDUPE_WINDOW_MS = 60 * 1000;
/** release id -> 最近一次推送时间 */
const handledReleases = new Map<number, number>();

/**
 * 判断一个 release webhook 事件是否应当推送。
 *
 * GitHub 对同一次发布会投递多个 action（实测同一 release id 会在数秒内先后收到
 * created + released、published + created + prereleased 等组合，且组合不固定），
 * 因此不能只按 action 过滤：这里以 release id 在时间窗口内去重，保证一次发布只推一张。
 * 同时跳过仍是草稿的 release（保存草稿同样会触发 created）。
 *
 * @param event release webhook 事件
 * @param now 当前时间戳（便于验证）
 * @returns 是否推送，以及跳过原因
 */
export function shouldPushRelease(event: ReleaseEvent, now: number = Date.now()): { push: boolean; reason: string } {
  if (!RELEASE_PUBLISH_ACTIONS.has(event.action)) {
    return { push: false, reason: `action ${event.action} 不属于发布` };
  }
  if (event.release.draft) {
    return { push: false, reason: 'release 仍为草稿' };
  }
  const last = handledReleases.get(event.release.id);
  if (last !== undefined && now - last < RELEASE_DEDUPE_WINDOW_MS) {
    return { push: false, reason: `同一 release 已于 ${now - last}ms 前推送` };
  }
  // 清理窗口外的记录，避免长期运行后 Map 持续增长
  for (const [id, timestamp] of handledReleases) {
    if (now - timestamp >= RELEASE_DEDUPE_WINDOW_MS) handledReleases.delete(id);
  }
  handledReleases.set(event.release.id, now);
  return { push: true, reason: '首次收到该 release 的发布事件' };
}
