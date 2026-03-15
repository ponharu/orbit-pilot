import { graphql } from '@octokit/graphql';
import type { GraphQlQueryResponseData } from '@octokit/graphql';
import type { GitHubIssue, RepoTarget } from '../core/types';
import { runShell } from '../util/shell';

type IssueListItem = {
  number: number;
  title: string;
  body: string | null;
  url: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  assignees: Array<{ login: string }>;
};

type PullRequestCheck = {
  bucket?: string;
  completedAt?: string | null;
  description?: string | null;
  link?: string | null;
  name?: string;
  state?: string;
  workflow?: string | null;
};

type RepositoryListItem = {
  name: string;
  nameWithOwner: string;
  owner?: {
    login?: string | null;
  } | null;
  defaultBranchRef?: {
    name?: string | null;
  } | null;
  isArchived?: boolean;
  isDisabled?: boolean;
};

type LinkedPullRequestQuery = {
  repository: {
    issue: {
      timelineItems: {
        nodes: Array<{
          source?: {
            __typename?: string;
            number?: number;
            updatedAt?: string;
          } | null;
        } | null>;
      };
    } | null;
  } | null;
};

type PullRequestReviewSnapshotQuery = {
  repository: {
    pullRequest: {
      number: number;
      updatedAt: string;
      comments: {
        nodes: Array<PullRequestIssueCommentNode | null>;
      };
      reviews: {
        nodes: Array<PullRequestReviewNode | null>;
      };
      reviewThreads: {
        nodes: Array<ReviewThreadNode | null>;
      };
    } | null;
  } | null;
};

type PullRequestIssueCommentNode = {
  body?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  author?: {
    login?: string | null;
  } | null;
};

type PullRequestReviewNode = {
  body?: string | null;
  state?: string | null;
  submittedAt?: string | null;
  author?: {
    login?: string | null;
  } | null;
};

type ReviewThreadNode = {
  isResolved?: boolean | null;
  isOutdated?: boolean | null;
  comments: {
    nodes: Array<ReviewThreadCommentNode | null>;
  };
};

type ReviewThreadCommentNode = {
  body?: string | null;
  path?: string | null;
  line?: number | null;
  originalLine?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  author?: {
    login?: string | null;
  } | null;
};

type PullRequestReference = {
  number: number;
  updatedAt: string;
};

type PullRequestReviewSnapshot = {
  number: number;
  updatedAt: string;
  reviewBodies: Array<{
    timestamp: string;
    text: string;
  }>;
  issueComments: Array<{
    timestamp: string;
    text: string;
  }>;
  threadComments: Array<{
    timestamp: string;
    text: string;
  }>;
};

export class GitHubClient {
  private authTokenPromise: Promise<string> | null = null;
  private viewerLoginPromise: Promise<string> | null = null;

