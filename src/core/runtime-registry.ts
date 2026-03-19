import type { AppConfig } from '../config';
import { GitHubClient, type PullRequestSignal, type RepoIssueTarget } from '../github/client';
import type { Logger } from './types';
import { AgentRunner, AgentTurnError, type AgentRunHandle } from './agent-runner';
import { StateStore } from './state-store';
import type { AgentContext, GitHubIssue, RepoTarget, RunMetadata, WorkspaceState } from './types';
import { WorkspaceManager } from './workspace-manager';

type RunningEntry = {
  target: RepoTarget;
  issue: GitHubIssue;
  handle: AgentRunHandle;
};

type IssueState = {
  claimed?: true;
  retryTimer?: Timer;
  stopRequested?: true;
};

export class RuntimeRegistry {
  private readonly stateStore: StateStore;
  private readonly runner: AgentRunner;
  private readonly logger: Logger;
  private readonly running = new Map<string, RunningEntry>();
  private readonly issueState = new Map<string, IssueState>();
  private reconciling = false;
  private pollTimer: Timer | null = null;
  private continuous = true;

  constructor(
    private readonly config: AppConfig,
    private readonly client: GitHubClient,
    logger: Logger,
  ) {
    this.logger = logger;
    const workspaceManager = new WorkspaceManager(config, logger);
    this.stateStore = new StateStore(config);
    this.runner = new AgentRunner(config, logger, workspaceManager);
  }

  async startAll(once: boolean) {
    this.continuous = !once;

    await this.hydrateState();
    await this.reconcile();

    if (once) {
      return;
    }

    await new Promise(() => undefined);
  }

  private async hydrateState() {
    const savedStates = await this.stateStore.listAllStates();

    for (const state of savedStates) {
      if (state.status === 'running' || state.status === 'retrying') {
        this.logger.warn('found interrupted workspace state during startup', {
          repo: state.repo,
          issueNumber: state.issueNumber,
          status: state.status,
          lastError: state.lastError ?? undefined,
        });
      }
    }
  }

