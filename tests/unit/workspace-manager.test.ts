import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../../src/config';
import { WorkspaceManager } from '../../src/core/workspace-manager';
import type { GitHubIssue, Logger, RepoTarget } from '../../src/core/types';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('WorkspaceManager', () => {
  test('creates a managed branch and keeps local branch state even after origin/main moves forward', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orbit-pilot-workspace-'));
    tempDirs.push(tempDir);

    const remotePath = await createRemoteRepository(tempDir);
    const manager = new WorkspaceManager(createConfig(tempDir), silentLogger);
    const target = createTarget();
    const issue = createIssue();

    const first = await manager.prepareWorkspace(target, issue, remotePath, null);

    expect(first.created).toBe(true);
    expect(first.branchName).toBe('42-orbit-pilot');
    expect(await git(first.path, 'git branch --show-current')).toBe('42-orbit-pilot');
    expect(await readFile(path.join(first.path, 'README.md'), 'utf8')).toContain('v1');

    await updateRemoteRepository(tempDir, remotePath, 'v2');

    const second = await manager.prepareWorkspace(target, issue, remotePath, first.branchName);

    expect(second.created).toBe(false);
    expect(second.branchName).toBe(first.branchName);
    expect(await readFile(path.join(second.path, 'README.md'), 'utf8')).toContain('v1');
  });

  test('reuses the canonical issue branch when the remote already has it', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orbit-pilot-workspace-'));
    tempDirs.push(tempDir);

    const remotePath = await createRemoteRepository(tempDir);
    await createRemoteIssueBranch(tempDir, remotePath, '42-orbit-pilot');

    const manager = new WorkspaceManager(createConfig(tempDir), silentLogger);
    const target = createTarget();
    const issue = createIssue();

    const workspace = await manager.prepareWorkspace(target, issue, remotePath, null);

    expect(workspace.branchName).toBe('42-orbit-pilot');
    expect(await git(workspace.path, 'git branch --show-current')).toBe('42-orbit-pilot');
  });

  test('preserves local changes without creating a checkpoint commit', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orbit-pilot-workspace-'));
    tempDirs.push(tempDir);

    const remotePath = await createRemoteRepository(tempDir);
    const manager = new WorkspaceManager(createConfig(tempDir), silentLogger);
    const target = createTarget();
    const issue = createIssue();

    const workspace = await manager.prepareWorkspace(target, issue, remotePath, null);
    await writeFile(path.join(workspace.path, 'README.md'), 'local change\n', 'utf8');

    await manager.prepareWorkspace(target, issue, remotePath, workspace.branchName);

    expect(await git(workspace.path, 'git status --porcelain')).toBe('M README.md');
    expect(await git(workspace.path, 'git log --format=%s -1')).toBe('init');
  });

  test('returns existing merge conflict context without performing the merge automatically', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orbit-pilot-workspace-'));
    tempDirs.push(tempDir);

    const remotePath = await createRemoteRepository(tempDir);
    const manager = new WorkspaceManager(createConfig(tempDir), silentLogger);
    const target = createTarget();
    const issue = createIssue();

    const workspace = await manager.prepareWorkspace(target, issue, remotePath, null);
    await updateRemoteRepository(tempDir, remotePath, 'main branch change');
    await writeFile(path.join(workspace.path, 'README.md'), 'local branch change\n', 'utf8');
    await configureCommitIdentity(workspace.path);
    await git(workspace.path, 'git add README.md');
    await git(workspace.path, `git commit -m ${shellEscape('local change')}`);
    await git(workspace.path, 'git fetch origin');
    await runAllowFailure('git merge origin/main', workspace.path);

    const conflicted = await manager.prepareWorkspace(target, issue, remotePath, workspace.branchName);

    expect(conflicted.mergeConflictContext).toContain(
      'Existing merge conflict detected on the managed branch against origin/main.',
    );
    expect(conflicted.mergeConflictContext).toContain('Conflicted files: README.md');
    expect(await git(conflicted.path, 'git diff --name-only --diff-filter=U')).toBe('README.md');
  });

  test('keeps returning conflict context until an existing merge conflict is resolved', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orbit-pilot-workspace-'));
    tempDirs.push(tempDir);

    const remotePath = await createRemoteRepository(tempDir);
    const manager = new WorkspaceManager(createConfig(tempDir), silentLogger);
    const target = createTarget();
    const issue = createIssue();

    const workspace = await manager.prepareWorkspace(target, issue, remotePath, null);
    await updateRemoteRepository(tempDir, remotePath, 'main branch change');
    await writeFile(path.join(workspace.path, 'README.md'), 'local branch change\n', 'utf8');
    await configureCommitIdentity(workspace.path);
    await git(workspace.path, 'git add README.md');
    await git(workspace.path, `git commit -m ${shellEscape('local change')}`);
    await git(workspace.path, 'git fetch origin');
    await runAllowFailure('git merge origin/main', workspace.path);
    await manager.prepareWorkspace(target, issue, remotePath, workspace.branchName);

    const repeated = await manager.prepareWorkspace(target, issue, remotePath, workspace.branchName);

    expect(repeated.mergeConflictContext).toContain(
      'Existing merge conflict detected on the managed branch against origin/main.',
    );
    expect(await git(repeated.path, 'git diff --name-only --diff-filter=U')).toBe('README.md');
  });
});

