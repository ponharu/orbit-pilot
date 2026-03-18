import { graphql as requestGraphql } from '@octokit/graphql';
import type { GitHubIssue, RepoTarget } from '../core/types';
import { runShell } from '../util/shell';

type PullRequestCheck = {
  bucket?: string;
  completedAt?: string | null;
};

type SearchIssueResult = {
  assignees?: Array<{ login?: string | null }> | null;
  body?: string | null;
  createdAt?: string | null;
  isPullRequest?: boolean;
  number?: number;
  repository?: {
    name?: string | null;
    nameWithOwner?: string | null;
  } | null;
  state?: string | null;
  title?: string | null;
  updatedAt?: string | null;
  url?: string | null;
};

type LinkedPullRequestsResponse = {
  repository?: {
    issue?: {
      timelineItems?: {
        nodes?: Array<{
          __typename?: string;
          source?: {
            __typename?: string;
            number?: number;
            updatedAt?: string | null;
            state?: string | null;
            url?: string | null;
            headRefName?: string | null;
            baseRefName?: string | null;
            baseRefOid?: string | null;
            mergeStateStatus?: string | null;
          } | null;
        } | null> | null;
      } | null;
    } | null;
  } | null;
};

type PullRequestSignalSnapshotResponse = {
  repository?: {
    pullRequest?: {
      comments: {
        nodes?: Array<{
          createdAt?: string | null;
          updatedAt?: string | null;
        } | null> | null;
      };
      reviews: {
        nodes?: Array<{
          submittedAt?: string | null;
        } | null> | null;
      };
      reviewThreads: {
        nodes?: Array<{
          isResolved?: boolean | null;
          comments: {
            nodes?: Array<{
              createdAt?: string | null;
              updatedAt?: string | null;
            } | null> | null;
          };
        } | null> | null;
      };
    } | null;
  } | null;
};

const LINKED_PULL_REQUESTS_QUERY = `
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
                  state
                  url
                  headRefName
                  baseRefName
                  baseRefOid
                  mergeStateStatus
                }
              }
            }
          }
        }
      }
    }
  }
`;

const PULL_REQUEST_SIGNAL_SNAPSHOT_QUERY = `
  query PullRequestSignalSnapshot($owner: String!, $repo: String!, $prNumber: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $prNumber) {
        comments(first: 50) {
          nodes {
            createdAt
            updatedAt
          }
        }
        reviews(first: 50) {
          nodes {
            submittedAt
          }
        }
        reviewThreads(first: 100) {
          nodes {
            isResolved
            comments(first: 20) {
              nodes {
                createdAt
                updatedAt
              }
            }
          }
        }
      }
    }
  }
`;

type PullRequestSignalSnapshot = {
  reviewTimestamps: string[];
  issueCommentTimestamps: string[];
  unresolvedThreadCommentTimestamps: string[];
};

export type LinkedPullRequest = {
  number: number;
  updatedAt: string;
  url: string;
  headRefName: string | null;
  baseRefName: string | null;
  baseRefOid: string | null;
  mergeStateStatus: string | null;
};

export type PullRequestSignal = {
  pullRequest: LinkedPullRequest;
  hasReviewActivity: boolean;
  hasFailedChecks: boolean;
  hasMergeConflicts: boolean;
  revision: string | null;
};

export type RepoIssueTarget = {
  target: RepoTarget;
  issue: GitHubIssue;
};

export type IssueSignalContext =
  | {
      kind: 'initial';
      revision: string;
      branchName: null;
      signals: [];
    }
  | {
      kind: 'review';
      branchName: string | null;
      revision: string | null;
      signals: PullRequestSignal[];
    };

export class GitHubClient {
  private authTokenPromise: Promise<string> | null = null;
  private viewerLoginPromise: Promise<string> | null = null;

  async getViewerLogin() {
    if (!this.viewerLoginPromise) {
      this.viewerLoginPromise = this.runGhText(['api', 'user', '--jq', '.login'], process.cwd()).then((login) =>
        login.trim().toLowerCase(),
      );
    }

    return this.viewerLoginPromise;
  }

