import { Codex, type Thread, type ThreadItem } from '@openai/codex-sdk';
import type { AppConfig } from '../config';
import { runShell } from '../util/shell';
import type { AgentContext, GitHubIssue, Logger, RepoTarget } from './types';
import { loadRuntimeRules } from './runtime-rules-loader';
import { buildAgentPrompt } from './prompt-builder';
import { WorkspaceManager } from './workspace-manager';

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

    const codex = new Codex();
    const threadOptions = {
      workingDirectory: workspace.path,
      model: this.config.codex.model,
      sandboxMode: this.config.codex.sandboxMode,
      approvalPolicy: this.config.codex.approvalPolicy,
      modelReasoningEffort: this.config.codex.modelReasoningEffort,
    } as const;

    const thread = existingThreadId
      ? codex.resumeThread(existingThreadId, threadOptions)
      : codex.startThread(threadOptions);

    this.logger.info('starting codex turn', {
      repo: target.fullName,
      issue: issue.identifier,
      resumed: Boolean(existingThreadId),
      runtimeRulesPath: runtimeRules.path,
    });

    let turn;
    try {
      turn = await runTurn(
        thread,
        buildAgentPrompt({
          target,
          issue,
          context,
          initialRun: !existingThreadId,
          branchName: workspace.branchName,
          mergeConflictContext: workspace.mergeConflictContext,
          runtimeRulesText: runtimeRules.text,
        }),
        signal,
        workspace.branchName,
      );
    } catch (error) {
      if (!signal.aborted) {
        await this.ensureBranchPullRequestAssignedToViewer(target, workspace.path, workspace.branchName, viewerLogin);
      }

      throw error;
    }

    await this.ensureBranchPullRequestAssignedToViewer(target, workspace.path, workspace.branchName, viewerLogin);

    this.logger.info('codex turn completed', {
      repo: target.fullName,
      issue: issue.identifier,
      usage: turn.usage ?? undefined,
      finalResponse: turn.finalResponse.slice(0, 500),
    });

    return {
      branchName: workspace.branchName,
      threadId: thread.id ?? existingThreadId,
    };
  }

  private async ensureBranchPullRequestAssignedToViewer(
    target: RepoTarget,
    workspacePath: string,
    branchName: string,
    viewerLogin: string,
  ) {
    const branchPullRequest = await findOpenPullRequestForBranch(target, workspacePath, branchName);

    if (!branchPullRequest) {
      return;
    }

    if (branchPullRequest.assignees.includes(viewerLogin)) {
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

type BranchPullRequest = {
  number: number;
  assignees: string[];
};

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
      'number,assignees',
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
    assignees?: Array<{ login?: string | null }>;
  }>;

  const pullRequest = pullRequests.find((item) => typeof item.number === 'number');
  if (!pullRequest || typeof pullRequest.number !== 'number') {
    return null;
  }

  return {
    number: pullRequest.number,
    assignees: (pullRequest.assignees ?? [])
      .map((assignee) => assignee.login?.trim().toLowerCase() || '')
      .filter(Boolean),
  };
}

async function runTurn(thread: Thread, prompt: string, signal: AbortSignal, branchName: string) {
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