async function createRemoteRepository(root: string) {
  const sourcePath = path.join(root, 'source');
  const remotePath = path.join(root, 'remote.git');

  await run(`mkdir -p ${shellEscape(sourcePath)}`);
  await run(`git init -b main ${shellEscape(sourcePath)}`);
  await run(`git -C ${shellEscape(sourcePath)} config user.name ${shellEscape('tester')}`);
  await run(`git -C ${shellEscape(sourcePath)} config user.email ${shellEscape('tester@example.com')}`);
  await writeFile(path.join(sourcePath, 'README.md'), 'v1\n', 'utf8');
  await run(`git -C ${shellEscape(sourcePath)} add README.md`);
  await run(`git -C ${shellEscape(sourcePath)} commit -m ${shellEscape('init')}`);
  await run(`git clone --bare ${shellEscape(sourcePath)} ${shellEscape(remotePath)}`);

  return remotePath;
}

async function updateRemoteRepository(root: string, remotePath: string, contents: string) {
  const sourcePath = path.join(root, 'source');
  await writeFile(path.join(sourcePath, 'README.md'), `${contents}\n`, 'utf8');
  await run(`git -C ${shellEscape(sourcePath)} add README.md`);
  await run(`git -C ${shellEscape(sourcePath)} commit -m ${shellEscape(`update ${contents}`)}`);
  await run(`git -C ${shellEscape(sourcePath)} push ${shellEscape(remotePath)} main`);
}

async function createRemoteIssueBranch(root: string, remotePath: string, branchName: string) {
  const sourcePath = path.join(root, 'source');
  await run(`git -C ${shellEscape(sourcePath)} checkout -b ${shellEscape(branchName)}`);
  await run(`git -C ${shellEscape(sourcePath)} push ${shellEscape(remotePath)} ${shellEscape(branchName)}`);
  await run(`git -C ${shellEscape(sourcePath)} checkout main`);
}

function createConfig(root: string): AppConfig {
  return {
    pollIntervalMs: 30_000,
    workspaceRoot: path.join(root, 'workspaces'),
    stateRoot: path.join(root, '.orbit-pilot-state'),
    maxConcurrentRunsPerRepo: 1,
    owners: ['acme'],
    excludeRepos: [],
    codex: {},
  };
}

function createTarget(): RepoTarget {
  return {
    owner: 'acme',
    repo: 'widget',
    fullName: 'acme/widget',
    defaultBranch: 'main',
  };
}

function createIssue(): GitHubIssue {
  return {
    number: 42,
    identifier: 'acme/widget#42',
    title: 'Test issue',
    body: 'Body',
    state: 'open',
    assignees: [],
    htmlUrl: 'https://github.com/acme/widget/issues/42',
    createdAt: '2026-03-15T00:00:00Z',
    updatedAt: '2026-03-15T00:00:00Z',
    isPullRequest: false,
  };
}

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

async function git(cwd: string, command: string) {
  const result = await run(command, cwd);
  return result.trim();
}

async function run(command: string, cwd?: string) {
  const proc = Bun.spawn(['sh', '-lc', command], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(stderr || stdout || `command failed: ${command}`);
  }

  return stdout.trim();
}

async function runAllowFailure(command: string, cwd?: string) {
  const proc = Bun.spawn(['sh', '-lc', command], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    exitCode,
  };
}

async function configureCommitIdentity(cwd: string) {
  await run(`git -C ${shellEscape(cwd)} config user.name ${shellEscape('tester')}`);
  await run(`git -C ${shellEscape(cwd)} config user.email ${shellEscape('tester@example.com')}`);
}

function shellEscape(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
