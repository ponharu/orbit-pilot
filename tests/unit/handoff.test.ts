import { describe, expect, test } from 'bun:test';
import {
  ensureBranchPullRequestAssignedToViewer,
  findOpenPullRequestForBranch,
  inspectHandoff,
  type ShellRunner,
} from '../../src/core/handoff';
import type { Logger, RepoTarget } from '../../src/core/types';

const target: RepoTarget = {
  owner: 'acme',
  repo: 'widget',
  fullName: 'acme/widget',
};

const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const shellReturningSinglePullRequest: ShellRunner = async () => ({
  exitCode: 0,
  stdout: JSON.stringify([
    {
      number: 12,
      url: 'https://github.com/acme/widget/pull/12',
      assignees: [{ login: 'Alice' }, { login: 'bob' }],
    },
  ]),
  stderr: '',
});

describe('findOpenPullRequestForBranch', () => {
  test('returns the first matching PR with normalized assignees', async () => {
    const pullRequest = await findOpenPullRequestForBranch(
      target,
      '/tmp/workspace',
      '42-orbit-pilot',
      shellReturningSinglePullRequest,
    );

    expect(pullRequest).toEqual({
      number: 12,
      url: 'https://github.com/acme/widget/pull/12',
      assignees: ['alice', 'bob'],
    });
  });
});

describe('inspectHandoff', () => {
  test('reports all missing handoff conditions', async () => {
    const calls: string[] = [];

    const shell: ShellRunner = async (command: string) => {
      calls.push(command);

      if (command.includes('ls-remote')) {
        return { exitCode: 2, stdout: '', stderr: '' };
      }

      if (command.includes('status --porcelain')) {
        return { exitCode: 0, stdout: ' M src/app.ts\n', stderr: '' };
      }

      if (command.includes('symbolic-ref')) {
        return { exitCode: 0, stdout: 'origin/main\n', stderr: '' };
      }

      if (command.includes('rev-list')) {
        return { exitCode: 0, stdout: '1\n', stderr: '' };
      }

      if (command.includes('gh') && command.includes('pr') && command.includes('list')) {
        return { exitCode: 0, stdout: '[]', stderr: '' };
      }

      throw new Error(`Unexpected command: ${command}`);
    };

    const result = await inspectHandoff(target, '/tmp/workspace', '42-orbit-pilot', shell);

    expect(result.complete).toBe(false);
    expect(result.summary).toContain('uncommitted changes');
    expect(result.summary).toContain('does not exist on origin');
    expect(result.summary).toContain('no open pull request');
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe('ensureBranchPullRequestAssignedToViewer', () => {
  test('assigns the PR when the viewer is missing', async () => {
    const commands: string[] = [];

    const shell: ShellRunner = async (command: string) => {
      commands.push(command);

      if (command.includes('gh') && command.includes('pr') && command.includes('list')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              number: 34,
              url: 'https://github.com/acme/widget/pull/34',
              assignees: [{ login: 'other-user' }],
            },
          ]),
          stderr: '',
        };
      }

      if (command.includes('gh') && command.includes('pr') && command.includes('edit')) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      throw new Error(`Unexpected command: ${command}`);
    };

    await ensureBranchPullRequestAssignedToViewer(target, '/tmp/workspace', '42-orbit-pilot', logger, shell);

    expect(
      commands.some(
        (command) =>
          command.includes("'pr' 'edit'") && command.includes("'--add-assignee'") && command.includes("'@me'"),
      ),
    ).toBe(true);
  });

  test('reuses an already-fetched PR instead of listing again', async () => {
    const commands: string[] = [];

    const shell: ShellRunner = async (command: string) => {
      commands.push(command);

      if (command.includes('gh') && command.includes('pr') && command.includes('edit')) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      throw new Error(`Unexpected command: ${command}`);
    };

    await ensureBranchPullRequestAssignedToViewer(target, '/tmp/workspace', '42-orbit-pilot', logger, shell, {
      number: 56,
      url: 'https://github.com/acme/widget/pull/56',
      assignees: ['other-user'],
    });

    expect(commands.some((command) => command.includes("'pr' 'list'"))).toBe(false);
    expect(commands.some((command) => command.includes("'pr' 'edit'"))).toBe(true);
  });
});
