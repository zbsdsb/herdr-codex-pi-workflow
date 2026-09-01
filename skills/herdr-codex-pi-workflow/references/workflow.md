# Workflow State Machine

## States

```text
NEW
  -> PREFLIGHTING
  -> GRILL_ME (mandatory when requirements contain ambiguity)
  -> REQUIREMENTS_READY
       -> IMPLEMENTING (quick-code: compact frozen plan, no Planner pane)
       -> PLANNING (standard / release)
  -> PLAN_READY
  -> AWAITING_PLAN_APPROVAL (mandatory user review before code writing)
  -> IMPLEMENTING
  -> SELF_CHECKING
  -> REVIEWING
  -> FINDING_TRIAGE
       -> IMPLEMENTING
       -> PLAN_REVISION
       -> SOL_ADVISORY
       -> ARCHITECTURE_GATE
       -> VALIDATED
  -> AWAITING_DEPLOY_APPROVAL
  -> DEPLOYING
       -> DELIVERY_GATE (quick-code after VALIDATED; standard after DEPLOYING when approved push evidence is sufficient)
       -> VERIFYING (release)
            -> DEPLOYMENT_FAILED
            -> FINAL_AUDITING
                 -> VERIFYING (verification remediation)
                 -> DELIVERY_GATE
                      -> COMPLETE

Any active state -> PAUSED_BY_USER only by explicit user action. `PAUSED_BY_USER` has no automatic outgoing transition; only a new explicit resume instruction may continue after reconciliation. All mutating commands are serialized by the run lock and increment `state_revision`.
```

## Transition Rules

### NEW -> PREFLIGHTING

Optional but recommended when the request involves non-trivial repository facts:

- Coordinator executes `codegraph sync` in project root (or `codegraph init` if not yet initialized) so Preflight and Planner query the latest code graph;
- a new read-only Preflight pane/session exists (only `read`, `grep`, `find`, `ls`, `codegraph`);
- the unchanged original request and repository root were passed to it;
- `PREFLIGHT.md` has the verdict `PREFLIGHT_READY`, or the preflight is recorded as failed.

Preflight is skipped for extension commands, slash commands, steering messages, empty input, and image-bearing requests. A failed preflight does not block: continue to `REQUIREMENTS_READY` from the original request.

### PREFLIGHTING -> GRILL_ME -> REQUIREMENTS_READY

Required:

- when user request leaves semantics, scope, dual-end alignment, or acceptance criteria unresolved, execute `grill-me` with the user before finalizing requirements;
- the Preflight pane is closed and its metadata recorded;
- the original request is restated in `REQUIREMENTS.md` as authoritative;
- acceptance criteria, non-goals, target repository/base branch, and deployment expectation are written;
- the brief (when present) is incorporated as advisory context, never replacing the original request;
- run directory and `state.json` created.

### REQUIREMENTS_READY -> PLANNING / IMPLEMENTING

- `standard` and `release`: start a native Codex Planner in a read-only pane, send the planner prompt, and persist its identity.
- `quick-code`: Coordinator writes a compact `PLAN.md` change contract with scope, symbols, tests, non-goals, and acceptance mapping; run `freeze`, then `round` creates Round 01 directly. No Planner pane or plan-approval wait.

### PLANNING -> PLAN_READY

Required:

- Planner is settled, not `blocked` or `unknown`;
- `PLAN.md` exists and is non-empty;
- artifact footer is `WORKFLOW_VERDICT: PLAN_READY`;
- plan covers affected modules, tests, risks, migration/configuration, and acceptance checks.

### PLAN_READY -> AWAITING_PLAN_APPROVAL

Mandatory plan review gate before any code writing:

- Coordinator presents an executive summary of `PLAN.md` (affected modules, sequence, testing approach, acceptance mapping) to the user;
- Coordinator triggers `workflow_notify.py` (Telegram Bot + desktop banner) alerting the user to review the plan;
- User explicitly approves -> transitions to `IMPLEMENTING` (Round 01);
- User requests plan adjustments during the approval gate -> keep the standby Planner and revise `PLAN.md` in that warm session; material changes discovered after implementation starts use a new `PLAN_REVISION` session;
- User pauses -> `PAUSED_BY_USER`.

