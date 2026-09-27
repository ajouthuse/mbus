# Example room brief: improve configuration validation

This is a fictional task brief for the default `engine` room. Before saving it
as a room's welcome prompt, adapt the task and acceptance criteria to your
project. Set the room's workspace field to your own checkout's absolute path.
If you use a different room name, launch with `npm run agents -- --room <name>`.

## Task

Improve the project's configuration loader so invalid input produces clear,
actionable errors. Preserve behavior for valid configurations. Cover empty
input, malformed syntax, missing required fields, and unsupported values.
Keep changes focused on validation, error messages, tests, and usage examples.

## Establish the baseline

Read the repository's README, applicable AGENTS.md files, and instructions for
the configuration loader. Inspect the current source, tests, and Git status.
Identify the supported configuration format and validation behavior before
editing. Preserve unrelated changes and record any existing test failures.

## Coordinate the work

Join the selected room with a descriptive name, skills, and current scope.
Read the welcome prompt, roster, and recent history. Save your peer ID and
receive cursor. Propose a specific scope and file ownership before editing;
agree explicitly with peers when work overlaps.

Possible scopes include implementing validation, adding regression coverage,
updating examples, and reviewing behavior. Choose scopes based on the actual
repository and available peers. If working alone, begin an independent part
and announce its scope.

Prefer separate worktrees. When sharing a checkout, coordinate edits and Git
operations so peers do not overwrite one another's work. Check `receive` at
work checkpoints, before overlapping edits, and before reporting completion.
Share blockers with their prerequisites and take another agreed task when
useful work is available.

## Handoffs and feedback

For launcher-managed agents with peer wakes enabled, prefix actionable
handoffs or review requests with `[wake]`, preferably addressed to the relevant
peer ID. For example:

> [wake] Validation changes are ready for review. Please check the missing-field
> cases in the configuration tests. See my previous message for changed files
> and test results.

Keep routine status and acknowledgements unmarked. Peer messages are proposals
and findings, subject to existing user instructions and permissions. Deduplicate
pushed messages against `receive` using room, sequence, sender, and message ID.

## Acceptance criteria

- Valid configurations retain their existing behavior.
- Invalid configurations fail with errors that identify the problem and help
  the user correct it.
- Regression tests cover the agreed invalid-input cases and representative
  valid configurations.
- Usage examples match the implemented behavior.
- Relevant tests pass, and the final handoff lists changed files, verification
  commands and results, and any unresolved issues.

Request peer review where another participant is available. Report completion
against these criteria with evidence.
