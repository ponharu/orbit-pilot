import type { AgentContext, GitHubIssue, RepoTarget } from './types';

type PromptInput = {
  target: RepoTarget;
  issue: GitHubIssue;
  context: AgentContext;
  branchName: string;
  mergeConflictContext: string | null;
  initialRun: boolean;
  runtimeRulesText: string;
};

export function buildAgentPrompt(input: PromptInput) {
  if (input.initialRun) {
    return buildInitialPrompt(input);
  }

  return buildContinuationPrompt(input);
}

function buildInitialPrompt({
  target,
  issue,
  context,
  branchName,
  mergeConflictContext,
  runtimeRulesText,
}: PromptInput) {
  const sections = [
    'Runtime rules:',
    runtimeRulesText,
    '',
    'Execution context:',
    `Repository: ${target.fullName}`,
    `Issue #${issue.number}: ${issue.title}`,
    `URL: ${issue.htmlUrl}`,
    `Branch: ${branchName}`,
    `State: ${context.state}`,
    '',
    issue.body.trim() ? 'Issue body:' : 'Issue body: (empty)',
    issue.body.trim() || '(empty)',
  ];

  appendContextSections(sections, context, mergeConflictContext);
  return sections.join('\n');
}

function buildContinuationPrompt({ target, issue, context, branchName, mergeConflictContext }: PromptInput) {
  const sections = [
    'Continuation guidance:',
    '',
    `- Continue issue #${issue.number} in ${target.fullName}.`,
    `- Work on branch ${branchName}.`,
    `- Current state is ${context.state}.`,
    '- The runtime rules and original task are already present in this thread, so do not restate them.',
    '- Resume from the current workspace state.',
    '- Focus on the remaining work only.',
    '- GitHub updates remain your responsibility in this thread.',
  ];

  appendContextSections(sections, context, mergeConflictContext);
  return sections.join('\n');
}

function appendContextSections(sections: string[], context: AgentContext, mergeConflictContext: string | null) {
  if (context.reviewFeedback) {
    sections.push('', 'Review feedback:', context.reviewFeedback);
  }

  if (context.ciFailures) {
    sections.push('', 'CI failures:', context.ciFailures);
  }

  if (context.failureContext) {
    sections.push('', 'Failure context:', context.failureContext);
  }

  if (mergeConflictContext) {
    sections.push('', 'Merge conflict context:', mergeConflictContext);
  }
}