  async assertReady() {
    const result = await runShell('gh auth status', { cwd: process.cwd() });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || '`gh auth status` failed');
    }
  }

  async getViewerLogin() {
    if (!this.viewerLoginPromise) {
      this.viewerLoginPromise = this.runGhText(['api', 'user', '--jq', '.login'], process.cwd()).then((login) =>
        login.trim().toLowerCase(),
      );
    }

    return this.viewerLoginPromise;
  }

  async listRepositories(owners: string[], excludeRepos: string[]): Promise<RepoTarget[]> {
    const excluded = new Set(excludeRepos.map((repo) => repo.trim().toLowerCase()).filter(Boolean));
    const repositories = new Map<string, RepoTarget>();

    for (const owner of owners) {
      const items = await this.runGhJson<RepositoryListItem[]>(
        [
          'repo',
          'list',
          owner,
          '--limit',
          '1000',
          '--json',
          'name,nameWithOwner,owner,defaultBranchRef,isArchived,isDisabled',
        ],
        process.cwd(),
      );

      for (const item of items) {
        const fullName = item.nameWithOwner?.trim();
        if (!fullName || excluded.has(fullName.toLowerCase()) || item.isArchived || item.isDisabled) {
          continue;
        }

        const ownerLogin = item.owner?.login?.trim() || fullName.split('/')[0];
        const repoName = item.name?.trim() || fullName.split('/')[1];

        repositories.set(fullName.toLowerCase(), {
          owner: ownerLogin,
          repo: repoName,
          fullName,
          defaultBranch: item.defaultBranchRef?.name?.trim() || 'main',
        });
      }
    }

    return [...repositories.values()].toSorted((left, right) => left.fullName.localeCompare(right.fullName));
  }

  async listOpenIssues(target: RepoTarget): Promise<GitHubIssue[]> {
    const output = await this.runGhJson<IssueListItem[]>(
      [
        'issue',
        'list',
        '--repo',
        target.fullName,
        '--state',
        'open',
        '--limit',
        '500',
        '--json',
        'number,title,body,url,state,createdAt,updatedAt,assignees',
      ],
      process.cwd(),
    );

    return output.map((issue) => normalizeIssue(target, issue));
  }

  async getIssues(target: RepoTarget, issueNumbers: number[]): Promise<GitHubIssue[]> {
    return Promise.all(
      issueNumbers.map(async (issueNumber) => {
        const issue = await this.runGhJson<IssueListItem>(
          [
            'issue',
            'view',
            String(issueNumber),
            '--repo',
            target.fullName,
            '--json',
            'number,title,body,url,state,createdAt,updatedAt,assignees',
          ],
          process.cwd(),
        );

        return normalizeIssue(target, issue);
      }),
    );
  }

  async getIssueSignal(target: RepoTarget, issue: GitHubIssue) {
    const issueTimestamp = issue.updatedAt;

    const pullRequests = await this.listLinkedPullRequests(target, issue.number);

    if (pullRequests.length === 0) {
      return {
        revision: issueTimestamp,
        reason: 'poll' as const,
      };
    }

    let reviewTimestamp = issueTimestamp;

    for (const pullRequest of pullRequests) {
      const signalTimestamp = await this.getPullRequestSignalTimestamp(target, pullRequest);
      if (signalTimestamp > reviewTimestamp) {
        reviewTimestamp = signalTimestamp;
      }
    }

    return {
      revision: reviewTimestamp,
      reason: reviewTimestamp > issueTimestamp ? ('review' as const) : ('poll' as const),
    };
  }

  async buildCloneUrl(target: RepoTarget): Promise<string> {
    const token = await this.getAuthToken();
    return `https://x-access-token:${token}@github.com/${target.fullName}.git`;
  }

  async getReviewFeedback(
    target: RepoTarget,
    issue: GitHubIssue,
  ): Promise<{ prNumber: number; feedback: string } | null> {
    const pullRequests = await this.listLinkedPullRequests(target, issue.number);

    if (pullRequests.length === 0) {
      return null;
    }

    let latest: { prNumber: number; timestamp: string; feedback: string } | null = null;

    for (const pullRequest of pullRequests) {
      const snapshot = await this.getPullRequestReviewSnapshot(target, pullRequest.number);
      const timestamp = latestReviewTimestamp(snapshot);
      const feedback = formatReviewFeedback(snapshot);

      if (!latest || timestamp > latest.timestamp) {
        latest = {
          prNumber: pullRequest.number,
          timestamp,
          feedback,
        };
      }
    }

    return latest;
  }

  async getCiFailureContext(
    target: RepoTarget,
    issue: GitHubIssue,
  ): Promise<{ prNumber: number; summary: string } | null> {
    const pullRequests = await this.listLinkedPullRequests(target, issue.number);

    if (pullRequests.length === 0) {
      return null;
    }

    for (const pullRequest of pullRequests) {
      const summary = await this.getPullRequestCiFailureSummary(target, pullRequest.number);
      if (summary) {
        return { prNumber: pullRequest.number, summary };
      }
    }

    return null;
  }

  private async listLinkedPullRequests(target: RepoTarget, issueNumber: number): Promise<PullRequestReference[]> {
    const result = await this.graphqlQuery<LinkedPullRequestQuery>(
      `
        query LinkedPullRequests($owner: String!, $repo: String!, $issueNumber: Int!) {
          repository(owner: $owner, name: $repo) {
            issue(number: $issueNumber) {
              timelineItems(first: 100, itemTypes: [CROSS_REFERENCED_EVENT]) {
                nodes {
                  ... on CrossReferencedEvent {
                    source {
                      __typename
                      ... on PullRequest {
                        number
                        updatedAt
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `,
      {
        owner: target.owner,
        repo: target.repo,
        issueNumber,
      },
    );

    const references = result.repository?.issue?.timelineItems.nodes ?? [];
    const pullRequests = new Map<number, PullRequestReference>();

    for (const node of references) {
      const source = node?.source;
      if (source?.__typename !== 'PullRequest' || typeof source.number !== 'number' || !source.updatedAt) {
        continue;
      }

      pullRequests.set(source.number, {
        number: source.number,
        updatedAt: source.updatedAt,
      });
    }

    return [...pullRequests.values()];
  }

  private async getPullRequestSignalTimestamp(target: RepoTarget, pullRequest: PullRequestReference) {
    const [snapshot, checks] = await Promise.all([
      this.getPullRequestReviewSnapshot(target, pullRequest.number),
      this.runGhJsonAllowing<PullRequestCheck[]>(
        ['pr', 'checks', String(pullRequest.number), '--repo', target.fullName, '--json', 'completedAt'],
        process.cwd(),
        [8],
      ),
    ]);

    const timestamps = [
      snapshot.updatedAt,
      ...snapshot.reviewBodies.map((item) => item.timestamp),
      ...snapshot.issueComments.map((item) => item.timestamp),
      ...snapshot.threadComments.map((item) => item.timestamp),
      ...checks.flatMap((item) => (item.completedAt ? [item.completedAt] : [])),
    ];

    return timestamps.toSorted().at(-1) ?? pullRequest.updatedAt;
  }

  private async getPullRequestReviewSnapshot(target: RepoTarget, prNumber: number): Promise<PullRequestReviewSnapshot> {
    const result = await this.graphqlQuery<PullRequestReviewSnapshotQuery>(
      `
        query PullRequestReviewSnapshot($owner: String!, $repo: String!, $prNumber: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $prNumber) {
              number
              updatedAt
              comments(first: 50) {
                nodes {
                  body
                  createdAt
                  updatedAt
                  author {
                    login
                  }
                }
              }
              reviews(first: 50) {
                nodes {
                  body
                  state
                  submittedAt
                  author {
                    login
                  }
                }
              }
              reviewThreads(first: 100) {
                nodes {
                  isResolved
                  isOutdated
                  comments(first: 20) {
                    nodes {
                      body
                      path
                      line
                      originalLine
                      createdAt
                      updatedAt
                      author {
                        login
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `,
      {
        owner: target.owner,
        repo: target.repo,
        prNumber,
      },
    );

    const pullRequest = result.repository?.pullRequest;
    if (!pullRequest) {
      throw new Error(`pull request not found: ${target.fullName}#${prNumber}`);
    }

    return {
      number: pullRequest.number,
      updatedAt: pullRequest.updatedAt,
      reviewBodies: (pullRequest.reviews.nodes ?? []).flatMap((review) => {
        const body = review?.body?.trim();
        const timestamp = review?.submittedAt ?? null;
        if (!body || !timestamp) {
          return [];
        }

        const author = review?.author?.login?.trim() || 'unknown';
        const state = review?.state?.trim().toLowerCase() || 'commented';
        return [{ timestamp, text: `[review:${state}] ${author}\n${body}` }];
      }),
      issueComments: (pullRequest.comments.nodes ?? []).flatMap((comment) => {
        const body = comment?.body?.trim();
        const timestamp = comment?.updatedAt ?? comment?.createdAt ?? null;
        if (!body || !timestamp) {
          return [];
        }

        const author = comment?.author?.login?.trim() || 'unknown';
        return [{ timestamp, text: `[comment] ${author}\n${body}` }];
      }),
      threadComments: (pullRequest.reviewThreads.nodes ?? []).flatMap((thread) => {
        const prefix = threadPrefix(thread);

        return (thread?.comments.nodes ?? []).flatMap((comment) => {
          const body = comment?.body?.trim();
          const timestamp = comment?.updatedAt ?? comment?.createdAt ?? null;
          if (!body || !timestamp) {
            return [];
          }

          const author = comment?.author?.login?.trim() || 'unknown';
          const location = formatCommentLocation(comment);
          return [
            {
              timestamp,
              text: `${prefix} ${author}${location}\n${body}`,
            },
          ];
        });
      }),
    };
  }

  private async getPullRequestCiFailureSummary(target: RepoTarget, prNumber: number) {
    const checks = await this.runGhJsonAllowing<PullRequestCheck[]>(
      [
        'pr',
        'checks',
        String(prNumber),
        '--repo',
        target.fullName,
        '--json',
        'bucket,completedAt,description,link,name,state,workflow',
      ],
      process.cwd(),
      [8],
    );

    const failedChecks = checks
      .filter((check) => check.bucket === 'fail')
      .toSorted((left, right) => (left.completedAt ?? '').localeCompare(right.completedAt ?? ''))
      .slice(-3);

    if (failedChecks.length === 0) {
      return null;
    }

    const sections: string[] = [];

    for (const check of failedChecks) {
      const headerParts = [check.name?.trim() || 'unknown-check'];
      if (check.workflow?.trim()) {
        headerParts.push(`workflow: ${check.workflow.trim()}`);
      }
      if (check.state?.trim()) {
        headerParts.push(`state: ${check.state.trim()}`);
      }
      if (check.description?.trim()) {
        headerParts.push(check.description.trim());
      }

      const log = await this.getCheckFailureLog(target, check.link ?? null);
      sections.push([headerParts.join(' | '), log ?? '(failed check log unavailable)'].join('\n'));
    }

    return sections.join('\n\n');
  }

  private async getCheckFailureLog(target: RepoTarget, link: string | null) {
    if (!link) {
      return null;
    }

    const jobMatch = link.match(/\/jobs\/(\d+)/);
    if (jobMatch) {
      const result = await runShell(
        ['gh', 'run', 'view', '--repo', target.fullName, '--job', jobMatch[1], '--log-failed']
          .map(shellEscape)
          .join(' '),
        { cwd: process.cwd() },
      );

      if (result.exitCode === 0) {
        return trimForContext(result.stdout, 2000);
      }
    }

    const runMatch = link.match(/\/runs\/(\d+)/);
    if (runMatch) {
      const result = await runShell(
        ['gh', 'run', 'view', runMatch[1], '--repo', target.fullName, '--log-failed'].map(shellEscape).join(' '),
        { cwd: process.cwd() },
      );

      if (result.exitCode === 0) {
        return trimForContext(result.stdout, 2000);
      }
    }

    return null;
  }

  private async graphqlQuery<T extends GraphQlQueryResponseData>(
    query: string,
    variables: Record<string, string | number>,
  ): Promise<T> {
    const token = await this.getAuthToken();

    return graphql<T>(query, {
      ...variables,
      headers: {
        authorization: `token ${token}`,
      },
    });
  }

  private async getAuthToken() {
    if (!this.authTokenPromise) {
      this.authTokenPromise = this.runGhText(['auth', 'token'], process.cwd()).then((token) => token.trim());
    }

    return this.authTokenPromise;
  }

  private async runGhJson<T>(args: string[], cwd: string): Promise<T> {
    return this.runGhJsonAllowing<T>(args, cwd, []);
  }

  private async runGhJsonAllowing<T>(args: string[], cwd: string, allowedExitCodes: number[]): Promise<T> {
    const result = await runShell(['gh', ...args].map(shellEscape).join(' '), { cwd });

    if (result.exitCode !== 0 && !allowedExitCodes.includes(result.exitCode)) {
      throw new Error(result.stderr || result.stdout || `gh command failed: ${args.join(' ')}`);
    }

    if (result.stdout.trim().length === 0) {
      return [] as T;
    }

    return JSON.parse(result.stdout) as T;
  }

  private async runGhText(args: string[], cwd: string): Promise<string> {
    const result = await runShell(['gh', ...args].map(shellEscape).join(' '), { cwd });

    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || `gh command failed: ${args.join(' ')}`);
    }

    return result.stdout;
  }
}