  async listAssignedOpenIssues(
    owners: string[],
    excludeRepos: string[],
    limitPerOwner: number,
  ): Promise<RepoIssueTarget[]> {
    const excluded = new Set(excludeRepos.map((repo) => repo.trim().toLowerCase()).filter(Boolean));
    const discovered = new Map<string, RepoIssueTarget>();

    for (const owner of owners) {
      const issues = await this.runGhJson<SearchIssueResult[]>(
        [
          'search',
          'issues',
          '--owner',
          owner,
          '--assignee',
          '@me',
          '--state',
          'open',
          '--sort',
          'updated',
          '--order',
          'desc',
          '--archived=false',
          '--limit',
          String(limitPerOwner),
          '--json',
          'assignees,body,createdAt,isPullRequest,number,repository,state,title,updatedAt,url',
        ],
        process.cwd(),
      );

      for (const item of issues) {
        const candidate = normalizeSearchedIssue(item);
        if (!candidate || excluded.has(candidate.target.fullName.toLowerCase())) {
          continue;
        }

        discovered.set(candidate.issue.identifier, candidate);
      }
    }

    return [...discovered.values()].toSorted((left, right) =>
      right.issue.updatedAt.localeCompare(left.issue.updatedAt),
    );
  }

  async getIssueSignalContext(target: RepoTarget, issue: GitHubIssue): Promise<IssueSignalContext> {
    const pullRequests = await this.listLinkedOpenPullRequests(target, issue.number);

    if (pullRequests.length === 0) {
      return {
        kind: 'initial',
        revision: issue.updatedAt,
        branchName: null,
        signals: [],
      };
    }

    const branchName = selectManagedBranchName(issue.number, pullRequests);
    const signals = await Promise.all(
      pullRequests.map((pullRequest) => this.getPullRequestSignal(target, pullRequest)),
    );
    const tokens = signals.flatMap((signal) => (signal.revision ? [signal.revision] : []));

    return {
      kind: 'review',
      branchName,
      revision: tokens.length > 0 ? tokens.toSorted().join('|') : null,
      signals,
    };
  }

  async buildCloneUrl(target: RepoTarget): Promise<string> {
    const token = await this.getAuthToken();
    return `https://x-access-token:${token}@github.com/${target.fullName}.git`;
  }

  private async listLinkedOpenPullRequests(target: RepoTarget, issueNumber: number): Promise<LinkedPullRequest[]> {
    const result = await this.graphqlQuery<LinkedPullRequestsResponse>(LINKED_PULL_REQUESTS_QUERY, {
      owner: target.owner,
      repo: target.repo,
      issueNumber,
    });
    const references = result.repository?.issue?.timelineItems?.nodes ?? [];
    const pullRequests = new Map<number, LinkedPullRequest>();

    for (const node of references) {
      const source = node?.__typename === 'CrossReferencedEvent' ? node.source : null;
      if (
        source?.__typename !== 'PullRequest' ||
        typeof source.number !== 'number' ||
        !source.updatedAt ||
        !source.url ||
        source.state !== 'OPEN'
      ) {
        continue;
      }

      pullRequests.set(source.number, {
        number: source.number,
        updatedAt: source.updatedAt,
        url: source.url,
        headRefName: source.headRefName?.trim() || null,
        baseRefName: source.baseRefName?.trim() || null,
        baseRefOid: source.baseRefOid?.trim() || null,
        mergeStateStatus: source.mergeStateStatus?.trim() || null,
      });
    }

    return [...pullRequests.values()];
  }

  private async getPullRequestSignal(target: RepoTarget, pullRequest: LinkedPullRequest): Promise<PullRequestSignal> {
    const [snapshot, checks] = await Promise.all([
      this.getPullRequestSignalSnapshot(target, pullRequest.number),
      this.runGhJsonAllowing<PullRequestCheck[]>(
        ['pr', 'checks', String(pullRequest.number), '--repo', target.fullName, '--json', 'bucket,completedAt'],
        process.cwd(),
        [8],
      ),
    ]);

    const failedCheckTimestamps = checks.flatMap((item) =>
      item.bucket === 'fail' && item.completedAt ? [item.completedAt] : [],
    );
    const hasReviewActivity =
      snapshot.reviewTimestamps.length > 0 ||
      snapshot.issueCommentTimestamps.length > 0 ||
      snapshot.unresolvedThreadCommentTimestamps.length > 0;
    const hasFailedChecks = failedCheckTimestamps.length > 0;
    const hasMergeConflicts = pullRequest.mergeStateStatus === 'DIRTY';
    const tokens = [
      ...snapshot.reviewTimestamps,
      ...snapshot.issueCommentTimestamps,
      ...snapshot.unresolvedThreadCommentTimestamps,
      ...failedCheckTimestamps,
      ...(hasMergeConflicts && pullRequest.baseRefOid
        ? [`conflict:${pullRequest.number}:${pullRequest.baseRefOid}`]
        : []),
    ];

    return {
      pullRequest,
      hasReviewActivity,
      hasFailedChecks,
      hasMergeConflicts,
      revision: tokens.length > 0 ? tokens.toSorted().join('|') : null,
    };
  }

