export type ReactionGroup = {
  content?: string | null;
  viewerHasReacted?: boolean | null;
};

export type PullRequestSignalSnapshotData = {
  id?: string | null;
  comments: {
    nodes?: Array<{
      id?: string | null;
      body?: string | null;
      createdAt?: string | null;
      updatedAt?: string | null;
      reactionGroups?: ReactionGroup[] | null;
    } | null> | null;
  };
  reviews: {
    nodes?: Array<{
      id?: string | null;
      state?: string | null;
      submittedAt?: string | null;
      updatedAt?: string | null;
      reactionGroups?: ReactionGroup[] | null;
    } | null> | null;
  };
  reviewThreads: {
    nodes?: Array<{
      id?: string | null;
      isResolved?: boolean | null;
      comments: {
        nodes?: Array<{
          id?: string | null;
          createdAt?: string | null;
          updatedAt?: string | null;
          reactionGroups?: ReactionGroup[] | null;
        } | null> | null;
      };
    } | null> | null;
  };
};

export type PullRequestSignalItem = {
  token: string;
  reactableId: string | null;
  acknowledged: boolean;
  reviewState: string | null;
};

export type PullRequestSignalSnapshot = {
  pullRequestId: string;
  ackCommentId: string | null;
  ackedNonReactableTokens: string[];
  reviewItems: PullRequestSignalItem[];
  issueCommentItems: PullRequestSignalItem[];
  unresolvedThreadItems: PullRequestSignalItem[];
};

export type PullRequestSignalCheck = {
  bucket?: string;
  name?: string | null;
  completedAt?: string | null;
};

export type PullRequestSignalSource = {
  number: number;
  baseRefOid: string | null;
  mergeStateStatus: string | null;
};

export type PendingPullRequestSignalDetails = {
  hasReviewActivity: boolean;
  hasFailedChecks: boolean;
  hasMergeConflicts: boolean;
  reviewStates: string[];
  ackCommentId: string | null;
  ackCommentTokens: string[];
  reactionSubjectIds: string[];
  nonReactableTokens: string[];
};

const SIGNAL_ACK_COMMENT_MARKER = '<!-- orbit-pilot-signal-acks';
const SIGNAL_ACK_COMMENT_FOOTER = '-->';

export function buildPullRequestSignalSnapshot(pullRequest: PullRequestSignalSnapshotData): PullRequestSignalSnapshot {
  const pullRequestId = pullRequest.id?.trim() || null;
  if (!pullRequestId) {
    throw new Error('pull request node id is missing');
  }

  const ackComment = (pullRequest.comments.nodes ?? []).find((comment) => hasSignalAckComment(comment?.body));
  const ackedNonReactableTokens = ackComment ? parseSignalAckCommentBody(ackComment.body ?? '') : [];

  return {
    pullRequestId,
    ackCommentId: ackComment?.id?.trim() || null,
    ackedNonReactableTokens,
    reviewItems: (pullRequest.reviews.nodes ?? []).flatMap((review) => {
      const reviewId = review?.id?.trim() || null;
      const timestamp = review?.updatedAt ?? review?.submittedAt ?? null;
      if (!reviewId || !timestamp) {
        return [];
      }

      const reviewState = normalizeReviewState(review?.state);
      return [
        {
          token: `review:${reviewId}:${reviewState ?? 'UNKNOWN'}:${timestamp}`,
          reactableId: reviewId,
          acknowledged: hasEyesReaction(review?.reactionGroups),
          reviewState,
        },
      ];
    }),
    issueCommentItems: (pullRequest.comments.nodes ?? []).flatMap((comment) => {
      if (hasSignalAckComment(comment?.body)) {
        return [];
      }

      const commentId = comment?.id?.trim() || null;
      const timestamp = comment?.updatedAt ?? comment?.createdAt ?? null;
      if (!commentId || !timestamp) {
        return [];
      }

      return [
        {
          token: `comment:${commentId}:${timestamp}`,
          reactableId: commentId,
          acknowledged: hasEyesReaction(comment?.reactionGroups),
          reviewState: null,
        },
      ];
    }),
    unresolvedThreadItems: (pullRequest.reviewThreads.nodes ?? []).flatMap((thread) => {
      const threadId = thread?.id?.trim() || null;
      if (!thread || thread.isResolved || !threadId) {
        return [];
      }

      let latestComment: {
        id?: string | null;
        createdAt?: string | null;
        updatedAt?: string | null;
        reactionGroups?: ReactionGroup[] | null;
      } | null = null;
      for (const comment of thread.comments.nodes ?? []) {
        const timestamp = comment?.updatedAt ?? comment?.createdAt ?? null;
        const latestTimestamp = latestComment?.updatedAt ?? latestComment?.createdAt ?? null;
        if (!timestamp) {
          continue;
        }

        if (!latestTimestamp || latestTimestamp.localeCompare(timestamp) < 0) {
          latestComment = comment;
        }
      }

      const latestCommentId = latestComment?.id?.trim() || null;
      const latestTimestamp = latestComment?.updatedAt ?? latestComment?.createdAt ?? null;
      if (!latestCommentId || !latestTimestamp) {
        return [];
      }

      return [
        {
          token: `thread:${threadId}:${latestTimestamp}`,
          reactableId: latestCommentId,
          acknowledged: hasEyesReaction(latestComment?.reactionGroups),
          reviewState: null,
        },
      ];
    }),
  };
}

