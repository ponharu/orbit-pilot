import { describe, expect, test } from 'bun:test';
import {
  buildPullRequestSignalSnapshot,
  type PullRequestSignalSnapshotData,
} from '../../src/github/pull-request-signals';

describe('buildPullRequestSignalSnapshot', () => {
  test('captures reactable review signals and unresolved thread markers from the latest activity', () => {
    const snapshot = buildPullRequestSignalSnapshot({
      id: 'PR_kwDO123',
      comments: {
        nodes: [
          {
            id: 'IC_1',
            body: 'please check',
            createdAt: '2026-03-18T13:18:15Z',
            updatedAt: '2026-03-18T13:18:15Z',
            reactionGroups: [
              {
                content: 'EYES',
                viewerHasReacted: true,
              },
            ],
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
            reactionGroups: [],
          },
          {
            id: 'PRR_2',
            state: 'CHANGES_REQUESTED',
            submittedAt: '2026-03-19T13:13:34Z',
            updatedAt: '2026-03-19T13:13:34Z',
            reactionGroups: [
              {
                content: 'EYES',
                viewerHasReacted: true,
              },
            ],
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
                  reactionGroups: [],
                },
                {
                  id: 'PRRC_2',
                  createdAt: '2026-03-19T13:13:34Z',
                  updatedAt: '2026-03-19T13:15:00Z',
                  reactionGroups: [],
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
                  reactionGroups: [],
                },
              ],
            },
          },
        ],
      },
    } satisfies PullRequestSignalSnapshotData);

    expect(snapshot.pullRequestId).toBe('PR_kwDO123');
    expect(snapshot.reviewItems).toEqual([
      {
        token: 'review:PRR_1:COMMENTED:2026-03-19T13:14:26Z',
        reactableId: 'PRR_1',
        acknowledged: false,
        reviewState: 'COMMENTED',
      },
      {
        token: 'review:PRR_2:CHANGES_REQUESTED:2026-03-19T13:13:34Z',
        reactableId: 'PRR_2',
        acknowledged: true,
        reviewState: 'CHANGES_REQUESTED',
      },
    ]);
    expect(snapshot.issueCommentItems).toEqual([
      {
        token: 'comment:IC_1:2026-03-18T13:18:15Z',
        reactableId: 'IC_1',
        acknowledged: true,
        reviewState: null,
      },
    ]);
    expect(snapshot.unresolvedThreadItems).toEqual([
      {
        token: 'thread:PRRT_open:2026-03-19T13:15:00Z',
        reactableId: 'PRRC_2',
        acknowledged: false,
        reviewState: null,
      },
    ]);
  });

  test('ignores the legacy managed ack comment as a PR comment signal', () => {
    const snapshot = buildPullRequestSignalSnapshot({
      id: 'PR_kwDO456',
      comments: {
        nodes: [
          {
            id: 'IC_ack',
            body: '👀 orbit-pilot acknowledged signals\n<!-- orbit-pilot-signal-acks\ncheck:test:2026-03-19T13:04:00Z:0\n-->',
            createdAt: '2026-03-19T13:04:00Z',
            updatedAt: '2026-03-19T13:04:00Z',
            reactionGroups: [],
          },
        ],
      },
      reviews: {
        nodes: [
          {
            id: 'PRR_1',
            state: 'commented',
            submittedAt: '2026-03-19T13:02:40Z',
            updatedAt: '2026-03-19T13:02:40Z',
            reactionGroups: [],
          },
          {
            id: 'PRR_2',
            state: 'COMMENTED',
            submittedAt: '2026-03-19T13:03:00Z',
            updatedAt: '2026-03-19T13:03:00Z',
            reactionGroups: [],
          },
          {
            id: null,
            state: 'APPROVED',
            submittedAt: '2026-03-19T13:04:00Z',
            updatedAt: '2026-03-19T13:04:00Z',
            reactionGroups: [],
          },
        ],
      },
      reviewThreads: {
        nodes: [],
      },
    } satisfies PullRequestSignalSnapshotData);

    expect(snapshot.issueCommentItems).toEqual([]);
    expect(snapshot.reviewItems).toEqual([
      {
        token: 'review:PRR_1:COMMENTED:2026-03-19T13:02:40Z',
        reactableId: 'PRR_1',
        acknowledged: false,
        reviewState: 'COMMENTED',
      },
      {
        token: 'review:PRR_2:COMMENTED:2026-03-19T13:03:00Z',
        reactableId: 'PRR_2',
        acknowledged: false,
        reviewState: 'COMMENTED',
      },
    ]);
  });
});
