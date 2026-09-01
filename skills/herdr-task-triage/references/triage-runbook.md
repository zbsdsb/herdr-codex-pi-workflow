# Post-delivery Triage Runbook

Use this runbook when a completed or validated workflow run later shows a regression, missing field, error response, or environment mismatch.

## 1. Hydrate the Existing Run

Read these artifacts before searching the source tree:

- `RUN.md` and `state.json`: run identity, repository, approved commit, deployment target, and verification status.
- `REQUIREMENTS.md` and `PLAN.md`: original contract, acceptance criteria, and non-goals.
- `DEPLOYMENT.md` and `VERIFICATION.md`: deployed artifact, environment, commands, and smoke results.
- `DELIVERY-MANIFEST.json` and the referenced test cases: reproducible request and expected response.

Do not treat a projection as authoritative when it conflicts with `state.json`, Git evidence, or an independent verification report.

## 2. Classify the Root Cause

Check in this order:

1. **Artifact drift**: deployed package, container, or runtime no longer matches the approved commit.
2. **Environment or data drift**: test data, partition/view routing, feature flags, or dependencies changed.
3. **Serialization or contract behavior**: a null, renamed field, content-type, or compatibility setting changes the response.
4. **Source defect**: current source and approved commit reproduce the failure.

Record the evidence supporting the classification. A symptom alone is not a root-cause finding.

## 3. Reproduce Safely

- Use the environment already authorized by the original run.
- For remote operations, use the host's approved SSH/operations wrapper rather than raw SSH commands.
- Use synthetic or approved test identities only. Never paste credentials, tokens, cookies, or real customer records into the run.
- Re-run the smallest existing positive and negative cases first.
- Capture status code, response assertions, logs, artifact digest, and command exit code.

If the environment or data is missing, record the gap instead of manufacturing evidence.

## 4. Repair and Verify

- Runtime-only or data-only repairs must be documented with backup, change, rollback, and post-change evidence.
- Source repairs must use a new linked patch run. Do not rewrite the original `COMPLETE` evidence.
- Re-run the affected positive and negative cases and any directly related regression cases.
- Update `state.json` only through the canonical workflow commands.

## 5. Archive the Triage

Create:

```text
<run-dir>/issues/<UTC-timestamp>-<short-slug>.md
```

Include:

- observed symptom and reproduction;
- root-cause classification and evidence;
- commands and environment, with secrets and customer data redacted;
- repair, backup, rollback, and verification results;
- remaining risk and status (`OPEN`, `MITIGATED`, or `CLOSED`).

Append a concise `Post-Delivery Triage` entry to `RUN.md`. Keep the original run's approved commits and terminal evidence immutable.
