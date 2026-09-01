# Convergence And Escalation Policy

## Round Semantics

A round counts only when the Implementer received a valid task, produced a non-empty implementation artifact, and the Reviewer produced a valid verdict. Pane startup failures, missing artifacts, transport failures, repository/environment failures, and coordinator mistakes do not consume an implementation round; record them as workflow incidents in `RUN.md`.

## Tiered Review Scope Policy

Review adopts a tiered strategy to balance thoroughness and efficiency:

### Round 01: Full Acceptance Review
The initial reviewer performs a comprehensive scan against `REQUIREMENTS.md` and `PLAN.md`:
- all acceptance criteria;
- non-goals and compatibility requirements;
- current plan;
- complete diff from the frozen base;
- implementation/test artifacts;
- targeted, package-level, and integration test runs.
This establishes the authoritative finding baseline.

### Round 02+ (Remediation Rounds): Diff-Scoped + Mutation Review
Remediation reviewers perform a focused two-tier review:
1. **Finding Closure Verification**: strictly check each finding in `REMEDIATION.md` against its code fix and tests. Enforce mutation-sensitivity: reject reflection-only tests on private helpers that bypass caller chains, and reject stub mocks that return identical objects regardless of query parameters.
2. **Git Diff Review**: perform a deep logic review of the current round's incremental diff (`git diff <prior-round-commit> HEAD`). Actively look for secondary bugs, broken contracts, or regressions introduced during the fix. Do not re-read the entire unaffected codebase from scratch.
3. **Regression Verification**: confirm the test suite passes and clean worktree status.
4. **Closure Matrix & Verdict**: update prior finding closure statuses (`VERIFIED_CLOSED`, `OPEN`, `REOPENED`). Issue `PASS` if all prior findings are closed and the round's diff introduces no new blocking findings.

This prevents both failure modes: it catches regressions and new bugs in the diff, while avoiding 40+ minute full rescans of untouched code.

## Finding Classification

Every blocking finding must be classified in `REVIEW.md`:

- `implementation_bug`: the plan explicitly covered the behavior and the code is wrong or incomplete;
- `test_gap`: behavior may be implemented, but required evidence is missing;
- `plan_gap`: the plan omitted a requirement, edge case, boundary, or invariant that is required by the user contract;
- `architecture_gap`: the plan requires an operation unsupported by the selected repository/service boundary;
- `workflow_gap`: pane, artifact, state, or handoff failure rather than product code;
- `environment_failure`: toolchain, service, network, or pre-existing baseline failure.

The Reviewer must cite the requirement/plan section and source evidence for the classification.

## Routing Rules

### Implementation bug or test gap

Start the next numbered implementation round in a new Implementer pane/session only after:

- the finding is registered with a stable ID and family;
- `rounds/NN/REMEDIATION.md` maps every open/reopened finding to files, symbols, tests, and expected evidence;
- the scope delta is within the active plan;
- the same family has not already remained blocking across two reviews.

Use the current plan. The next Implementer model remains the resolved configuration value unless the user explicitly supplies a per-round model/thinking override. Record the source and reason in the round metadata.

### Plan gap, architecture gap, or repeated finding

Do not blindly send the issue to another Implementer. First start a new independent Codex Plan Revision session. It writes `PLAN-REVISION-N.md`, updates the acceptance/technical boundary, and ends with `WORKFLOW_VERDICT: PLAN_REVISION_READY`. Then stop at `ARCHITECTURE_GATE` if the revision introduces a new transaction, lock, recovery, cache, or cross-subsystem boundary; require explicit scope approval before implementation.

A finding is `repeated_finding` when the same invariant remains blocking after one attempted fix, or when two reviewers independently identify equivalent failures. A related finding in the same `family` is not a clean slate: it increments the family attempt count and must be shown in the closure matrix.

### Scope or architecture expansion

Pause instead of starting another implementation round when any of these occurs:

- the task changes from a local feature to a transaction/rollback/recovery protocol;
- a new subsystem or resource family is added that was absent from the active plan;
- changed production files grow by more than 50% over the plan estimate;
- a round adds more than 25 files or 1,000 production lines outside the original acceptance matrix;
- the fix requires proving all-or-nothing state across multiple repository boundaries.

Write `SCOPE-DELTA.md`, classify the change, and enter `ARCHITECTURE_GATE`. The available decisions are: split into a new task, implement a real UoW/transaction first, narrow the acceptance criteria, explicitly accept a residual risk, or pause.

### Workflow or environment failure

Do not increase the model tier or count the implementation round. Repair the workflow/environment, record the incident, and resume only after the required artifact and identity checks pass.

## Model Escalation

Automatic model escalation is disabled by default. Continue using the resolved `active_profile` Implementer across implementation rounds unless the user explicitly supplies a per-round model/thinking override or selects a different profile for a new run.

- rounds 1-3: use the resolved run configuration;
- when blocking findings are plan/architecture/repeated, require Plan Revision before implementation; this does **not** imply a stronger Implementer model;
- when implementation bugs repeat, present evidence, estimated scope, and the configured profiles, then ask the user whether to keep the resolved model, split the task, or approve a different model/profile;
- round 4: use `hard_stop_round`; generate `ESCALATION.md` and ask the user whether to revise scope, keep the resolved model for another explicitly approved round, accept residual risk, or manually authorize another profile.

Never select `strong-implementation`, `maximum-quality`, DeepSeek V4 Pro, Terra, or any other higher-cost route merely because a round threshold was reached. Model changes require explicit user approval and are recorded in the round metadata.

## Pause Is A Hard Gate

When `state.json.status` is `PAUSED_BY_USER`, no Coordinator, monitor, or resumed child may create an agent, send a prompt, change state, push, start CI, or modify the worktree. Resume requires a new explicit user instruction. Every transition must re-read state and verify schema, branch, HEAD, and worktree identity. Long `sleep` calls are forbidden for orchestration; use bounded `herdr agent wait` and re-check the state after wake-up. Legacy schema runs must not auto-resume or pass completion under schema v4 without explicit migration.


After `PLAN_READY` or `PLAN_REVISION_READY`:

1. calculate SHA-256 for the plan and active requirements;
2. store both hashes in `state.json`, `RUN.md`, and round metadata;
3. before review and deployment, verify the files are unchanged;
4. if either hash changes, invalidate the current review and deployment approval, create a new plan revision, and start a new implementation round.

## Escalation Artifact

At the hard stop create `ESCALATION.md` containing:

- run and branch identifiers;
- completed rounds and exact model settings;
- each round's blocking findings and classification;
- repeated findings and why they did not converge;
- whether the root cause is implementation, plan, architecture, test, workflow, or environment;
- available choices and a recommended next action;
- explicit statement that no deployment approval is valid.
