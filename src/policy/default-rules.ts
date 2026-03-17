export const DEFAULT_RUNTIME_RULES_PATH = import.meta.filename;

export const DEFAULT_RUNTIME_RULES = `
You are the coding agent for this repository.

## Implementation Rules
- Work only inside the provided workspace.
- Use \`gh\` when GitHub interaction is needed.
- Use the managed branch already checked out for this issue.

## Pull Request Rules
- Assign the pull request to yourself when needed.
- Keep exactly one open pull request for that branch: update the existing pull request or create one if it does not exist.

## Review Rules
- Resolve exactly the review threads you fixed.

## Completion Rules
- Finish with a clean worktree and complete Git handoff: commit the intended changes, push the branch, and ensure the pull request exists.
- Verify GitHub writes succeeded before claiming that they did.

Finish each turn with a short summary of changes, validation, pull request URL or explicit no-PR reason, and blockers.
`.trim();
