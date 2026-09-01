# State And Evidence Gates

## Authority

New runs use `state.json.schema_version = 4`.

- `state.json` is the machine truth.
- `events.jsonl` is the append-only transition history.
- `RUN.md`, `README.md`, pi goal state, and `tasks/index.json` are projections.
- Only `herdr-workflow.mjs transition`, `round`, `freeze`, and `record-decision` may mutate machine state or decisions.
- Every mutating command takes the run-level `.workflow.lock`, increments `state_revision`, and records an event through `.pending-mutation.json` before appending `events.jsonl`.
- `reconcile --write` repairs projections from `state.json`; it only records `last_reconcile_ok` after a successful audit and never manufactures evidence.
- Legacy runs remain read-only until an explicit migration is reviewed. Completion audit and completion notification require `schema_version = 4`; never silently upgrade them.

Use:

```bash
node ~/.herdr-codex-pi-workflow/scripts/herdr-workflow.mjs audit --run <run-dir>
node ~/.herdr-codex-pi-workflow/scripts/herdr-workflow.mjs reconcile --run <run-dir>
node ~/.herdr-codex-pi-workflow/scripts/herdr-workflow.mjs reconcile --run <run-dir> --write
node ~/.herdr-codex-pi-workflow/scripts/herdr-workflow.mjs transition --run <run-dir> --to <STATE>
node ~/.herdr-codex-pi-workflow/scripts/herdr-workflow.mjs round --run <run-dir> [--remediation <prepared-remediation.md>]
node ~/.herdr-codex-pi-workflow/scripts/herdr-workflow.mjs record-decision --run <run-dir> --event <event> --choice <choice> [--gate-revision <revision>]
node ~/.herdr-codex-pi-workflow/scripts/herdr-workflow.mjs notify-pending --run <run-dir>
node ~/.herdr-codex-pi-workflow/scripts/herdr-workflow.mjs record-landing --run <run-dir> --repo-name <name> --commit <sha> --branch <branch> --round <n> --decision-id <recovery-decision-id> [--remote-ref <ref>] [--worktree-cleaned]
node ~/.herdr-codex-pi-workflow/scripts/workflow_notify.py --status-json --run <run-dir>
node ~/.herdr-codex-pi-workflow/scripts/workflow_notify.py --retry-pending --run <run-dir>
node ~/.herdr-codex-pi-workflow/scripts/herdr-workflow.mjs verify-delivery-evidence --run <run-dir>
```

A failed command is a closed gate. Record the exact failures in `RUN.md`; do not set the target state manually. `round` is the only route into `IMPLEMENTING`: plan-approved Round 01 validates the approved hashes; remediation rounds require `--remediation`, allowed finding classifications, family-attempt bounds, and any architecture/escalation decision.

The Pi `before_agent_start` extension injects the current run state on every turn. This is context guidance, not a complete security boundary. The canonical CLI remains authoritative: `record-decision` rejects decisions outside their gate, and canonical `wf:<event>:<gate-revision>:<choice>` callbacks must match the current gate revision. The Pi `tool_call` handler additionally blocks direct edits to run machine-truth files and Git mutations during read-only or user-decision states. If the extension is unavailable, the CLI gates still apply.

## Workflow Modes

Select and freeze one mode in `state.json.workflow_mode` before Planner starts. `freeze` scans requirements/plan text and records `risk_triggers` plus `risk_mode_floor`, automatically upgrading quick-code/standard when a release trigger is present. It also snapshots `resolved_config` and `resolved_config_sha256`; unknown modes fail. A downgrade requires a latest `mode_change` decision binding `from_mode` and `to_mode`, and can never go below `risk_mode_floor`. Mode changes cannot be made by editing the state file alone.

| Mode | Use when | Required terminal evidence |
|---|---|---|
| `quick-code` | Local, low-risk code change; no DDL, auth, transaction, cache, scheduler, external side effect, or cross-service consistency | Coordinator-authored compact `PLAN.md`/change contract, targeted tests, one independent Review PASS, approved/pushed commits, delivery manifest |
| `standard` | Normal multi-module or API work requiring explicit plan approval | Preflight/Plan as applicable, independent Review PASS, approved/pushed commits, delivery manifest |
| `release` | DDL, XXL-Job, remote runtime, multi-service state, deployment, data seeding, or user-requested end-to-end proof | standard evidence plus `DEPLOYMENT.md`, `VERIFICATION.md`, and `FINAL-AUDIT.md` |

