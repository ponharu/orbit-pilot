import type { AgentContext, GitHubIssue, RepoTarget } from './types';

type PromptInput = {
  target: RepoTarget;
  issue: GitHubIssue;
  context: AgentContext;
  branchName: string;
  mergeConflictContext: string | null;
  runtimeRulesText: string;
  handoffRequirements: string | null;
};

export function buildInitialPrompt(input: PromptInput) {
  const sections = [
    'Runtime rules:',
    input.runtimeRulesText,
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
    '- The runtime rules and original task are already present in this thread, so do not restate them.',
    '- Resume from the current workspace state and focus only on the remaining work.',
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
    sections.push('', 'Additional context:', context.continuationContext);
  }

  if (mergeConflictContext) {
    sections.push('', 'Merge conflict context:', mergeConflictContext);
  }

  if (handoffRequirements) {
    sections.push('', 'Remaining handoff work:', handoffRequirements);
  }
}