  private async reconcile() {
    if (this.reconciling) {
      return;
    }

    this.reconciling = true;

    try {
      const discoveryLimitPerOwner = this.discoveryLimitPerOwner();
      const assignedIssues = await this.client.listAssignedOpenIssues(
        this.config.owners,
        this.config.excludeRepos,
        discoveryLimitPerOwner,
      );

      this.logger.info('discovered assigned issues', {
        owners: this.config.owners,
        excludeRepos: this.config.excludeRepos,
        discoveryLimitPerOwner,
        issueCount: assignedIssues.length,
        repositoryCount: new Set(assignedIssues.map((entry) => entry.target.fullName.toLowerCase())).size,
      });

      this.reconcileRunningIssues(assignedIssues);
      const evaluated = await this.evaluateDispatchCandidates(assignedIssues);

      evaluated.sort((left, right) => left.issue.createdAt.localeCompare(right.issue.createdAt));

      for (const entry of evaluated) {
        if (this.repoRunningCount(entry.target) >= this.config.maxConcurrentRunsPerRepo) {
          continue;
        }

        this.dispatchIssue(
          entry.target,
          entry.issue,
          {
            attempt: 1,
            reason: entry.reason,
            branchName: entry.branchName ?? null,
          },
          entry.reviewSignals,
        );
      }

      if (this.continuous) {
        this.scheduleNextPoll(this.config.pollIntervalMs);
      }
    } catch (error) {
      this.logger.error('global reconcile failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.scheduleNextPoll(30_000);
    } finally {
      this.reconciling = false;
    }
  }

  private reconcileRunningIssues(openIssues: RepoIssueTarget[]) {
    const openByKey = new Map(openIssues.map((entry) => [issueKey(entry.target.fullName, entry.issue.number), entry]));

    for (const [key, running] of this.running) {
      const current = openByKey.get(key);

      if (!current) {
        this.logger.info('stopping ineligible running issue', {
          repo: running.target.fullName,
          issueNumber: running.issue.number,
        });

        this.stateByKey(key).stopRequested = true;
        running.handle.abort();
        this.running.delete(key);
        this.releaseClaim(key);
      } else {
        running.target = current.target;
        running.issue = current.issue;
      }
    }
  }

  private async evaluateIssue(entry: RepoIssueTarget) {
    const key = issueKey(entry.target.fullName, entry.issue.number);

    if (this.isClaimed(key) || this.running.has(key)) {
      return null;
    }

    const signal = await this.client.getIssueSignalContext(entry.target, entry.issue);

    if (signal.kind === 'review' && signal.signals.length === 0) {
      return null;
    }

    return {
      ...entry,
      reason: signal.kind,
      branchName: signal.branchName,
      reviewSignals: signal.kind === 'review' ? signal.signals : null,
    };
  }

  private async evaluateDispatchCandidates(assignedIssues: RepoIssueTarget[]) {
    const grouped = new Map<string, RepoIssueTarget[]>();

    for (const entry of assignedIssues) {
      const key = entry.target.fullName.toLowerCase();
      const existing = grouped.get(key);
      if (existing) {
        existing.push(entry);
      } else {
        grouped.set(key, [entry]);
      }
    }

    const repoQueues = [...grouped.values()].filter((entries) => this.repoAvailableSlots(entries[0].target) > 0);
    const evaluatedGroups = await mapWithConcurrencyLimit(
      repoQueues,
      this.repoEvaluationConcurrency(),
      async (entries) => {
        const availableSlots = this.repoAvailableSlots(entries[0].target);
        const evaluated: NonNullable<Awaited<ReturnType<RuntimeRegistry['evaluateIssue']>>>[] = [];

        for (const entry of entries) {
          if (evaluated.length >= availableSlots) {
            break;
          }

          const result = await this.evaluateIssue(entry);
          if (result) {
            evaluated.push(result);
          }
        }

        return evaluated;
      },
    );

    return evaluatedGroups.flat();
  }

  private dispatchIssue(
    target: RepoTarget,
    issue: GitHubIssue,
    metadata: RunMetadata,
    reviewSignals: PullRequestSignal[] | null = null,
  ) {
    const key = issueKey(target.fullName, issue.number);

    if (this.isClaimed(key) || this.running.has(key)) {
      return;
    }

    this.claim(key);

    void (async () => {
      let existingState: WorkspaceState | null = null;
      let preferredBranchName: string | null = metadata.branchName;
      let hydratedIssue = issue;

      try {
        existingState = await this.stateStore.readState(target, issue.number);
        preferredBranchName = existingState?.branchName ?? metadata.branchName;
        hydratedIssue = await this.client.hydrateIssue(target, issue);
        const context = await this.buildAgentContext(metadata, existingState, reviewSignals);

        await this.persistState(target, hydratedIssue, {
          ...this.buildStateValues(metadata, Math.max(0, metadata.attempt - 1), {
            branchName: preferredBranchName,
            status: 'running',
            lastError: null,
            lastFailureContext: existingState?.lastFailureContext ?? null,
            threadId: existingState?.threadId ?? null,
          }),
        });

        const cloneUrl = await this.client.buildCloneUrl(target);
        const handle = this.runner.run(
          target,
          hydratedIssue,
          context,
          cloneUrl,
          existingState?.threadId ?? null,
          preferredBranchName,
        );

        this.running.set(key, {
          target,
          issue,
          handle,
        });

        const result = await handle.promise;

        this.logger.info('agent run completed', {
          repo: target.fullName,
          issue: hydratedIssue.identifier,
        });

        if (metadata.reason === 'review' && reviewSignals && reviewSignals.length > 0) {
          await this.client.acknowledgePullRequestSignals(target, reviewSignals);
        }
        await this.persistState(target, hydratedIssue, {
          ...this.buildStateValues(metadata, Math.max(0, metadata.attempt - 1), {
            branchName: result.branchName,
            status: 'idle',
            lastError: null,
            lastFailureContext: null,
            threadId: result.threadId,
          }),
        });
        this.running.delete(key);
        this.releaseClaim(key);
        if (this.continuous) {
          void this.reconcile();
        }
      } catch (error) {
        if (this.consumeStopRequested(key)) {
          await this.persistState(target, hydratedIssue, {
            ...this.buildStateValues(metadata, Math.max(0, metadata.attempt - 1), {
              branchName: preferredBranchName,
              status: 'idle',
              lastError: null,
              lastFailureContext: null,
              threadId: existingState?.threadId ?? null,
            }),
          });
          this.running.delete(key);
          this.releaseClaim(key);
          return;
        }

        const errorMessage = error instanceof Error ? error.message : String(error);

        this.logger.warn('agent run failed; scheduling retry', {
          repo: target.fullName,
          issue: hydratedIssue.identifier,
          error: errorMessage,
        });

        await this.persistState(target, hydratedIssue, {
          ...this.buildStateValues(metadata, metadata.attempt, {
            branchName: error instanceof AgentTurnError ? error.branchName : preferredBranchName,
            status: this.continuous ? 'retrying' : 'failed',
            lastError: errorMessage,
            lastFailureContext:
              error instanceof AgentTurnError ? error.failureContext : (existingState?.lastFailureContext ?? null),
            threadId: error instanceof AgentTurnError ? error.threadId : (existingState?.threadId ?? null),
          }),
        });

        this.running.delete(key);
        this.scheduleRetry(target, issue, metadata.attempt + 1);
      }
    })();
  }

  private scheduleRetry(target: RepoTarget, issue: GitHubIssue, attempt: number) {
    const key = issueKey(target.fullName, issue.number);

    if (!this.continuous) {
      this.releaseClaim(key);
      return;
    }

    const existing = this.issueState.get(key)?.retryTimer;
    if (existing) {
      clearTimeout(existing);
    }

    const delayMs = Math.min(10_000 * 2 ** (attempt - 1), 300_000);
    const timer = setTimeout(() => {
      void (async () => {
        const state = this.issueState.get(key);
        if (state) {
          delete state.retryTimer;
          this.cleanupState(key, state);
        }
        this.releaseClaim(key);

        if (this.repoRunningCount(target) < this.config.maxConcurrentRunsPerRepo) {
          const savedState = await this.stateStore.readState(target, issue.number);
          const reason = savedState?.lastTrigger === 'review' ? 'review' : 'initial';
          this.dispatchIssue(target, issue, {
            attempt,
            reason,
            branchName: savedState?.branchName ?? null,
          });
        } else {
          void this.reconcile();
        }
      })();
    }, delayMs);

    this.stateByKey(key).retryTimer = timer;
  }

  private scheduleNextPoll(delayMs: number) {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }

    this.pollTimer = setTimeout(() => {
      void this.reconcile();
    }, delayMs);
  }

