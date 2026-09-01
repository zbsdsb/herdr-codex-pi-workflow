---
name: herdr-task-triage
description: "Use when investigating regressions, missing fields, error responses, or environment drift after a Herdr workflow run was completed or validated. Hydrates the existing run, classifies root cause, verifies a safe repair, and archives a linked triage record without rewriting original evidence."
---

# Herdr Task Triage

Use this Skill when a previously completed or validated workflow run later develops a regression, missing field, error response, or environment mismatch. Keep the original run immutable and treat `state.json`, Git evidence, and independent verification as authoritative.

## Workflow

1. Read the existing run before searching source code:
   - `RUN.md` and `state.json`;
   - `REQUIREMENTS.md` and `PLAN.md`;
   - `DEPLOYMENT.md` and `VERIFICATION.md` when present;
   - `DELIVERY-MANIFEST.json` and referenced test cases.
2. Classify the cause:
   - deployed artifact or commit drift;
   - environment, configuration, dependency, or test-data drift;
   - serialization or API contract behavior;
   - source defect.
3. Reproduce using the environment and identities authorized by the original run. Use the approved remote-operations wrapper for remote access. Never store credentials, tokens, cookies, or real customer records in the run.
4. Apply the smallest repair. Runtime/data-only repairs require backup, rollback, and verification evidence. Source repairs require a new linked patch run.
5. Re-run affected positive and negative cases with exact commands, status codes, assertions, logs, and exit codes.
6. Archive the result at `<run-dir>/issues/<UTC-timestamp>-<short-slug>.md` and append a concise `Post-Delivery Triage` entry to `RUN.md`.

Read `references/triage-runbook.md` for the detailed evidence and archive contract.

## Boundaries

- Do not rewrite the original `COMPLETE` or approved evidence.
- Do not manufacture missing test data, response fields, logs, or deployment proof.
- Use the canonical workflow command for lifecycle mutations.
- Escalate to the parent workflow when the fix changes source, scope, approval, or acceptance criteria.
