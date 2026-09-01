import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/herdr-workflow.mjs", import.meta.url));
process.env.HERDR_WORKFLOW_NOTIFY_DISABLED = "1";

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: "utf8" }).trim();
}

function hash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function hashJson(value) {
  return createHash("sha256").update(`${JSON.stringify(value, null, 2)}\n`).digest("hex");
}

function write(path, content) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "herdr-workflow-test-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, repo], root);
  run("git", ["config", "user.email", "test@example.com"], repo);
  run("git", ["config", "user.name", "Workflow Test"], repo);
  write(join(repo, "source.txt"), "tested\n");
  run("git", ["add", "source.txt"], repo);
  run("git", ["commit", "-m", "test: fixture"], repo);
  run("git", ["branch", "-M", "workflow-test"], repo);
  run("git", ["push", "-u", "origin", "workflow-test"], repo);
  const commit = run("git", ["rev-parse", "HEAD"], repo);

  const tasksRoot = join(root, "tasks");
  const runDir = join(tasksRoot, "fixture", "run-1");
  const docsDir = join(root, "docs", "feature");
  const roundDir = join(runDir, "rounds", "01");
  mkdirSync(roundDir, { recursive: true });
  mkdirSync(join(docsDir, "bruno", "environments"), { recursive: true });
  mkdirSync(join(docsDir, "bruno", "cases"), { recursive: true });

  const requirements = join(runDir, "REQUIREMENTS.md");
  const plan = join(runDir, "PLAN.md");
  write(requirements, "# Requirements\n\nAC-1: tested\n");
  write(plan, "# Plan\n\nImplement and verify.\n\nWORKFLOW_VERDICT: PLAN_READY\n");
  write(join(runDir, "RUN.md"), "# Run\n\n## ⏱️ 耗时与阶段结构\n- real timestamps\n\n## 🔗 过程产物与交付物索引\n- evidence\n");
  write(join(runDir, "README.md"), "# Navigation\n");
  write(join(runDir, "FINDINGS.json"), '{"schema_version":1,"findings":[]}\n');
  write(join(runDir, "FINDING-TRACEABILITY.md"), "# Traceability\n\nNo findings.\n");
  write(join(runDir, "decision.json"), `${JSON.stringify({ decisions: [{
    id: "deploy-1",
    event: "deploy_approval",
    choice: "approve_and_deploy",
    timestamp: new Date().toISOString(),
    approved_commits: { service: commit },
    operations: ["push workflow-test"]
  }] }, null, 2)}\n`);
  write(join(runDir, "DEPLOYMENT.md"), `# Deployment\n\nApproved commit: ${commit}\n\nWORKFLOW_VERDICT: DEPLOYED\n`);
  write(join(runDir, "events.jsonl"), "");

  write(join(roundDir, "metadata.json"), JSON.stringify({
    number: 1,
    created_at: new Date().toISOString(),
    requirements_sha256: hash(requirements),
    active_plan_sha256: hash(plan),
    attempt_id: "attempt-1",
    session_id: "session-1",
    prompt_hash: "prompt-hash-1",
    checkpoint: "round-1-complete",
    failure_classification: "none",
    head_before: commit,
    head_after_implementation: commit,
    head_reviewed: commit,
    exact_tests: ["node --test fixture"],
    reviewed_commits: { service: commit }
  }, null, 2));
  write(join(roundDir, "REMEDIATION.md"), "# Remediation\n\nNo prior findings.\n");
  write(join(roundDir, "IMPLEMENTATION.md"), "# Implementation\n\nWORKFLOW_VERDICT: IMPLEMENTED\n");
  write(join(roundDir, "TEST-RESULTS.md"), "# Tests\n\ncommand: true, exit: 0\n\nWORKFLOW_VERDICT: TESTS_PASSED\n");
  write(join(roundDir, "REVIEW.md"), `# Review\n\nReviewed commit: ${commit}\n\n## Full Acceptance Matrix\n\n| Criterion | Result |\n|---|---|\n| AC-1 | PASS |\n\nWORKFLOW_VERDICT: PASS\n`);

  write(join(docsDir, "README.md"), "# Delivery\n\n## ⏱️ 耗时与阶段结构\n- measured\n\n## 🔗 过程产物与交付物索引\n- linked\n\n## 🎯 业务修改点人话摘要\n- implemented real endpoint\n\n## ⚠️ 残余风险与后续建议\n- none\n");
  write(join(docsDir, "前端接口交接文档.md"), "# Interface\n\nPOST /real/change supports validated input and output.\n");
  write(join(docsDir, "bruno", "bruno.json"), '{"version":"1","name":"fixture","type":"collection"}\n');
  write(join(docsDir, "bruno", "environments", "test.bru"), "vars {\n  baseUrl: http://127.0.0.1:1\n}\n");
  write(join(docsDir, "bruno", "cases", "changed-endpoint.bru"), "meta {\n  name: changed endpoint\n  type: http\n  seq: 1\n}\n\npost {\n  url: {{baseUrl}}/real/change\n  auth: none\n}\n");
  write(join(docsDir, "bruno", "cases", "changed-endpoint-negative.bru"), "meta {\n  name: changed endpoint negative\n  type: http\n  seq: 2\n}\n\npost {\n  url: {{baseUrl}}/real/change\n  auth: none\n}\n");
  write(join(docsDir, "evidence", "changed-positive.json"), '{"status":200,"rtnCode":"SUCCESS"}\n');
  write(join(docsDir, "evidence", "changed-negative.json"), '{"status":400,"rtnCode":"PARAM_ERROR"}\n');
  write(join(docsDir, "evidence", "changed-positive.stdout.log"), "PASS positive\n");
  write(join(docsDir, "evidence", "changed-positive.stderr.log"), "\n");
  write(join(docsDir, "evidence", "changed-negative.stdout.log"), "PASS negative\n");
  write(join(docsDir, "evidence", "changed-negative.stderr.log"), "\n");
  write(join(docsDir, "evidence", "changed-positive.receipt.json"), `${JSON.stringify({
    bruno_file: "cases/changed-endpoint.bru",
    result_file: "evidence/changed-positive.json",
    command: "bru run cases/changed-endpoint.bru --env test",
    tool: "bruno",
    environment: "test",
    started_at: "2026-08-26T10:00:00Z",
    finished_at: "2026-08-26T10:00:01Z",
    exit_code: 0,
    stdout_file: "evidence/changed-positive.stdout.log",
    stderr_file: "evidence/changed-positive.stderr.log",
    stdout_sha256: hash(join(docsDir, "evidence", "changed-positive.stdout.log")),
    stderr_sha256: hash(join(docsDir, "evidence", "changed-positive.stderr.log")),
    result_sha256: hash(join(docsDir, "evidence", "changed-positive.json")),
    status: "PASS"
  }, null, 2)}\n`);
  write(join(docsDir, "evidence", "changed-negative.receipt.json"), `${JSON.stringify({
    bruno_file: "cases/changed-endpoint-negative.bru",
    result_file: "evidence/changed-negative.json",
    command: "bru run cases/changed-endpoint-negative.bru --env test",
    tool: "bruno",
    environment: "test",
    started_at: "2026-08-26T10:01:00Z",
    finished_at: "2026-08-26T10:01:01Z",
    exit_code: 0,
    stdout_file: "evidence/changed-negative.stdout.log",
    stderr_file: "evidence/changed-negative.stderr.log",
    stdout_sha256: hash(join(docsDir, "evidence", "changed-negative.stdout.log")),
    stderr_sha256: hash(join(docsDir, "evidence", "changed-negative.stderr.log")),
    result_sha256: hash(join(docsDir, "evidence", "changed-negative.json")),
    status: "PASS"
  }, null, 2)}\n`);

  const manifestPath = join(runDir, "DELIVERY-MANIFEST.json");
  write(manifestPath, JSON.stringify({
    schema_version: 2,
    docs_dir: docsDir,
    test_environment: "test-environment",
    allow_side_effects: true,
    interface_change: true,
    changed_endpoints: [{
      method: "POST",
      path: "/real/change",
      positive_cases: [{ id: "positive-1", bruno_file: "cases/changed-endpoint.bru", result_file: "evidence/changed-positive.json", result_sha256: hash(join(docsDir, "evidence", "changed-positive.json")), execution_receipt_file: "evidence/changed-positive.receipt.json", status: "PASS" }],
      negative_cases: [{ id: "negative-1", bruno_file: "cases/changed-endpoint-negative.bru", result_file: "evidence/changed-negative.json", result_sha256: hash(join(docsDir, "evidence", "changed-negative.json")), execution_receipt_file: "evidence/changed-negative.receipt.json", status: "PASS" }]
    }]
  }, null, 2));

  const resolvedConfig = { workflow: { hard_stop_round: 3, max_attempts_per_finding_family: 1 } };
  const state = {
    schema_version: 4,
    state_revision: 0,
    run_id: "run-1",
    workflow_mode: "standard",
    workflow_mode_frozen: "standard",
    workflow_mode_frozen_at: new Date().toISOString(),
    resolved_config: resolvedConfig,
    resolved_config_sha256: hashJson(resolvedConfig),
    status: "DELIVERY_GATE",
    objective: "strict workflow fixture",
    requirements_path: requirements,
    requirements_sha256: hash(requirements),
    plan_path: plan,
    active_plan_path: plan,
    active_plan_sha256: hash(plan),
    findings_path: join(runDir, "FINDINGS.json"),
    decision_path: join(runDir, "decision.json"),
    rounds: [{
      number: 1,
      metadata_path: join(roundDir, "metadata.json"),
      review_path: join(roundDir, "REVIEW.md")
    }],
    current_round: 1,
    repositories: [{
      name: "service",
      root: repo,
      worktree: repo,
      branch: "workflow-test",
      pushed_branch: "workflow-test",
      reviewed_commit: commit,
      approved_commit: commit
    }],
    delivery: { manifest_path: manifestPath, docs_dir: docsDir },
    risk_assessment_path: join(runDir, "RISK-ASSESSMENT.json"),
    risk_mode_floor: "quick-code",
    risk_triggers: [],
    open_gates: []
  };
  write(join(runDir, "RISK-ASSESSMENT.json"), `${JSON.stringify({
    schema_version: 1,
    requirements_sha256: hash(requirements),
    active_plan_sha256: hash(plan),
    required_mode: "quick-code",
    triggers: [],
    changed_files: []
  }, null, 2)}\n`);
  write(join(runDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  write(join(tasksRoot, "index.json"), `${JSON.stringify({ schema_version: 1, tasks: [{ repository: "fixture", run_id: "run-1", status: "DELIVERY_GATE" }] }, null, 2)}\n`);
  return { runDir, docsDir, repo, commit };
}

test("strict transition reaches COMPLETE only with complete evidence", () => {
  const { runDir } = fixture();
  const output = JSON.parse(run("node", [script, "transition", "--run", runDir, "--to", "COMPLETE"], runDir));
  assert.equal(output.ok, true);
  const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
  assert.equal(state.status, "COMPLETE");
  assert.match(readFileSync(join(runDir, "events.jsonl"), "utf8"), /"from":"DELIVERY_GATE","to":"COMPLETE"/);
});

test("strict delivery gate rejects placeholder evidence", () => {
  const { runDir, docsDir } = fixture();
  write(join(docsDir, "前端接口交接文档.md"), "# Interface\n\n请根据需求填写\n");
  const result = spawnSync("node", [script, "verify-delivery-gate", "--run", runDir], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.ok(output.failures.some((failure) => failure.includes("占位文本")));
});

test("verify-delivery-evidence executes test-environment cases and refreshes receipts", () => {
  const { runDir } = fixture();
  const runner = join(runDir, "fake-bru");
  write(runner, "#!/bin/sh\nprintf '{\\\"status\\\":\\\"PASS\\\",\\\"rtnCode\\\":\\\"SUCCESS\\\"}\\n'\n");
  chmodSync(runner, 0o755);
  const manifestPath = join(runDir, "DELIVERY-MANIFEST.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.test_runner = runner;
  write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const output = JSON.parse(run("node", [script, "verify-delivery-evidence", "--run", runDir], runDir));
  assert.equal(output.ok, true);
  assert.equal(output.results.length, 2);
  const refreshed = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(refreshed.changed_endpoints[0].positive_cases[0].status, "PASS");
  const receipt = JSON.parse(readFileSync(join(join(runDir, "..", "..", "..", "docs", "feature", "evidence", "changed-positive.receipt.json")), "utf8"));
  assert.equal(receipt.exit_code, 0);
  assert.equal(receipt.status, "PASS");
});

test("automatic evidence execution rejects production environments and implicit side effects", () => {
  const { runDir } = fixture();
  const manifestPath = join(runDir, "DELIVERY-MANIFEST.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.test_environment = "production";
  write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const blockedProduction = spawnSync("node", [script, "verify-delivery-evidence", "--run", runDir], { encoding: "utf8" });
  assert.notEqual(blockedProduction.status, 0);
  assert.match(`${blockedProduction.stdout}${blockedProduction.stderr}`, /测试环境/);
  manifest.test_environment = "test-environment";
  manifest.allow_side_effects = false;
  write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const blockedSideEffects = spawnSync("node", [script, "verify-delivery-evidence", "--run", runDir], { encoding: "utf8" });
  assert.notEqual(blockedSideEffects.status, 0);
  assert.match(`${blockedSideEffects.stdout}${blockedSideEffects.stderr}`, /allow_side_effects/);
});

test("freeze automatically upgrades risk mode for release triggers", () => {
  const { runDir } = fixture();
  const statePath = join(runDir, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.workflow_mode = "quick-code";
  state.workflow_mode_frozen = null;
  state.resolved_config_sha256 = null;
  write(statePath, `${JSON.stringify(state, null, 2)}\n`);
  write(state.requirements_path, "# Requirements\n\nDDL: ALTER TABLE account ADD COLUMN status.\n");
  const output = JSON.parse(run("node", [script, "freeze", "--run", runDir], runDir));
  assert.equal(output.workflow_mode, "release");
  assert.equal(output.risk_mode_floor, "release");
  assert.ok(output.risk_triggers.includes("ddl"));
  const after = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(after.risk_mode_auto_upgraded, true);
});

test("delivery gate rejects descriptive-only or hash-mismatched evidence", () => {
  const { runDir } = fixture();
  const manifestPath = join(runDir, "DELIVERY-MANIFEST.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.changed_endpoints[0].positive_cases[0].result_sha256 = "0".repeat(64);
  write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const result = spawnSync("node", [script, "verify-delivery-gate", "--run", runDir], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /result sha256/);
});

test("delivery gate rejects a non-passing execution receipt", () => {
  const { runDir } = fixture();
  const receiptPath = join(runDir, "..", "..", "..", "docs", "feature", "evidence", "changed-positive.receipt.json");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  receipt.exit_code = 1;
  receipt.status = "FAIL";
  write(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const result = spawnSync("node", [script, "verify-delivery-gate", "--run", runDir], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /execution receipt 未通过/);
});

test("completion rejects legacy schema and manifest directory override", () => {
  const { runDir, docsDir } = fixture();
  const statePath = join(runDir, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.schema_version = 3;
  write(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const legacy = spawnSync("node", [script, "verify-delivery-gate", "--run", runDir], { encoding: "utf8" });
  assert.notEqual(legacy.status, 0);
  assert.match(legacy.stdout, /schema_version=4/);

  state.schema_version = 4;
  write(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const alternateDocs = join(runDir, "alternate-docs");
  mkdirSync(alternateDocs, { recursive: true });
  const override = spawnSync("node", [script, "verify-delivery-gate", "--run", runDir, "--docs-dir", alternateDocs], { encoding: "utf8" });
  assert.notEqual(override.status, 0);
  assert.match(override.stdout, /docs-dir 与 DELIVERY-MANIFEST/);
});

test("gen-nav creates a canonical run overview and delivery overview without mutating legacy state", () => {
  const { runDir, docsDir } = fixture();
  const statePath = join(runDir, "state.json");
  const stateBefore = JSON.parse(readFileSync(statePath, "utf8"));
  stateBefore.schema_version = 3;
  stateBefore.status = "PUSHED";
  write(statePath, `${JSON.stringify(stateBefore, null, 2)}\n`);

  const generated = JSON.parse(run("node", [script, "gen-delivery-overview", "--run", runDir, "--docs-dir", docsDir, "--force"], runDir));
  assert.equal(generated.ok, true);
  assert.equal(generated.historical, true);
  const runOverview = readFileSync(join(runDir, "README.md"), "utf8");
  assert.match(runOverview, /唯一总览入口/);
  assert.match(runOverview, /思考与决策材料/);
  assert.match(runOverview, /测试请求集合/);
  assert.match(runOverview, /legacy schema/);
  const deliveryOverview = readFileSync(join(docsDir, "README.md"), "utf8");
  assert.match(deliveryOverview, /耗时与阶段结构/);
  assert.match(deliveryOverview, /过程产物与交付物索引/);
  assert.match(deliveryOverview, /业务修改点人话摘要/);
  assert.match(deliveryOverview, /残余风险与后续建议/);
  assert.match(deliveryOverview, /历史归档/);
  assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), stateBefore);
});

test("run lock blocks concurrent mutation and decisions advance state revision", () => {
  const { runDir } = fixture();
  const lockDir = join(runDir, ".workflow.lock");
  mkdirSync(lockDir, { recursive: true });
  write(join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, hostname: "another-host", command: "transition" }));
  const blocked = spawnSync("node", [script, "freeze", "--run", runDir], { encoding: "utf8" });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /run is locked/);
  rmSync(lockDir, { recursive: true, force: true });
  const statePath = join(runDir, "state.json");
  const before = JSON.parse(readFileSync(statePath, "utf8"));
  before.status = "AWAITING_PLAN_APPROVAL";
  write(statePath, `${JSON.stringify(before, null, 2)}\n`);
  run("node", [script, "record-decision", "--run", runDir, "--event", "plan_approval", "--choice", "approve_and_implement"], runDir);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.state_revision, 1);
});

test("pending mutation mismatch is preserved and blocks the next mutation", () => {
  const { runDir } = fixture();
  write(join(runDir, ".pending-mutation.json"), JSON.stringify({ revision: 1, target_state_sha256: "not-current", event: { event_id: "pending-1" } }));
  const blocked = spawnSync("node", [script, "freeze", "--run", runDir], { encoding: "utf8" });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /pending mutation/);
  assert.equal(JSON.parse(readFileSync(join(runDir, ".pending-mutation.json"), "utf8")).event.event_id, "pending-1");
});

test("record-decision rejects a decision outside its current user gate", () => {
  const { runDir } = fixture();
  const rejected = spawnSync("node", [script, "record-decision", "--run", runDir, "--event", "plan_approval", "--choice", "approve"], { encoding: "utf8" });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /stale or out-of-gate decision/);
  assert.equal(JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")).state_revision, 0);
});

test("notify-pending is side-effect free when notifications are disabled", () => {
  const { runDir } = fixture();
  const output = JSON.parse(run("node", [script, "notify-pending", "--run", runDir], runDir));
  assert.equal(output.disabled, true);
  assert.equal(existsSync(join(runDir, "notifications.json")), false);
});

test("latest decision wins and rejects stale approval", () => {
  const { runDir } = fixture();
  const statePath = join(runDir, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.status = "AWAITING_PLAN_APPROVAL";
  write(statePath, `${JSON.stringify(state, null, 2)}\n`);
  run("node", [script, "record-decision", "--run", runDir, "--event", "plan_approval", "--choice", "approve_and_implement"], runDir);
  run("node", [script, "record-decision", "--run", runDir, "--event", "plan_approval", "--choice", "reject"], runDir);
  const result = spawnSync("node", [script, "round", "--run", runDir], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /plan_approval/);
});

test("round records and increments finding family attempts", () => {
  const { runDir } = fixture();
  const statePath = join(runDir, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.status = "FINDING_TRIAGE";
  state.finding_family_attempts = {};
  write(statePath, `${JSON.stringify(state, null, 2)}\n`);
  write(join(runDir, "FINDINGS.json"), `${JSON.stringify({ findings: [{ id: "F-IMPL", family: "implementation", classification: "implementation_bug", status: "OPEN" }] }, null, 2)}\n`);
  const remediation = join(runDir, "NEXT-REMEDIATION.md");
  write(remediation, "# Remediation\n\nFix implementation.\n");
  const result = JSON.parse(run("node", [script, "round", "--run", runDir, "--remediation", remediation], runDir));
  const after = JSON.parse(readFileSync(statePath, "utf8"));
  const currentRound = after.rounds.find((round) => round.number === result.number);
  const metadata = JSON.parse(readFileSync(currentRound.metadata_path, "utf8"));
  assert.equal(result.to, "IMPLEMENTING");
  assert.equal(after.finding_family_attempts.implementation, 1);
  assert.equal(metadata.finding_family_attempts.implementation, 1);
});

test("quick-code creates a round directly from frozen requirements", () => {
  const { runDir } = fixture();
  const statePath = join(runDir, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.workflow_mode = "quick-code";
  state.workflow_mode_frozen = "quick-code";
  state.status = "REQUIREMENTS_READY";
  write(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const output = JSON.parse(run("node", [script, "round", "--run", runDir], runDir));
  assert.equal(output.from, "REQUIREMENTS_READY");
  assert.equal(output.to, "IMPLEMENTING");
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).status, "IMPLEMENTING");
});

test("reconcile repairs task-index projection without changing state", () => {
  const { runDir } = fixture();
  const indexPath = join(runDir, "..", "..", "index.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  index.tasks[0].status = "NEW";
  write(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  const result = JSON.parse(run("node", [script, "reconcile", "--run", runDir, "--write"], runDir));
  assert.equal(result.ok, true);
  assert.equal(result.wrote, true);
  assert.equal(JSON.parse(readFileSync(indexPath, "utf8")).tasks[0].status, "DELIVERY_GATE");
  const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
  assert.equal(state.status, "DELIVERY_GATE");
  assert.equal(state.last_reconcile_ok, true);
  assert.equal(state.state_revision, 1);
});

test("round blocks implementation without plan approval bound to frozen hashes", () => {
  const { runDir } = fixture();
  const statePath = join(runDir, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.status = "AWAITING_PLAN_APPROVAL";
  write(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const blocked = spawnSync("node", [script, "round", "--run", runDir], { encoding: "utf8" });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stdout, /plan_approval/);

  const decisionPath = join(runDir, "decision.json");
  const decisions = JSON.parse(readFileSync(decisionPath, "utf8"));
  decisions.decisions.push({
    id: "plan-1",
    event: "plan_approval",
    choice: "approve_and_implement",
    timestamp: new Date().toISOString(),
    plan_sha256: state.active_plan_sha256,
    requirements_sha256: state.requirements_sha256
  });
  write(decisionPath, `${JSON.stringify(decisions, null, 2)}\n`);
  const output = JSON.parse(run("node", [script, "round", "--run", runDir], runDir));
  assert.equal(output.to, "IMPLEMENTING");
});

test("finding triage cannot route architecture gaps directly to implementation", () => {
  const { runDir } = fixture();
  const statePath = join(runDir, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.status = "FINDING_TRIAGE";
  state.finding_family_attempts = {};
  write(statePath, `${JSON.stringify(state, null, 2)}\n`);
  write(join(runDir, "FINDINGS.json"), `${JSON.stringify({ findings: [{
    id: "F-ARCH",
    family: "transaction-boundary",
    classification: "architecture_gap",
    status: "OPEN"
  }] }, null, 2)}\n`);
  const remediation = join(runDir, "NEXT-REMEDIATION.md");
  write(remediation, "# Remediation\n\nArchitecture decision required.\n");
  const result = spawnSync("node", [script, "round", "--run", runDir, "--remediation", remediation], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /不能直接实施/);
});

test("paused run requires a bound resume decision and reconciliation after it", () => {
  const { runDir } = fixture();
  const statePath = join(runDir, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.status = "PAUSED_BY_USER";
  state.paused_at = new Date(Date.now() - 2000).toISOString();
  state.resume_target_state = "DELIVERY_GATE";
  write(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const blocked = spawnSync("node", [script, "transition", "--run", runDir, "--to", "DELIVERY_GATE"], { encoding: "utf8" });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stdout, /resume/);

  const decisionPath = join(runDir, "decision.json");
  const decisions = JSON.parse(readFileSync(decisionPath, "utf8"));
  decisions.decisions.push({ id: "resume-1", event: "resume", choice: "resume", timestamp: new Date().toISOString() });
  write(decisionPath, `${JSON.stringify(decisions, null, 2)}\n`);
  run("node", [script, "reconcile", "--run", runDir, "--write"], runDir);
  const output = JSON.parse(run("node", [script, "transition", "--run", runDir, "--to", "DELIVERY_GATE", "--resume-decision", "resume-1"], runDir));
  assert.equal(output.ok, true);
});

test("accepted finding must reference a decision that names that finding", () => {
  const { runDir } = fixture();
  write(join(runDir, "FINDINGS.json"), `${JSON.stringify({ findings: [{
    id: "F-ACCEPT",
    family: "residual-risk",
    classification: "implementation_bug",
    status: "ACCEPTED_BY_USER",
    decision_ref: "deploy-1"
  }] }, null, 2)}\n`);
  const result = spawnSync("node", [script, "verify-delivery-gate", "--run", runDir], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /decision_ref/);
});

test("review gate binds machine reviewed commits and requires the worktree", () => {
  const { runDir } = fixture();
  const statePath = join(runDir, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.status = "REVIEWING";
  state.repositories[0].worktree = join(runDir, "missing-worktree");
  write(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const result = spawnSync("node", [script, "transition", "--run", runDir, "--to", "VALIDATED"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /worktree 不存在/);
});

test("review gate rejects metadata commit that differs from state", () => {
  const { runDir } = fixture();
  const statePath = join(runDir, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.status = "REVIEWING";
  write(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const metadataPath = state.rounds[0].metadata_path;
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  metadata.reviewed_commits.service = "b".repeat(40);
  write(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  const result = spawnSync("node", [script, "transition", "--run", runDir, "--to", "VALIDATED"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /reviewed_commits/);
});

test("hard stop blocks another finding-triage round before escalation", () => {
  const { runDir } = fixture();
  const statePath = join(runDir, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.status = "FINDING_TRIAGE";
  state.resolved_config = { workflow: { hard_stop_round: 1, max_attempts_per_finding_family: 2 } };
  state.finding_family_attempts = { implementation: 0 };
  write(statePath, `${JSON.stringify(state, null, 2)}\n`);
  write(join(runDir, "FINDINGS.json"), `${JSON.stringify({ findings: [{
    id: "F-IMPL",
    family: "implementation",
    classification: "implementation_bug",
    status: "OPEN"
  }] }, null, 2)}\n`);
  const remediation = join(runDir, "NEXT-REMEDIATION.md");
  write(remediation, "# Remediation\n\nFix implementation.\n");
  const result = spawnSync("node", [script, "round", "--run", runDir, "--remediation", remediation], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /hard_stop_round/);
});

test("strict completion validates every repository in a multi-repository run", () => {
  const { runDir, repo, commit } = fixture();
  const statePath = join(runDir, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.repositories.push({
    name: "common",
    root: repo,
    worktree: repo,
    branch: "workflow-test",
    pushed_branch: "workflow-test",
    reviewed_commit: commit,
    approved_commit: commit
  });
  write(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const metadata = JSON.parse(readFileSync(state.rounds[0].metadata_path, "utf8"));
  metadata.reviewed_commits.common = commit;
  write(state.rounds[0].metadata_path, `${JSON.stringify(metadata, null, 2)}\n`);
  const decisionPath = join(runDir, "decision.json");
  const decisions = JSON.parse(readFileSync(decisionPath, "utf8"));
  decisions.decisions[0].approved_commits.common = commit;
  write(decisionPath, `${JSON.stringify(decisions, null, 2)}\n`);
  const output = JSON.parse(run("node", [script, "transition", "--run", runDir, "--to", "COMPLETE"], runDir));
  assert.equal(output.ok, true);
  assert.equal(output.gate.checks.repositories.length, 2);
});
