import type { AgentContext, GitHubIssue, RepoTarget } from './types';

type PromptInput = {
  target: RepoTarget;
  issue: GitHubIssue;
  context: AgentContext;
  branchName: string;
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
    '- Implement this issue while following the runtime rules for this thread.',
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

  appendContextSections(sections, input.context);
  return sections.join('\n');
}

export function buildContinuationPrompt(input: PromptInput) {
  const sections = [
    'Task:',
    '',
    `- Continue the remaining work for issue #${input.issue.number} in ${input.target.fullName}.`,
    `- Use branch ${input.branchName}.`,
    '- Use the current workspace state.',
  ];

  appendContextSections(sections, input.context);
  return sections.join('\n');
}

function appendContextSections(sections: string[], context: AgentContext) {
  if (context.continuationContext) {
    sections.push('', 'Additional information:', context.continuationContext);
  }
}
