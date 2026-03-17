import type { AppConfig } from '../config';
import { GitHubClient } from '../github/client';
import type { AgentContext, GitHubIssue, Logger, RepoTarget, RunMetadata, WorkspaceState } from './types';
import { AgentRunner, AgentTurnError, type AgentRunHandle } from './agent-runner';
import { StateStore } from './state-store';

type RunningEntry = {
  issue: GitHubIssue;
  handle: AgentRunHandle;
  metadata: RunMetadata;
};

type RetryEntry = {
  attempt: number;
  timer: Timer;
};

export class RepositoryRuntime {
  private running = new Map<number, RunningEntry>();
  private claimed = new Set<number>();
  private retries = new Map<number, RetryEntry>();
  private stoppedByRuntime = new Set<number>();
  private handledRevisions = new Map<number, string>();
  private reconciling = false;
  private pendingReconcile = false;
  private pollTimer: Timer | null = null;
  private disposed = false;

  constructor(
    private readonly config: AppConfig,
    private readonly target: RepoTarget,
    private readonly viewerLogin: string,
    private readonly client: GitHubClient,
    private readonly runner: AgentRunner,
    private readonly stateStore: StateStore,
    private readonly logger: Logger,
    private readonly continuous = true,
  ) {}

  async start() {
    await this.hydrateState();
    await this.reconcile('poll');
  }

  stop() {
    this.disposed = true;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    for (const retry of this.retries.values()) {
      clearTimeout(retry.timer);
    }

    for (const running of this.running.values()) {
      this.stoppedByRuntime.add(running.issue.number);
      running.handle.abort();
    }

    this.retries.clear();
    this.running.clear();
    this.claimed.clear();
  }

  reconcileSoon() {
    void this.reconcile('poll');
  }

  private async hydrateState() {
    const savedStates = await this.stateStore.listStates(this.target);

    for (const state of savedStates) {
      if (state.lastHandledRevision) {
        this.handledRevisions.set(state.issueNumber, state.lastHandledRevision);
      }

      if (state.status === 'running' || state.status === 'retrying') {
        this.logger.warn('found interrupted workspace state during startup', {
          issueNumber: state.issueNumber,
          status: state.status,
          lastError: state.lastError ?? undefined,
        });
      }
    }
  }

  async handleReviewTrigger(issueNumbers: number[], prNumber: number, reason: string) {
    if (issueNumbers.length === 0) {
      return;
    }

    const issues = await this.client.getIssues(this.target, issueNumbers);

    for (const issue of issues) {
      const signal = await this.client.getIssueSignal(this.target, issue);

      if (signal.kind === 'review' && signal.revision !== null && this.shouldRouteIssue(issue)) {
        this.logger.info('dispatching review-triggered issue', {
          repo: this.target.fullName,
          issue: issue.identifier,
          prNumber,
          reason,
        });

        this.dispatchIssue(
          issue,
          { issueNumber: issue.number, attempt: 1, reason: 'review', branchName: signal.branchName },
          signal.revision,
        );
      }
    }
  }

  private async reconcile(trigger: 'poll') {
    if (this.disposed) {
      return;
    }

    if (this.reconciling) {
      this.pendingReconcile = true;
      return;
    }

    this.reconciling = true;

    try {
      const issues = await this.client.listOpenIssues(this.target);

      this.reconcileRunningIssues(issues);

      const evaluated = [];

      for (const issue of issues) {
        if (issue.isPullRequest) {
          continue;
        }

        const evaluation = await this.evaluateIssue(issue);
        if (evaluation.shouldDispatch) {
          evaluated.push(evaluation);
        }
      }

      evaluated.sort((left, right) => left.issue.createdAt.localeCompare(right.issue.createdAt));

      for (const entry of evaluated) {
        if (this.running.size >= this.config.maxConcurrentRunsPerRepo) {
          break;
        }

        this.dispatchIssue(
          entry.issue,
          {
            issueNumber: entry.issue.number,
            attempt: 1,
            reason: entry.reason ?? trigger,
            branchName: entry.branchName ?? null,
          },
          entry.revision,
        );
      }

      if (this.continuous) {
        this.scheduleNextPoll(this.config.pollIntervalMs);
      }
    } catch (error) {
      this.logger.error('repository reconcile failed', {
        repo: this.target.fullName,
        error: error instanceof Error ? error.message : String(error),
      });
      this.scheduleNextPoll(30_000);
    } finally {
      this.reconciling = false;

      if (this.pendingReconcile) {
        this.pendingReconcile = false;
        queueMicrotask(() => {
          void this.reconcile('poll');
        });
      }
    }
  }

