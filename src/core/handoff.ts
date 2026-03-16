import { runShell } from '../util/shell';
import type { Logger, RepoTarget } from './types';

export type BranchPullRequest = {
  number: number;
  url: string;
  assignees: string[];
};

export type HandoffInspection = {
  complete: boolean;
  summary: string | null;
};

export type ShellRunner = typeof runShell;

type WorkspaceSnapshot = {
  hasUncommittedChanges: boolean;
  hasRemoteBranch: boolean;
  commitsAheadOfRemote: number;
  pullRequest: BranchPullRequest | null;
};

export async function inspectHandoff(
  target: RepoTarget,
  workspacePath: string,
  branchName: string,
  shell: ShellRunner = runShell,
): Promise<HandoffInspection> {
  const snapshot = await inspectWorkspaceState(target, workspacePath, branchName, shell);
  const missing: string[] = [];

  if (snapshot.hasUncommittedChanges) {
    missing.push(
      'The worktree still has uncommitted changes. Commit or intentionally discard them before ending the turn.',
    );
  }

  if (snapshot.commitsAheadOfRemote > 0) {
    missing.push('The branch has local commits that have not been pushed to origin yet.');
  }

  if (!snapshot.hasRemoteBranch) {
    missing.push('The branch does not exist on origin yet.');
  }

  if (!snapshot.pullRequest) {
    missing.push('There is still no open pull request for this branch.');
  }

  return {
    complete: missing.length === 0,
    summary: missing.length > 0 ? missing.join('\n') : null,
  };
}

export async function ensureBranchPullRequestAssignedToViewer(
  target: RepoTarget,
  workspacePath: string,
  branchName: string,
  viewerLogin: string,
  logger: Logger,
  shell: ShellRunner = runShell,
) {
  const branchPullRequest = await findOpenPullRequestForBranch(target, workspacePath, branchName, shell);

  if (!branchPullRequest || branchPullRequest.assignees.includes(viewerLogin)) {
    return;
  }

  const result = await shell(
    ['gh', 'pr', 'edit', String(branchPullRequest.number), '--repo', target.fullName, '--add-assignee', viewerLogin]
      .map(shellEscape)
      .join(' '),
    { cwd: workspacePath },
  );

  if (result.exitCode !== 0) {
    logger.warn('failed to self-assign pull request after turn completion', {
      repo: target.fullName,
      branchName,
      prNumber: branchPullRequest.number,
      error: result.stderr || result.stdout,
    });
    return;
  }

  logger.info('self-assigned pull request after turn completion', {
    repo: target.fullName,
    branchName,
    prNumber: branchPullRequest.number,
    viewerLogin,
  });
}

export async function findOpenPullRequestForBranch(
  target: RepoTarget,
  workspacePath: string,
  branchName: string,
  shell: ShellRunner = runShell,
): Promise<BranchPullRequest | null> {
  const result = await shell(
    [
      'gh',
      'pr',
      'list',
      '--repo',
      target.fullName,
      '--state',
      'open',
      '--head',
      branchName,
      '--json',
      'number,url,assignees',
    ]
      .map(shellEscape)
      .join(' '),
    { cwd: workspacePath },
  );

  if (result.exitCode !== 0) {
    return null;
  }

  const pullRequests = JSON.parse(result.stdout) as Array<{
    number?: number;
    url?: string | null;
    assignees?: Array<{ login?: string | null }>;
  }>;

  const pullRequest = pullRequests.find((item) => typeof item.number === 'number');
  if (!pullRequest || typeof pullRequest.number !== 'number' || !pullRequest.url) {
    return null;
  }

  return {
    number: pullRequest.number,
    url: pullRequest.url,
    assignees: (pullRequest.assignees ?? [])
      .map((assignee) => assignee.login?.trim().toLowerCase() || '')
      .filter(Boolean),
  };
}

async function inspectWorkspaceState(
  target: RepoTarget,
  workspacePath: string,
  branchName: string,
  shell: ShellRunner,
): Promise<WorkspaceSnapshot> {
  const remoteBranchResult = await shell(
    ['git', 'ls-remote', '--exit-code', '--heads', 'origin', shellEscape(branchName)].join(' '),
    { cwd: workspacePath },
  );

  const hasRemoteBranch = remoteBranchResult.exitCode === 0;

  const [statusResult, aheadResult, pullRequest] = await Promise.all([
    shell('git status --porcelain', { cwd: workspacePath }),
    hasRemoteBranch
      ? shell(['git', 'rev-list', '--count', `${shellEscape(`origin/${branchName}`)}..HEAD`].join(' '), {
          cwd: workspacePath,
        })
      : shell(['git', 'rev-list', '--count', `${shellEscape(`origin/${target.defaultBranch}`)}..HEAD`].join(' '), {
          cwd: workspacePath,
        }),
    findOpenPullRequestForBranch(target, workspacePath, branchName, shell),
  ]);

  const commitsAhead = aheadResult.exitCode === 0 ? Number.parseInt(aheadResult.stdout.trim(), 10) : 0;

  return {
    hasUncommittedChanges: statusResult.exitCode === 0 && statusResult.stdout.trim().length > 0,
    hasRemoteBranch,
    commitsAheadOfRemote: Number.isFinite(commitsAhead) ? commitsAhead : 0,
    pullRequest,
  };
}

function shellEscape(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
