export interface User {
  avatar_url: string;
  deleted?: boolean;
  email?: string;
  html_url: string;
  id: number;
  login: string;
  name?: string;
  type: 'Bot' | 'User' | 'Organization';
}

export interface Label {
  color: string;
  name: string;
  description?: string;
}

export type State = 'open' | 'closed';

export type IssueStateReason = 'completed' | 'duplicate' | 'not_planned' | string;

export interface Issue {
  title: string | number;
  number: number;
  body?: string;
  assignee?: User;
  state: State;
  state_reason?: IssueStateReason;
  milestone?: Milestone;
  labels: Label[];
  assignees?: User[];
  type: string;
  user: User;
  created_at: string;
  html_url?: string;
  repository_url?: string;
}

export interface PullRequest {
  title: string | number;
  number: number;
  body?: string;
  requested_reviewers?: User;
  assignee?: User;
  state: State;
  milestone?: Milestone;
  labels: Label[];
  assignees?: User[];
  user: User;
  merged: boolean;
  draft?: boolean;
  created_at: string;
  html_url?: string;
  repository_url?: string;
}

export interface Organization {
  id: number;
  login: string;
  description: string;
  avatar_url: string;
}

export type Privacy = State | 'secret';
export interface Team {
  id: number;
  name: string;
  slug: string;
  description: string;
  node_id: string;
  url: string;
  html_url: string;
  repositories_url: string;
  members_url: string;
  permission: string;
  privacy: Privacy;
  deleted?: boolean;
  parent?: Team;
}

export interface Repository {
  id: number;
  name: string;
  full_name: string;
  owner: User;
  html_url: string;
}

export interface Milestone {
  closed_at?: string;
  closed_issues: number;
  created_at: string;
  creator?: User;
  description?: string;
  due_on?: string;
  html_url: string;
  labels_url: string;
  node_id: string;
  number: string;
  open_issues: number;
  state: State;
  title: string;
  updated_at: string;
  url: string;
}

export interface TypeOfIssue {
  id: number;
  name: string;
  description?: string;
  color?: string;
  created_at?: string;
  updated_at?: string;
  is_enabled?: boolean;
}

export interface IssueEvent {
  issue: Issue;
  organization?: Organization;
  repository: Repository;
  sender: User;
}

export type AssignedIssueEvent = IssueEvent & {
  action: 'assigned';
  assignee?: User;
};

export type ClosedIssueEvent = IssueEvent & {
  action: 'closed';
};

export type DeletedIssueEvent = IssueEvent & {
  action: 'deleted';
};

export type DemilestonedIssueEvent = IssueEvent & {
  action: 'demilestoned';
  milestone: Milestone;
};

export type EditedIssueEvent = IssueEvent & {
  action: 'edited';
  changes: {
    body?: {
      from: string;
    };
    title?: {
      from: string;
    };
  };
};

export type LabeledIssueEvent = IssueEvent & {
  action: 'labeled';
  label: Label;
};

export type LockedIssueEvent = IssueEvent & {
  action: 'locked';
};

export type MilestonedIssueEvent = IssueEvent & {
  action: 'milestoned';
  milestone: Milestone;
};

export type OpenedIssueEvent = IssueEvent & {
  action: 'opened';
  changes?: {
    old_issue: Issue;
    old_repository: Repository;
  };
};

export type PinnedIssueEvent = IssueEvent & {
  action: 'pinned';
};

export type ReopenedIssueEvent = IssueEvent & {
  action: 'reopened';
};

export type TransferredIssueEvent = IssueEvent & {
  action: 'transferred';
  changes: {
    new_issue: Issue;
    new_repository: Repository;
  };
};

export type TypedIssueEvent = IssueEvent & {
  action: 'typed';
  type: TypeOfIssue;
};

export type UnassignedIssueEvent = IssueEvent & {
  action: 'unassigned';
  assignee?: User;
};

export type UnlabeledIssueEvent = IssueEvent & {
  action: 'unlabeled';
  label?: Label;
};

export type UnpinnedIssueEvent = IssueEvent & {
  action: 'unpinned';
};

export type UntypedIssueEvent = IssueEvent & {
  action: 'untyped';
  type: TypeOfIssue;
};

export type AllIssueEvent =
  | AssignedIssueEvent
  | ClosedIssueEvent
  | DeletedIssueEvent
  | DemilestonedIssueEvent
  | EditedIssueEvent
  | LabeledIssueEvent
  | LockedIssueEvent
  | MilestonedIssueEvent
  | OpenedIssueEvent
  | PinnedIssueEvent
  | ReopenedIssueEvent
  | TransferredIssueEvent
  | TypedIssueEvent
  | UnassignedIssueEvent
  | UnlabeledIssueEvent
  | UnpinnedIssueEvent
  | UntypedIssueEvent;

export interface PullRequestEvent {
  pull_request: PullRequest;
  organization?: Organization;
  repository: Repository;
  sender: User;
}

export type AssignedPullRequestEvent = PullRequestEvent & {
  action: 'assigned';
  assignee?: User;
};

export type AutoMergeDisabledPullRequestEvent = PullRequestEvent & {
  action: 'auto_merge_disabled';
  reason: string;
};