  private async persistState(
    target: RepoTarget,
    issue: GitHubIssue,
    values: Omit<WorkspaceState, 'issueNumber' | 'repo' | 'updatedAt'>,
  ) {
    await this.stateStore.writeState(target, issue.number, {
      issueNumber: issue.number,
      repo: target.fullName,
      updatedAt: new Date().toISOString(),
      ...values,
    });
  }

  private buildStateValues(
    metadata: RunMetadata,
    retryCount: number,
    values: Pick<WorkspaceState, 'branchName' | 'status' | 'lastError' | 'lastFailureContext' | 'threadId'>,
  ): Omit<WorkspaceState, 'issueNumber' | 'repo' | 'updatedAt'> {
    return {
      ...values,
      lastRunAt: new Date().toISOString(),
      lastTrigger: metadata.reason,
      retryCount,
    };
  }

  private async buildAgentContext(
    metadata: RunMetadata,
    existingState: WorkspaceState | null,
    reviewSignals: PullRequestSignal[] | null = null,
  ): Promise<AgentContext> {
    const segments: string[] = [];
    const failureContext =
      metadata.attempt > 1 ? (existingState?.lastFailureContext ?? existingState?.lastError ?? null) : null;

    if (failureContext) {
      segments.push(`Previous failure context:\n${failureContext}`);
    }

    if (metadata.reason === 'review') {
      if (reviewSignals && reviewSignals.length > 0) {
        segments.push(buildReviewSignalInstructions(reviewSignals));
      } else {
        segments.push(
          'This run was triggered by linked pull request activity. Inspect the current linked pull request reviews, unresolved review threads, failed checks, and mergeability yourself before making changes.',
        );
      }
    }

    return {
      continuationContext: segments.length > 0 ? segments.join('\n\n') : null,
    };
  }