### AWAITING_PLAN_APPROVAL -> IMPLEMENTING

Required:

- user explicitly approved the active plan;
- create or reuse the run-owned implementation worktree;
- resolve round number `01`;
- start a **new** Pi pane/session with the configured Implementer model and thinking;
- send requirements, active plan, prior review when present, repository rules, and mutation-sensitive testing standard.

### IMPLEMENTING -> SELF_CHECKING

Required:

- `rounds/NN/IMPLEMENTATION.md` exists;
- implementation footer is `WORKFLOW_VERDICT: IMPLEMENTED`;
- report lists changed files, commands/results, deviations, and remaining risks.

Do not send follow-up implementation work to the same pane. If evidence is incomplete, mark the round incomplete, record and close the settled pane when safe, then start a new numbered implementation round with a new Pi session.

### SELF_CHECKING -> REVIEWING

Required:

- implementation worktree status recorded;
- current HEAD and diff fingerprint recorded;
- `rounds/NN/TEST-RESULTS.md` exists with actual commands and exit results;
- no unrelated modifications are knowingly included;
- Coordinator executes `codegraph sync` so modified/new classes and call relationships are indexed for the Reviewer;
- Implementer session/pane metadata is persisted, then its settled pane is closed.

Start a brand-new native Codex Reviewer in a new pane/session for round `NN`. Review mode follows the tiered strategy (Round 01: full acceptance review; Round 02+: diff-scoped + mutation review).

### REVIEWING -> FINDING_TRIAGE

When `rounds/NN/REVIEW.md` is valid, first update `FINDINGS.json`, `FINDING-TRACEABILITY.md`, and `SCOPE-DELTA.md`. Do not create the next Implementer directly from the Reviewer verdict.

### FINDING_TRIAGE -> IMPLEMENTING

Allowed only when all blocking findings are `implementation_bug` or `test_gap`, the remediation report exists, the finding family has not hit the repeated-finding gate, and scope remains within the active plan.

### FINDING_TRIAGE -> PLAN_REVISION

Required for `plan_gap`, `architecture_gap`, or a reopened finding family. Start a new independent Codex Plan Revision and do not reuse the prior Planner session.

### FINDING_TRIAGE -> SOL_ADVISORY

Optional before an `ARCHITECTURE_GATE` or the hard-stop escalation when a concrete high-risk decision remains and the Coordinator chooses to consult a high-capability model first:

- start a new read-only Sol pane/session with the configured Sol model;
- send one precise question, its risk class, and compact evidence;
- write `SOL-ADVISORY.md` with verdict `SOL_ADVISORY`;
- the advisory is input to the gate decision, never an authorization.

### SOL_ADVISORY -> ARCHITECTURE_GATE

- Sol pane is closed and metadata recorded;
- the advisory (when present) is included in the decision packet shown to the user.

### FINDING_TRIAGE -> ARCHITECTURE_GATE

Required for repeated findings, new transaction/lock/recovery/cache boundaries, or scope expansion.
- Coordinator presents the decision packet to the user;
- Coordinator triggers `workflow_notify.py` (Telegram Bot + desktop banner);
- Stop and wait for explicit scope/architecture decision.

### FINDING_TRIAGE -> VALIDATED

Required:

- review footer is `WORKFLOW_VERDICT: PASS`;
- zero blocking findings;
- every acceptance criterion is `PASS`, not `NOT_EVIDENCED`;
- every finding in `FINDINGS.json` is `VERIFIED_CLOSED`, deferred by explicit user decision, or outside the active scope with a recorded decision;
- no scope or architecture gate is open;
- `reviewed_commit` equals implementation worktree HEAD;
- worktree clean at the reviewed commit;
- requirements and active plan hashes match the frozen values;
- required tests passed or skipped tests are explicitly accepted by the user;
- Reviewer session/pane metadata is persisted, then its settled pane is closed.

### PAUSED_BY_USER