  private reconcileRunningIssues(openIssues: GitHubIssue[]) {
    const openByNumber = new Map(openIssues.map((issue) => [issue.number, issue]));

    for (const [issueNumber, running] of this.running) {
      const current = openByNumber.get(issueNumber);

      if (!current || this.isTerminalIssue(current) || !this.shouldRouteIssue(current)) {
        this.logger.info('stopping ineligible running issue', {
          repo: this.target.fullName,
          issueNumber,
        });

        this.stoppedByRuntime.add(issueNumber);
        running.handle.abort();
        this.running.delete(issueNumber);
        this.claimed.delete(issueNumber);
      } else {
        running.issue = current;
      }
    }
  }

  private async evaluateIssue(issue: GitHubIssue) {
    if (
      !this.shouldRouteIssue(issue) ||
      this.isTerminalIssue(issue) ||
      this.claimed.has(issue.number) ||
      this.running.has(issue.number)
    ) {
      return { issue, shouldDispatch: false, revision: issue.updatedAt, reason: 'initial' as const, branchName: null };
    }

    const signal = await this.client.getIssueSignal(this.target, issue);
    const previous = this.handledRevisions.get(issue.number);

    if (signal.kind === 'review' && signal.revision === null) {
      return {
        issue,
        shouldDispatch: false,
        revision: issue.updatedAt,
        reason: signal.kind,
        branchName: signal.branchName,
      };
    }

    const revision = signal.kind === 'initial' ? signal.revision : signal.revision!;
    const shouldDispatch =
      signal.kind === 'initial' ? previous === undefined : previous === undefined || revision !== previous;

    return {
      issue,
      shouldDispatch,
      revision,
      reason: signal.kind,
      branchName: signal.branchName,
    };
  }

  private shouldRouteIssue(issue: GitHubIssue) {
    return issue.assignees.includes(this.viewerLogin);
  }

  private isTerminalIssue(issue: GitHubIssue) {
    return issue.state === 'closed';
  }

  private dispatchIssue(issue: GitHubIssue, metadata: RunMetadata, revision: string) {
    if (this.claimed.has(issue.number) || this.running.has(issue.number)) {
      return;
    }

    this.claimed.add(issue.number);

    void (async () => {
      try {
        const existingState = await this.stateStore.readState(this.target, issue.number);
        const preferredBranchName = existingState?.branchName ?? metadata.branchName;
        const context = await this.buildAgentContext(issue, metadata, existingState);

        await this.persistState(issue, {
          branchName: preferredBranchName,
          status: 'running',
          lastHandledRevision: this.handledRevisions.get(issue.number) ?? null,
          lastRunAt: new Date().toISOString(),
          lastTrigger: metadata.reason,
          retryCount: Math.max(0, metadata.attempt - 1),
          lastError: null,
          lastFailureContext: existingState?.lastFailureContext ?? null,
          threadId: existingState?.threadId ?? null,
        });

        const cloneUrl = await this.client.buildCloneUrl(this.target);
        const handle = this.runner.run(
          this.target,
          issue,
          context,
          cloneUrl,
          this.viewerLogin,
          existingState?.threadId ?? null,
          preferredBranchName,
        );

        this.running.set(issue.number, {
          issue,
          handle,
          metadata,
        });

        const result = await handle.promise;

        this.logger.info('agent run completed', {
          repo: this.target.fullName,
          issue: issue.identifier,
        });

        this.handledRevisions.set(issue.number, revision);
        await this.persistState(issue, {
          branchName: result.branchName,
          status: 'idle',
          lastHandledRevision: revision,
          lastRunAt: new Date().toISOString(),
          lastTrigger: metadata.reason,
          retryCount: Math.max(0, metadata.attempt - 1),
          lastError: null,
          lastFailureContext: null,
          threadId: result.threadId,
        });
        this.running.delete(issue.number);
        this.claimed.delete(issue.number);
      } catch (error) {
        if (this.disposed || this.stoppedByRuntime.delete(issue.number)) {
          await this.persistState(issue, {
            branchName: (await this.stateStore.readState(this.target, issue.number))?.branchName ?? null,
            status: 'idle',
            lastHandledRevision: this.handledRevisions.get(issue.number) ?? null,
            lastRunAt: new Date().toISOString(),
            lastTrigger: metadata.reason,
            retryCount: Math.max(0, metadata.attempt - 1),
            lastError: null,
            lastFailureContext: null,
            threadId: (await this.stateStore.readState(this.target, issue.number))?.threadId ?? null,
          });
          this.running.delete(issue.number);
          this.claimed.delete(issue.number);
          return;
        }

        const errorMessage = error instanceof Error ? error.message : String(error);

        this.logger.warn('agent run failed; scheduling retry', {
          repo: this.target.fullName,
          issue: issue.identifier,
          error: errorMessage,
        });

        await this.persistState(issue, {
          branchName:
            error instanceof AgentTurnError
              ? error.branchName
              : ((await this.stateStore.readState(this.target, issue.number))?.branchName ?? null),
          status: this.continuous ? 'retrying' : 'failed',
          lastHandledRevision: this.handledRevisions.get(issue.number) ?? null,
          lastRunAt: new Date().toISOString(),
          lastTrigger: metadata.reason,
          retryCount: metadata.attempt,
          lastError: errorMessage,
          lastFailureContext:
            error instanceof AgentTurnError
              ? error.failureContext
              : ((await this.stateStore.readState(this.target, issue.number))?.lastFailureContext ?? null),
          threadId:
            error instanceof AgentTurnError
              ? error.threadId
              : ((await this.stateStore.readState(this.target, issue.number))?.threadId ?? null),
        });

        this.running.delete(issue.number);
        this.scheduleRetry(issue, metadata.attempt + 1);
      }
    })();
  }

