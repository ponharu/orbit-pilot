import { graphql as requestGraphql } from '@octokit/graphql';
import type { GitHubIssue, RepoTarget } from '../core/types';
import {
  buildPendingPullRequestSignalDetails,
  buildPullRequestSignalSnapshot,
  buildSignalAckCommentBody,
  type PullRequestSignalCheck,
  type PullRequestSignalSnapshotData,
} from './pull-request-signals';
import { runShell } from '../util/shell';

type SearchIssueResult = {
  createdAt?: string | null;
  isPullRequest?: boolean;
  number?: number;
  repository?: {
    name?: string | null;
    nameWithOwner?: string | null;
  } | null;
  updatedAt?: string | null;
  url?: string | null;
};

type IssueViewResult = {
  body?: string | null;
  title?: string | null;
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
    pullRequest?: PullRequestSignalSnapshotData | null;
  } | null;
};

const LINKED_PULL_REQUESTS_QUERY = `
  query LinkedPullRequests($owner: String!, $repo: String!, $issueNumber: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $issueNumber) {
        timelineItems(first: 100, itemTypes: [CROSS_REFERENCED_EVENT]) {
          nodes {
            __typename
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
        id
        comments(first: 50) {
          nodes {
            id
            body
            createdAt
            updatedAt
            reactionGroups {
              content
              viewerHasReacted
            }
          }
        }
        reviews(last: 100) {
          nodes {
            id
            state
            submittedAt
            updatedAt
            reactionGroups {
              content
              viewerHasReacted
            }
          }
        }
        reviewThreads(last: 100) {
          nodes {
            id
            isResolved
            comments(last: 50) {
              nodes {
                id
                createdAt
                updatedAt
                reactionGroups {
                  content
                  viewerHasReacted
                }
              }
            }
          }
        }
      }
    }
  }
`;

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
  reviewStates: string[];
  pullRequestNodeId: string;
  ackCommentId: string | null;
  ackCommentTokens: string[];
  reactionSubjectIds: string[];
  nonReactableTokens: string[];
};

export type RepoIssueTarget = {
  target: RepoTarget;
  issue: GitHubIssue;
};

export type IssueSignalContext =
  | {
      kind: 'initial';
      branchName: null;
      signals: [];
    }
  | {
      kind: 'review';
      branchName: string | null;
      signals: PullRequestSignal[];
    };

export class GitHubClient {
  private authTokenPromise: Promise<string> | null = null;

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
          'createdAt,isPullRequest,number,repository,updatedAt,url',
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
        branchName: null,
        signals: [],
      };
    }

    const branchName = selectManagedBranchName(issue.number, pullRequests);
    const signals = await Promise.all(
      pullRequests.map((pullRequest) => this.getPullRequestSignal(target, pullRequest)),
    );

    return {
      kind: 'review',
      branchName,
      signals: signals.filter(
        (signal) => signal.hasReviewActivity || signal.hasFailedChecks || signal.hasMergeConflicts,
      ),
    };
  }

  async acknowledgePullRequestSignals(_target: RepoTarget, signals: PullRequestSignal[]) {
    for (const signal of signals) {
      for (const subjectId of signal.reactionSubjectIds) {
        await this.graphqlQuery(
          `
            mutation AddReaction($subjectId: ID!) {
              addReaction(input: { subjectId: $subjectId, content: EYES }) {
                reaction {
                  content
                }
              }
            }
          `,
          {
            subjectId,
          },
        );
      }

      if (signal.nonReactableTokens.length === 0) {
        continue;
      }

      const tokens = [...new Set([...signal.ackCommentTokens, ...signal.nonReactableTokens])].toSorted();
      const body = buildSignalAckCommentBody(tokens);

      if (signal.ackCommentId) {
        await this.graphqlQuery(
          `
            mutation UpdateIssueComment($id: ID!, $body: String!) {
              updateIssueComment(input: { id: $id, body: $body }) {
                issueComment {
                  id
                }
              }
            }
          `,
          {
            id: signal.ackCommentId,
            body,
          },
        );
      } else {
        await this.graphqlQuery(
          `
            mutation AddComment($subjectId: ID!, $body: String!) {
              addComment(input: { subjectId: $subjectId, body: $body }) {
                commentEdge {
                  node {
                    id
                  }
                }
              }
            }
          `,
          {
            subjectId: signal.pullRequestNodeId,
            body,
          },
        );
      }
    }
  }

  async buildCloneUrl(target: RepoTarget): Promise<string> {
    const token = await this.getAuthToken();
    return `https://x-access-token:${token}@github.com/${target.fullName}.git`;
  }

  async hydrateIssue(target: RepoTarget, issue: GitHubIssue): Promise<GitHubIssue> {
    if (issue.title.trim() && issue.body.trim()) {
      return issue;
    }

    const details = await this.runGhJson<IssueViewResult>(
      ['issue', 'view', String(issue.number), '--repo', target.fullName, '--json', 'title,body'],
      process.cwd(),
    );

    return {
      ...issue,
      title: details.title ?? issue.title,
      body: details.body ?? issue.body,
    };
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
      this.runGhJsonAllowing<PullRequestSignalCheck[]>(
        ['pr', 'checks', String(pullRequest.number), '--repo', target.fullName, '--json', 'name,bucket,completedAt'],
        process.cwd(),
        [8],
      ),
    ]);
    const pending = buildPendingPullRequestSignalDetails(snapshot, pullRequest, checks);

    return {
      pullRequest,
      hasReviewActivity: pending.hasReviewActivity,
      hasFailedChecks: pending.hasFailedChecks,
      hasMergeConflicts: pending.hasMergeConflicts,
      reviewStates: pending.reviewStates,
      pullRequestNodeId: snapshot.pullRequestId,
      ackCommentId: pending.ackCommentId,
      ackCommentTokens: pending.ackCommentTokens,
      reactionSubjectIds: pending.reactionSubjectIds,
      nonReactableTokens: pending.nonReactableTokens,
    };
  }

  private async getPullRequestSignalSnapshot(target: RepoTarget, prNumber: number) {
    const result = await this.graphqlQuery<PullRequestSignalSnapshotResponse>(PULL_REQUEST_SIGNAL_SNAPSHOT_QUERY, {
      owner: target.owner,
      repo: target.repo,
      prNumber,
    });

    const pullRequest = result.repository?.pullRequest;
    if (!pullRequest) {
      throw new Error(`pull request not found: ${target.fullName}#${prNumber}`);
    }

    return buildPullRequestSignalSnapshot(pullRequest);
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
      title: '',
      body: '',
      htmlUrl: item.url,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    },
  };
}

function shellEscape(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
