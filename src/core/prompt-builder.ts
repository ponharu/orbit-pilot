import type { AgentContext, GitHubIssue, RepoTarget } from './types';

export type MainThreadPhase = 'investigate' | 'diagnose' | 'implement' | 'fix' | 'handoff-draft' | 'handoff-update';

type MainThreadPromptInput = {
  target: RepoTarget;
  issue: GitHubIssue;
  context: AgentContext;
  branchName: string;
  mergeConflictContext: string | null;
  initialThreadTurn: boolean;
  runtimeRulesText: string;
  phase: MainThreadPhase;
  selfReviewFeedback?: string | null;
  handoffRequirements?: string | null;
};

type ReviewPromptInput = {
  target: RepoTarget;
  issue: GitHubIssue;
  branchName: string;
  context: AgentContext;
};

export function buildMainThreadPrompt(input: MainThreadPromptInput) {
  const sections: string[] = [];

  if (input.initialThreadTurn) {
    sections.push('Runtime rules:', input.runtimeRulesText, '');
  } else {
    sections.push('Continuation guidance:', '');
    sections.push(
      '- Continue from the current workspace and thread state.',
      '- The runtime rules and original task are already present in this thread, so do not restate them.',
      '- Focus only on the current phase.',
      '',
    );
  }

  sections.push(
    'Execution context:',
    `Repository: ${input.target.fullName}`,
    `Issue #${input.issue.number}: ${input.issue.title}`,
    `URL: ${input.issue.htmlUrl}`,
    `Branch: ${input.branchName}`,
    `State: ${input.context.state}`,
    `Phase: ${input.phase}`,
  );

  if (input.initialThreadTurn) {
    sections.push(
      '',
      input.issue.body.trim() ? 'Issue body:' : 'Issue body: (empty)',
      input.issue.body.trim() || '(empty)',
    );
  }

  sections.push('', 'Phase instructions:', phaseInstructions(input.phase));
  appendContextSections(
    sections,
    input.context,
    input.mergeConflictContext,
    input.selfReviewFeedback,
    input.handoffRequirements,
  );
  return sections.join('\n');
}

export function buildSelfReviewPrompt(input: ReviewPromptInput) {
  const sections = [
    'You are acting as a strict internal reviewer for the current workspace state.',
    '',
    'Rules:',
    '- Do not modify files, create commits, push branches, or write to GitHub.',
    '- Review the current workspace as it exists right now.',
    '- Focus on correctness, regressions, missing validation, and incomplete handoff work.',
    '- Ignore stylistic nits unless they block a safe merge.',
    '',
    'Execution context:',
    `Repository: ${input.target.fullName}`,
    `Issue #${input.issue.number}: ${input.issue.title}`,
    `Branch: ${input.branchName}`,
    `State: ${input.context.state}`,
    '',
    'Output format:',
    'RESULT: pass | changes_requested',
    'SUMMARY: one sentence',
    'FINDINGS:',
    '- one finding per line, or',
    '- none',
  ];

  appendContextSections(sections, input.context, null, null, null);
  return sections.join('\n');
}

function phaseInstructions(phase: MainThreadPhase) {
  switch (phase) {
    case 'investigate':
      return [
        '- Inspect the repository and the issue requirements.',
        '- Do not edit files in this phase.',
        '- Identify the relevant code paths, risks, and a concise implementation plan.',
        '- End with the plan and the files you expect to touch.',
      ].join('\n');
    case 'diagnose':
      return [
        '- Investigate the provided review feedback, CI failures, or prior failure context.',
        '- Do not edit files in this phase.',
        '- Determine the likely root cause and the minimal fix plan.',
        '- End with the diagnosis and the files you expect to touch.',
      ].join('\n');
    case 'implement':
      return [
        '- Implement the planned change in the current workspace.',
        '- Do not commit, push, or create/update pull requests in this phase.',
        '- Run the relevant validation needed to support the change.',
        '- Leave the workspace ready for handoff.',
      ].join('\n');
    case 'fix':
      return [
        '- Apply the requested fix in the current workspace.',
        '- Do not commit, push, or create/update pull requests in this phase.',
        '- Run the relevant validation needed to support the change.',
        '- Leave the workspace ready for handoff.',
      ].join('\n');
    case 'handoff-draft':
      return [
        '- Finish the initial Git and GitHub handoff for the current workspace state.',
        '- Commit the intended changes.',
        '- Push the branch.',
        '- Create a draft pull request for this branch if one does not exist yet.',
        '- If a pull request already exists, keep it in draft while updating it as needed.',
        '- Do not leave this phase with uncommitted changes, an unpushed branch, or a missing draft pull request unless you are truly blocked.',
      ].join('\n');
    case 'handoff-update':
      return [
        '- Finish the Git and GitHub handoff for the current workspace state.',
        '- Commit the intended changes.',
        '- Push the branch.',
        '- Update the existing pull request as needed.',
        '- When this run is addressing review feedback, resolve only the review threads you actually fixed and leave comments for intentionally unaddressed feedback when useful.',
        '- Do not leave this phase with uncommitted changes, an unpushed branch, or a missing open pull request unless you are truly blocked.',
      ].join('\n');
  }
}

function appendContextSections(
  sections: string[],
  context: AgentContext,
  mergeConflictContext: string | null,
  selfReviewFeedback: string | null | undefined,
  handoffRequirements: string | null | undefined,
) {
  if (context.reviewFeedback) {
    sections.push('', 'GitHub review feedback:', context.reviewFeedback);
  }

  if (context.ciFailures) {
    sections.push('', 'CI failures:', context.ciFailures);
  }

  if (context.failureContext) {
    sections.push('', 'Failure context:', context.failureContext);
  }

  if (selfReviewFeedback) {
    sections.push('', 'Internal self-review feedback:', selfReviewFeedback);
  }

  if (mergeConflictContext) {
    sections.push('', 'Merge conflict context:', mergeConflictContext);
  }

  if (handoffRequirements) {
    sections.push('', 'Outstanding handoff requirements:', handoffRequirements);
  }
}