This state is a hard stop. The Coordinator must interrupt every workflow-created active agent, verify no target agent remains `working`, preserve the current worktree and artifacts, and wait. A stale Coordinator or monitor must not auto-resume it.

### HARD_STOP / ESCALATED

When the configured `hard_stop_round` is reached without a valid PASS:

- do not create another implementation or deployment session automatically;
- write `ESCALATION.md` using `references/convergence.md`;
- set state to `ESCALATED` and update `tasks/index.json`;
- trigger `workflow_notify.py` alerting the user to decide;
- ask the user to choose scope revision, architecture revision, maximum-quality profile, residual-risk acceptance, or pause.

### VALIDATED -> AWAITING_DEPLOY_APPROVAL

Show the user:

- reviewed commit;
- branch;
- review verdict;
- tests run;
- proposed deployment operations;
- rollback target and residual risks.

Coordinator triggers `workflow_notify.py` (Telegram Bot + desktop banner) for deploy approval. Do not infer approval from earlier requests to implement, push, or generally deploy. Ask for explicit approval of the exact commit and operations.

### AWAITING_DEPLOY_APPROVAL -> DEPLOYING

Required:

- user explicitly approved the exact commit;
- `HEAD == reviewed_commit == approved_commit`;
- worktree clean;
- release configuration unchanged since review.

### DEPLOYING -> VERIFYING

Record each command/remote workflow and result in `DEPLOYMENT.md`. If any external effect is ambiguous, stop and report uncertainty; do not repeat potentially non-idempotent actions blindly.

### VERIFYING -> FINAL_AUDITING -> DELIVERY_GATE

`release` mode requires `VERIFICATION.md: VERIFIED`, then a fresh Auditor produces `FINAL-AUDIT.md: AUDITED_PASS`. `quick-code` may move from `VALIDATED` directly to `DELIVERY_GATE` after reviewed commit push evidence; `standard` may move from `DEPLOYING` to `DELIVERY_GATE` after its approved push/deployment record is complete.

### DELIVERY_GATE -> COMPLETE

Run `verify-delivery-gate`, then `transition --to COMPLETE`. Required:

- latest independent Review is PASS and its acceptance matrix contains no FAIL/NOT_EVIDENCED;
- all findings are independently closed or explicitly accepted/deferred by the user;
- every repository's remote branch resolves to the reviewed and approved commit (quick-code: reviewed commit);
- requirements and active-plan hashes are unchanged;
- every round artifact and metadata file is non-empty;
- standard/release `DEPLOYMENT.md` ends with `DEPLOYED`; quick-code does not require deployment evidence;
- release mode has `VERIFICATION.md: VERIFIED` and `FINAL-AUDIT.md: AUDITED_PASS`;
- `DELIVERY-MANIFEST.json` points to the exact docs directory and binds every interface scenario to a real Bruno file, PASS result file, and matching SHA-256;
- delivery files contain no scaffold placeholders;
- completion notification receives explicit `--run <run-dir>`.

The transition command updates state, event history, index, and navigation atomically, then enqueues the applicable user-gate notification using the resulting state-entry revision. A failed gate leaves the run in its current state. Notification delivery is an outbox side effect and does not roll back a committed transition; `notify-pending` retries failed channels idempotently. Worktree cleanup happens only after remote commit verification succeeds and a canonical recovery/cleanup decision is recorded.

## Pausing and Recovery

New runs use state schema version 4 and follow `state-and-gates.md`. `state.json` is authoritative; `events.jsonl` records transitions; `RUN.md`, navigation, goals, and the task index are projections repaired by `reconcile`.

On recovery, first run `audit` and `reconcile`. Verify saved pane/session IDs, prompt/checkpoint metadata, repository worktrees, branches, artifacts, hashes, Git SHAs, and notification outbox entries. Resume transport/environment failures from the existing worktree and artifact checkpoint; they do not create a new round. Missing panes never imply completion. A missing or failed notification may be retried, but recovery, landing, cleanup, architecture, escalation, and deployment decisions still require the matching explicit user decision.
