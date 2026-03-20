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
  reviewItems: PullRequestSignalItem[];
  issueCommentItems: PullRequestSignalItem[];
  unresolvedThreadItems: PullRequestSignalItem[];
};

export type PendingPullRequestSignalDetails = {
  hasReviewActivity: boolean;
  reviewStates: string[];
  reactionSubjectIds: string[];
};

const SIGNAL_ACK_COMMENT_MARKER = '<!-- orbit-pilot-signal-acks';

export function buildPullRequestSignalSnapshot(pullRequest: PullRequestSignalSnapshotData): PullRequestSignalSnapshot {
  const pullRequestId = pullRequest.id?.trim() || null;
  if (!pullRequestId) {
    throw new Error('pull request node id is missing');
  }

  return {
    pullRequestId,
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
): PendingPullRequestSignalDetails {
  const pendingReviewItems = snapshot.reviewItems.filter((item) => !item.acknowledged);
  const pendingIssueCommentItems = snapshot.issueCommentItems.filter((item) => !item.acknowledged);
  const pendingUnresolvedThreadItems = snapshot.unresolvedThreadItems.filter((item) => !item.acknowledged);

  return {
    hasReviewActivity:
      pendingReviewItems.length > 0 || pendingIssueCommentItems.length > 0 || pendingUnresolvedThreadItems.length > 0,
    reviewStates: [...new Set(pendingReviewItems.flatMap((item) => (item.reviewState ? [item.reviewState] : [])))],
    reactionSubjectIds: [
      ...new Set(
        [...pendingReviewItems, ...pendingIssueCommentItems, ...pendingUnresolvedThreadItems]
          .flatMap((item) => (item.reactableId ? [item.reactableId] : []))
          .filter(Boolean),
      ),
    ],
  };
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