If classification is uncertain, use `standard`. Any release trigger upgrades the run to `release`; downgrading requires an explicit user decision recorded in `decision.json`.

`quick-code` skips the Preflight/Planner panes and plan-approval wait, not the contract. Coordinator writes a compact `PLAN.md` containing scope, affected symbols, tests, non-goals, and acceptance mapping; `freeze` records requirements/plan hashes before `round` creates Round 01 directly from `REQUIREMENTS_READY`. Quick-code may enter `DELIVERY_GATE` directly after `VALIDATED`; it still requires reviewed worktree HEAD and a matching pushed remote branch, but does not require deployment approval or `DEPLOYMENT.md`.

## Schema V4 Repository Shape

Use one repository contract for single- and multi-repository runs:

```json
{
  "schema_version": 4,
  "workflow_mode": "standard",
  "status": "NEW",
  "repositories": [
    {
      "name": "common",
      "root": "/absolute/main/repo",
      "worktree": "/absolute/worktree",
      "base_branch": "origin/develop",
      "base_commit": "...",
      "branch": "workflow/...",
      "pushed_branch": null,
      "reviewed_commit": null,
      "approved_commit": null
    }
  ],
  "delivery": {
    "manifest_path": "/absolute/run/DELIVERY-MANIFEST.json",
    "docs_dir": "/absolute/docs/feature"
  },
  "verification_path": "/absolute/run/VERIFICATION.md",
  "final_audit_path": "/absolute/run/FINAL-AUDIT.md",
  "open_gates": []
}
```

Do not also write legacy `repo`, `repos`, `worktree`, singular `reviewed_commit`, or singular `approved_commit` fields in new runs.

## Validation Gates

### `VALIDATED`

All conditions are mandatory:

- latest numbered `REVIEW.md` ends with `WORKFLOW_VERDICT: PASS`;
- the latest full acceptance matrix contains only `PASS`;
- every finding is `VERIFIED_CLOSED`, `DEFERRED_BY_USER`, `ACCEPTED_BY_USER`, or `OUT_OF_SCOPE_BY_USER`;
- deferred/accepted findings have a user decision in `decision.json`;
- no `open_gates` remain;
- frozen requirements and active-plan hashes still match;
- each repository worktree is clean and its HEAD equals `reviewed_commit`.

### `DEPLOYING`

`VALIDATED` conditions plus, for every repository:

```text
HEAD == reviewed_commit == approved_commit
```

The exact commit and external actions must be approved in `decision.json`. Schema v4 stores append-only decisions as `decisions[]`; deployment approval contains a stable `id`, `event="deploy_approval"`, approved `choice`, per-repository `approved_commits`, non-empty `operations`, channel, original user text, and timestamp. Findings marked `DEFERRED_BY_USER`, `ACCEPTED_BY_USER`, or `OUT_OF_SCOPE_BY_USER` must carry `decision_ref` pointing to one of these stable decision IDs.

### Notifications And Landing Evidence

User-gate notifications are written to a persistent `notifications.json` outbox before network delivery. IDs are `run_id:state_entry_revision:event`; channel results and retries are recorded independently, and `notification-events.jsonl` records enqueue/attempt events. `notify-pending` and `workflow_notify.py --retry-pending` are idempotent retries. Notification failure does not roll back a committed state transition.

Telegram output uses `wf:<event>:<gate-revision>:<choice>` and stays within Telegram's 64-byte callback limit. `hdrw:` is accepted only as legacy input. When pi-telegram is actively polling, the notification helper is send-only and must not start a second `getUpdates` consumer.

`record-landing` requires a recovery decision, an explicit round, a complete SHA, and independently verifiable branch/remote/patch evidence. A landing or cleanup record never approves an architecture gate, escalation, deployment, or paused-run recovery.

### `DELIVERY_GATE`

Deployment/push evidence exists, every `origin/<pushed_branch>` resolves to the approved commit, and the applicable runtime evidence is complete.

