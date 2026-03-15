import { Codex, type Thread, type ThreadItem } from '@openai/codex-sdk';
import type { AppConfig } from '../config';
import { runShell } from '../util/shell';
import type { AgentContext, GitHubIssue, Logger, RepoTarget } from './types';
import { buildMainThreadPrompt, buildSelfReviewPrompt, type MainThreadPhase } from './prompt-builder';
import { loadRuntimeRules } from './runtime-rules-loader';
import { WorkspaceManager } from './workspace-manager';

const MAX_SELF_REVIEW_ROUNDS = 3;
const MAX_HANDOFF_TURNS = 3;

export type AgentRunResult = {
  branchName: string;
  threadId: string | null;
};

export type AgentRunHandle = {
  promise: Promise<AgentRunResult>;
  abort(): void;
};

export class AgentTurnError extends Error {
  constructor(
    message: string,
    readonly branchName: string,
    readonly threadId: string | null,
    readonly failureContext: string | null,
  ) {
    super(message);
    this.name = 'AgentTurnError';
  }
}

type BranchPullRequest = {
  number: number;
  url: string;
  isDraft: boolean;
  assignees: string[];
};

type TurnResult = {
  items: ThreadItem[];
  finalResponse: string;
  usage: unknown;
};

type SelfReviewResult =
  | {
      outcome: 'pass';
      summary: string | null;
      findings: null;
      raw: string;
    }
  | {
      outcome: 'changes_requested';
      summary: string | null;
      findings: string;
      raw: string;
    };

type WorkspaceSnapshot = {
  hasUncommittedChanges: boolean;
  commitsAheadOfRemote: number;
  hasRemoteBranch: boolean;
  pullRequest: BranchPullRequest | null;
};

type WorktreeFingerprint = {
  statusPorcelain: string;
};

type HandoffInspection = {
  complete: boolean;
  summary: string | null;
};

type ThreadOptions = {
  workingDirectory: string;
  model: AppConfig['codex']['model'];
  sandboxMode: AppConfig['codex']['sandboxMode'];
  approvalPolicy: AppConfig['codex']['approvalPolicy'];
  modelReasoningEffort: AppConfig['codex']['modelReasoningEffort'];
};

