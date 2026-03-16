import { describe, expect, test } from 'bun:test';
import { buildContinuationPrompt, buildInitialPrompt } from '../../src/core/prompt-builder';
import type { AgentContext, GitHubIssue, RepoTarget } from '../../src/core/types';

describe('buildInitialPrompt', () => {
  test('includes runtime rules and issue body on the first turn', () => {
    const prompt = buildInitialPrompt({
      target,
      issue,
      context,
      branchName: '42-orbit-pilot',
      mergeConflictContext: null,
      runtimeRulesText: 'runtime rules',
      handoffRequirements: null,
    });

    expect(prompt).toContain('Runtime rules:');
    expect(prompt).toContain('runtime rules');
    expect(prompt).toContain('Issue body:');
    expect(prompt).not.toContain('Run reason:');
  });
});

describe('buildContinuationPrompt', () => {
  test('uses short continuation guidance and includes remaining handoff work', () => {
    const prompt = buildContinuationPrompt({
      target,
      issue,
      context: {
        ...context,
        continuationContext: 'GitHub review feedback for PR #10:\nPlease fix the failing test.',
      },
      branchName: '42-orbit-pilot',
      mergeConflictContext: 'merge conflict',
      runtimeRulesText: 'runtime rules',
      handoffRequirements: 'There is still no open pull request for this branch.',
    });

    expect(prompt).toContain('Continuation guidance:');
    expect(prompt).not.toContain('Runtime rules:');
    expect(prompt).toContain('The previous turn completed, but the task is not finished yet.');
    expect(prompt).toContain('Additional context:');
    expect(prompt).toContain('Merge conflict context:');
    expect(prompt).toContain('Remaining handoff work:');
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
  continuationContext: null,
};
