import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import type { AppConfig } from '../../src/config';
import { RuntimeRegistry } from '../../src/core/runtime-registry';
import type { GitHubIssue, Logger, RepoTarget } from '../../src/core/types';

const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const target: RepoTarget = {
  owner: 'acme',
  repo: 'widget',
  fullName: 'acme/widget',
};

const issue: GitHubIssue = {
  number: 19,
  identifier: 'acme/widget#19',
  title: 'Handle review reruns',
  body: 'body',
  htmlUrl: 'https://example.com/issues/19',
  createdAt: '2026-03-18T00:00:00Z',
  updatedAt: '2026-03-18T00:00:00Z',
};

describe('RuntimeRegistry', () => {
  test('reconciles immediately after a successful run completes', async () => {
    const registry = new RuntimeRegistry(createConfig(), {} as never, logger) as any;
    let reconcileCount = 0;

    registry.client = {
      hydrateIssue: async () => issue,
      buildCloneUrl: async () => 'https://example.com/acme/widget.git',
      acknowledgePullRequestSignals: async () => undefined,
    };
    registry.stateStore = {
      readState: async () => null,
      writeState: async () => undefined,
      listAllStates: async () => [],
    };
    registry.runner = {
      run: () => ({
        promise: Promise.resolve({
          branchName: '19-orbit-pilot',
          threadId: 'thread_123',
        }),
        abort() {},
      }),
    };
    registry.reconcile = async () => {
      reconcileCount += 1;
    };
    registry.continuous = true;

    registry.dispatchIssue(
      target,
      issue,
      {
        attempt: 1,
        reason: 'review',
        branchName: '19-orbit-pilot',
      },
      [
        {
          pullRequest: {
            number: 19,
            updatedAt: '2026-03-19T13:02:40Z',
            url: 'https://example.com/pull/19',
            headRefName: '19-orbit-pilot',
            baseRefName: 'main',
            baseRefOid: 'abc123',
            mergeStateStatus: 'CLEAN',
          },
          hasReviewActivity: true,
          reviewStates: ['COMMENTED'],
          pullRequestNodeId: 'PR_kwDO123',
          reactionSubjectIds: ['PRR_2'],
        },
      ],
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(reconcileCount).toBe(1);
    expect(registry.issueState.has('acme/widget#19')).toBe(false);
  });
});

function createConfig(): AppConfig {
  return {
    pollIntervalMs: 30_000,
    workspaceRoot: path.join(process.cwd(), 'workspaces'),
    stateRoot: path.join(process.cwd(), '.orbit-pilot-state'),
    maxConcurrentRunsPerRepo: 1,
    owners: ['acme'],
    excludeRepos: [],
    codex: {},
  };
}