export class AgentRunner {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly workspaceManager: WorkspaceManager,
  ) {}

  run(
    target: RepoTarget,
    issue: GitHubIssue,
    context: AgentContext,
    cloneUrl: string,
    viewerLogin: string,
    existingThreadId: string | null,
    existingBranchName: string | null,
  ): AgentRunHandle {
    const controller = new AbortController();

    const promise = this.execute(
      target,
      issue,
      context,
      cloneUrl,
      viewerLogin,
      existingThreadId,
      existingBranchName,
      controller.signal,
    );

    return {
      promise,
      abort() {
        controller.abort();
      },
    };
  }

  private async execute(
    target: RepoTarget,
    issue: GitHubIssue,
    context: AgentContext,
    cloneUrl: string,
    viewerLogin: string,
    existingThreadId: string | null,
    existingBranchName: string | null,
    signal: AbortSignal,
  ) {
    const workspace = await this.workspaceManager.prepareWorkspace(target, issue, cloneUrl, existingBranchName);
    const runtimeRules = await loadRuntimeRules();
    const initialFlow = context.state === 'implement';

    const codex = new Codex();
    const threadOptions: ThreadOptions = {
      workingDirectory: workspace.path,
      model: this.config.codex.model,
      sandboxMode: this.config.codex.sandboxMode,
      approvalPolicy: this.config.codex.approvalPolicy,
      modelReasoningEffort: this.config.codex.modelReasoningEffort,
    };

    const mainThread = existingThreadId
      ? codex.resumeThread(existingThreadId, threadOptions)
      : codex.startThread(threadOptions);

    this.logger.info('starting phased codex run', {
      repo: target.fullName,
      issue: issue.identifier,
      resumed: Boolean(existingThreadId),
      runtimeRulesPath: runtimeRules.path,
      flow: initialFlow ? 'initial' : 'repair',
    });

    let initialThreadTurn = !existingThreadId;
    let latestTurn: TurnResult | null = null;

    try {
      latestTurn = await this.runReadOnlyMainPhase(
        mainThread,
        target,
        issue,
        context,
        workspace.path,
        workspace.branchName,
        workspace.mergeConflictContext,
        runtimeRules.text,
        initialFlow ? 'investigate' : 'diagnose',
        initialThreadTurn,
        mainThread.id ?? existingThreadId,
        signal,
      );
      initialThreadTurn = false;

      latestTurn = await this.runMainPhase(
        mainThread,
        target,
        issue,
        context,
        workspace.branchName,
        workspace.mergeConflictContext,
        runtimeRules.text,
        initialFlow ? 'implement' : 'fix',
        false,
        null,
        null,
        signal,
      );

      if (!initialFlow) {
        await this.completeHandoffFlow(
          mainThread,
          target,
          issue,
          context,
          workspace.branchName,
          workspace.mergeConflictContext,
          runtimeRules.text,
          existingThreadId,
          viewerLogin,
          workspace.path,
          'handoff-update',
          false,
          signal,
        );

        this.logger.info('codex run completed after phased handoff', {
          repo: target.fullName,
          issue: issue.identifier,
          usage: latestTurn.usage ?? undefined,
          finalResponse: latestTurn.finalResponse.slice(0, 500),
        });

        return {
          branchName: workspace.branchName,
          threadId: mainThread.id ?? existingThreadId,
        };
      }

      await this.completeHandoffFlow(
        mainThread,
        target,
        issue,
        context,
        workspace.branchName,
        workspace.mergeConflictContext,
        runtimeRules.text,
        existingThreadId,
        viewerLogin,
        workspace.path,
        'handoff-draft',
        true,
        signal,
      );

      for (let reviewRound = 1; reviewRound <= MAX_SELF_REVIEW_ROUNDS; reviewRound += 1) {
        const reviewResult = await this.runReadOnlySelfReview(
          target,
          issue,
          context,
          workspace.branchName,
          threadOptions,
          workspace.path,
          mainThread.id ?? existingThreadId,
          signal,
        );

        if (reviewResult.outcome === 'pass') {
          break;
        }

        this.logger.info('self-review requested follow-up changes', {
          repo: target.fullName,
          issue: issue.identifier,
          reviewRound,
          summary: reviewResult.summary ?? undefined,
        });

        if (reviewRound === MAX_SELF_REVIEW_ROUNDS) {
          throw new AgentTurnError(
            'Internal self-review still reports blocking issues after the maximum review rounds.',
            workspace.branchName,
            mainThread.id ?? existingThreadId,
            reviewResult.findings,
          );
        }

        latestTurn = await this.runMainPhase(
          mainThread,
          target,
          issue,
          context,
          workspace.branchName,
          workspace.mergeConflictContext,
          runtimeRules.text,
          'fix',
          false,
          reviewResult.findings,
          null,
          signal,
        );

        await this.completeHandoffFlow(
          mainThread,
          target,
          issue,
          context,
          workspace.branchName,
          workspace.mergeConflictContext,
          runtimeRules.text,
          existingThreadId,
          viewerLogin,
          workspace.path,
          'handoff-update',
          false,
          signal,
        );
      }

      const readyPullRequest = await markPullRequestReadyForReview(target, workspace.path, workspace.branchName);

      if (!readyPullRequest) {
        throw new AgentTurnError(
          'Initial flow completed without a draft pull request that could be marked ready for review.',
          workspace.branchName,
          mainThread.id ?? existingThreadId,
          'Expected a draft pull request to exist before the ready step.',
        );
      }

      await this.ensureBranchPullRequestAssignedToViewer(target, workspace.path, workspace.branchName, viewerLogin);

      this.logger.info('codex run completed after phased handoff', {
        repo: target.fullName,
        issue: issue.identifier,
        usage: latestTurn?.usage ?? undefined,
        finalResponse: latestTurn?.finalResponse.slice(0, 500) ?? undefined,
        readyPullRequest: readyPullRequest.url,
      });

      return {
        branchName: workspace.branchName,
        threadId: mainThread.id ?? existingThreadId,
      };
    } catch (error) {
      if (!signal.aborted) {
        await this.ensureBranchPullRequestAssignedToViewer(target, workspace.path, workspace.branchName, viewerLogin);
      }

      throw error;
    }
  }

  private async runReadOnlyMainPhase(
    thread: Thread,
    target: RepoTarget,
    issue: GitHubIssue,
    context: AgentContext,
    workspacePath: string,
    branchName: string,
    mergeConflictContext: string | null,
    runtimeRulesText: string,
    phase: Extract<MainThreadPhase, 'investigate' | 'diagnose'>,
    initialThreadTurn: boolean,
    threadId: string | null,
    signal: AbortSignal,
  ) {
    const baseline = await captureWorktreeFingerprint(workspacePath);
    const turn = await this.runMainPhase(
      thread,
      target,
      issue,
      context,
      branchName,
      mergeConflictContext,
      runtimeRulesText,
      phase,
      initialThreadTurn,
      null,
      null,
      signal,
    );

    await ensureWorktreeUnchanged(workspacePath, baseline, phase, branchName, threadId);

    return turn;
  }

  private async runMainPhase(
    thread: Thread,
    target: RepoTarget,
    issue: GitHubIssue,
    context: AgentContext,
    branchName: string,
    mergeConflictContext: string | null,
    runtimeRulesText: string,
    phase: MainThreadPhase,
    initialThreadTurn: boolean,
    selfReviewFeedback: string | null,
    handoffRequirements: string | null,
    signal: AbortSignal,
  ) {
    this.logger.info('starting codex phase', {
      repo: target.fullName,
      issue: issue.identifier,
      phase,
      initialThreadTurn,
    });

    return runTurn(
      thread,
      buildMainThreadPrompt({
        target,
        issue,
        context,
        phase,
        initialThreadTurn,
        branchName,
        mergeConflictContext,
        runtimeRulesText,
        selfReviewFeedback,
        handoffRequirements,
      }),
      signal,
      branchName,
    );
  }

  private async runReadOnlySelfReview(
    target: RepoTarget,
    issue: GitHubIssue,
    context: AgentContext,
    branchName: string,
    threadOptions: ThreadOptions,
    workspacePath: string,
    mainThreadId: string | null,
    signal: AbortSignal,
  ) {
    const reviewBaseline = await captureWorktreeFingerprint(workspacePath);
    const reviewResult = await this.runSelfReview(target, issue, context, branchName, threadOptions, signal);

    await ensureWorktreeUnchanged(workspacePath, reviewBaseline, 'self-review', branchName, mainThreadId);
    return reviewResult;
  }

  private async runSelfReview(
    target: RepoTarget,
    issue: GitHubIssue,
    context: AgentContext,
    branchName: string,
    threadOptions: ThreadOptions,
    signal: AbortSignal,
  ): Promise<SelfReviewResult> {
    const codex = new Codex();
    const reviewThread = codex.startThread(threadOptions);
    const reviewTurn = await runTurn(
      reviewThread,
      buildSelfReviewPrompt({ target, issue, context, branchName }),
      signal,
      branchName,
    );

    return parseSelfReviewResult(reviewTurn.finalResponse);
  }

  private async completeHandoffFlow(
    thread: Thread,
    target: RepoTarget,
    issue: GitHubIssue,
    context: AgentContext,
    branchName: string,
    mergeConflictContext: string | null,
    runtimeRulesText: string,
    existingThreadId: string | null,
    viewerLogin: string,
    workspacePath: string,
    phase: Extract<MainThreadPhase, 'handoff-draft' | 'handoff-update'>,
    requireDraftPullRequest: boolean,
    signal: AbortSignal,
  ) {
    let handoffRequirements: string | null = null;

    for (let handoffAttempt = 1; handoffAttempt <= MAX_HANDOFF_TURNS; handoffAttempt += 1) {
      await this.runMainPhase(
        thread,
        target,
        issue,
        context,
        branchName,
        mergeConflictContext,
        runtimeRulesText,
        phase,
        false,
        null,
        handoffRequirements,
        signal,
      );

      const handoff = await inspectHandoff(target, workspacePath, branchName, requireDraftPullRequest);
      await this.ensureBranchPullRequestAssignedToViewer(target, workspacePath, branchName, viewerLogin);

      if (handoff.complete) {
        return;
      }

      handoffRequirements = handoff.summary;

      this.logger.warn('handoff verification failed; continuing same thread', {
        repo: target.fullName,
        issue: issue.identifier,
        phase,
        handoffAttempt,
        handoffRequirements: handoff.summary ?? undefined,
      });

      if (handoffAttempt === MAX_HANDOFF_TURNS) {
        throw new AgentTurnError(
          'Git handoff remained incomplete after the maximum handoff turns.',
          branchName,
          thread.id ?? existingThreadId,
          handoff.summary,
        );
      }
    }
  }

  private async ensureBranchPullRequestAssignedToViewer(
    target: RepoTarget,
    workspacePath: string,
    branchName: string,
    viewerLogin: string,
  ) {
    const branchPullRequest = await findOpenPullRequestForBranch(target, workspacePath, branchName);

    if (!branchPullRequest || branchPullRequest.assignees.includes(viewerLogin)) {
      return;
    }

    const result = await runShell(
      ['gh', 'pr', 'edit', String(branchPullRequest.number), '--repo', target.fullName, '--add-assignee', viewerLogin]
        .map(shellEscape)
        .join(' '),
      { cwd: workspacePath },
    );

    if (result.exitCode !== 0) {
      this.logger.warn('failed to self-assign pull request after turn completion', {
        repo: target.fullName,
        branchName,
        prNumber: branchPullRequest.number,
        error: result.stderr || result.stdout,
      });
      return;
    }

    this.logger.info('self-assigned pull request after turn completion', {
      repo: target.fullName,
      branchName,
      prNumber: branchPullRequest.number,
      viewerLogin,
    });
  }
}