export function buildPendingPullRequestSignalDetails(
  snapshot: PullRequestSignalSnapshot,
  pullRequest: PullRequestSignalSource,
  checks: PullRequestSignalCheck[],
): PendingPullRequestSignalDetails {
  const pendingReviewItems = snapshot.reviewItems.filter((item) => !item.acknowledged);
  const pendingIssueCommentItems = snapshot.issueCommentItems.filter((item) => !item.acknowledged);
  const pendingUnresolvedThreadItems = snapshot.unresolvedThreadItems.filter((item) => !item.acknowledged);
  const ackedNonReactableTokens = new Set(snapshot.ackedNonReactableTokens);
  const pendingFailedCheckTokens = checks
    .flatMap((item, index) =>
      item.bucket === 'fail' && item.completedAt
        ? [`check:${item.name?.trim() || item.bucket || 'unknown'}:${item.completedAt}:${index}`]
        : [],
    )
    .filter((token) => !ackedNonReactableTokens.has(token));

  const conflictToken =
    pullRequest.mergeStateStatus === 'DIRTY' && pullRequest.baseRefOid
      ? `conflict:${pullRequest.number}:${pullRequest.baseRefOid}`
      : null;
  const pendingConflictTokens = conflictToken && !ackedNonReactableTokens.has(conflictToken) ? [conflictToken] : [];

  return {
    hasReviewActivity:
      pendingReviewItems.length > 0 || pendingIssueCommentItems.length > 0 || pendingUnresolvedThreadItems.length > 0,
    hasFailedChecks: pendingFailedCheckTokens.length > 0,
    hasMergeConflicts: pendingConflictTokens.length > 0,
    reviewStates: [...new Set(pendingReviewItems.flatMap((item) => (item.reviewState ? [item.reviewState] : [])))],
    ackCommentId: snapshot.ackCommentId,
    ackCommentTokens: snapshot.ackedNonReactableTokens,
    reactionSubjectIds: [
      ...new Set(
        [...pendingReviewItems, ...pendingIssueCommentItems, ...pendingUnresolvedThreadItems]
          .flatMap((item) => (item.reactableId ? [item.reactableId] : []))
          .filter(Boolean),
      ),
    ],
    nonReactableTokens: [...pendingFailedCheckTokens, ...pendingConflictTokens],
  };
}

export function buildSignalAckCommentBody(tokens: string[]) {
  return [`👀 orbit-pilot acknowledged signals`, SIGNAL_ACK_COMMENT_MARKER, ...tokens, SIGNAL_ACK_COMMENT_FOOTER].join(
    '\n',
  );
}

function normalizeReviewState(state: string | null | undefined) {
  const normalized = state?.trim().toUpperCase() ?? '';
  return normalized.length > 0 ? normalized : null;
}

function hasEyesReaction(reactionGroups: ReactionGroup[] | null | undefined) {
  return (reactionGroups ?? []).some(
    (group) => group?.content?.trim().toUpperCase() === 'EYES' && group.viewerHasReacted === true,
  );
}

function hasSignalAckComment(body: string | null | undefined) {
  return (body ?? '').includes(SIGNAL_ACK_COMMENT_MARKER);
}

function parseSignalAckCommentBody(body: string) {
  const start = body.indexOf(SIGNAL_ACK_COMMENT_MARKER);
  const end = body.indexOf(SIGNAL_ACK_COMMENT_FOOTER, start);
  if (start < 0 || end < 0) {
    return [];
  }

  return body
    .slice(start + SIGNAL_ACK_COMMENT_MARKER.length, end)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}
