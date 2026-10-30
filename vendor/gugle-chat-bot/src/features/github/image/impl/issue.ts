import { Issue, IssueEvent, OpenedIssueEvent, ReopenedIssueEvent, User } from '@/type/github';
import { Logger } from 'winston';
import { Template, tryGenerateImage } from '@/image';
import dayjs from 'dayjs';
import { renderIssueBody } from '@/features/github/image';

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

function getIssueState(issue: Issue): string {
  if (issue.state == 'open') {
    return `
           <div class="state_label" style="color:white; background-color: #347d39; box-shadow-color: #347d39;">
               <div style="display: flex; align-items: center;">
                 <svg focusable="false" aria-label="Issue" 
                     class="octicon octicon-issue-opened prc-StateLabel-Icon-YICrR" role="img" viewBox="0 0 16 16" 
                     width="16" height="16" fill="currentColor" display="inline-block" 
                     overflow="visible" style="margin-right:4px; vertical-align:text-bottom">
                         <path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/>
                         <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z"/>
                 </svg>
                 Open
               </div>
           </div>\n
           `;
  } else {
    if (issue.state_reason == 'completed') {
      return `
             <div class="state_label" style="color:white; background-color: #8256d0; box-shadow-color: #8256d0;">
                 <div style="display: flex; align-items: center;">
                   <svg focusable="false" aria-label="Issue" class="octicon octicon-issue-closed prc-StateLabel-Icon-YICrR"
                    role="img" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" display="inline-block" 
                    overflow="visible" style="margin-right:4px; vertical-align:text-bottom">
                       <path d="M11.28 6.78a.75.75 0 0 0-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l3.5-3.5Z"/>
                       <path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0Zm-1.5 0a6.5 6.5 0 1 0-13 0 6.5 6.5 0 0 0 13 0Z"></path>
                   </svg>
                   Closed
                 </div>
             </div>\n
             `;
    } else {
      return `
             <div class="state_label" style="color:white; background-color: #656c76; box-shadow-color: #656c76;">
                 <div style="display: flex; align-items: center;">
                   <svg focusable="false" aria-label="Issue, not planned" class="octicon octicon-skip prc-StateLabel-Icon-YICrR"
                    role="img" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" display="inline-block" 
                    overflow="visible" style="margin-right:4px; vertical-align: text-bottom;">
                       <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 
                       0Zm9.78-2.22-5.5 5.5a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l5.5-5.5a.751.751 0 0 1 
                       1.042.018.751.751 0 0 1 .018 1.042Z"/>
                   </svg>
                   Closed
                 </div>
             </div>\n
             `;
    }
  }
}

export function issuesHandler(issue: Issue, logger?: Logger, operation?: string, sender?: User, extra?: string) {
  let labelsHtml = '';
  for (let label of issue.labels) {
    labelsHtml += `<div class="sidebar-label" style="color:#${label.color}ff; background-color: #${label.color}55; border:2px solid #${label.color}99">${label.name}</div>\n`;
  }
  let headerExtra: string | undefined = undefined;
  if (sender) {
    headerExtra = `<div class="message">用户<div class="user">${sender.login}</div>${operation}了 </div>`;
  }
  return new Promise<string>((resolve, reject) => {
    const repository = getRepositoryParts(issue.repository_url, issue.html_url);
    const repoFullName = `${repository.owner}/${repository.name}`;
    renderIssueBody(issue.body, repoFullName, logger)
      .then(bodyHtml => {
        const template = Template.load('issue', 'src/features/github/template')
          .arg('header extra', headerExtra || '')
          .arg('repository owner', repository.owner)
          .arg('repository name', repository.name)
          .arg('issue number', issue.number)
          .arg('state label', getIssueState(issue))
          .arg('issue title', issue.title)
          .arg('issue author', issue.user.login)
          .arg('issue body', bodyHtml)
          .arg('issue created at', dayjs(issue.created_at).format('YYYY-MM-DD HH:mm:ss'))
          .arg('issue labels', labelsHtml || 'No labels')
          .arg('extra', extra || '');
        const templateFile = template.file();
        template
          .handler()
          .then(issue => {
            logger?.debug(`Start process issue message...`);
            tryGenerateImage(resolve, reject, issue, 820, templateFile);
          })
          .catch(reject);
      })
      .catch(reject);
  });
}

export function issuesClosed(issue: IssueEvent, logger?: Logger): Promise<string> {
  let extra: string | undefined;
  if (issue.issue.state_reason) {
    extra = "<div class='h1'>关闭原因：</div>\n";
  }
  if (issue.issue.state_reason == 'completed') {
    extra += "<div class='body'>已完成</div>\n";
  } else if (issue.issue.state_reason == 'not_planned') {
    extra += "<div class='body'>未计划</div>\n";
  } else if (issue.issue.state_reason == 'duplicate') {
    extra += "<div class='body'>重复</div>\n";
  } else {
    extra += `<div class='body'>${issue.issue.state_reason}</div>\n`;
  }
  return issuesHandler(issue.issue, logger, '关闭', issue.sender, extra);
}

export function issuesOpened(issue: OpenedIssueEvent | ReopenedIssueEvent, logger?: Logger): Promise<string> {
  let operation: string;
  if (issue.action == 'reopened') {
    operation = '重新打开';
  } else {
    operation = '提交';
  }
  return issuesHandler(issue.issue, logger, operation, issue.sender);
}