async function inspectHandoff(
  target: RepoTarget,
  workspacePath: string,
  branchName: string,
  requireDraftPullRequest: boolean,
): Promise<HandoffInspection> {
  const snapshot = await inspectWorkspaceState(target, workspacePath, branchName);
  const missing: string[] = [];

  if (snapshot.hasUncommittedChanges) {
    missing.push(
      'The worktree still has uncommitted changes. Commit or intentionally discard them before ending the turn.',
    );
  }

  if (snapshot.commitsAheadOfRemote > 0) {
    missing.push('The branch has local commits that have not been pushed to origin yet.');
  }

  if (!snapshot.hasRemoteBranch) {
    missing.push('The branch does not exist on origin yet.');
  }

  if (!snapshot.pullRequest) {
    missing.push('There is still no open pull request for this branch.');
  } else if (requireDraftPullRequest && !snapshot.pullRequest.isDraft) {
    missing.push(
      'The initial handoff requires a draft pull request, but the current pull request is already open for review.',
    );
  }

  return {
    complete: missing.length === 0,
    summary: missing.length > 0 ? missing.join('\n') : null,
  };
}

async function inspectWorkspaceState(
  target: RepoTarget,
  workspacePath: string,
  branchName: string,
): Promise<WorkspaceSnapshot> {
  const remoteBranchResult = await runShell(
    ['git', 'ls-remote', '--exit-code', '--heads', 'origin', shellEscape(branchName)].join(' '),
    {
      cwd: workspacePath,
    },
  );

  const hasRemoteBranch = remoteBranchResult.exitCode === 0;

  const [statusResult, aheadResult, pullRequest] = await Promise.all([
    runShell('git status --porcelain', { cwd: workspacePath }),
    hasRemoteBranch
      ? runShell(['git', 'rev-list', '--count', `${shellEscape(`origin/${branchName}`)}..HEAD`].join(' '), {
          cwd: workspacePath,
        })
      : runShell(['git', 'rev-list', '--count', `${shellEscape(`origin/${target.defaultBranch}`)}..HEAD`].join(' '), {
          cwd: workspacePath,
        }),
    findOpenPullRequestForBranch(target, workspacePath, branchName),
  ]);

  const commitsAhead = aheadResult.exitCode === 0 ? Number.parseInt(aheadResult.stdout.trim(), 10) : 0;

  return {
    hasUncommittedChanges: statusResult.exitCode === 0 && statusResult.stdout.trim().length > 0,
    commitsAheadOfRemote: Number.isFinite(commitsAhead) ? commitsAhead : 0,
    hasRemoteBranch,
    pullRequest,
  };
}

