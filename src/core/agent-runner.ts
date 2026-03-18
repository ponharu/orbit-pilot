import { Codex, type Thread, type ThreadItem } from '@openai/codex-sdk';
import type { AppConfig } from '../config';
import type { AgentContext, GitHubIssue, Logger, RepoTarget } from './types';
import { ensureBranchPullRequestAssignedToViewer, inspectHandoff, type BranchPullRequest } from './handoff';
import { buildContinuationPrompt, buildIssuePrompt, buildRuntimeRulesPrompt } from './prompt-builder';
import { loadRuntimeRules } from './runtime-rules-loader';
import { WorkspaceManager } from './workspace-manager';

const MAX_AGENT_TURNS = 6;

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

type TurnResult = {
  finalResponse: string;
  usage: unknown;
};

type TurnLogContext = {
  logger: Logger;
  target: RepoTarget;
  issue: GitHubIssue;
  turnLabel: string;
};

type HandoffCache = {
  pullRequest?: BranchPullRequest | null;
  hasRemoteBranch?: boolean;
  assigneeEnsuredForPullRequest?: number;
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
    existingThreadId: string | null,
    existingBranchName: string | null,
  ): AgentRunHandle {
    const controller = new AbortController();

    const promise = this.execute(
      target,
      issue,
      context,
      cloneUrl,
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
    existingThreadId: string | null,
    existingBranchName: string | null,
    signal: AbortSignal,
  ) {
    const workspace = await this.workspaceManager.prepareWorkspace(target, issue, cloneUrl, existingBranchName);
    const runtimeRules = loadRuntimeRules();

    const codex = new Codex();
    const threadOptions = {
      workingDirectory: workspace.path,
      model: this.config.codex.model,
      sandboxMode: 'danger-full-access' as const,
      approvalPolicy: this.config.codex.approvalPolicy,
      modelReasoningEffort: this.config.codex.modelReasoningEffort,
    };

    const thread = existingThreadId
      ? codex.resumeThread(existingThreadId, threadOptions)
      : codex.startThread(threadOptions);

    this.logger.info('starting autonomous codex run', {
      repo: target.fullName,
      issue: issue.identifier,
      resumed: Boolean(existingThreadId),
      runtimeRulesPath: runtimeRules.path,
    });

    let handoffRequirements: string | null = null;
    let latestTurn: TurnResult | null = null;
    const handoffCache: HandoffCache = {};

    try {
      if (!existingThreadId) {
        this.logger.info('starting runtime rules acknowledgement turn', {
          repo: target.fullName,
          issue: issue.identifier,
        });

        const rulesTurn = await runTurn(
          thread,
          buildRuntimeRulesPrompt(runtimeRules.text),
          signal,
          workspace.branchName,
          {
            logger: this.logger,
            target,
            issue,
            turnLabel: 'runtime-rules',
          },
        );
        if (rulesTurn.finalResponse.trim().toLowerCase() !== 'yes') {
          throw new AgentTurnError(
            'The runtime-rules acknowledgement turn did not return exactly `yes`.',
            workspace.branchName,
            thread.id ?? existingThreadId,
            trimForPrompt(rulesTurn.finalResponse, 600),
          );
        }
      }

      for (let turnNumber = 1; turnNumber <= MAX_AGENT_TURNS; turnNumber += 1) {
        const initialTurn = turnNumber === 1 && !existingThreadId;

        this.logger.info('starting codex turn', {
          repo: target.fullName,
          issue: issue.identifier,
          turnNumber,
          initialTurn,
        });
        const turnContext = buildTurnContext(context, workspace.mergeConflictContext, handoffRequirements);

        const prompt = initialTurn
          ? buildIssuePrompt({
              target,
              issue,
              context: turnContext,
              branchName: workspace.branchName,
            })
          : buildContinuationPrompt({
              target,
              issue,
              context: turnContext,
              branchName: workspace.branchName,
            });

        latestTurn = await runTurn(thread, prompt, signal, workspace.branchName, {
          logger: this.logger,
          target,
          issue,
          turnLabel: `turn-${turnNumber}`,
        });

        const handoff = await verifyHandoff(target, workspace.path, workspace.branchName, this.logger, handoffCache);

        if (handoff.complete) {
          this.logger.info('codex run completed after handoff verification', {
            repo: target.fullName,
            issue: issue.identifier,
            usage: latestTurn.usage ?? undefined,
            finalResponse: latestTurn.finalResponse.slice(0, 500),
          });

          return {
            branchName: workspace.branchName,
            threadId: thread.id ?? existingThreadId,
          };
        }

        handoffRequirements = handoff.summary;

        this.logger.warn('handoff verification failed; continuing same thread', {
          repo: target.fullName,
          issue: issue.identifier,
          turnNumber,
          handoffRequirements: handoff.summary ?? undefined,
        });
      }

      throw new AgentTurnError(
        'Git handoff remained incomplete after the maximum number of turns.',
        workspace.branchName,
        thread.id ?? existingThreadId,
        handoffRequirements ?? latestTurn?.finalResponse ?? null,
      );
    } catch (error) {
      if (!signal.aborted) {
        await verifyHandoff(target, workspace.path, workspace.branchName, this.logger, handoffCache);
      }

      throw error;
    }
  }
}

