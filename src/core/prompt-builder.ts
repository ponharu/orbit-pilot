import type { AgentContext, GitHubIssue, RepoTarget } from './types';

type PromptInput = {
  target: RepoTarget;
  issue: GitHubIssue;
  context: AgentContext;
  branchName: string;
  mergeConflictContext: string | null;
  handoffRequirements: string | null;
};

export function buildRuntimeRulesPrompt(runtimeRulesText: string) {
  return [
    'Runtime rules:',
    runtimeRulesText,
    '',
    'If you understand and will follow these runtime rules in this thread, reply with exactly `yes`.',
  ].join('\n');
}

export function buildIssuePrompt(input: PromptInput) {
  const sections = [
    'Task:',
    '- The runtime rules for this thread are already established.',
    '- Implement this issue while following those runtime rules.',
    '',
    'Execution context:',
    `Repository: ${input.target.fullName}`,
    `Issue #${input.issue.number}: ${input.issue.title}`,
    `URL: ${input.issue.htmlUrl}`,
    `Branch: ${input.branchName}`,
    '',
    input.issue.body.trim() ? 'Issue body:' : 'Issue body: (empty)',
    input.issue.body.trim() || '(empty)',
  ];

  appendContextSections(sections, input.context, input.mergeConflictContext, input.handoffRequirements);
  return sections.join('\n');
}

export function buildContinuationPrompt(input: PromptInput) {
  const sections = [
    'Continuation guidance:',
    '',
    `- Continue issue #${input.issue.number} in ${input.target.fullName}.`,
    `- Work on branch ${input.branchName}.`,
    '- The previous turn completed, but the task is not finished yet.',
    '- The runtime rules and original task are already present in this thread.',
    '- Resume from the current workspace state and continue only the remaining work.',
  ];

  appendContextSections(sections, input.context, input.mergeConflictContext, input.handoffRequirements);
  return sections.join('\n');
}

function appendContextSections(
  sections: string[],
  context: AgentContext,
  mergeConflictContext: string | null,
  handoffRequirements: string | null,
) {
  if (context.continuationContext) {
    sections.push(
      '',
      'Additional context:',
      context.continuationContext,
      '',
      'Continue the remaining work while following the runtime rules already established in this thread.',
    );
  }

  if (mergeConflictContext) {
    sections.push('', 'Merge conflict context:', mergeConflictContext);
  }

  if (handoffRequirements) {
    sections.push('', 'Remaining handoff work:', handoffRequirements);
  }
}
