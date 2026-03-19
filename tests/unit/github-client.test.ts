import { describe, expect, test } from 'bun:test';
import { buildPullRequestSignalSnapshot, type PullRequestSignalSnapshotData } from '../../src/github/client';

describe('buildPullRequestSignalSnapshot', () => {
  test('captures review states and unresolved thread revisions from the latest review activity', () => {
    const snapshot = buildPullRequestSignalSnapshot({
      comments: {
        nodes: [
          {
            createdAt: '2026-03-18T13:18:15Z',
            updatedAt: '2026-03-18T13:18:15Z',
          },
        ],
      },
      reviews: {
        nodes: [
          {
            id: 'PRR_1',
            state: 'COMMENTED',
            submittedAt: '2026-03-19T13:02:40Z',
            updatedAt: '2026-03-19T13:14:26Z',
          },
          {
            id: 'PRR_2',
            state: 'CHANGES_REQUESTED',
            submittedAt: '2026-03-19T13:13:34Z',
            updatedAt: '2026-03-19T13:13:34Z',
          },
        ],
      },
      reviewThreads: {
        nodes: [
          {
            id: 'PRRT_open',
            isResolved: false,
            comments: {
              nodes: [
                {
                  id: 'PRRC_1',
                  createdAt: '2026-03-19T13:02:40Z',
                  updatedAt: '2026-03-19T13:02:40Z',
                },
                {
                  id: 'PRRC_2',
                  createdAt: '2026-03-19T13:13:34Z',
                  updatedAt: '2026-03-19T13:15:00Z',
                },
              ],
            },
          },
          {
            id: 'PRRT_resolved',
            isResolved: true,
            comments: {
              nodes: [
                {
                  id: 'PRRC_3',
                  createdAt: '2026-03-19T12:16:29Z',
                  updatedAt: '2026-03-19T12:16:29Z',
                },
              ],
            },
          },
        ],
      },
    } satisfies PullRequestSignalSnapshotData);

    expect(snapshot.reviewStates).toEqual(['COMMENTED', 'CHANGES_REQUESTED']);
    expect(snapshot.reviewTokens).toEqual([
      'review:PRR_1:COMMENTED:2026-03-19T13:14:26Z',
      'review:PRR_2:CHANGES_REQUESTED:2026-03-19T13:13:34Z',
    ]);
    expect(snapshot.issueCommentTimestamps).toEqual(['2026-03-18T13:18:15Z']);
    expect(snapshot.unresolvedThreadTokens).toEqual(['thread:PRRT_open:2026-03-19T13:15:00Z']);
  });

  test('ignores incomplete review records and de-duplicates states', () => {
    const snapshot = buildPullRequestSignalSnapshot({
      comments: {
        nodes: [],
      },
      reviews: {
        nodes: [
          {
            id: 'PRR_1',
            state: 'commented',
            submittedAt: '2026-03-19T13:02:40Z',
            updatedAt: '2026-03-19T13:02:40Z',
          },
          {
            id: 'PRR_2',
            state: 'COMMENTED',
            submittedAt: '2026-03-19T13:03:00Z',
            updatedAt: '2026-03-19T13:03:00Z',
          },
          {
            id: null,
            state: 'APPROVED',
            submittedAt: '2026-03-19T13:04:00Z',
            updatedAt: '2026-03-19T13:04:00Z',
          },
        ],
      },
      reviewThreads: {
        nodes: [],
      },
    } satisfies PullRequestSignalSnapshotData);

    expect(snapshot.reviewStates).toEqual(['COMMENTED', 'APPROVED']);
    expect(snapshot.reviewTokens).toEqual([
      'review:PRR_1:COMMENTED:2026-03-19T13:02:40Z',
      'review:PRR_2:COMMENTED:2026-03-19T13:03:00Z',
    ]);
  });
});