### `COMPLETE`

`verify-delivery-gate` must pass. Completion requires:

- every round has non-empty `metadata.json`, `REMEDIATION.md`, `IMPLEMENTATION.md`, `TEST-RESULTS.md`, and `REVIEW.md`; metadata must contain attempt/session identity, prompt hash, checkpoint, failure classification, exact tests, requirements/plan hashes, and `head_before`/`head_after_implementation`/`head_reviewed` Git SHAs;
- `DEPLOYMENT.md` ends with `WORKFLOW_VERDICT: DEPLOYED`;
- release mode additionally has `VERIFICATION.md: VERIFIED` and `FINAL-AUDIT.md: AUDITED_PASS`;
- `DELIVERY-MANIFEST.json` names the exact docs directory and interface-change contract;
- delivery documents and Bruno cases contain no placeholders;
- interface changes list every changed endpoint with at least one positive and one negative scenario;
- **Filter Benchmark & Cross-Channel Parity Contract**: 查询/明细类接口的 Bruno 与测试用例必须覆盖每个独立查询参数的正负隔离用例；多端共享接口必须提供同客户跨端（如 PAD 与后管）一致性调用证据；
- all repository remote commits equal approved commits (or reviewed commits for quick-code).
- `state_revision`, frozen mode/config hash, and the latest successful reconciliation must be present for schema v4 runs.

`PUSHED`, `VERIFYING_DONE`, and similar labels are evidence fields, not terminal lifecycle states.

## Delivery Manifest

`DELIVERY-MANIFEST.json` is authored from actual implementation and verification evidence. Scripts never invent its content. `docs_dir` is authoritative: a conflicting `--docs-dir` is rejected rather than used as an override.

```json
{
  "schema_version": 2,
  "docs_dir": "/absolute/docs/feature",
  "interface_change": true,
  "changed_endpoints": [
    {
      "method": "POST",
      "path": "/real/changed/path",
      "positive_cases": [{
        "id": "post-normal",
        "bruno_file": "cases/post-normal.bru",
        "result_file": "evidence/post-normal.json",
        "result_sha256": "...",
        "execution_receipt_file": "evidence/post-normal.receipt.json",
        "status": "PASS"
      }],
      "negative_cases": [{
        "id": "post-invalid",
        "bruno_file": "cases/post-invalid.bru",
        "result_file": "evidence/post-invalid.json",
        "result_sha256": "...",
        "execution_receipt_file": "evidence/post-invalid.receipt.json",
        "status": "PASS"
      }]
    }
  ]
}
```

For no-interface work, set `interface_change` to `false` and provide `interface_change_reason`. For interface work, each case must reference an execution receipt whose command cites the Bruno file, has exit code `0`, PASS status, valid timestamps, and matching stdout/stderr/result hashes. In a declared test environment, run `verify-delivery-evidence` to execute every manifest case with `runner run <bruno_file> --env <test_environment>`; production/正式 environment labels and missing `allow_side_effects=true` are rejected. Placeholder health checks, default Bruno requests, TODO/TBD text, and generic interface templates fail the gate.

## Waiting And Recovery

- Send the business prompt without a blocking `--wait` loop.
- Observe agent transport state with bounded event waits.
- Determine phase completion only from the required artifact verdict plus Git evidence.
- On timeout or disconnect, record an attempt with session ID, prompt hash, last artifact checkpoint, HEAD, dirty status, and failure classification.
- Resume from the existing artifact and worktree first. A transport/environment failure does not create a new implementation round. `PAUSED_BY_USER` records `resume_target_state`; recovery requires a stable `resume` decision ID, `reconcile --write` after both pause and decision, then `transition --resume-decision <id>` back to that exact state.
- Never resend the full task blindly or use long `sleep` orchestration.

## Post-Delivery Triage

A completed run is immutable. New production or acceptance issues are recorded under:

```text
<run-dir>/issues/<timestamp>-<slug>.md
```

Use `herdr-task-triage` to diagnose. Any code correction starts a linked patch run containing `parent_run_id`, original approved commits, symptom, narrowed acceptance criteria, and new independent review/verification. Do not rewrite the original run's PASS or COMPLETE evidence.