async function captureWorktreeFingerprint(workspacePath: string): Promise<WorktreeFingerprint> {
  const statusResult = await runShell('git status --porcelain', { cwd: workspacePath });

  return {
    statusPorcelain: statusResult.exitCode === 0 ? statusResult.stdout : '',
  };
}

async function ensureWorktreeUnchanged(
  workspacePath: string,
  before: WorktreeFingerprint,
  phaseName: string,
  branchName: string,
  threadId: string | null,
) {
  const after = await captureWorktreeFingerprint(workspacePath);

  if (before.statusPorcelain === after.statusPorcelain) {
    return;
  }

  throw new AgentTurnError(
    `The ${phaseName} phase changed the workspace even though file edits are not allowed in that phase.`,
    branchName,
    threadId,
    trimForPrompt(after.statusPorcelain || '(empty status)', 1200),
  );
}

async function markPullRequestReadyForReview(
  target: RepoTarget,
  workspacePath: string,
  branchName: string,
): Promise<BranchPullRequest | null> {
  const pullRequest = await findOpenPullRequestForBranch(target, workspacePath, branchName);

  if (!pullRequest) {
    return null;
  }

  if (!pullRequest.isDraft) {
    return pullRequest;
  }

  const result = await runShell(
    ['gh', 'pr', 'ready', String(pullRequest.number), '--repo', target.fullName].map(shellEscape).join(' '),
    { cwd: workspacePath },
  );

  if (result.exitCode !== 0) {
    return null;
  }

  return findOpenPullRequestForBranch(target, workspacePath, branchName);
}

