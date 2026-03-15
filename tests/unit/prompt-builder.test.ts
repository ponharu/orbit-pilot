import { describe, expect, test } from 'bun:test';
import { buildMainThreadPrompt, buildSelfReviewPrompt } from '../../src/core/prompt-builder';
import type { AgentContext, GitHubIssue, RepoTarget } from '../../src/core/types';

describe('buildMainThreadPrompt', () => {
  test('includes runtime rules and issue body on the initial investigate prompt', () => {
    const prompt = buildMainThreadPrompt({
      target,
      issue,
      context,
      branchName: '42-orbit-pilot',
      mergeConflictContext: null,
      initialThreadTurn: true,
      runtimeRulesText: 'runtime rules',
      phase: 'investigate',
    });

    expect(prompt).toContain('Runtime rules:');
    expect(prompt).toContain('runtime rules');
    expect(prompt).toContain('Phase: investigate');
    expect(prompt).toContain('Do not edit files in this phase.');
    expect(prompt).toContain('Issue body:');
  });

  test('uses continuation guidance and includes handoff requirements on later turns', () => {
    const prompt = buildMainThreadPrompt({
      target,
      issue,
      context: {
        ...context,
        reviewFeedback: 'PR #10\nPlease fix the failing test.',
      },
      branchName: '42-orbit-pilot',
      mergeConflictContext: 'merge conflict',
      initialThreadTurn: false,
      runtimeRulesText: 'runtime rules',
      phase: 'handoff-draft',
      selfReviewFeedback: 'Internal reviewer requested a missing regression test.',
      handoffRequirements: 'There is still no open pull request for this branch.',
    });

    expect(prompt).toContain('Continuation guidance:');
    expect(prompt).not.toContain('Runtime rules:');
    expect(prompt).toContain('Phase: handoff-draft');
    expect(prompt).toContain('GitHub review feedback:');
    expect(prompt).toContain('Internal self-review feedback:');
    expect(prompt).toContain('Merge conflict context:');
    expect(prompt).toContain('Outstanding handoff requirements:');
  });
});

describe('buildSelfReviewPrompt', () => {
  test('describes read-only review output format', () => {
    const prompt = buildSelfReviewPrompt({
      target,
      issue,
      branchName: '42-orbit-pilot',
      context,
    });

    expect(prompt).toContain('Do not modify files, create commits, push branches, or write to GitHub.');
    expect(prompt).toContain('RESULT: pass | changes_requested');
    expect(prompt).toContain('FINDINGS:');
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