  private async getPullRequestSignalSnapshot(target: RepoTarget, prNumber: number): Promise<PullRequestSignalSnapshot> {
    const result = await this.graphqlQuery<PullRequestSignalSnapshotResponse>(PULL_REQUEST_SIGNAL_SNAPSHOT_QUERY, {
      owner: target.owner,
      repo: target.repo,
      prNumber,
    });

    const pullRequest = result.repository?.pullRequest;
    if (!pullRequest) {
      throw new Error(`pull request not found: ${target.fullName}#${prNumber}`);
    }

    return {
      reviewTimestamps: (pullRequest.reviews.nodes ?? []).flatMap((review) =>
        review?.submittedAt ? [review.submittedAt] : [],
      ),
      issueCommentTimestamps: (pullRequest.comments.nodes ?? []).flatMap((comment) => {
        const timestamp = comment?.updatedAt ?? comment?.createdAt ?? null;
        return timestamp ? [timestamp] : [];
      }),
      unresolvedThreadCommentTimestamps: (pullRequest.reviewThreads.nodes ?? []).flatMap((thread) =>
        thread?.isResolved
          ? []
          : (thread?.comments.nodes ?? []).flatMap((comment) => {
              const timestamp = comment?.updatedAt ?? comment?.createdAt ?? null;
              return timestamp ? [timestamp] : [];
            }),
      ),
    };
  }

  private async graphqlQuery<TData>(query: string, variables: Record<string, unknown>): Promise<TData> {
    const token = await this.getAuthToken();
    return requestGraphql<TData>(query, {
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
    const result = await runShell(['gh', ...args].map(shellEscape).join(' '), { cwd });

    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || `gh command failed: ${args.join(' ')}`);
    }

    if (result.stdout.trim().length === 0) {
      return [] as T;
    }

    return JSON.parse(result.stdout) as T;
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

export function selectManagedBranchName(
  issueNumber: number,
  pullRequests: Array<Pick<LinkedPullRequest, 'headRefName'>>,
): string | null {
  const branchNames = [
    ...new Set(pullRequests.map((pullRequest) => pullRequest.headRefName?.trim() || '').filter(Boolean)),
  ];
  if (branchNames.length === 0) {
    return null;
  }

  const canonicalBranch = `${issueNumber}-orbit-pilot`;
  if (branchNames.includes(canonicalBranch)) {
    return canonicalBranch;
  }

  if (branchNames.length === 1) {
    return branchNames[0];
  }

  const managedBranches = branchNames.filter((branchName) => branchName.startsWith(`${issueNumber}-orbit-pilot`));
  if (managedBranches.length === 1) {
    return managedBranches[0];
  }

  throw new Error(
    `multiple linked open pull requests found for issue #${issueNumber}; unable to determine a managed branch`,
  );
}

function normalizeSearchedIssue(item: SearchIssueResult): RepoIssueTarget | null {
  if (
    item.isPullRequest ||
    typeof item.number !== 'number' ||
    !item.url ||
    !item.createdAt ||
    !item.updatedAt ||
    !item.repository?.nameWithOwner
  ) {
    return null;
  }

  const fullName = item.repository.nameWithOwner.trim();
  const [owner = '', repo = ''] = fullName.split('/');
  if (!owner || !repo) {
    return null;
  }

  return {
    target: {
      owner,
      repo,
      fullName,
    },
    issue: {
      number: item.number,
      identifier: `${fullName}#${item.number}`,
      title: item.title ?? '',
      body: item.body ?? '',
      state: item.state === 'CLOSED' ? 'closed' : 'open',
      assignees: (item.assignees ?? []).map((assignee) => assignee.login?.trim().toLowerCase() || '').filter(Boolean),
      htmlUrl: item.url,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    },
  };
}

function shellEscape(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