export type AutoMergeEnabledPullRequestEvent = PullRequestEvent & {
  action: 'auto_merge_enabled';
  reason?: string;
};

export type ClosedPullRequestEvent = PullRequestEvent & {
  action: 'closed';
};

export type ConvertedToDraftPullRequestEvent = PullRequestEvent & {
  action: 'converted_to_draft';
};

export type DemilestonedPullRequestEvent = PullRequestEvent & {
  action: 'demilestoned';
  milestone?: Milestone;
};

export type DequeuedReason =
  | 'UNKNOWN_REMOVAL_REASON'
  | 'MANUAL'
  | 'MERGE'
  | 'MERGE_CONFLICT'
  | 'CI_FAILURE'
  | 'CI_TIMEOUT'
  | 'ALREADY_MERGED'
  | 'QUEUE_CLEARED'
  | 'ROLL_BACK'
  | 'BRANCH_PROTECTIONS'
  | 'GIT_TREE_INVALID'
  | 'INVALID_MERGE_COMMIT';
export type DequeuedPullRequestEvent = PullRequestEvent & {
  action: 'dequeued';
  reason: DequeuedReason;
};

export type EditedPullRequestEvent = PullRequestEvent & {
  action: 'edited';
  changes: {
    base: {
      ref: {
        from: string;
      };
      sha: {
        from: string;
      };
    };
    body?: {
      from: string;
    };
    title?: {
      from: string;
    };
  };
};

export type EnqueuedPullRequestEvent = PullRequestEvent & {
  action: 'enqueued';
};

export type LabeledPullRequestEvent = PullRequestEvent & {
  action: 'labeled';
  label?: Label;
};

export type LockedPullRequestEvent = PullRequestEvent & {
  action: 'locked';
};

export type MilestonedPullRequestEvent = PullRequestEvent & {
  action: 'milestoned';
  milestone?: Milestone;
};

export type OpenedPullRequestEvent = PullRequestEvent & {
  action: 'opened';
};

export type ReadyForReviewPullRequestEvent = PullRequestEvent & {
  action: 'ready_for_review';
};

export type ReopenedPullRequestEvent = PullRequestEvent & {
  action: 'reopened';
};

export type ReviewRequestRemovedPullRequestEvent = PullRequestEvent & {
  action: 'review_request_removed';
  requested_reviewer?: User;
  requested_team: Team;
};

export type ReviewRequestedPullRequestEvent = PullRequestEvent & {
  action: 'review_requested';
  requested_reviewer?: User;
  requested_team: Team;
};

export type SynchronizePullRequestEvent = PullRequestEvent & {
  action: 'synchronize';
  after: string;
  before: string;
};

export type UnassignedPullRequestEvent = PullRequestEvent & {
  action: 'unassigned';
  assignee?: User;
};

export type UnlabeledPullRequestEvent = PullRequestEvent & {
  action: 'unlabeled';
  label?: Label;
};

export type UnlockedPullRequestEvent = PullRequestEvent & {
  action: 'unlocked';
};

export type AllPullRequestEvent =
  | AssignedPullRequestEvent
  | AutoMergeDisabledPullRequestEvent
  | AutoMergeEnabledPullRequestEvent
  | ClosedPullRequestEvent
  | ConvertedToDraftPullRequestEvent
  | DemilestonedPullRequestEvent
  | DequeuedPullRequestEvent
  | EditedPullRequestEvent
  | EnqueuedPullRequestEvent
  | LabeledPullRequestEvent
  | LockedPullRequestEvent
  | MilestonedPullRequestEvent
  | OpenedPullRequestEvent
  | ReadyForReviewPullRequestEvent
  | ReopenedPullRequestEvent
  | ReviewRequestRemovedPullRequestEvent
  | ReviewRequestedPullRequestEvent
  | SynchronizePullRequestEvent
  | UnassignedPullRequestEvent
  | UnlabeledPullRequestEvent
  | UnlockedPullRequestEvent;

/** release 上传的附件（如 jar 构建产物） */
export interface ReleaseAsset {
  id: number;
  name: string;
  label?: string | null;
  content_type: string;
  state: 'uploaded' | 'open' | string;
  size: number;
  download_count: number;
  created_at: string;
  updated_at: string;
  browser_download_url: string;
  uploader?: User;
}

export interface Release {
  id: number;
  tag_name: string;
  target_commitish: string;
  name: string | null;
  body?: string | null;
  draft: boolean;
  prerelease: boolean;
  created_at: string;
  published_at: string | null;
  html_url: string;
  url: string;
  tarball_url?: string | null;
  zipball_url?: string | null;
  author: User;
  assets: ReleaseAsset[];
}

export type ReleaseEvent = {
  action: 'published' | 'released' | 'created' | 'edited' | 'deleted' | 'prereleased' | 'unpublished';
  release: Release;
  repository: Repository;
  sender: User;
  organization?: Organization;
};

export type PublishedReleaseEvent = ReleaseEvent & {
  action: 'published';
};

export type ReleasedReleaseEvent = ReleaseEvent & {
  action: 'released';
};

export type PrereleasedReleaseEvent = ReleaseEvent & {
  action: 'prereleased';
};

export type AllReleaseEvent = ReleaseEvent;