  private repoRunningCount(target: RepoTarget) {
    const repoKey = target.fullName.toLowerCase();
    return [...this.running.values()].filter((entry) => entry.target.fullName.toLowerCase() === repoKey).length;
  }

  private repoAvailableSlots(target: RepoTarget) {
    return Math.max(0, this.config.maxConcurrentRunsPerRepo - this.repoRunningCount(target));
  }

  private discoveryLimitPerOwner() {
    const activeRepoCount = new Set(this.running.values().map((entry) => entry.target.fullName.toLowerCase())).size;
    return Math.min(20, Math.max(8, (activeRepoCount + 1) * this.config.maxConcurrentRunsPerRepo * 2));
  }

  private repoEvaluationConcurrency() {
    return Math.max(2, this.config.maxConcurrentRunsPerRepo * 4);
  }

  private state(repoOrTarget: string, issueNumber: number) {
    return this.stateByKey(issueKey(repoOrTarget, issueNumber));
  }

  private stateByKey(key: string) {
    const existing = this.issueState.get(key);
    if (existing) {
      return existing;
    }

    const created: IssueState = {};
    this.issueState.set(key, created);
    return created;
  }

  private cleanupState(key: string, state = this.issueState.get(key)) {
    if (state && !state.claimed && !state.retryTimer && !state.stopRequested) {
      this.issueState.delete(key);
    }
  }

  private isClaimed(key: string) {
    return this.issueState.get(key)?.claimed === true;
  }

  private claim(key: string) {
    this.stateByKey(key).claimed = true;
  }

  private releaseClaim(key: string) {
    const state = this.issueState.get(key);
    if (!state) {
      return;
    }

    delete state.claimed;
    this.cleanupState(key, state);
  }

  private consumeStopRequested(key: string) {
    const state = this.issueState.get(key);
    if (!state?.stopRequested) {
      return false;
    }

    delete state.stopRequested;
    this.cleanupState(key, state);
    return true;
  }
}

function issueKey(repoOrTarget: string, issueNumber: number): string {
  return `${repoOrTarget.toLowerCase()}#${issueNumber}`;
}

async function mapWithConcurrencyLimit<TInput, TOutput>(
  items: TInput[],
  concurrency: number,
  mapper: (item: TInput) => Promise<TOutput>,
) {
  const results = Array.from({ length: items.length }) as TOutput[];
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex]);
    }
  });

  await Promise.all(workers);
  return results;
}

function buildReviewSignalInstructions(reviewSignals: PullRequestSignal[]) {
  return reviewSignals
    .map((signal) => {
      const actions: string[] = [];
      if (signal.reviewStates.length > 0) {
        actions.push(`submitted reviews (${signal.reviewStates.join(', ')})`);
      }
      if (signal.hasReviewActivity) {
        actions.push('review comments or unresolved review threads');
      }
      if (signal.hasFailedChecks) {
        actions.push('failing checks');
      }
      if (signal.hasMergeConflicts) {
        actions.push('merge conflicts');
      }

      const bullets =
        actions.length > 0 ? actions.map((action) => `- ${action}`).join('\n') : '- linked pull request activity';
      return [
        `PR #${signal.pullRequest.number} had actionable GitHub updates. Inspect the current GitHub state yourself before making changes.`,
        bullets,
      ].join('\n');
    })
    .join('\n');
}
