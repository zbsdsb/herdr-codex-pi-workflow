// Herdr Codex-Pi Workflow State Injection Extension
// Injects the current workflow gate/state into the agent context
// at the start of every turn, like Trellis does with workflow-state breadcrumbs.
// @ts-nocheck

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const HERDR_ROOT = resolve(
  process.env.HERDR_WORKFLOW_ROOT ||
    join(process.env.HOME || process.env.USERPROFILE || ".", ".herdr-codex-pi-workflow")
);

// Global extensions need an explicit project scope. Comma-separated roots are supported.
const WORKFLOW_PROJECT_ROOTS = (
  process.env.HERDR_WORKFLOW_PROJECT_ROOTS || process.cwd()
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => resolve(value));

interface RunState {
  run_id?: string;
  status?: string;
  state_revision?: number;
  current_round?: number;
  workflow_mode?: string;
  workflow_mode_frozen?: string;
  objective?: string;
  schema_version?: number;
  repositories?: Array<{
    name?: string;
    root?: string;
    worktree?: string;
    branch?: string;
    reviewed_commit?: string;
    approved_commit?: string;
    landing?: {
      commit?: string;
      branch?: string;
      worktree_cleanup?: { authorized?: boolean };
    };
  }>;
  open_gates?: string[];
  resolved_config?: Record<string, unknown>;
}

