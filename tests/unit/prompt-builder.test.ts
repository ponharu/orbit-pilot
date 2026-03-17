import { describe, expect, test } from 'bun:test';
import { buildContinuationPrompt, buildIssuePrompt, buildRuntimeRulesPrompt } from '../../src/core/prompt-builder';
import type { AgentContext, GitHubIssue, RepoTarget } from '../../src/core/types';

describe('buildRuntimeRulesPrompt', () => {
  test('asks for an exact yes acknowledgement', () => {
    const prompt = buildRuntimeRulesPrompt('runtime rules');

    expect(prompt).toContain('Runtime rules:');
    expect(prompt).toContain('runtime rules');
    expect(prompt).toContain('reply with exactly `yes`');
  });
});

describe('buildIssuePrompt', () => {
  test('includes the issue body after the runtime rules are established', () => {
    const prompt = buildIssuePrompt({
      target,
      issue,
      context,
      branchName: '42-orbit-pilot',
    });

    expect(prompt).toContain('Task:');
    expect(prompt).toContain('Implement this issue while following the runtime rules for this thread.');
    expect(prompt).toContain('Issue body:');
    expect(prompt).not.toContain('Runtime rules:');
  });
});

describe('buildContinuationPrompt', () => {
  test('uses short continuation guidance and includes only the remaining work', () => {
    const prompt = buildContinuationPrompt({
      target,
      issue,
      context: {
        ...context,
        continuationContext: 'GitHub review feedback for PR #10:\nPlease fix the failing test.',
      },
      branchName: '42-orbit-pilot',
    });

    expect(prompt).toContain('Task:');
    expect(prompt).not.toContain('Runtime rules:');
    expect(prompt).toContain('Continue the remaining work for issue #42');
    expect(prompt).toContain('Additional information:');
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
