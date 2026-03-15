import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../../src/config';
import { StateStore } from '../../src/core/state-store';
import type { RepoTarget, WorkspaceState } from '../../src/core/types';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('StateStore', () => {
  test('writes, reads, and filters state files by repository', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orbit-pilot-state-'));
    tempDirs.push(tempDir);

    const config = {
      pollIntervalMs: 30_000,
      workspaceRoot: path.join(tempDir, 'workspaces'),
      stateRoot: path.join(tempDir, '.orbit-pilot-state'),
      maxConcurrentRunsPerRepo: 1,
      owners: ['acme'],
      excludeRepos: [],
      codex: {
        sandboxMode: 'workspace-write',
      },
    } satisfies AppConfig;

    const store = new StateStore(config);
    const target: RepoTarget = {
      owner: 'acme',
      repo: 'widget',
      fullName: 'acme/widget',
      defaultBranch: 'main',
    };
    const otherTarget: RepoTarget = {
      owner: 'acme',
      repo: 'other',
      fullName: 'acme/other',
      defaultBranch: 'main',
    };

    const state = createState(7, target.fullName, 'running');
    const otherState = createState(8, otherTarget.fullName, 'idle');

    await store.writeState(target, 7, state);
    await store.writeState(otherTarget, 8, otherState);

    expect(await store.readState(target, 7)).toEqual(state);
    expect(await store.listStates(target)).toEqual([state]);
  });
});

function createState(issueNumber: number, repo: string, status: WorkspaceState['status']): WorkspaceState {
  return {
    issueNumber,
    repo,
    branchName: '42-orbit-pilot',
    status,
    lastHandledRevision: '2026-03-15T00:00:00Z',
    lastRunAt: '2026-03-15T00:00:00Z',
    lastTrigger: 'poll',
    retryCount: 0,
    lastError: null,
    lastFailureContext: null,
    threadId: 'thread_123',
    updatedAt: '2026-03-15T00:00:00Z',
  };
}
