export type Logger = {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
};

export type GitHubIssue = {
  number: number;
  identifier: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  assignees: string[];
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  isPullRequest: boolean;
};

export type RepoTarget = {
  owner: string;
  repo: string;
  fullName: string;
  defaultBranch: string;
};

export type RunMetadata = {
  issueNumber: number;
  attempt: number;
  reason: 'initial' | 'review';
  branchName: string | null;
};

export type AgentContext = {
  continuationContext: string | null;
};

export type WorkspaceState = {
  issueNumber: number;
  repo: string;
  branchName: string | null;
  status: 'idle' | 'running' | 'retrying' | 'failed';
  lastHandledRevision: string | null;
  lastRunAt: string | null;
  lastTrigger: string | null;
  retryCount: number;
  lastError: string | null;
  lastFailureContext: string | null;
  threadId: string | null;
  updatedAt: string;
};
