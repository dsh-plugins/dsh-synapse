import { OpenedPullRequestEvent, PullRequest, PullRequestEvent, ReopenedPullRequestEvent, User } from '@/type/github';
import { Logger } from 'winston';
import { Template, tryGenerateImage } from '@/image';
import { renderIssueBody } from '@/features/github/image';
import dayjs from 'dayjs';

function getRepositoryParts(repositoryUrl?: string, htmlUrl?: string): { owner: string; name: string } {
  const url = repositoryUrl || htmlUrl;
  if (!url) return { owner: 'GitHub', name: '' };
  const parts = url.split('/').filter(Boolean);
  const githubIndex = parts.indexOf('github.com');
  const repositoryParts = githubIndex >= 0 ? parts.slice(githubIndex + 1, githubIndex + 3) : parts.slice(-2);
  return repositoryParts.length === 2
    ? { owner: repositoryParts[0]!, name: repositoryParts[1]! }
    : { owner: 'GitHub', name: '' };
}

export function getPullRequestState(pr: PullRequest): string {
  if (pr.state == 'open') {
    if (pr.draft) {
      return `
             <div class="state_label" style="color:white; background-color: #656c76;  box-shadow-color: #656c76;">
                 <div style="display: flex; align-items: center;">
                     <svg class="octicon" focusable="false" height="16" fill="currentColor" viewBox="0 0 16 16" version="1.1" width="16" aria-hidden="true">
                         <path d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 
                          0 0 1 3.25 1Zm9.5 14a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5ZM2.5 3.25a.75.75 0 1 0 1.5 0 
                          .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 
                          0 0 0 0-1.5ZM14 7.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm0-4.25a1.25 1.25 0 1 1-2.5 0 
                          1.25 1.25 0 0 1 2.5 0Z"/>
                     </svg>
                     Draft 
                 </div>
             </div>\n
             `;
    } else {
      return `
             <div class="state_label" style="color:white; background-color: #347d39; box-shadow-color: #347d39;">
                 <div style="display: flex; align-items: center;">
                     <svg class="octicon" focusable="false" height="16" fill="currentColor" viewBox="0 0 16 16" version="1.1" width="16" aria-hidden="true">
                         <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 
                          0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 
                          2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 
                          0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 
                          0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"/>
                     </svg>
                     Open 
                 </div>
             </div>\n
             `;
    }
  } else {
    if (pr.merged) {
      return `
             <div class="state_label" style="color:white; background-color: #8256d0; box-shadow-color: #8256d0;">
                 <div style="display: flex; align-items: center;">
                     <svg class="octicon" focusable="false" height="16" fill="currentColor" viewBox="0 0 16 16" version="1.1" width="16" aria-hidden="true">
                         <path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734
                          0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 
                          0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 
                          0 1 0 0 .005V3.25Z"/>
                     </svg>
                     Merged 
                 </div>
             </div>\n
             `;
    } else {
      return `
             <div class="state_label" style="color:white; background-color: #c93c37; box-shadow-color: #c93c37;">
                 <div style="display: flex; align-items: center;">
                     <svg class="octicon" focusable="false" height="16" fill="currentColor" viewBox="0 0 16 16" version="1.1" width="16" aria-hidden="true">
                         <path d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251
                             0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75
                             0 0 1 .75-.75Zm-2.03-5.273a.75.75 0 0 1 1.06 0l.97.97.97-.97a.748.748 0 0 1 1.265.332.75.75
                             0 0 1-.205.729l-.97.97.97.97a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-.97-.97-.97.97a.749.749
                             0 0 1-1.275-.326.749.749 0 0 1 .215-.734l.97-.97-.97-.97a.75.75 0 0 1 0-1.06ZM2.5 3.25a.75.75
                             0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1
                             0 0 1.5.75.75 0 0 0 0-1.5Z"/>
                     </svg>
                     Closed
                 </div>
             </div>\n
             `;
    }
  }
}

export function prHandler(pr: PullRequest, logger?: Logger, operation?: string, sender?: User, extra?: string) {
  let labelsHtml = '';
  for (let label of pr.labels) {
    labelsHtml += `<div class="sidebar-label" style="color:#${label.color}ff; background-color: #${label.color}55; border:2px solid #${label.color}99">${label.name}</div>\n`;
  }
  let headerExtra: string | undefined = undefined;
  if (sender) {
    headerExtra = `<div class="message">用户<div class="user">${sender.login}</div>${operation}了 </div>`;
  }
  return new Promise<string>((resolve, reject) => {
    const repository = getRepositoryParts(pr.repository_url, pr.html_url);
    const repoFullName = `${repository.owner}/${repository.name}`;
    renderIssueBody(pr.body, repoFullName, logger)
      .then(bodyHtml => {
        const template = Template.load('pull_request', 'src/features/github/template')
          .arg('header extra', headerExtra || '')
          .arg('repository owner', repository.owner)
          .arg('repository name', repository.name)
          .arg('pr number', pr.number)
          .arg('pr title', pr.title)
          .arg('pr body', bodyHtml)
          .arg('pr labels', labelsHtml || 'No labels')
          .arg('pr author', pr.user.login)
          .arg('pr created at', dayjs(pr.created_at).format('YYYY-MM-DD HH:mm:ss'))
          .arg('state label', getPullRequestState(pr))
          .arg('extra', extra || '');
        const templateFile = template.file();
        template
          .handler()
          .then(pr => {
            logger?.debug(`Start process pull request message...`);
            tryGenerateImage(resolve, reject, pr, 820, templateFile);
          })
          .catch(reject);
      })
      .catch(reject);
  });
}

export function prClosed(pr: PullRequestEvent, logger?: Logger): Promise<string> {
  let operation: string;
  if (pr.pull_request.merged) {
    operation = '合并';
  } else {
    operation = '关闭';
  }
  return prHandler(pr.pull_request, logger, operation, pr.sender);
}

export function prOpened(pr: OpenedPullRequestEvent | ReopenedPullRequestEvent, logger?: Logger): Promise<string> {
  let operation: string;
  if (pr.action == 'reopened') {
    operation = '重新打开';
  } else {
    operation = '提交';
  }
  return prHandler(pr.pull_request, logger, operation, pr.sender);
}
