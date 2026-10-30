import axios, { AxiosInstance } from 'axios';
import { Logger } from 'winston';
import { botConfig } from '@/config';
import { Issue, IssueStateReason, State } from '@/type/github';

/**
 * GitHub API 反代地址：URL 结构为 ghapi.anvilcraft.dev + apiPath。
 * 不再经其他第三方代理。
 */
const GITHUB_API_BASE = 'https://ghapi.anvilcraft.dev';

const axiosInstance: AxiosInstance = axios.create({
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
    'User-Agent': botConfig.userAgent
  }
});

/**
 * 请求 GitHub API（经 ghapi.anvilcraft.dev 反代）。
 * @param apiPath GitHub API 路径（不含域名），如 /repos/owner/repo/issues/123
 * @param logger 可选日志器
 */
export function fetchGithubApi<T>(apiPath: string, logger?: Logger): Promise<T> {
  const url = `${GITHUB_API_BASE}${apiPath}`;
  logger?.debug(`GitHub API: ${url}`);
  return axiosInstance.get(url).then(response => response.data as T);
}

/** issue/PR 状态细分（用于 pill 徽章渲染） */
export type LinkedIssueStatus =
  | 'open' // issue 进行中（绿色圆点）
  | 'completed' // issue 已完成关闭（紫色对勾）
  | 'not_planned' // issue 未计划等关闭（灰色斜杠）
  | 'pr_open' // PR 进行中（绿色 PR 图标）
  | 'pr_merged' // PR 已合并（紫色合并图标）
  | 'pr_closed' // PR 关闭未合并（红色 PR 关闭图标）
  | 'unknown'; // 状态未知（查询失败回退，灰色问号）

export interface LinkedIssueInfo {
  state: State;
  state_reason?: IssueStateReason;
  /** issue / PR 标题 */
  title?: string | number;
  /** issue API 对 PR 会带此字段；merged_at 非空表示已合并 */
  pull_request?: { merged_at?: string | null };
}

/** 把 API 返回的 state/state_reason/pull_request 归一化为 pill 状态 */
function toStatus(info: LinkedIssueInfo): LinkedIssueStatus {
  // PR 优先：issue API 对 PR 会带 pull_request 字段，merged_at 区分合并/关闭未合并
  if (info.pull_request) {
    if (info.state === 'open') return 'pr_open';
    return info.pull_request.merged_at ? 'pr_merged' : 'pr_closed';
  }
  if (info.state === 'open') return 'open';
  if (info.state === 'closed') {
    return info.state_reason === 'completed' ? 'completed' : 'not_planned';
  }
  return 'unknown';
}

/** 查询结果：状态 + 标题（失败时标题缺失，调用方回退为编号显示） */
export interface LinkedIssueDetail {
  status: LinkedIssueStatus;
  title?: string;
}

/**
 * 查询 issue/PR 状态与标题。失败回退：任何错误都返回 { status: 'unknown' }，
 * 不抛异常、不阻塞调用方。
 * @param repository owner/repo
 * @param number issue 编号
 * @param logger 可选日志器
 */
export async function fetchIssueDetail(
  repository: string,
  number: number,
  logger?: Logger
): Promise<LinkedIssueDetail> {
  try {
    const info = await fetchGithubApi<LinkedIssueInfo>(`/repos/${repository}/issues/${number}`, logger);
    const status = toStatus(info);
    if (info.title == null) {
      return { status };
    }
    return { status, title: String(info.title) };
  } catch (e) {
    logger?.warn(`查询 issue 状态失败 ${repository}#${number}：${(e as Error)?.message ?? e}`);
    return { status: 'unknown' };
  }
}
