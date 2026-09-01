#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_HOME="${PI_HOME:-${HOME:?HOME is required}}"
SKILLS_HOME="${PI_SKILLS_HOME:-${PI_HOME}/.agents/skills}"
WORKFLOW_ROOT="${HERDR_WORKFLOW_ROOT:-${PI_HOME}/.herdr-codex-pi-workflow}"
EXTENSIONS_HOME="${PI_EXTENSIONS_HOME:-${PI_HOME}/.pi/agent/extensions}"
FORCE=0

if [[ "${1:-}" == "--force" ]]; then
  FORCE=1
elif [[ "${1:-}" != "" ]]; then
  echo "usage: $0 [--force]" >&2
  exit 2
fi

copy_dir() {
  local source="$1" target="$2"
  mkdir -p "$target"
  if [[ "$FORCE" == 1 ]]; then
    cp -R "$source"/. "$target"/
  else
    if find "$target" -mindepth 1 -print -quit | grep -q .; then
      echo "refusing to overwrite non-empty directory: $target (use --force)" >&2
      exit 1
    fi
    cp -R "$source"/. "$target"/
  fi
}

copy_file() {
  local source="$1" target="$2"
  mkdir -p "$(dirname "$target")"
  if [[ -e "$target" && "$FORCE" != 1 ]]; then
    echo "refusing to overwrite: $target (use --force)" >&2
    exit 1
  fi
  cp "$source" "$target"
}

copy_dir "$ROOT_DIR/skills/herdr-codex-pi-workflow" "$SKILLS_HOME/herdr-codex-pi-workflow"
copy_dir "$ROOT_DIR/skills/herdr-task-triage" "$SKILLS_HOME/herdr-task-triage"
copy_dir "$ROOT_DIR/runtime/scripts" "$WORKFLOW_ROOT/scripts"
copy_file "$ROOT_DIR/config.example.json" "$WORKFLOW_ROOT/config.example.json"
copy_file "$ROOT_DIR/extensions/herdr-workflow-state.ts" "$EXTENSIONS_HOME/herdr-workflow-state.ts"

if [[ ! -e "$WORKFLOW_ROOT/config.json" ]]; then
  cp "$ROOT_DIR/config.example.json" "$WORKFLOW_ROOT/config.json"
  echo "created $WORKFLOW_ROOT/config.json; review model and project settings"
fi

chmod +x "$WORKFLOW_ROOT/scripts/herdr-workflow.mjs" "$WORKFLOW_ROOT/scripts/workflow_notify.py"
echo "installed Herdr Codex-Pi Workflow to $WORKFLOW_ROOT"
echo "restart Pi or reload the extension before using state injection"