function normalizeIssue(target: RepoTarget, issue: IssueListItem): GitHubIssue {
  return {
    number: issue.number,
    identifier: `${target.fullName}#${issue.number}`,
    title: issue.title ?? '',
    body: issue.body ?? '',
    state: issue.state === 'closed' ? 'closed' : 'open',
    assignees: issue.assignees.map((assignee) => assignee.login.trim().toLowerCase()).filter(Boolean),
    htmlUrl: issue.url,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    isPullRequest: false,
  };
}

function latestReviewTimestamp(snapshot: PullRequestReviewSnapshot) {
  const timestamps = [
    snapshot.updatedAt,
    ...snapshot.reviewBodies.map((item) => item.timestamp),
    ...snapshot.issueComments.map((item) => item.timestamp),
    ...snapshot.threadComments.map((item) => item.timestamp),
  ];

  return timestamps.toSorted().at(-1) ?? snapshot.updatedAt;
}

function formatReviewFeedback(snapshot: PullRequestReviewSnapshot) {
  const items = [...snapshot.reviewBodies, ...snapshot.issueComments, ...snapshot.threadComments]
    .toSorted((left, right) => left.timestamp.localeCompare(right.timestamp))
    .slice(-10)
    .map((item) => item.text);

  if (items.length === 0) {
    return `PR #${snapshot.number} was updated, but no textual review feedback was found.`;
  }

  return items.join('\n\n');
}

function threadPrefix(thread: ReviewThreadNode | null) {
  if (thread?.isResolved) {
    return '[inline][resolved]';
  }

  if (thread?.isOutdated) {
    return '[inline][outdated]';
  }

  return '[inline][unresolved]';
}

function formatCommentLocation(comment: ReviewThreadCommentNode | null) {
  if (!comment?.path) {
    return '';
  }

  const line = typeof comment.line === 'number' ? comment.line : comment.originalLine;
  if (typeof line === 'number') {
    return ` (${comment.path}:${line})`;
  }

  return ` (${comment.path})`;
}

function shellEscape(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function trimForContext(value: string, maxLength: number) {
  const normalized = value.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 14)}\n...[truncated]`;
}