interface ActiveRun {
  runDir: string;
  state: RunState;
  repository: string;
  updatedAt: number;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function pathRelated(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function loadCandidates(): { index: Record<string, unknown>; runs: ActiveRun[] } {
  const indexPath = join(HERDR_ROOT, "tasks", "index.json");
  const index = readJson(indexPath) || {};
  if (!Array.isArray(index.tasks)) return { index, runs: [] };
  const terminal = new Set(["COMPLETE", "PUSHED", "DEPLOYMENT_FAILED", "CANCELLED"]);
  const runs: ActiveRun[] = [];
  for (const task of index.tasks as Array<Record<string, unknown>>) {
    if (typeof task.run_id !== "string" || terminal.has(String(task.status))) continue;
    const repository = String(task.repository || "unknown");
    const runDir = join(HERDR_ROOT, "tasks", repository, task.run_id);
    const state = readJson(join(runDir, "state.json")) as RunState | null;
    if (!state) continue;
    runs.push({
      runDir,
      state,
      repository,
      updatedAt: Date.parse(String(task.updated_at || "")) || 0,
    });
  }
  return { index, runs };
}

function projectScopeMatches(cwd: string): boolean {
  return WORKFLOW_PROJECT_ROOTS.some((root) => pathRelated(cwd, root));
}

function findActiveRun(cwd: string = process.cwd()): ActiveRun | null {
  const { index, runs } = loadCandidates();
  if (!runs.length) return null;

  const explicit = process.env.HERDR_RUN_DIR || process.env.HERDR_WORKFLOW_RUN;
  if (explicit) {
    const target = resolve(explicit);
    const selected = runs.find((item) => resolve(item.runDir) === target || item.state.run_id === explicit);
    if (selected) return selected;
  }

  const activeRef = index.active;
  if (typeof activeRef === "string") {
    const selected = runs.find((item) => item.state.run_id === activeRef || resolve(item.runDir) === resolve(activeRef));
    if (selected) return selected;
  }
  if (activeRef && typeof activeRef === "object") {
    const runId = String((activeRef as Record<string, unknown>).run_id || "");
    const selected = runs.find((item) => item.state.run_id === runId);
    if (selected) return selected;
  }

  const related = runs.filter((item) => {
    if (pathRelated(cwd, item.runDir)) return true;
    return (item.state.repositories || []).some((repo) => {
      const paths = [repo.root, repo.worktree].filter(Boolean) as string[];
      return paths.some((path) => pathRelated(cwd, path));
    });
  });
  // Never guess between multiple runs in the same project. Bind with HERDR_RUN_DIR
  // or tasks/index.json.active when more than one candidate exists.
  if (related.length === 1) return related[0];
  return runs.length === 1 ? runs[0] : null;
}

function buildStateContext(active: ActiveRun): string {
  const { state, runDir } = active;
  const status = state.status || "UNKNOWN";
  const revision = state.state_revision || 0;
  const round = state.current_round || 0;
  const mode = state.workflow_mode_frozen || state.workflow_mode || "standard";
  const objective = state.objective || "";
  const repos = state.repositories || [];
  const repoLines = repos.map((repo) => {
    const parts = [`  - ${repo.name || "unknown"}`];
    if (repo.branch) parts.push(`branch: ${repo.branch}`);
    if (repo.reviewed_commit) parts.push(`reviewed: ${repo.reviewed_commit.slice(0, 12)}`);
    if (repo.landing?.commit) parts.push(`landed: ${repo.landing.commit.slice(0, 12)}`);
    return parts.join(" | ");
  });
  const guidance = stateGuidance(status);
  const userGate = new Set(["AWAITING_PLAN_APPROVAL", "ARCHITECTURE_GATE", "ESCALATED", "AWAITING_DEPLOY_APPROVAL", "PAUSED_BY_USER"]).has(status);

  return `<herdr-workflow-state>
Source: ${join(runDir, "state.json")}
Run: ${runDir}
Status: ${status}
Revision: ${revision}
Round: ${round}
Mode: ${mode}
${objective ? `Objective: ${objective}` : ""}
Open gates: ${(state.open_gates || []).join(", ") || "none recorded"}
${repoLines.length ? `Repositories:\n${repoLines.join("\n")}` : ""}

Next action: ${guidance}
Allowed: read current evidence; invoke canonical herdr-workflow.mjs commands that are legal for this state.
Forbidden: hand-edit state.json, events.jsonl, decision.json, notifications.json or tasks/index.json; bypass a failed transition; reuse an approval from another gate revision.
${userGate ? "User decision gate: do not modify business source, start another implementation round, deploy, push, or infer approval until a fresh decision is recorded." : ""}
Enforcement: this message is turn context. Canonical state-machine commands and Pi tool interception provide the hard checks; when they reject an action, stop and report the gate.
</herdr-workflow-state>`;
}

function stateGuidance(status: string): string {
  const guidance: Record<string, string> = {
    NEW: "No active task. Use 'round' to start with PREFLIGHTING or REQUIREMENTS_READY.",
    PREFLIGHTING:
      "Read-only fact-finding phase. Write PREFLIGHT.md, then 'transition --to REQUIREMENTS_READY'.",
    GRILL_ME:
      "Clarify undecided requirements with the user. Write findings to REQUIREMENTS.md.",
    REQUIREMENTS_READY:
      "Requirements are ready. Use 'freeze' to assess risk, then 'round' to start PLANNING (or IMPLEMENTING for quick-code).",
    PLANNING:
      "Writing PLAN.md. Output WORKFLOW_VERDICT: PLAN_READY when done.",
    PLAN_READY:
      "Plan is ready. Run 'transition --to AWAITING_PLAN_APPROVAL' to submit for user approval.",
    AWAITING_PLAN_APPROVAL:
      "Waiting for user plan approval. Use 'record-decision --event plan_approval --choice approve_and_implement|reject'.",
    IMPLEMENTING:
      "Implementation in progress. Write IMPLEMENTATION.md + TEST-RESULTS.md, then 'transition --to SELF_CHECKING'.",
    SELF_CHECKING:
      "Self-checking implementation. Run tests, then 'transition --to REVIEWING' or back to IMPLEMENTING.",
    REVIEWING:
      "Independent review in progress. Review writes REVIEW.md with verdict.",
    FINDING_TRIAGE:
      "Review found issues. Classify findings, then 'round --remediation <file>' or 'transition --to VALIDATED' if none blocking.",
    PLAN_REVISION:
      "Plan revision needed. Update PLAN.md, then 'transition --to AWAITING_PLAN_APPROVAL' or ARCHITECTURE_GATE.",
    SOL_ADVISORY:
      "Sol advisory in progress. Write SOL-ADVISORY.md, then 'transition --to ARCHITECTURE_GATE' or FINDING_TRIAGE.",
    ARCHITECTURE_GATE:
      "Architecture gate: waiting for user decision. Use 'record-decision --event architecture_gate --choice approve|revise'.",
    VALIDATED:
      "All findings closed. Ready for 'transition --to AWAITING_DEPLOY_APPROVAL' or DELIVERY_GATE.",
    AWAITING_DEPLOY_APPROVAL:
      "Waiting for user deploy approval. Use 'record-decision --event deploy_approval --choice approve|reject'.",
    DEPLOYING:
      "Deployment in progress. After deployment, 'transition --to VERIFYING'.",
    VERIFYING:
      "Remote verification in progress. Write VERIFICATION.md, then 'transition --to FINAL_AUDITING'.",
    FINAL_AUDITING:
      "Final audit in progress. Write FINAL-AUDIT.md, then 'transition --to DELIVERY_GATE'.",
    DELIVERY_GATE:
      "Delivery evidence gate. Run 'verify-delivery-gate', then 'transition --to COMPLETE'.",
    COMPLETE:
      "Task is complete. Run 'notify-pending' to send completion notification.",
    PAUSED_BY_USER:
      "Paused by user. Use 'record-decision --event resume --choice resume', reconcile, then 'transition --resume-decision <id>'.",
    ESCALATED:
      "Hard stop reached. Use 'record-decision --event escalation --choice continue|revise'.",
    DEPLOYMENT_FAILED:
      "Deployment failed. Fix and 'transition --to AWAITING_DEPLOY_APPROVAL'.",
  };

  return (
    guidance[status] ||
    `Status "${status}" has no specific guidance. See state.json for details.`
  );
}

const GATE_EVENT_BY_STATE: Record<string, string> = {
  AWAITING_PLAN_APPROVAL: "plan_approval",
  ARCHITECTURE_GATE: "architecture_gate",
  ESCALATED: "escalation",
  AWAITING_DEPLOY_APPROVAL: "deploy_approval",
};

function gateEntryRevision(active: ActiveRun): number {
  const status = active.state.status || "";
  const fallback = active.state.state_revision || 0;
  try {
    const lines = readFileSync(join(active.runDir, "events.jsonl"), "utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines.reverse()) {
      const event = JSON.parse(line);
      if (["transition", "round_created"].includes(event.kind) && event.to === status) {
        return Number(event.revision) || fallback;
      }
    }
  } catch {
    // The state revision remains a conservative fallback for legacy runs.
  }
  return fallback;
}

function recordCallbackDecision(prompt: string, active: ActiveRun): string | null {
  const match = prompt.match(/\[callback\]\s+((?:wf|hdrw):[^\s]+)/i);
  if (!match) return null;
  const raw = match[1];
  const currentEvent = GATE_EVENT_BY_STATE[active.state.status || ""];
  if (!currentEvent) return `Rejected workflow callback: state ${active.state.status || "UNKNOWN"} is not a user decision gate.`;

  const parts = raw.split(":");
  const canonical = parts[0] === "wf";
  let callbackEvent = currentEvent;
  let callbackRevision: number | null = null;
  let choice = parts.at(-1) || "";
  if (canonical) {
    if (parts.length !== 4) return "Rejected workflow callback: canonical wf callback must include event, gate revision and choice.";
    callbackEvent = parts[1];
    callbackRevision = Number(parts[2]);
  } else if (parts.length >= 3) {
    const legacyEvent = parts[1];
    callbackEvent = ({ plan: "plan_approval", deploy: "deploy_approval" } as Record<string, string>)[legacyEvent] || legacyEvent;
  }
  const expectedRevision = gateEntryRevision(active);
  if (callbackEvent !== currentEvent) return `Rejected stale workflow callback: expected ${currentEvent}, received ${callbackEvent}.`;
  if (canonical && callbackRevision !== expectedRevision) {
    return `Rejected stale workflow callback revision: expected ${expectedRevision}, received ${callbackRevision}.`;
  }

  const id = `callback-${createHash("sha256").update(`${active.state.run_id}:${raw}`).digest("hex").slice(0, 24)}`;
  const args = [
    join(HERDR_ROOT, "scripts", "herdr-workflow.mjs"),
    "record-decision",
    "--run", active.runDir,
    "--event", currentEvent,
    "--choice", choice,
    "--original-text", raw,
    "--channel", "pi-telegram-callback",
    "--id", id,
  ];
  if (canonical) args.push("--gate-revision", String(callbackRevision));
  const result = spawnSync("node", args, { encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) return `Workflow callback was not recorded: ${result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`}`;
  return `Workflow callback recorded through the canonical state machine: ${currentEvent}=${choice}, gate revision ${expectedRevision}.`;
}

const injectedSessions = new Set<string>();

function sessionKey(ctx: any): string {
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    if (typeof id === "string" && id.length > 0) return id;
  } catch {
    // Fall back to the extension process when session metadata is unavailable.
  }
  return `process:${process.pid}`;
}

const MACHINE_TRUTH_FILES = new Set([
  "state.json",
  "events.jsonl",
  "decision.json",
  "notifications.json",
  "notification-events.jsonl",
]);

function absoluteToolPath(inputPath: string, cwd: string = process.cwd()): string {
  return isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath);
}

function isMachineTruthPath(path: string, runDir: string): boolean {
  if (path === join(HERDR_ROOT, "tasks", "index.json")) return true;
  return MACHINE_TRUTH_FILES.has(path.split("/").at(-1) || "") && path.startsWith(`${runDir}/`);
}

function sourceWriteAllowed(status: string): boolean {
  return new Set(["IMPLEMENTING", "SELF_CHECKING", "DEPLOYING", "VERIFYING"]).has(status);
}

export default function (pi) {
  pi.on("before_agent_start", async (event, ctx) => {
    const cwd = event.systemPromptOptions?.cwd || ctx.cwd || process.cwd();
    const explicitlySelected = Boolean(process.env.HERDR_RUN_DIR || process.env.HERDR_WORKFLOW_RUN);
    if (!projectScopeMatches(cwd) && !explicitlySelected) return;

    const active = findActiveRun(cwd);
    if (!active) return;
    const callbackResult = recordCallbackDecision(String(event.prompt || ""), active);
    const refreshed = findActiveRun(cwd) || active;
    const key = sessionKey(ctx);
    const firstInjection = !injectedSessions.has(key);
    if (firstInjection) injectedSessions.add(key);
    if (!firstInjection && !callbackResult) return;

    const content = firstInjection
      ? `${buildStateContext(refreshed)}${callbackResult ? `\n<herdr-callback-result>${callbackResult}</herdr-callback-result>` : ""}`
      : `<herdr-callback-result>${callbackResult}</herdr-callback-result>`;
    return {
      message: {
        customType: "herdr-workflow-state",
        content,
        // Keep workflow breadcrumbs in model context without rendering them in the transcript.
        display: false,
      },
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    const cwd = ctx.cwd || process.cwd();
    const explicitlySelected = Boolean(process.env.HERDR_RUN_DIR || process.env.HERDR_WORKFLOW_RUN);
    if (!projectScopeMatches(cwd) && !explicitlySelected) return;
    const active = findActiveRun(cwd);
    if (!active) return;
    const status = active.state.status || "UNKNOWN";

    if (event.toolName === "write" || event.toolName === "edit") {
      const rawPath = String(event.input.path || "");
      if (!rawPath) return;
      const path = absoluteToolPath(rawPath, ctx.cwd);
      if (isMachineTruthPath(path, active.runDir)) {
        return {
          block: true,
          reason: `Herdr workflow blocks direct edits to machine truth (${path}). Use the canonical herdr-workflow.mjs command for state ${status}.`,
        };
      }
      const sourcePath = (active.state.repositories || []).some((repo) =>
        [repo.root, repo.worktree].filter(Boolean).some((root) => pathRelated(path, String(root)))
      );
      if (sourcePath && !sourceWriteAllowed(status)) {
        return {
          block: true,
          reason: `Herdr state ${status} is read-only for business source. Advance through the state machine or obtain the required user decision first.`,
        };
      }
    }

    if (event.toolName === "bash" && !sourceWriteAllowed(status)) {
      const command = String(event.input.command || "");
      const gitMutation = /(?:^|[;&|]\s*|\s)git(?:\s+-C\s+\S+)?\s+(?:add|commit|push|pull|merge|rebase|reset|clean|checkout|switch|branch\s+-[dD])\b/;
      if (gitMutation.test(command)) {
        return {
          block: true,
          reason: `Herdr state ${status} blocks Git mutations. Source-changing work is only legal in implementation/deployment states.`,
        };
      }
    }
  });
}