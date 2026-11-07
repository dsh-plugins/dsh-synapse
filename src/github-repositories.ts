import type { GithubRepository } from "./types.js";

export const REPOSITORY_PATTERN = "^(?!\\.{1,2}/)[\\w.-]{1,100}/(?!\\.{1,2}$)(?:[\\w.-]{1,100}|\\*)$(?![\\s\\S])";
const pattern = new RegExp(REPOSITORY_PATTERN);

export function repositoryName(value: unknown): value is string {
  return typeof value === "string" && pattern.test(value) && !value.endsWith("/*");
}

/** 新连接默认只允许卡片，模型任务需要逐项启用。 */
export function newRepository(repository = ""): GithubRepository {
  return { repository, reviewPr: false, triageIssues: false, sendCards: true };
}

export function repositoryConnection(value: unknown, repositories: GithubRepository[]): GithubRepository | undefined {
  if (!repositoryName(value)) { return undefined; }
  const repository = value.toLowerCase();
  const wildcard = `${repository.split("/")[0]}/*`;
  return repositories.find(row => row.repository.toLowerCase() === repository)
    ?? repositories.find(row => row.repository.toLowerCase() === wildcard);
}