function parseSelfReviewResult(output: string): SelfReviewResult {
  const normalized = output.trim();
  const resultMatch = normalized.match(/^RESULT:\s*(pass|changes_requested)\s*$/im);
  const summaryMatch = normalized.match(/^SUMMARY:\s*(.+)$/im);
  const findingsMatch = normalized.match(/^FINDINGS:\s*([\s\S]*)$/im);
  const outcome = resultMatch?.[1]?.toLowerCase();
  const summary = summaryMatch?.[1]?.trim() || null;
  const findingsBlock = findingsMatch?.[1]?.trim() || '';

  if (outcome === 'pass') {
    return {
      outcome: 'pass',
      summary,
      findings: null,
      raw: output,
    };
  }

  if (outcome === 'changes_requested') {
    return {
      outcome: 'changes_requested',
      summary,
      findings: findingsBlock || trimForPrompt(output, 1600),
      raw: output,
    };
  }

  return {
    outcome: 'changes_requested',
    summary: 'The self-review output did not follow the required format.',
    findings: trimForPrompt(output, 1600),
    raw: output,
  };
}

async function findOpenPullRequestForBranch(
  target: RepoTarget,
  workspacePath: string,
  branchName: string,
): Promise<BranchPullRequest | null> {
  const result = await runShell(
    [
      'gh',
      'pr',
      'list',
      '--repo',
      target.fullName,
      '--state',
      'open',
      '--head',
      branchName,
      '--json',
      'number,url,isDraft,assignees',
    ]
      .map(shellEscape)
      .join(' '),
    { cwd: workspacePath },
  );

  if (result.exitCode !== 0) {
    return null;
  }

  const pullRequests = JSON.parse(result.stdout) as Array<{
    number?: number;
    url?: string | null;
    isDraft?: boolean;
    assignees?: Array<{ login?: string | null }>;
  }>;

  const pullRequest = pullRequests.find((item) => typeof item.number === 'number');
  if (!pullRequest || typeof pullRequest.number !== 'number' || !pullRequest.url) {
    return null;
  }

  return {
    number: pullRequest.number,
    url: pullRequest.url,
    isDraft: Boolean(pullRequest.isDraft),
    assignees: (pullRequest.assignees ?? [])
      .map((assignee) => assignee.login?.trim().toLowerCase() || '')
      .filter(Boolean),
  };
}

async function runTurn(thread: Thread, prompt: string, signal: AbortSignal, branchName: string): Promise<TurnResult> {
  const { events } = await thread.runStreamed(prompt, { signal });
  const items: ThreadItem[] = [];
  let finalResponse = '';
  let usage: unknown = null;
  let failureMessage: string | null = null;

  for await (const event of events) {
    if (event.type === 'item.completed') {
      items.push(event.item);

      if (event.item.type === 'agent_message') {
        finalResponse = event.item.text;
      }
    } else if (event.type === 'turn.completed') {
      usage = event.usage;
    } else if (event.type === 'turn.failed') {
      failureMessage = event.error.message;
      break;
    } else if (event.type === 'error') {
      failureMessage = event.message;
      break;
    }
  }

  if (failureMessage) {
    throw new AgentTurnError(failureMessage, branchName, thread.id, summarizeFailureContext(items));
  }

  return { items, finalResponse, usage };
}

function summarizeFailureContext(items: ThreadItem[]) {
  const failedCommands = items
    .flatMap((item) => {
      if (item.type !== 'command_execution') {
        return [];
      }

      if (item.status !== 'failed' && item.exit_code === 0) {
        return [];
      }

      const output = item.aggregated_output.trim();
      return [[`$ ${item.command}`, output ? trimForPrompt(output, 1200) : '(no output)'].join('\n')];
    })
    .slice(-2);

  const errorItems = items
    .flatMap((item) => (item.type === 'error' ? [trimForPrompt(item.message, 600)] : []))
    .slice(-2);

  const segments = [...failedCommands, ...errorItems];
  return segments.length > 0 ? segments.join('\n\n') : null;
}

function trimForPrompt(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 14)}\n...[truncated]`;
}

function shellEscape(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
