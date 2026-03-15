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

      const result = await runShell(
        `git clone --branch ${shellEscape(target.defaultBranch)} ${shellEscape(cloneUrl)} ${shellEscape(workspacePath)}`,
        {
          cwd: workspaceParent,
        },
      );

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
    const branchName = preferredBranchName ?? (await this.allocateBranchName(workspacePath, issue.number));
    const originBranchRef = `origin/${target.defaultBranch}`;
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

    const existingConflictContext = await this.buildExistingMergeConflictContext(workspacePath, target.defaultBranch);
    if (existingConflictContext) {
      return { branchName, mergeConflictContext: existingConflictContext };
    }

    if (await this.isDirty(workspacePath)) {
      await this.ensureCommitIdentity(workspacePath);
      await this.runGit(workspacePath, 'git add -A', 'git add failed');
      await this.runGit(
        workspacePath,
        `git commit -m ${shellEscape('chore: orbit-pilot checkpoint')}`,
        'git checkpoint commit failed',
      );
    }

    const mergeMain = await runShell(`git merge --no-edit ${shellEscape(originBranchRef)}`, {
      cwd: workspacePath,
    });

    if (mergeMain.exitCode !== 0) {
      const conflictContext = await this.buildMergeConflictContext(workspacePath, target.defaultBranch, mergeMain);
      if (conflictContext) {
        return { branchName, mergeConflictContext: conflictContext };
      }

      throw new Error(`git merge main failed: ${mergeMain.stderr || mergeMain.stdout}`);
    }

    await this.runGit(workspacePath, 'git clean -fd', 'git clean failed');

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

  private async isDirty(workspacePath: string) {
    const result = await this.runGit(workspacePath, 'git status --porcelain', 'git status failed');

    return result.stdout.trim().length > 0;
  }

  private async ensureCommitIdentity(workspacePath: string) {
    const name = await runShell('git config user.name', { cwd: workspacePath });
    if (name.exitCode !== 0 || name.stdout.trim().length === 0) {
      await this.runGit(
        workspacePath,
        `git config user.name ${shellEscape('orbit-pilot')}`,
        'git config user.name failed',
      );
    }

    const email = await runShell('git config user.email', { cwd: workspacePath });
    if (email.exitCode !== 0 || email.stdout.trim().length === 0) {
      await this.runGit(
        workspacePath,
        `git config user.email ${shellEscape('orbit-pilot@local')}`,
        'git config user.email failed',
      );
    }
  }

  private async runGit(workspacePath: string, command: string, errorPrefix: string) {
    const result = await runShell(command, { cwd: workspacePath });

    if (result.exitCode !== 0) {
      throw new Error(`${errorPrefix}: ${result.stderr || result.stdout}`);
    }

    return result;
  }

  private async allocateBranchName(workspacePath: string, issueNumber: number) {
    const base = issueBranchName(issueNumber);

    for (let suffix = 0; suffix < 100; suffix += 1) {
      const branchName = suffix === 0 ? base : `${base}-${suffix}`;
      if (
        !(await this.branchExists(workspacePath, branchName)) &&
        !(await this.remoteBranchExists(workspacePath, branchName))
      ) {
        return branchName;
      }
    }

    throw new Error(`unable to allocate branch name for issue ${issueNumber}`);
  }

  private async buildMergeConflictContext(
    workspacePath: string,
    defaultBranch: string,
    mergeResult: { stdout: string; stderr: string },
  ) {
    const files = await this.listConflictedFiles(workspacePath);

    if (files.length === 0) {
      return null;
    }

    const status = await runShell('git status --short', { cwd: workspacePath });

    return [
      `Merge conflict while bringing the branch up to date with origin/${defaultBranch}.`,
      `Conflicted files: ${files.join(', ')}`,
      '',
      'git status --short:',
      status.stdout.trim() || '(empty)',
      '',
      'merge output:',
      (mergeResult.stderr || mergeResult.stdout).trim() || '(empty)',
    ].join('\n');
  }

  private async buildExistingMergeConflictContext(workspacePath: string, defaultBranch: string) {
    const files = await this.listConflictedFiles(workspacePath);
    if (files.length === 0) {
      return null;
    }

    const status = await runShell('git status --short', { cwd: workspacePath });

    return [
      `Existing merge conflict detected on the managed branch before merging origin/${defaultBranch}.`,
      `Conflicted files: ${files.join(', ')}`,
      '',
      'Resolve these conflicts first, then continue the requested work.',
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
