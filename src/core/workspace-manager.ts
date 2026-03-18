import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../config';
import type { GitHubIssue, Logger, RepoTarget } from './types';
import { runShell } from '../util/shell';

export class WorkspaceManager {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  async prepareWorkspace(target: RepoTarget, issue: GitHubIssue, cloneUrl: string, preferredBranchName: string | null) {
    const workspacePath = this.workspacePath(target, issue.number);
    const gitHead = path.join(workspacePath, '.git', 'HEAD');
    const created = !(await Bun.file(gitHead).exists());
    const workspaceParent = path.dirname(workspacePath);

    await mkdir(workspaceParent, { recursive: true });

    if (created) {
      await runShell(`rm -rf ${shellEscape(workspacePath)}`, { cwd: workspaceParent });

      this.logger.info('cloning repository into workspace', {
        repo: target.fullName,
        issue: issue.identifier,
        workspacePath,
      });

      const result = await runShell(`git clone ${shellEscape(cloneUrl)} ${shellEscape(workspacePath)}`, {
        cwd: workspaceParent,
      });

      if (result.exitCode !== 0) {
        throw new Error(`git clone failed: ${result.stderr || result.stdout}`);
      }
    }

    const managedBranch = await this.prepareManagedBranch(target, issue, workspacePath, preferredBranchName);

    return {
      path: workspacePath,
      created,
      branchName: managedBranch.branchName,
      mergeConflictContext: managedBranch.mergeConflictContext,
    };
  }

  workspacePath(target: RepoTarget, issueNumber: number) {
    return path.join(this.repoRootPath(target), `issue-${issueNumber}`);
  }

  private repoRootPath(target: RepoTarget) {
    const root = path.isAbsolute(this.config.workspaceRoot)
      ? this.config.workspaceRoot
      : path.resolve(process.cwd(), this.config.workspaceRoot);

    return path.join(root, sanitize(target.owner), sanitize(target.repo));
  }

  private async prepareManagedBranch(
    target: RepoTarget,
    issue: GitHubIssue,
    workspacePath: string,
    preferredBranchName: string | null,
  ) {
    const branchName = preferredBranchName ?? issueBranchName(issue.number);
    const originBranchRef = await this.originDefaultBranchRef(workspacePath);
    const remoteBranchRef = `origin/${branchName}`;

    await this.runGit(workspacePath, 'git fetch --prune origin', 'git fetch failed');

    const currentBranch = await this.currentBranch(workspacePath);

    if (currentBranch === branchName) {
      // Keep the current branch checked out when an unresolved merge is in progress.
    } else if (await this.branchExists(workspacePath, branchName)) {
      await this.runGit(workspacePath, `git checkout ${shellEscape(branchName)}`, 'git checkout failed');
    } else if (await this.remoteBranchExists(workspacePath, branchName)) {
      await this.runGit(
        workspacePath,
        `git checkout -b ${shellEscape(branchName)} ${shellEscape(remoteBranchRef)}`,
        'git checkout from remote branch failed',
      );
    } else {
      await this.runGit(
        workspacePath,
        `git checkout -b ${shellEscape(branchName)} ${shellEscape(originBranchRef)}`,
        'git checkout -b failed',
      );
    }

    const existingConflictContext = await this.buildExistingMergeConflictContext(workspacePath, originBranchRef);
    if (existingConflictContext) {
      return { branchName, mergeConflictContext: existingConflictContext };
    }

    return {
      branchName,
      mergeConflictContext: null,
    };
  }

  private async branchExists(workspacePath: string, branchName: string) {
    const result = await runShell(`git rev-parse --verify ${shellEscape(branchName)}`, {
      cwd: workspacePath,
    });

    return result.exitCode === 0;
  }

  private async currentBranch(workspacePath: string) {
    const result = await runShell('git branch --show-current', {
      cwd: workspacePath,
    });

    if (result.exitCode !== 0) {
      throw new Error(`git branch --show-current failed: ${result.stderr || result.stdout}`);
    }

    return result.stdout.trim();
  }

  private async remoteBranchExists(workspacePath: string, branchName: string) {
    const result = await runShell(`git rev-parse --verify ${shellEscape(`origin/${branchName}`)}`, {
      cwd: workspacePath,
    });

    return result.exitCode === 0;
  }

  private async runGit(workspacePath: string, command: string, errorPrefix: string) {
    const result = await runShell(command, { cwd: workspacePath });

    if (result.exitCode !== 0) {
      throw new Error(`${errorPrefix}: ${result.stderr || result.stdout}`);
    }

    return result;
  }

  private async originDefaultBranchRef(workspacePath: string) {
    const result = await runShell('git symbolic-ref --quiet --short refs/remotes/origin/HEAD', {
      cwd: workspacePath,
    });

    return result.exitCode === 0 ? result.stdout.trim() || 'origin/main' : 'origin/main';
  }

  private async buildExistingMergeConflictContext(workspacePath: string, originBranchRef: string) {
    const files = await this.listConflictedFiles(workspacePath);
    if (files.length === 0) {
      return null;
    }

    const status = await runShell('git status --short', { cwd: workspacePath });
    const defaultBranch = originBranchRef.replace(/^origin\//, '');

    return [
      `Existing merge conflict detected on the managed branch against origin/${defaultBranch}.`,
      `Conflicted files: ${files.join(', ')}`,
      '',
      `Bring origin/${defaultBranch} into this branch, resolve the conflicts, and continue the requested work.`,
      '',
      'git status --short:',
      status.stdout.trim() || '(empty)',
    ].join('\n');
  }

  private async listConflictedFiles(workspacePath: string) {
    const conflictedFiles = await runShell('git diff --name-only --diff-filter=U', {
      cwd: workspacePath,
    });

    return conflictedFiles.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }
}

function sanitize(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function issueBranchName(issueNumber: number) {
  return `${issueNumber}-orbit-pilot`;
}

function shellEscape(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
