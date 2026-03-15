import { describe, expect, test } from 'bun:test';
import { buildAgentPrompt } from '../../src/core/prompt-builder';
import type { AgentContext, GitHubIssue, RepoTarget } from '../../src/core/types';

describe('buildAgentPrompt', () => {
  test('includes runtime rules on the initial prompt', () => {
    const prompt = buildAgentPrompt({
      target,
      issue,
      context,
      branchName: '42-orbit-pilot',
      mergeConflictContext: null,
      initialRun: true,
      runtimeRulesText: 'runtime rules',
    });

    expect(prompt).toContain('Runtime rules:');
    expect(prompt).toContain('runtime rules');
    expect(prompt).toContain('Issue body:');
  });

  test('uses continuation guidance without restating runtime rules on resumed turns', () => {
    const prompt = buildAgentPrompt({
      target,
      issue,
      context: {
        ...context,
        reviewFeedback: 'PR #10\nPlease fix the failing test.',
      },
      branchName: '42-orbit-pilot',
      mergeConflictContext: 'merge conflict',
      initialRun: false,
      runtimeRulesText: 'runtime rules',
    });

    expect(prompt).toContain('Continuation guidance:');
    expect(prompt).not.toContain('Runtime rules:');
    expect(prompt).toContain('The runtime rules and original task are already present in this thread');
    expect(prompt).toContain('Review feedback:');
    expect(prompt).toContain('Merge conflict context:');
  });
});

const target: RepoTarget = {
  owner: 'acme',
  repo: 'widget',
  fullName: 'acme/widget',
  defaultBranch: 'main',
};

const issue: GitHubIssue = {
  number: 42,
  identifier: 'acme/widget#42',
  title: 'Test issue',
  body: 'Implement the feature.',
  state: 'open',
  assignees: [],
  htmlUrl: 'https://github.com/acme/widget/issues/42',
  createdAt: '2026-03-15T00:00:00Z',
  updatedAt: '2026-03-15T00:00:00Z',
  isPullRequest: false,
};

const context: AgentContext = {
  state: 'implement',
  reviewFeedback: null,
  ciFailures: null,
  failureContext: null,
};