async function runTurn(
  thread: Thread,
  prompt: string,
  signal: AbortSignal,
  branchName: string,
  logContext: TurnLogContext,
): Promise<TurnResult> {
  const { events } = await thread.runStreamed(prompt, { signal });
  const items: ThreadItem[] = [];
  let finalResponse = '';
  let usage: unknown = null;
  let failureMessage: string | null = null;

  for await (const event of events) {
    if (event.type === 'item.completed') {
      logCompletedItem(event.item, logContext);
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

  return { finalResponse, usage };
}

function logCompletedItem(item: ThreadItem, context: TurnLogContext) {
  const baseContext = {
    repo: context.target.fullName,
    issue: context.issue.identifier,
    turn: context.turnLabel,
  };

  if (item.type === 'agent_message') {
    context.logger.info('codex reasoning', {
      ...baseContext,
      text: trimForPrompt(item.text, 1000),
    });
    return;
  }

  if (item.type === 'command_execution') {
    context.logger.info('codex command', {
      ...baseContext,
      command: item.command,
      exitCode: item.exit_code,
      status: item.status,
      output: item.aggregated_output ? trimForPrompt(item.aggregated_output, 1500) : undefined,
    });
  }
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

function buildTurnContext(
  context: AgentContext,
  mergeConflictContext: string | null,
  handoffRequirements: string | null,
): AgentContext {
  const segments = [context.continuationContext, mergeConflictContext, handoffRequirements].filter(
    (value): value is string => Boolean(value && value.trim().length > 0),
  );

  return {
    continuationContext: segments.length > 0 ? segments.join('\n\n') : null,
  };
}

async function verifyHandoff(
  target: RepoTarget,
  workspacePath: string,
  branchName: string,
  logger: Logger,
  cache: HandoffCache,
) {
  const handoff = await inspectHandoff(target, workspacePath, branchName, undefined, {
    pullRequest: cache.pullRequest,
    hasRemoteBranch: cache.hasRemoteBranch,
  });
  if (handoff.pullRequest) {
    cache.pullRequest = handoff.pullRequest;
  }
  if (handoff.hasRemoteBranch) {
    cache.hasRemoteBranch = true;
  }
  if (handoff.pullRequest && cache.assigneeEnsuredForPullRequest !== handoff.pullRequest.number) {
    const ensured = await ensureBranchPullRequestAssignedToViewer(
      target,
      workspacePath,
      branchName,
      logger,
      undefined,
      handoff.pullRequest,
    );
    if (ensured) {
      cache.assigneeEnsuredForPullRequest = handoff.pullRequest.number;
    }
  }
  return handoff;
}

function trimForPrompt(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 14)}\n...[truncated]`;
}