  private scheduleRetry(issue: GitHubIssue, attempt: number) {
    if (!this.continuous) {
      this.claimed.delete(issue.number);
      return;
    }

    const existing = this.retries.get(issue.number);
    if (existing) {
      clearTimeout(existing.timer);
    }

    const delayMs = Math.min(10_000 * 2 ** (attempt - 1), 300_000);
    const timer = setTimeout(() => {
      void (async () => {
        this.retries.delete(issue.number);
        this.claimed.delete(issue.number);

        if (this.running.size < this.config.maxConcurrentRunsPerRepo) {
          const savedState = await this.stateStore.readState(this.target, issue.number);
          const reason = savedState?.lastTrigger === 'review' ? 'review' : 'initial';
          this.dispatchIssue(
            issue,
            {
              issueNumber: issue.number,
              attempt,
              reason,
              branchName: savedState?.branchName ?? null,
            },
            issue.updatedAt,
          );
        } else {
          this.reconcileSoon();
        }
      })();
    }, delayMs);

    this.retries.set(issue.number, { attempt, timer });
  }

  private scheduleNextPoll(delayMs: number) {
    if (this.disposed) {
      return;
    }

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }

    this.pollTimer = setTimeout(() => {
      void this.reconcile('poll');
    }, delayMs);
  }

  private async persistState(issue: GitHubIssue, values: Omit<WorkspaceState, 'issueNumber' | 'repo' | 'updatedAt'>) {
    await this.stateStore.writeState(this.target, issue.number, {
      issueNumber: issue.number,
      repo: this.target.fullName,
      updatedAt: new Date().toISOString(),
      ...values,
    });
  }

  private async buildAgentContext(
    issue: GitHubIssue,
    metadata: RunMetadata,
    existingState: WorkspaceState | null,
  ): Promise<AgentContext> {
    const segments: string[] = [];
    const failureContext =
      metadata.attempt > 1 ? (existingState?.lastFailureContext ?? existingState?.lastError ?? null) : null;

    if (failureContext) {
      segments.push(`Previous failure context:\n${failureContext}`);
    }

    if (metadata.reason === 'review') {
      const [reviewFeedback, ciFailureContext, mergeConflictContext] = await Promise.all([
        this.client.getReviewFeedback(this.target, issue),
        this.client.getCiFailureContext(this.target, issue),
        this.client.getMergeConflictContext(this.target, issue),
      ]);

      if (reviewFeedback) {
        segments.push(`GitHub review feedback for PR #${reviewFeedback.prNumber}:\n${reviewFeedback.feedback}`);
      }

      if (ciFailureContext) {
        segments.push(`CI failures for PR #${ciFailureContext.prNumber}:\n${ciFailureContext.summary}`);
      }

      if (mergeConflictContext) {
        segments.push(`Merge conflicts for PR #${mergeConflictContext.prNumber}:\n${mergeConflictContext.summary}`);
      }
    }

    return {
      continuationContext: segments.length > 0 ? segments.join('\n\n') : null,
    };
  }
}
