# Herdr Codex-Pi Workflow

A stateful, evidence-driven workflow for coordinating coding agents across planning, implementation, review, deployment approval, verification, and post-delivery triage.

This repository publishes two agent Skills:

- `herdr-codex-pi-workflow`: strict lifecycle gates, append-only evidence, isolated rounds, user decision gates, notification outbox, landing checks, and delivery verification.
- `herdr-task-triage`: context-first diagnosis for regressions discovered after a run was completed or validated.

The package is project-agnostic. It contains no task history, business source code, customer data, credentials, or personal configuration.

## Design

`state.json` is the machine truth. Lifecycle changes go through `runtime/scripts/herdr-workflow.mjs`; direct edits to state and decision ledgers are rejected by the canonical CLI and, when installed, by the Pi extension.

The workflow separates three concerns:

1. Pi context injection provides current-state guidance at the start of a turn.
2. The Coordinator advances ordinary evidence-backed stages automatically.
3. CLI gates and the Pi `tool_call` guard enforce hard boundaries for illegal transitions, stale decisions, direct ledger edits, and read-only stages.

User decisions remain mandatory for plan approval, architecture changes, escalation, pause recovery, deployment, and release actions. Notifications are persisted in an outbox and can be retried independently from state transitions.

## Requirements

- Node.js 20 or newer
- Python 3.9 or newer
- Git
- Pi for the optional state-injection extension
- A project-specific remote-operations wrapper for remote verification, if needed
- `bru` or another configured test runner only when delivery evidence uses API cases

## Install

From a clone of this repository:

```bash
./install.sh
```

The installer copies the Skills into `~/.agents/skills/`, runtime scripts into `~/.herdr-codex-pi-workflow/scripts/`, and the optional Pi extension into `~/.pi/agent/extensions/`. Existing files are not overwritten unless `--force` is supplied.

To install to a different home directory or workflow root:

```bash
PI_HOME="$HOME" HERDR_WORKFLOW_ROOT="$HOME/.herdr-codex-pi-workflow" ./install.sh
```

Restart Pi or reload the extension after installation.

## Configuration

Start from `config.example.json` and copy it to your workflow root as `config.json`. Configure model identifiers and project-specific policy there. Notification settings are supplied through environment variables; secrets must not be placed in `config.json` or run artifacts.

Useful variables:

- `HERDR_WORKFLOW_ROOT`: workflow data and script root.
- `HERDR_WORKFLOW_PROJECT_ROOTS`: comma-separated project directories where the global Pi extension is active.
- `HERDR_RUN_DIR` or `HERDR_WORKFLOW_RUN`: explicitly bind the extension to one run.
- `PI_TELEGRAM_CONFIG` and `PI_TELEGRAM_PROFILE`: optional Telegram configuration.
- `SMTP_SERVER`, `SMTP_PORT`, `SMTP_FROM`, `SMTP_TO`, `SMTP_PASS`, `SMTP_SSL`: optional email channel configuration.
- `HERDR_WORKFLOW_NOTIFY_DISABLED=1`: disable all external notification side effects during tests.

## Test

From the repository root:

```bash
node --test runtime/tests/herdr-workflow.test.mjs
python3 -m unittest runtime/tests/test_workflow_notify.py
node --check runtime/scripts/herdr-workflow.mjs
python3 -m py_compile runtime/scripts/workflow_notify.py
```

Tests use temporary Git repositories and disable external notifications. They do not send Telegram, email, attachments, or desktop notifications.

## Usage

After creating a run with the required schema and evidence files, use the canonical CLI:

```bash
node ~/.herdr-codex-pi-workflow/scripts/herdr-workflow.mjs audit --run <run-dir>
node ~/.herdr-codex-pi-workflow/scripts/herdr-workflow.mjs transition --run <run-dir> --to <STATE>
node ~/.herdr-codex-pi-workflow/scripts/herdr-workflow.mjs round --run <run-dir>
node ~/.herdr-codex-pi-workflow/scripts/herdr-workflow.mjs record-decision --run <run-dir> --event <event> --choice <choice> --gate-revision <revision>
python3 ~/.herdr-codex-pi-workflow/scripts/workflow_notify.py --notify-current --run <run-dir>
```

Use the published Skill instructions and reference contracts for the exact state, artifact, review, landing, and delivery-gate requirements. Remote deployment, release, and external system writes always require explicit user approval.

## License

MIT. See [LICENSE](LICENSE).
