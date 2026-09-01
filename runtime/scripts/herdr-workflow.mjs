#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

function usage() {
  console.error("Usage: herdr-workflow.mjs <freeze|round|audit|reconcile|transition|record-decision|notify-pending|record-landing|verify-deploy-gate|gen-nav|gen-delivery-overview|gen-plan-summary|verify-delivery-evidence|verify-delivery-gate|auto-complete-delivery> --run <run-dir> [--to <state>] [--repo <repo-root>] [--docs-dir <docs-dir>] [--force] [--write]");
  process.exit(2);
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

const command = process.argv[2];
const runDir = arg("--run");
if (!command || !runDir) usage();

const statePath = join(runDir, "state.json");
if (!existsSync(statePath)) throw new Error(`missing state.json: ${statePath}`);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function atomicJson(path, value) {
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, jsonText(value), "utf8");
  renameSync(temp, path);
}

function hashText(text) {
  return createHash("sha256").update(text).digest("hex");
}

function hashFile(path) {
  if (!existsSync(path)) throw new Error(`missing required artifact: ${path}`);
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function repoRoot(state) {
  return arg("--repo") || state.repo?.root || state.repository;
}

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function findFilesRecursive(dir, ext = ".bru") {
  if (!existsSync(dir)) return [];
  const results = [];
  function walk(current) {
    const list = readdirSync(current);
    for (const file of list) {
      const full = join(current, file);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (file.endsWith(ext)) {
        results.push(full);
      }
    }
  }
  walk(dir);
  return results;
}

let state = readJson(statePath);

const lockDir = join(runDir, ".workflow.lock");
const pendingMutationPath = join(runDir, ".pending-mutation.json");
let lockHeld = false;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function acquireRunLock() {
  const ownerPath = join(lockDir, "owner.json");
  const attempt = () => {
    mkdirSync(lockDir);
    atomicJson(ownerPath, {
      pid: process.pid,
      hostname: hostname(),
      command,
      acquired_at: new Date().toISOString()
    });
    lockHeld = true;
  };
  try {
    attempt();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let owner = null;
    try {
      owner = readJson(ownerPath);
    } catch {
      owner = null;
    }
    if (owner?.hostname === hostname() && !pidAlive(Number(owner.pid))) {
      rmSync(lockDir, { recursive: true, force: true });
      attempt();
    } else {
      throw new Error(`run is locked by ${owner?.hostname || "unknown-host"}:${owner?.pid || "unknown-pid"} (${owner?.command || "unknown-command"})`);
    }
  }
  state = readJson(statePath);
}

function releaseRunLock() {
  if (!lockHeld) return;
  rmSync(lockDir, { recursive: true, force: true });
  lockHeld = false;
}

function notificationScript() {
  return join(dirname(process.argv[1]), "workflow_notify.py");
}

function runNotifier(args) {
  if (process.env.HERDR_WORKFLOW_NOTIFY_DISABLED === "1") {
    return { ok: true, disabled: true, reason: "notification delivery disabled by test/runtime environment" };
  }
  const script = notificationScript();
  if (!existsSync(script)) return { ok: false, error: `missing notification script: ${script}` };
  const execution = spawnSync("python3", [script, ...args, "--run", runDir], {
    encoding: "utf8",
    timeout: 90_000,
    maxBuffer: 2 * 1024 * 1024
  });
  let output = null;
  try {
    output = execution.stdout?.trim() ? JSON.parse(execution.stdout) : null;
  } catch {
    output = execution.stdout?.trim() || null;
  }
  return {
    ok: execution.status === 0,
    exit_code: execution.status,
    output,
    error: execution.error?.message || execution.stderr?.trim() || null
  };
}

function notifyCurrentGate() {
  return runNotifier(["--notify-current"]);
}

const mutatingCommand = ["transition", "round", "freeze", "record-decision", "notify-pending", "record-landing", "verify-delivery-evidence"].includes(command) || (command === "reconcile" && hasFlag("--write"));
if (mutatingCommand) acquireRunLock();
process.on("exit", releaseRunLock);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

function eventExists(eventId) {
  const eventsPath = join(runDir, "events.jsonl");
  if (!existsSync(eventsPath)) return false;
  return readFileSync(eventsPath, "utf8").split(/\r?\n/).some((line) => {
    if (!line.trim()) return false;
    try {
      return JSON.parse(line).event_id === eventId;
    } catch {
      return false;
    }
  });
}

function recoverPendingMutation() {
  if (!existsSync(pendingMutationPath)) return;
  const pending = readJson(pendingMutationPath);
  const currentText = jsonText(state);
  const currentRevision = Number(state.state_revision) || 0;
  if (pending.target_state_sha256 === hashText(currentText) && currentRevision === pending.revision) {
    if (!eventExists(pending.event.event_id)) appendFileSync(join(runDir, "events.jsonl"), `${JSON.stringify(pending.event)}\n`, "utf8");
    rmSync(pendingMutationPath, { force: true });
    return;
  }
  throw new Error("pending mutation does not match current state; run reconcile --write after inspecting .pending-mutation.json");
}

if (mutatingCommand) recoverPendingMutation();

function commitStateMutation(kind, { from = null, to = null, details = {} } = {}) {
  const revision = (Number(state.state_revision) || 0) + 1;
  state.state_revision = revision;
  const timestamp = new Date().toISOString();
  const targetText = jsonText(state);
  const event = {
    event_id: `${state.run_id || basename(runDir)}:${revision}:${kind}`,
    timestamp,
    kind,
    revision,
    from,
    to,
    actor: "herdr-workflow.mjs",
    state_sha256: hashText(targetText),
    ...details
  };
  atomicJson(pendingMutationPath, {
    schema_version: 1,
    revision,
    target_state_sha256: event.state_sha256,
    event
  });
  atomicJson(statePath, state);
  appendFileSync(join(runDir, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
  rmSync(pendingMutationPath, { force: true });
  return event;
}

function finalNonEmptyLine(path) {
  if (!path || !existsSync(path) || statSync(path).size === 0) return null;
  const lines = readFileSync(path, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length ? lines.at(-1) : null;
}

function parseCommitMap(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return { ...value };
  const commits = {};
  for (const part of String(value).split(";")) {
    const match = part.match(/^\s*([\w.-]+)\s*:\s*([0-9a-f]{7,40})\s*$/i);
    if (match) commits[match[1]] = match[2];
  }
  return commits;
}

function repositoryEntries(state) {
  if (Array.isArray(state.repositories)) return state.repositories.map((repo) => ({ ...repo }));
  if (state.repos && typeof state.repos === "object") {
    return Object.entries(state.repos).map(([name, repo]) => ({ name, ...repo }));
  }
  const root = state.repo?.root || state.repository || repoRoot(state);
  const worktree = state.worktree?.path || root;
  return root ? [{ name: state.repo?.name || "repo", root, worktree, branch: state.worktree?.branch || state.repo?.branch }] : [];
}

function latestRound(state) {
  const rounds = Array.isArray(state.rounds) ? state.rounds : [];
  return [...rounds].sort((a, b) => Number(a.number) - Number(b.number)).at(-1) || null;
}

function roundMetadata(roundNumber) {
  const round = (state.rounds || []).find((entry) => Number(entry.number) === Number(roundNumber));
  const path = round?.metadata_path || join(runDir, "rounds", String(roundNumber).padStart(2, "0"), "metadata.json");
  if (!existsSync(path)) throw new Error(`missing round metadata: ${path}`);
  return { path, value: readJson(path) };
}

function reviewedPatchEvidence(repoName, roundNumber) {
  const { path, value } = roundMetadata(roundNumber);
  const patch = value.reviewed_patch || {};
  const perRepo = patch.repositories?.[repoName] || {};
  return {
    metadata_path: path,
    base_commit: value.head_before_by_repo?.[repoName] || value.head_before || null,
    tracked_patch_sha256: perRepo.tracked_patch_sha256 || patch[`${repoName}_tracked_patch_sha256`] || null,
    untracked_files: perRepo.untracked_files || patch[`${repoName}_untracked_files`] || {},
    declared_clean: perRepo.clean === true || patch[`${repoName}_clean`] === true
  };
}

function verifyLandingEvidence(repo, landing) {
  const failures = [];
  const root = repo.root || repo.path;
  const name = repo.name || "repo";
  const commit = landing?.commit;
  const branch = landing?.branch;
  const roundNumber = Number(landing?.round);
  const checks = { name, root, commit, branch, round: roundNumber };
  if (!root || !existsSync(root)) return { ok: false, failures: [`${name}: landing 主仓路径不存在`], checks };
  if (!/^[0-9a-f]{40}$/i.test(String(commit || ""))) return { ok: false, failures: [`${name}: landing commit 不是 40 位 SHA`], checks };
  if (!branch) return { ok: false, failures: [`${name}: landing 缺少目标 branch`], checks };
  let evidence;
  try {
    evidence = reviewedPatchEvidence(name, roundNumber);
  } catch (error) {
    return { ok: false, failures: [`${name}: ${error.message}`], checks };
  }
  const baseCommit = evidence.base_commit || repo.base_commit;
  checks.base_commit = baseCommit;
  checks.expected_tracked_patch_sha256 = evidence.tracked_patch_sha256;
  checks.expected_untracked_files = evidence.untracked_files;
  if (!baseCommit) return { ok: false, failures: [`${name}: Round ${roundNumber} 缺少 base commit`], checks };
  try {
    const resolvedCommit = git(root, ["rev-parse", "--verify", `${commit}^{commit}`]);
    checks.resolved_commit = resolvedCommit;
    if (resolvedCommit !== commit) failures.push(`${name}: landing commit 未解析为记录的完整 SHA`);
    git(root, ["rev-parse", "--verify", `refs/heads/${branch}`]);
    const branchContains = spawnSync("git", ["-C", root, "merge-base", "--is-ancestor", commit, `refs/heads/${branch}`], { encoding: "utf8" }).status === 0;
    checks.branch_contains_commit = branchContains;
    if (!branchContains) failures.push(`${name}: 目标分支 ${branch} 不包含 landing commit`);
    if (landing.remote_ref) {
      git(root, ["rev-parse", "--verify", landing.remote_ref]);
      const remoteContains = spawnSync("git", ["-C", root, "merge-base", "--is-ancestor", commit, landing.remote_ref], { encoding: "utf8" }).status === 0;
      checks.remote_ref = landing.remote_ref;
      checks.remote_contains_commit = remoteContains;
      if (!remoteContains) failures.push(`${name}: ${landing.remote_ref} 不包含 landing commit`);
    }
    const excluded = Object.keys(evidence.untracked_files || {}).map((path) => `:(exclude)${path}`);
    const diff = execFileSync("git", ["-C", root, "diff", `${baseCommit}..${commit}`, "--", ".", ...excluded], { maxBuffer: 100 * 1024 * 1024 });
    checks.actual_tracked_patch_sha256 = hashText(diff);
    if (evidence.tracked_patch_sha256 && checks.actual_tracked_patch_sha256 !== evidence.tracked_patch_sha256) {
      failures.push(`${name}: landing tracked patch hash 与 Round ${roundNumber} 审查证据不一致`);
    }
    for (const [path, expectedHash] of Object.entries(evidence.untracked_files || {})) {
      const content = execFileSync("git", ["-C", root, "show", `${commit}:${path}`], { maxBuffer: 100 * 1024 * 1024 });
      const actualHash = hashText(content);
      if (!checks.untracked_files) checks.untracked_files = {};
      checks.untracked_files[path] = { expected_sha256: expectedHash, actual_sha256: actualHash };
      if (actualHash !== expectedHash) failures.push(`${name}: landing 文件 ${path} hash 与 Round ${roundNumber} 审查证据不一致`);
    }
  } catch (error) {
    failures.push(`${name}: landing 证据校验失败: ${error.message}`);
  }
  return { ok: failures.length === 0, failures, checks };
}

function roundArtifactPath(round, key, fallbackName) {
  if (!round) return null;
  if (round[key]) return round[key];
  const label = String(round.number).padStart(2, "0");
  return join(runDir, "rounds", label, fallbackName);
}

function acceptanceSection(reviewText) {
  const headings = [...reviewText.matchAll(/^#{1,3}\s+.*(?:full acceptance matrix|acceptance matrix|验收矩阵).*$/gim)];
  if (!headings.length) return null;
  const start = headings.at(-1).index + headings.at(-1)[0].length;
  const rest = reviewText.slice(start);
  const end = rest.search(/^#{1,3}\s+/m);
  return (end >= 0 ? rest.slice(0, end) : rest).trim();
}

function decisionEntries() {
  const decisionPath = state.decision_path || join(runDir, "decision.json");
  if (!existsSync(decisionPath)) return [];
  try {
    const value = readJson(decisionPath);
    if (Array.isArray(value)) return value;
    if (Array.isArray(value.decisions)) return value.decisions;
    return value.event ? [value] : [];
  } catch {
    return [];
  }
}

function findingEntries() {
  const findingsPath = state.findings_path || join(runDir, "FINDINGS.json");
  if (!existsSync(findingsPath)) return null;
  try {
    const data = readJson(findingsPath);
    const findings = Array.isArray(data) ? data : data.findings;
    return Array.isArray(findings) ? findings : null;
  } catch {
    return null;
  }
}

function latestDecision(event) {
  return [...decisionEntries()].reverse().find((decision) => decision.event === event) || null;
}

function approvedDecision(event, choices) {
  const accepted = new Set(choices.map((choice) => choice.toLowerCase()));
  const decision = latestDecision(event);
  return decision && accepted.has(String(decision.choice || "").toLowerCase()) ? decision : null;
}

function findingFamily(finding) {
  return finding.family || finding.classification || "unclassified";
}

const workflowModes = ["quick-code", "standard", "release"];

function repositoryChangedFiles(stateValue) {
  const files = [];
  for (const repo of repositoryEntries(stateValue || {})) {
    const root = repo.root || repo.path;
    if (!root || !existsSync(root)) continue;
    try {
      const base = repo.base_commit;
      const args = base ? ["diff", "--name-only", `${base}..HEAD`] : ["diff", "--name-only", "HEAD"];
      for (const file of git(root, args).split(/\r?\n/).filter(Boolean)) files.push(`${repo.name || "repo"}:${file}`);
    } catch {
      // Risk evidence remains conservative when Git cannot inspect a repository.
    }
  }
  return files;
}

function detectRiskMode(requirementsText, planText, stateValue, changedFiles = []) {
  const text = `${requirementsText}\n${planText}\n${JSON.stringify(stateValue || {})}`;
  const changedText = changedFiles.join("\n");
  const triggers = [];
  const releaseRules = [
    ["ddl", /DDL|ALTER\s+TABLE|CREATE\s+TABLE|DROP\s+TABLE|表结构|数据库变更/i],
    ["xxl-job", /XXL[- ]?Job|定时任务|调度任务|scheduler|batch job/i],
    ["remote-runtime", /远端运行时|远程运行时|部署到|服务器部署|生产环境|SIT 环境|runtime deployment/i],
    ["multi-service-state", /多服务状态|跨服务一致性|跨服务事务|跨仓一致性|service[- ]to[- ]service/i],
    ["data-seeding", /造数|数据构造|seed(?:ing)? data|fixture injection/i],
    ["e2e-proof", /端到端|\bE2E\b|end[- ]to[- ]end|用户要求.*验收/i]
  ];
  const standardRules = [
    ["auth", /认证|鉴权|授权|JWT|OAuth|permission/i],
    ["transaction", /事务边界|transaction boundary|\btransaction\b/i],
    ["cache", /缓存|cache|redis/i],
    ["external-side-effect", /外部副作用|发送邮件|发短信|消息队列|webhook|external side effect/i]
  ];
  for (const [name, rule] of [...releaseRules, ...standardRules]) if (rule.test(text) || rule.test(changedText)) triggers.push(name);
  if (/(^|:)\S+\.(sql|ddl)$|(^|:).*?(migration|migrations|schema)/i.test(changedText)) triggers.push("ddl");
  if (/(^|:).*?(job|scheduler|xxl|quartz)/i.test(changedText)) triggers.push("xxl-job");
  if (/(^|:).*?(docker|deploy|helm|k8s|workflow|\.github\/workflows)/i.test(changedText)) triggers.push("remote-runtime");
  const uniqueTriggers = [...new Set(triggers)];
  const hasRelease = uniqueTriggers.some((trigger) => releaseRules.some(([name]) => name === trigger));
  return { mode_floor: hasRelease ? "release" : (uniqueTriggers.length ? "standard" : "quick-code"), triggers: uniqueTriggers, changed_files: changedFiles };
}

function validateRiskAssessment(failures, checks = {}, { requireFrozen = false } = {}) {
  const assessmentPath = state.risk_assessment_path || join(runDir, "RISK-ASSESSMENT.json");
  if (!existsSync(assessmentPath)) {
    if (requireFrozen) failures.push("缺少 RISK-ASSESSMENT.json");
    return;
  }
  let assessment;
  try {
    assessment = readJson(assessmentPath);
  } catch {
    failures.push("RISK-ASSESSMENT.json 无法解析");
    return;
  }
  if (assessment.schema_version !== 1) failures.push("RISK-ASSESSMENT.json schema_version 必须为 1");
  const requirementsPath = state.requirements_path || join(runDir, "REQUIREMENTS.md");
  const planPath = state.active_plan_path || state.plan_path || join(runDir, "PLAN.md");
  if (!existsSync(requirementsPath) || !existsSync(planPath)) return;
  const live = detectRiskMode(readFileSync(requirementsPath, "utf8"), readFileSync(planPath, "utf8"), state, repositoryChangedFiles(state));
  checks.risk_assessment = { path: assessmentPath, mode_floor: live.mode_floor, triggers: live.triggers, changed_files: live.changed_files };
  const declared = new Set(state.risk_triggers || []);
  const missing = live.triggers.filter((trigger) => !declared.has(trigger));
  if (missing.length) failures.push(`RISK-ASSESSMENT 未覆盖实际风险触发项: ${missing.join(", ")}`);
  if (workflowModes.indexOf(state.risk_mode_floor || "quick-code") < workflowModes.indexOf(live.mode_floor)) failures.push(`risk_mode_floor 低于实际变更要求: ${live.mode_floor}`);
  if (assessment.requirements_sha256 !== state.requirements_sha256 || assessment.active_plan_sha256 !== state.active_plan_sha256) failures.push("RISK-ASSESSMENT 未绑定当前 requirements/plan hash");
}

function validateWorkflowModeContract(failures, checks = {}, { requireFrozen = false } = {}) {
  const mode = state.workflow_mode;
  const frozen = state.workflow_mode_frozen;
  const riskFloor = state.risk_mode_floor || null;
  checks.workflow_mode_contract = {
    current: mode || null,
    frozen: frozen || null,
    risk_mode_floor: riskFloor,
    risk_triggers: state.risk_triggers || [],
    resolved_config_sha256: state.resolved_config_sha256 || null
  };
  if (!workflowModes.includes(mode)) {
    failures.push(`workflow_mode 无效: ${mode || "MISSING"}`);
    return;
  }
  if (riskFloor && workflowModes.includes(riskFloor) && workflowModes.indexOf(mode) < workflowModes.indexOf(riskFloor)) {
    failures.push(`workflow_mode=${mode} 低于风险触发项要求的最低模式 ${riskFloor}: ${(state.risk_triggers || []).join(", ")}`);
  }
  if (requireFrozen && !workflowModes.includes(frozen)) failures.push("workflow_mode 尚未通过 freeze 固定");
  if (requireFrozen && (!state.resolved_config || !state.resolved_config_sha256)) failures.push("resolved_config 尚未通过 freeze 固定");
  validateRiskAssessment(failures, checks, { requireFrozen });
  if (state.resolved_config_sha256 && state.resolved_config) {
    const actualConfigHash = hashText(jsonText(state.resolved_config));
    if (actualConfigHash !== state.resolved_config_sha256) failures.push("resolved_config hash 已变化");
  }
  if (workflowModes.includes(frozen) && mode !== frozen) {
    const currentRank = workflowModes.indexOf(mode);
    const frozenRank = workflowModes.indexOf(frozen);
    if (currentRank < frozenRank) {
      const decision = latestDecision("mode_change");
      const approved = decision && ["approve", "approved", "downgrade"].includes(String(decision.choice || "").toLowerCase());
      if (!approved || decision.from_mode !== frozen || decision.to_mode !== mode) {
        failures.push(`workflow_mode 从 ${frozen} 降级到 ${mode} 需要显式 mode_change 决策`);
      }
      if (riskFloor && workflowModes.indexOf(mode) < workflowModes.indexOf(riskFloor)) {
        failures.push(`mode_change 不能低于风险触发项要求的最低模式 ${riskFloor}`);
      }
    }
  }
}

function validateFindings(failures, checks) {
  const findings = findingEntries();
  if (!findings) {
    failures.push("FINDINGS.json 缺失、无法解析或缺少 findings 数组");
    return;
  }
  const terminal = new Set(["VERIFIED_CLOSED", "DEFERRED_BY_USER", "ACCEPTED_BY_USER", "OUT_OF_SCOPE_BY_USER"]);
  const open = findings.filter((finding) => !terminal.has(String(finding.status || "").toUpperCase()));
  const userDecided = findings.filter((finding) => ["DEFERRED_BY_USER", "ACCEPTED_BY_USER", "OUT_OF_SCOPE_BY_USER"].includes(String(finding.status || "").toUpperCase()));
  const decisionsById = new Map(decisionEntries().filter((decision) => decision.id).map((decision) => [decision.id, decision]));
  const acceptedChoices = {
    ACCEPTED_BY_USER: new Set(["accept", "accepted", "accept_risk"]),
    DEFERRED_BY_USER: new Set(["defer", "deferred"]),
    OUT_OF_SCOPE_BY_USER: new Set(["out_of_scope"])
  };
  const unboundDecisions = userDecided.filter((finding) => {
    const decision = finding.decision_ref ? decisionsById.get(finding.decision_ref) : null;
    const status = String(finding.status || "").toUpperCase();
    return !decision || decision.event !== "finding_decision" || !Array.isArray(decision.finding_ids) || !decision.finding_ids.includes(finding.id) || !acceptedChoices[status]?.has(String(decision.choice || "").toLowerCase());
  });
  checks.findings = {
    total: findings.length,
    open: open.map((finding) => finding.id || finding.title),
    unbound_user_decisions: unboundDecisions.map((finding) => finding.id || finding.title)
  };
  if (open.length) failures.push(`存在未闭环 findings: ${open.map((finding) => `${finding.id || "UNKNOWN"}:${finding.status || "MISSING_STATUS"}`).join(", ")}`);
  if (unboundDecisions.length) failures.push(`用户接受/延期的 findings 缺少有效 decision_ref: ${unboundDecisions.map((finding) => finding.id || "UNKNOWN").join(", ")}`);
}

function validateReview(failures, checks) {
  const round = latestRound(state);
  if (!round) {
    failures.push("没有可验收的 implementation/review round");
    return;
  }
  const reviewPath = roundArtifactPath(round, "review_path", "REVIEW.md");
  const verdict = finalNonEmptyLine(reviewPath);
  checks.latest_review = { round: round.number, path: reviewPath, verdict };
  if (verdict !== "WORKFLOW_VERDICT: PASS") failures.push(`最新 Review 未 PASS: ${verdict || "MISSING"}`);
  if (!reviewPath || !existsSync(reviewPath)) return;
  const reviewText = readFileSync(reviewPath, "utf8");
  const metadataPath = round.metadata_path || join(runDir, "rounds", String(round.number).padStart(2, "0"), "metadata.json");
  let reviewedCommits = null;
  try {
    reviewedCommits = readJson(metadataPath).reviewed_commits || null;
  } catch {
    reviewedCommits = null;
  }
  checks.latest_review.reviewed_commits = reviewedCommits;
  if (!reviewedCommits || typeof reviewedCommits !== "object") {
    failures.push("最新 round metadata 缺少 reviewed_commits");
  } else {
    for (const repo of repositoryEntries(state)) {
      if (!repo.reviewed_commit || reviewedCommits[repo.name] !== repo.reviewed_commit) {
        failures.push(`${repo.name}: round metadata reviewed_commits 与 state.reviewed_commit 不一致`);
      }
    }
  }
  const matrix = acceptanceSection(reviewText);
  if (!matrix) {
    failures.push("最新 REVIEW.md 缺少完整验收矩阵");
  } else if (/\|[^\n]*\|\s*(?:FAIL|NOT_EVIDENCED)\s*\|/i.test(matrix)) {
    failures.push("最新 REVIEW.md 验收矩阵仍包含 FAIL/NOT_EVIDENCED");
  }
}

function validateHashes(failures, checks) {
  const requirementsPath = state.requirements_path || join(runDir, "REQUIREMENTS.md");
  const planPath = state.active_plan_path || state.plan_path || join(runDir, "PLAN.md");
  if (!state.requirements_sha256 || !state.active_plan_sha256) {
    failures.push("requirements/active plan 尚未冻结 hash");
    return;
  }
  try {
    const actualRequirements = hashFile(requirementsPath);
    const actualPlan = hashFile(planPath);
    checks.hashes = { requirements: actualRequirements, plan: actualPlan };
    if (actualRequirements !== state.requirements_sha256) failures.push("REQUIREMENTS.md hash 已变化");
    if (actualPlan !== state.active_plan_sha256) failures.push("active plan hash 已变化");
  } catch (error) {
    failures.push(error.message);
  }
}

function validateRepositories(failures, warnings, checks, { requireReviewed = false, requireApproved = false, requireRemote = false, requireWorktree = false } = {}) {
  const repos = repositoryEntries(state);
  if (!repos.length) {
    failures.push("state.json 未声明 repositories/repos");
    return;
  }
  const reviewed = { ...parseCommitMap(state.reviewed_commit), ...parseCommitMap(state.reviewed_commits) };
  const approved = { ...parseCommitMap(state.approved_commit), ...parseCommitMap(state.approved_commits) };
  checks.repositories = [];
  for (const repo of repos) {
    const name = repo.name || "repo";
    const reviewedCommit = repo.reviewed_commit || reviewed[name] || (repos.length === 1 && typeof state.reviewed_commit === "string" ? state.reviewed_commit : null);
    const approvedCommit = repo.approved_commit || approved[name] || (repos.length === 1 && typeof state.approved_commit === "string" ? state.approved_commit : null);
    const branch = repo.pushed_branch || state.pushed_branch || repo.landing?.branch || repo.branch;
    const entry = { name, reviewed_commit: reviewedCommit, approved_commit: approvedCommit, branch };
    let landing = null;
    if (repo.landing) {
      landing = verifyLandingEvidence(repo, repo.landing);
      entry.landing = landing.checks;
      entry.landing_ok = landing.ok;
      failures.push(...landing.failures);
    }
    if (requireReviewed && !reviewedCommit) failures.push(`${name}: 缺少 reviewed_commit`);
    if (requireApproved && !approvedCommit) failures.push(`${name}: 缺少 approved_commit`);
    if (requireApproved && reviewedCommit && approvedCommit && reviewedCommit !== approvedCommit) failures.push(`${name}: reviewed_commit != approved_commit`);
    const worktree = repo.worktree || repo.path;
    if (worktree && existsSync(worktree)) {
      try {
        entry.worktree_head = git(worktree, ["rev-parse", "HEAD"]);
        entry.worktree_clean = git(worktree, ["status", "--porcelain"]).length === 0;
        if (requireReviewed && reviewedCommit && entry.worktree_head !== reviewedCommit) failures.push(`${name}: worktree HEAD != reviewed_commit`);
        if (requireApproved && approvedCommit && entry.worktree_head !== approvedCommit) failures.push(`${name}: worktree HEAD != approved_commit`);
        if (!entry.worktree_clean && (requireReviewed || requireApproved || requireRemote || requireWorktree)) failures.push(`${name}: worktree 不干净`);
      } catch (error) {
        failures.push(`${name}: 无法检查 worktree: ${error.message}`);
      }
    } else {
      const cleanupVerified = landing?.ok && repo.landing?.worktree_cleanup?.authorized === true;
      entry.worktree_present = false;
      entry.worktree_cleanup_verified = cleanupVerified;
      const activeStates = new Set(["IMPLEMENTING", "SELF_CHECKING", "REVIEWING", "FINDING_TRIAGE", "PLAN_REVISION", "SOL_ADVISORY", "ARCHITECTURE_GATE", "ESCALATED", "VALIDATED", "AWAITING_DEPLOY_APPROVAL", "DEPLOYING", "VERIFYING", "FINAL_AUDITING", "DELIVERY_GATE"]);
      if (requireWorktree) {
        failures.push(`${name}: worktree 不存在，无法执行需要现场工作区的门禁`);
      } else if (activeStates.has(state.status) && !cleanupVerified) {
        failures.push(`${name}: 活跃 run 的 worktree 不存在，且没有可验证的 post-merge cleanup 记录`);
      } else if (cleanupVerified) {
        warnings.push(`${name}: worktree 已按用户授权清理；继续实现前必须从 landing commit 重建隔离 worktree`);
      }
    }
    if (requireRemote) {
      if (!repo.root || !existsSync(repo.root)) {
        failures.push(`${name}: 主仓路径不存在，无法验证远端分支`);
      } else if (!branch) {
        failures.push(`${name}: 缺少 pushed_branch`);
      } else {
        try {
          const remoteLine = git(repo.root, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);
          entry.remote_head = remoteLine ? remoteLine.split(/\s+/)[0] : null;
          if (!entry.remote_head) failures.push(`${name}: 远端分支 origin/${branch} 不存在`);
          else {
            const expectedRemoteCommit = approvedCommit || reviewedCommit;
            if (expectedRemoteCommit && entry.remote_head !== expectedRemoteCommit) failures.push(`${name}: origin/${branch} != ${approvedCommit ? "approved_commit" : "reviewed_commit"}`);
          }
        } catch (error) {
          failures.push(`${name}: 无法实时读取 origin/${branch}: ${error.message}`);
        }
      }
    }
    checks.repositories.push(entry);
  }
}

function validateDeployApproval(failures, checks) {
  const approval = approvedDecision("deploy_approval", ["approve", "approved", "approve_and_deploy", "deploy"]);
  checks.deploy_approval = approval ? { id: approval.id || null, timestamp: approval.timestamp || null } : null;
  if (!approval) {
    failures.push("缺少显式 deploy_approval 决策记录");
    return;
  }
  if (!Array.isArray(approval.operations) || approval.operations.length === 0) failures.push("deploy_approval 缺少明确 operations");
  const approvedByDecision = parseCommitMap(approval.approved_commits);
  for (const repo of repositoryEntries(state)) {
    const expected = repo.approved_commit;
    if (!expected || approvedByDecision[repo.name] !== expected) failures.push(`${repo.name}: deploy_approval 的 approved_commits 与 state 不一致`);
  }
}

function validatePlanApproval(failures) {
  const approval = approvedDecision("plan_approval", ["approve", "approved", "approve_and_implement", "implement"]);
  if (!approval) {
    failures.push("缺少显式 plan_approval 决策记录");
    return;
  }
  if (approval.plan_sha256 !== state.active_plan_sha256 || approval.requirements_sha256 !== state.requirements_sha256) {
    failures.push("plan_approval 未绑定当前 requirements/active plan hash");
  }
}

function validateRoundEntry(from, remediationPath, nextRoundNumber) {
  const failures = [];
  validateWorkflowModeContract(failures, {}, { requireFrozen: true });
  if (from === "AWAITING_PLAN_APPROVAL") validatePlanApproval(failures);
  if (from === "ARCHITECTURE_GATE") {
    const decision = approvedDecision("architecture_gate", ["approve", "approved", "continue", "implement"]);
    if (!decision || decision.plan_sha256 !== state.active_plan_sha256) failures.push("架构门禁缺少绑定当前 plan hash 的明确批准");
  }
  if (from === "ESCALATED") {
    const decision = approvedDecision("escalation", ["continue", "approve_round", "implement"]);
    if (!decision || Number(decision.next_round) !== nextRoundNumber) failures.push(`硬停止后缺少绑定 Round ${nextRoundNumber} 的显式继续决策`);
  }
  const hardStopRound = state.resolved_config?.workflow?.hard_stop_round ?? state.workflow_config?.hard_stop_round ?? 3;
  if (nextRoundNumber > hardStopRound && from !== "ESCALATED") failures.push(`Round ${nextRoundNumber} 超过 hard_stop_round=${hardStopRound}，必须先进入 ESCALATED 并取得用户决策`);
  if (["FINDING_TRIAGE", "ARCHITECTURE_GATE", "ESCALATED"].includes(from)) {
    if (!remediationPath || !existsSync(remediationPath) || statSync(remediationPath).size === 0) {
      failures.push("修复轮必须通过 --remediation 提供非空 remediation 文件");
    }
    const findings = findingEntries() || [];
    const open = findings.filter((finding) => !["VERIFIED_CLOSED", "DEFERRED_BY_USER", "ACCEPTED_BY_USER", "OUT_OF_SCOPE_BY_USER"].includes(String(finding.status || "").toUpperCase()));
    if (from === "FINDING_TRIAGE") {
      const invalid = open.filter((finding) => !["implementation_bug", "test_gap"].includes(finding.classification));
      if (invalid.length) failures.push(`FINDING_TRIAGE 不能直接实施 plan/architecture/workflow/environment finding: ${invalid.map((finding) => finding.id).join(", ")}`);
      const maxAttempts = state.resolved_config?.workflow?.max_attempts_per_finding_family ?? state.workflow_config?.max_attempts_per_finding_family ?? 1;
      const repeated = open.filter((finding) => (state.finding_family_attempts?.[findingFamily(finding)] || 0) >= maxAttempts);
      if (repeated.length) failures.push(`finding family 已达到直接修复上限: ${[...new Set(repeated.map(findingFamily))].join(", ")}`);
    }
  }
  return failures;
}

function validateTransitionArtifact(to, failures) {
  const round = latestRound(state);
  if (to === "REQUIREMENTS_READY") {
    const requirementsPath = state.requirements_path || join(runDir, "REQUIREMENTS.md");
    if (!existsSync(requirementsPath) || statSync(requirementsPath).size === 0) failures.push("REQUIREMENTS_READY 需要非空 REQUIREMENTS.md");
  }
  if (["PLAN_READY", "AWAITING_PLAN_APPROVAL"].includes(to)) {
    const planPath = state.active_plan_path || state.plan_path || join(runDir, "PLAN.md");
    if (finalNonEmptyLine(planPath) !== "WORKFLOW_VERDICT: PLAN_READY" && finalNonEmptyLine(planPath) !== "WORKFLOW_VERDICT: PLAN_REVISION_READY") failures.push(`${to} 需要有效 PLAN verdict`);
  }
  if (["SELF_CHECKING", "REVIEWING"].includes(to)) {
    const implementationPath = roundArtifactPath(round, "implementation_path", "IMPLEMENTATION.md");
    const testPath = roundArtifactPath(round, "test_results_path", "TEST-RESULTS.md");
    if (finalNonEmptyLine(implementationPath) !== "WORKFLOW_VERDICT: IMPLEMENTED") failures.push(`${to} 需要 IMPLEMENTATION.md: IMPLEMENTED`);
    if (!["WORKFLOW_VERDICT: TESTS_PASSED", "WORKFLOW_VERDICT: TESTS_INCOMPLETE"].includes(finalNonEmptyLine(testPath))) failures.push(`${to} 需要有效 TEST-RESULTS.md verdict`);
  }
  if (to === "FINDING_TRIAGE") {
    const reviewPath = roundArtifactPath(round, "review_path", "REVIEW.md");
    if (!["WORKFLOW_VERDICT: CHANGES_REQUESTED", "WORKFLOW_VERDICT: BLOCKED"].includes(finalNonEmptyLine(reviewPath))) failures.push("FINDING_TRIAGE 需要 CHANGES_REQUESTED/BLOCKED Review");
    const open = (findingEntries() || []).filter((finding) => !["VERIFIED_CLOSED", "DEFERRED_BY_USER", "ACCEPTED_BY_USER", "OUT_OF_SCOPE_BY_USER"].includes(String(finding.status || "").toUpperCase()));
    if (!open.length) failures.push("FINDING_TRIAGE 需要已登记的 open finding");
  }
  if (to === "FINAL_AUDITING" && finalNonEmptyLine(state.verification_path || join(runDir, "VERIFICATION.md")) !== "WORKFLOW_VERDICT: VERIFIED") failures.push("FINAL_AUDITING 需要 VERIFICATION.md: VERIFIED");
  if (to === "DELIVERY_GATE") validateWorkflowModeEvidence(failures, {});
}

function validateResume(failures, resumeDecisionId) {
  const decision = decisionEntries().find((entry) => entry.id === resumeDecisionId);
  if (!decision || decision.event !== "resume" || !["resume", "continue"].includes(String(decision.choice || "").toLowerCase())) {
    failures.push("PAUSED_BY_USER 恢复需要 --resume-decision 指向显式 resume 决策");
    return;
  }
  const pausedAt = Date.parse(state.paused_at || "");
  const reconciledAt = Date.parse(state.last_reconciled_at || "");
  const decisionAt = Date.parse(decision.timestamp || "");
  if (!Number.isFinite(reconciledAt) || !Number.isFinite(pausedAt) || reconciledAt < pausedAt || (Number.isFinite(decisionAt) && reconciledAt < decisionAt)) {
    failures.push("恢复前必须在暂停和 resume 决策之后执行 reconcile --write");
  }
  if (state.last_reconcile_ok !== true || Number(state.last_reconciled_revision) !== Number(state.state_revision)) {
    failures.push("恢复前需要当前 state revision 上成功完成的 reconcile --write");
  }
}

function validateRounds(failures) {
  const rounds = Array.isArray(state.rounds) ? state.rounds : [];
  for (const round of rounds) {
    const label = String(round.number).padStart(2, "0");
    for (const file of ["REMEDIATION.md", "IMPLEMENTATION.md", "TEST-RESULTS.md", "REVIEW.md", "metadata.json"]) {
      const path = file === "metadata.json" ? (round.metadata_path || join(runDir, "rounds", label, file)) : join(runDir, "rounds", label, file);
      if (!existsSync(path) || statSync(path).size === 0) failures.push(`rounds/${label}/${file} 缺失或为空`);
    }
    const metadataPath = round.metadata_path || join(runDir, "rounds", label, "metadata.json");
    if (!existsSync(metadataPath)) continue;
    let metadata;
    try {
      metadata = readJson(metadataPath);
    } catch {
      continue;
    }
    const required = ["created_at", "attempt_id", "session_id", "prompt_hash", "checkpoint", "failure_classification", "head_before", "head_after_implementation", "head_reviewed", "exact_tests"];
    for (const field of required) {
      const value = metadata[field];
      const missing = value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
      if (missing) failures.push(`rounds/${label}/metadata.json 缺少 ${field}`);
    }
    if (metadata.requirements_sha256 !== state.requirements_sha256) failures.push(`rounds/${label}/metadata requirements_sha256 与 state 不一致`);
    if (metadata.active_plan_sha256 !== state.active_plan_sha256) failures.push(`rounds/${label}/metadata active_plan_sha256 与 state 不一致`);
    for (const field of ["head_before", "head_after_implementation", "head_reviewed"]) {
      if (metadata[field] && !/^[0-9a-f]{40}$/i.test(String(metadata[field]))) failures.push(`rounds/${label}/metadata ${field} 不是有效 Git SHA`);
    }
  }
}

function containsPlaceholder(text) {
  return /请根据需求填写|默认测试用例|\/sys\/health|相关业务功能|AUTO_SCAFFOLD_PLACEHOLDER|\bTODO\b|\bTBD\b|待补充/i.test(text);
}

function manifestPath(baseDir, relativePath) {
  if (typeof relativePath !== "string" || !relativePath.trim() || isAbsolute(relativePath)) return null;
  const base = resolve(baseDir);
  const target = resolve(baseDir, relativePath);
  return target === base || target.startsWith(`${base}${sep}`) ? target : null;
}

function validateEvidenceCase(failures, checks, docsDir, brunoDir, endpointPath, kind, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failures.push(`${endpointPath}: ${kind} 必须是结构化 evidence 对象`);
    return;
  }
  if (!value.id || !value.bruno_file || !value.result_file || !value.result_sha256 || !value.execution_receipt_file) {
    failures.push(`${endpointPath}: ${kind} 必须包含 id/bruno_file/result_file/result_sha256/execution_receipt_file`);
    return;
  }
  const brunoPath = manifestPath(brunoDir, value.bruno_file);
  const resultPath = manifestPath(docsDir, value.result_file);
  const receiptPath = manifestPath(docsDir, value.execution_receipt_file);
  if (!brunoPath || !existsSync(brunoPath) || statSync(brunoPath).size === 0) failures.push(`${endpointPath}: ${kind} Bruno 文件不存在或路径非法`);
  if (!resultPath || !existsSync(resultPath) || statSync(resultPath).size === 0) {
    failures.push(`${endpointPath}: ${kind} result_file 不存在或路径非法`);
    return;
  }
  if (!receiptPath || !existsSync(receiptPath) || statSync(receiptPath).size === 0) {
    failures.push(`${endpointPath}: ${kind} execution_receipt_file 不存在或路径非法`);
    return;
  }
  let receipt;
  try {
    receipt = readJson(receiptPath);
  } catch {
    failures.push(`${endpointPath}: ${kind} execution receipt 无法解析`);
    return;
  }
  const receiptRequired = ["command", "tool", "environment", "started_at", "finished_at", "exit_code", "stdout_file", "stderr_file", "result_file", "stdout_sha256", "stderr_sha256", "result_sha256", "status"];
  for (const field of receiptRequired) if (receipt[field] === undefined || receipt[field] === null || receipt[field] === "") failures.push(`${endpointPath}: ${kind} execution receipt 缺少 ${field}`);
  if (receipt.bruno_file !== value.bruno_file) failures.push(`${endpointPath}: ${kind} execution receipt 未绑定相同 bruno_file`);
  if (receipt.result_file !== value.result_file) failures.push(`${endpointPath}: ${kind} execution receipt 未绑定相同 result_file`);
  if (typeof receipt.command !== "string" || !receipt.command.includes(value.bruno_file)) failures.push(`${endpointPath}: ${kind} execution command 未引用 bruno_file`);
  if (Number(receipt.exit_code) !== 0 || String(receipt.status).toUpperCase() !== "PASS") failures.push(`${endpointPath}: ${kind} execution receipt 未通过`);
  const startedAt = Date.parse(receipt.started_at);
  const finishedAt = Date.parse(receipt.finished_at);
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) failures.push(`${endpointPath}: ${kind} execution 时间范围非法`);
  const stdoutPath = manifestPath(docsDir, receipt.stdout_file);
  const stderrPath = manifestPath(docsDir, receipt.stderr_file);
  for (const [path, field, label] of [[stdoutPath, "stdout_sha256", "stdout"], [stderrPath, "stderr_sha256", "stderr"], [resultPath, "result_sha256", "result"]]) {
    if (!path || !existsSync(path) || statSync(path).size === 0) failures.push(`${endpointPath}: ${kind} ${label} 文件不存在或路径非法`);
    else if (hashFile(path) !== receipt[field]) failures.push(`${endpointPath}: ${kind} ${label} sha256 不匹配`);
  }
  if (receipt.result_sha256 !== value.result_sha256) failures.push(`${endpointPath}: ${kind} manifest/result sha256 不一致`);
  if (value.status && String(value.status).toUpperCase() !== "PASS") failures.push(`${endpointPath}: ${kind} evidence status 不是 PASS`);
  checks.delivery_evidence = (checks.delivery_evidence || 0) + 1;
}

function validateDeliveryArtifacts(failures, checks) {
  const manifestPath = state.delivery?.manifest_path || join(runDir, "DELIVERY-MANIFEST.json");
  if (!existsSync(manifestPath)) {
    failures.push("缺少 DELIVERY-MANIFEST.json；交付目录、接口变更和测试场景必须显式声明");
    return;
  }
  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch {
    failures.push("DELIVERY-MANIFEST.json 无法解析");
    return;
  }
  if (manifest.schema_version !== 2) failures.push("DELIVERY-MANIFEST.json schema_version 必须为 2");
  const manifestDocsDir = manifest.docs_dir;
  const requestedDocsDir = arg("--docs-dir");
  checks.delivery_manifest = manifestPath;
  checks.docs_dir = manifestDocsDir || null;
  if (!manifestDocsDir || !isAbsolute(manifestDocsDir) || !existsSync(manifestDocsDir)) {
    failures.push("DELIVERY-MANIFEST.json 必须声明存在的绝对 docs_dir");
    return;
  }
  if (requestedDocsDir && resolve(requestedDocsDir) !== resolve(manifestDocsDir)) {
    failures.push("--docs-dir 与 DELIVERY-MANIFEST.json.docs_dir 不一致；严格门禁禁止覆盖 manifest");
    return;
  }
  const docsDir = manifestDocsDir;
  const readmePath = join(docsDir, "README.md");
  const runMdPath = join(runDir, "RUN.md");
  for (const [path, label] of [[readmePath, "交付 README.md"], [runMdPath, "RUN.md"]]) {
    if (!existsSync(path) || statSync(path).size === 0) {
      failures.push(`${label} 缺失或为空`);
      continue;
    }
    const text = readFileSync(path, "utf8");
    if (containsPlaceholder(text)) failures.push(`${label} 含占位文本`);
  }
  if (existsSync(readmePath)) {
    const readme = readFileSync(readmePath, "utf8");
    for (const section of ["耗时与阶段结构", "过程产物与交付物索引", "业务修改点人话摘要", "残余风险与后续建议"]) {
      if (!readme.includes(section)) failures.push(`交付 README.md 缺少【${section}】`);
    }
  }
  if (manifest.interface_change === true) {
    if (!Array.isArray(manifest.changed_endpoints) || manifest.changed_endpoints.length === 0) {
      failures.push("接口发生变化，但 DELIVERY-MANIFEST.json 未列出 changed_endpoints");
    } else {
      const brunoDir = join(docsDir, "bruno");
      for (const endpoint of manifest.changed_endpoints) {
        const endpointLabel = `${endpoint.method || "UNKNOWN"} ${endpoint.path || "UNKNOWN"}`;
        if (!endpoint.method || !endpoint.path) failures.push("changed_endpoints 存在缺少 method/path 的条目");
        if (!Array.isArray(endpoint.positive_cases) || endpoint.positive_cases.length === 0) failures.push(`${endpointLabel}: 缺少 positive_cases`);
        if (!Array.isArray(endpoint.negative_cases) || endpoint.negative_cases.length === 0) failures.push(`${endpointLabel}: 缺少 negative_cases`);
        for (const [kind, cases] of [["positive_cases", endpoint.positive_cases], ["negative_cases", endpoint.negative_cases]]) {
          if (Array.isArray(cases)) for (const evidence of cases) validateEvidenceCase(failures, checks, docsDir, brunoDir, endpointLabel, kind, evidence);
        }
      }
    }
    const frontendDoc = join(docsDir, "前端接口交接文档.md");
    if (!existsSync(frontendDoc) || statSync(frontendDoc).size === 0) failures.push("接口发生变化，但缺少前端接口交接文档.md");
    else if (containsPlaceholder(readFileSync(frontendDoc, "utf8"))) failures.push("前端接口交接文档.md 含占位文本");
    const brunoDir = join(docsDir, "bruno");
    const bruFiles = findFilesRecursive(brunoDir, ".bru");
    if (!existsSync(join(brunoDir, "bruno.json")) || !existsSync(join(brunoDir, "environments")) || bruFiles.length === 0) {
      failures.push("接口发生变化，但 Bruno collection/environments/用例不完整");
    } else {
      const placeholders = bruFiles.filter((path) => containsPlaceholder(readFileSync(path, "utf8")));
      if (placeholders.length) failures.push(`Bruno 用例含占位内容: ${placeholders.map(basename).join(", ")}`);
      checks.bruno_test_count = bruFiles.length;
    }
  } else if (manifest.interface_change === false) {
    if (!manifest.interface_change_reason) failures.push("interface_change=false 时必须填写 interface_change_reason");
  } else {
    failures.push("DELIVERY-MANIFEST.json 必须显式声明 interface_change=true/false");
  }
}

function validateWorkflowModeEvidence(failures, checks) {
  const mode = state.workflow_mode;
  checks.workflow_mode = mode;
  if (mode !== "quick-code") {
    const deploymentPath = state.deployment_path || join(runDir, "DEPLOYMENT.md");
    if (finalNonEmptyLine(deploymentPath) !== "WORKFLOW_VERDICT: DEPLOYED") failures.push("DEPLOYMENT.md 未以 DEPLOYED 结束");
  }
  if (mode === "release") {
    const verificationPath = state.verification_path || join(runDir, "VERIFICATION.md");
    const auditPath = state.final_audit_path || join(runDir, "FINAL-AUDIT.md");
    if (finalNonEmptyLine(verificationPath) !== "WORKFLOW_VERDICT: VERIFIED") failures.push("release 模式缺少有效 VERIFICATION.md");
    if (finalNonEmptyLine(auditPath) !== "WORKFLOW_VERDICT: AUDITED_PASS") failures.push("release 模式缺少有效 FINAL-AUDIT.md");
  }
}

function currentNotificationExpectation() {
  const eventByState = {
    AWAITING_PLAN_APPROVAL: "plan_approval",
    ARCHITECTURE_GATE: "architecture_gate",
    ESCALATED: "escalation",
    AWAITING_DEPLOY_APPROVAL: "deploy_approval",
    COMPLETE: "complete"
  };
  const event = eventByState[state.status];
  if (!event) return null;
  let revision = Number(state.state_revision) || 0;
  const eventsPath = join(runDir, "events.jsonl");
  if (existsSync(eventsPath)) {
    const events = readFileSync(eventsPath, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    const entry = [...events].reverse().find((item) => ["transition", "round_created"].includes(item.kind) && item.to === state.status);
    if (entry?.revision) revision = Number(entry.revision);
  }
  return { event, revision, notification_id: `${state.run_id || basename(runDir)}:${revision}:${event}` };
}

function validateNotificationEvidence(warnings, checks) {
  const expected = currentNotificationExpectation();
  if (!expected) return;
  const ledgerPath = join(runDir, "notifications.json");
  checks.notification = { expected, ledger_path: ledgerPath };
  if (!existsSync(ledgerPath)) {
    warnings.push(`当前用户决策门缺少通知 outbox: ${expected.notification_id}`);
    return;
  }
  let ledger;
  try {
    ledger = readJson(ledgerPath);
  } catch (error) {
    warnings.push(`通知 outbox 无法解析: ${error.message}`);
    return;
  }
  const item = (ledger.notifications || []).find((entry) => entry.notification_id === expected.notification_id);
  if (!item) {
    warnings.push(`当前用户决策门没有对应通知项: ${expected.notification_id}`);
    return;
  }
  const telegramOk = item.deliveries?.telegram?.ok === true;
  const emailOk = item.deliveries?.email?.ok === true;
  checks.notification.item = {
    status: item.status,
    telegram_ok: telegramOk,
    email_ok: emailOk,
    attempts: Array.isArray(item.attempts) ? item.attempts.length : 0
  };
  if (!telegramOk && !emailOk) warnings.push(`通知尚未通过 Telegram 或邮件触达用户: ${expected.notification_id}`);
  if (item.status === "partial") warnings.push(`通知仅部分通道成功，需执行 notify-pending 重试: ${expected.notification_id}`);
  if (["pending", "failed", "dispatching"].includes(item.status)) warnings.push(`通知状态为 ${item.status}，需检查并重试: ${expected.notification_id}`);
}

function validationAudit({ requireReview = false, requireApproved = false, requireRemote = false, requireWorktree = false, completion = false } = {}) {
  const failures = [];
  const warnings = [];
  const checks = { schema_version: state.schema_version || null, status: state.status || null, state_revision: state.state_revision || 0 };
  if ((state.schema_version || 0) < 4) warnings.push("legacy schema：不会自动迁移；新 transition 的严格契约以 schema_version 4 为准");
  if (completion && state.schema_version !== 4) failures.push("COMPLETE/完成通知只接受 schema_version=4；legacy run 必须显式迁移");
  validateNotificationEvidence(warnings, checks);
  validateWorkflowModeContract(failures, checks, { requireFrozen: completion });
  const reviewRequired = requireReview || requireApproved || requireRemote || completion || ["VALIDATED", "AWAITING_DEPLOY_APPROVAL", "DEPLOYING", "VERIFYING", "FINAL_AUDITING", "DELIVERY_GATE", "COMPLETE"].includes(state.status);
  if (reviewRequired) {
    validateReview(failures, checks);
    validateFindings(failures, checks);
  }
  if (state.active_plan_sha256 || reviewRequired) validateHashes(failures, checks);
  if (Array.isArray(state.open_gates) && state.open_gates.length) failures.push(`仍有 open_gates: ${state.open_gates.join(", ")}`);
  validateRepositories(failures, warnings, checks, { requireReviewed: reviewRequired, requireApproved, requireRemote, requireWorktree });
  if (requireApproved) validateDeployApproval(failures, checks);
  if (completion) {
    validateRounds(failures);
    validateDeliveryArtifacts(failures, checks);
    validateWorkflowModeEvidence(failures, checks);
  }
  return { ok: failures.length === 0, failures, warnings, checks };
}

function updateTaskIndex(state) {
  const indexPath = join(resolve(runDir, "..", ".."), "index.json");
  if (!existsSync(indexPath)) return false;
  const index = readJson(indexPath);
  const tasks = Array.isArray(index.tasks) ? index.tasks : [];
  const task = tasks.find((item) => item.run_id === state.run_id);
  if (!task) return false;
  task.status = state.status;
  task.branch = state.pushed_branch || task.branch;
  task.updated_at = new Date().toISOString();
  index.updated_at = task.updated_at;
  atomicJson(indexPath, index);
  return true;
}

if (command === "record-decision") {
  const rawEvent = arg("--event");
  const choice = arg("--choice");
  if (!rawEvent || !choice) throw new Error("record-decision requires --event and --choice");
  const eventAliases = {
    awaiting_plan_approval: "plan_approval",
    awaiting_deploy_approval: "deploy_approval"
  };
  const event = eventAliases[rawEvent] || rawEvent;
  // Gate state validation
  const expectedStates = {
    plan_approval: ["AWAITING_PLAN_APPROVAL"],
    architecture_gate: ["ARCHITECTURE_GATE"],
    escalation: ["ESCALATED"],
    deploy_approval: ["AWAITING_DEPLOY_APPROVAL"],
    resume: ["PAUSED_BY_USER"],
    finding_decision: ["FINDING_TRIAGE", "ARCHITECTURE_GATE", "ESCALATED"],
    recovery: ["ARCHITECTURE_GATE", "ESCALATED", "PAUSED_BY_USER"]
  };
  if (expectedStates[event] && !expectedStates[event].includes(state.status)) {
    throw new Error(`stale or out-of-gate decision: ${event} requires ${expectedStates[event].join("/")}, current state is ${state.status}`);
  }
  const gateRevisionText = arg("--gate-revision");
  let gateRevision = null;
  if (gateRevisionText !== undefined) {
    gateRevision = Number(gateRevisionText);
    const expected = currentNotificationExpectation();
    if (!Number.isInteger(gateRevision) || !expected || expected.event !== event || expected.revision !== gateRevision) {
      throw new Error(`stale callback revision: ${event}:${gateRevisionText}, current gate is ${expected ? `${expected.event}:${expected.revision}` : "none"}`);
    }
  }
  const decisionPath = state.decision_path || join(runDir, "decision.json");
  let payload = { schema_version: 1, decision_revision: 0, decisions: [] };
  if (existsSync(decisionPath)) {
    const existing = readJson(decisionPath);
    if (Array.isArray(existing)) payload.decisions = existing;
    else if (Array.isArray(existing.decisions)) payload = existing;
    else if (existing.event) payload.decisions = [existing];
  }
  const decision = {
    id: arg("--id") || randomUUID(),
    event,
    choice,
    original_text: arg("--original-text") || choice,
    channel: arg("--channel") || "coordinator",
    timestamp: new Date().toISOString(),
    state_revision: Number(state.state_revision) || 0
  };
  // Check for duplicate decision ID
  const duplicate = (payload.decisions || []).find((entry) => entry.id === decision.id);
  if (duplicate) {
    if (duplicate.event !== decision.event || duplicate.choice !== decision.choice) {
      throw new Error(`decision id collision: ${decision.id}`);
    }
    console.log(JSON.stringify({ ...duplicate, deduplicated: true, state_revision: state.state_revision }, null, 2));
    process.exit(0);
  }
  if (event === "plan_approval") {
    decision.plan_sha256 = state.active_plan_sha256 || null;
    decision.requirements_sha256 = state.requirements_sha256 || null;
  }
  if (event === "deploy_approval") {
    decision.approved_commits = Object.fromEntries(repositoryEntries(state)
      .filter((repo) => repo.name && repo.reviewed_commit)
      .map((repo) => [repo.name, repo.reviewed_commit]));
    decision.operations = Array.isArray(state.proposed_deployment_operations) ? state.proposed_deployment_operations : [];
  }
  if (event === "architecture_gate") decision.plan_sha256 = state.active_plan_sha256 || null;
  if (event === "escalation") decision.next_round = (Number(state.current_round) || 0) + 1;
  if (event === "finding_decision") decision.finding_ids = String(arg("--finding-ids") || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (event === "mode_change") {
    decision.from_mode = arg("--from-mode") || state.workflow_mode_frozen || state.workflow_mode || null;
    decision.to_mode = arg("--to-mode") || null;
  }
  if (gateRevision !== null) decision.gate_revision = gateRevision;
  const sourceMessageId = arg("--source-message-id");
  if (sourceMessageId) decision.source_message_id = sourceMessageId;
  payload.schema_version = 1;
  payload.decision_revision = (Number(payload.decision_revision) || 0) + 1;
  payload.decisions = [...(payload.decisions || []), decision];
  atomicJson(decisionPath, payload);
  state.decision_revision = payload.decision_revision;
  commitStateMutation("decision_recorded", { details: { decision_id: decision.id, decision_event: event, decision_choice: choice } });
  console.log(JSON.stringify({ ...decision, state_revision: state.state_revision }, null, 2));
  process.exit(0);
}

if (command === "audit") {
  const result = validationAudit({
    requireApproved: hasFlag("--approved") || state.status === "DEPLOYING" || state.status === "DELIVERY_GATE" || state.status === "COMPLETE",
    requireRemote: hasFlag("--remote") || state.status === "DELIVERY_GATE" || state.status === "COMPLETE",
    requireWorktree: hasFlag("--worktree"),
    completion: hasFlag("--complete") || state.status === "COMPLETE"
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

if (command === "reconcile") {
  const audit = validationAudit({ requireApproved: false, requireRemote: false, completion: false });
  const indexPath = join(resolve(runDir, "..", ".."), "index.json");
  let indexStatus = null;
  if (existsSync(indexPath)) {
    const index = readJson(indexPath);
    indexStatus = (index.tasks || []).find((item) => item.run_id === state.run_id)?.status || null;
  }
  const drift = [];
  if (indexStatus !== state.status) drift.push(`tasks/index.json status=${indexStatus || "MISSING"}, state.json status=${state.status}`);
  let wrote = false;
  let remainingDrift = [...drift];
  if (hasFlag("--write")) {
    wrote = updateTaskIndex(state);
    execFileSync("node", [resolve(process.argv[1]), "gen-nav", "--run", runDir], { stdio: "ignore" });
    if (wrote) remainingDrift = [];
    if (audit.ok && remainingDrift.length === 0) {
      state.last_reconciled_at = new Date().toISOString();
      state.last_reconcile_ok = true;
      state.last_reconciled_revision = (Number(state.state_revision) || 0) + 1;
      commitStateMutation("reconcile", { details: { repaired_drift: drift } });
    }
  }
  const result = { ok: audit.ok && remainingDrift.length === 0, wrote, drift, remaining_drift: remainingDrift, audit, state_revision: state.state_revision || 0 };
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

if (command === "notify-pending") {
  const result = notifyCurrentGate();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

if (command === "record-landing") {
  const repoName = arg("--repo-name");
  const commit = arg("--commit");
  const branch = arg("--branch");
  const remoteRef = arg("--remote-ref") || null;
  const roundNumber = Number(arg("--round") || state.current_round);
  const decisionId = arg("--decision-id");
  if (!repoName || !commit || !branch || !decisionId || !Number.isInteger(roundNumber) || roundNumber < 1) {
    throw new Error("record-landing requires --repo-name, --commit, --branch, --round and --decision-id");
  }
  const decision = decisionEntries().find((entry) => entry.id === decisionId);
  if (!decision || decision.event !== "recovery" || !/^confirm/i.test(String(decision.choice || ""))) {
    throw new Error("record-landing requires a recovery decision whose choice starts with confirm");
  }
  const repositories = repositoryEntries(state);
  const index = repositories.findIndex((repo) => repo.name === repoName);
  if (index < 0) throw new Error(`unknown repository: ${repoName}`);
  const landing = {
    commit,
    branch,
    remote_ref: remoteRef,
    round: roundNumber,
    recorded_at: new Date().toISOString(),
    decision_id: decisionId,
    worktree_cleanup: {
      authorized: hasFlag("--worktree-cleaned"),
      confirmed_at: decision.timestamp || new Date().toISOString(),
      decision_id: decisionId
    }
  };
  const verified = verifyLandingEvidence(repositories[index], landing);
  if (!verified.ok) {
    console.log(JSON.stringify({ ok: false, repository: repoName, verification: verified }, null, 2));
    process.exit(1);
  }
  repositories[index].landing = landing;
  state.repositories = repositories;
  commitStateMutation("repository_landing_recorded", {
    details: {
      repository: repoName,
      landing_commit: commit,
      landing_branch: branch,
      reviewed_round: roundNumber,
      recovery_decision_id: decisionId,
      worktree_cleanup_authorized: landing.worktree_cleanup.authorized,
      verification: verified.checks
    }
  });
  console.log(JSON.stringify({ ok: true, repository: repoName, landing, verification: verified.checks, state_revision: state.state_revision }, null, 2));
  process.exit(0);
}

if (command === "transition") {
  const to = arg("--to");
  if (!to) throw new Error("transition requires --to <state>");
  if ((state.schema_version || 0) < 4) throw new Error("legacy run must be migrated explicitly before transition; automatic migration is forbidden");
  const allowed = {
    NEW: ["PREFLIGHTING", "REQUIREMENTS_READY", "PAUSED_BY_USER"],
    PREFLIGHTING: ["GRILL_ME", "REQUIREMENTS_READY", "PAUSED_BY_USER"],
    GRILL_ME: ["REQUIREMENTS_READY", "PAUSED_BY_USER"],
    REQUIREMENTS_READY: ["PLANNING", "PAUSED_BY_USER"],
    PLANNING: ["PLAN_READY", "PAUSED_BY_USER"],
    PLAN_READY: ["AWAITING_PLAN_APPROVAL", "PAUSED_BY_USER"],
    AWAITING_PLAN_APPROVAL: ["PLAN_REVISION", "PAUSED_BY_USER"],
    IMPLEMENTING: ["SELF_CHECKING", "PAUSED_BY_USER"],
    SELF_CHECKING: ["REVIEWING", "IMPLEMENTING", "PAUSED_BY_USER"],
    REVIEWING: ["FINDING_TRIAGE", "VALIDATED", "PAUSED_BY_USER"],
    FINDING_TRIAGE: ["PLAN_REVISION", "SOL_ADVISORY", "ARCHITECTURE_GATE", "VALIDATED", "ESCALATED", "PAUSED_BY_USER"],
    PLAN_REVISION: ["AWAITING_PLAN_APPROVAL", "ARCHITECTURE_GATE", "PAUSED_BY_USER"],
    SOL_ADVISORY: ["ARCHITECTURE_GATE", "FINDING_TRIAGE", "PAUSED_BY_USER"],
    ARCHITECTURE_GATE: ["PLAN_REVISION", "SOL_ADVISORY", "ESCALATED", "PAUSED_BY_USER"],
    VALIDATED: ["AWAITING_DEPLOY_APPROVAL", "DELIVERY_GATE", "PAUSED_BY_USER"],
    AWAITING_DEPLOY_APPROVAL: ["DEPLOYING", "PAUSED_BY_USER"],
    DEPLOYING: ["VERIFYING", "DELIVERY_GATE", "PAUSED_BY_USER"],
    VERIFYING: ["FINAL_AUDITING", "DELIVERY_GATE", "DEPLOYMENT_FAILED", "PAUSED_BY_USER"],
    FINAL_AUDITING: ["VERIFYING", "DELIVERY_GATE", "PAUSED_BY_USER"],
    DELIVERY_GATE: ["COMPLETE", "PAUSED_BY_USER"],
    PAUSED_BY_USER: ["PREFLIGHTING", "REQUIREMENTS_READY", "PLANNING", "AWAITING_PLAN_APPROVAL", "IMPLEMENTING", "REVIEWING", "VALIDATED", "AWAITING_DEPLOY_APPROVAL", "DEPLOYING", "VERIFYING", "FINAL_AUDITING", "DELIVERY_GATE"],
    ESCALATED: ["PLAN_REVISION", "SOL_ADVISORY", "PAUSED_BY_USER"],
    DEPLOYMENT_FAILED: ["AWAITING_DEPLOY_APPROVAL", "PAUSED_BY_USER"]
  };
  const from = state.status || "NEW";
  if (!(allowed[from] || []).includes(to)) throw new Error(`invalid transition: ${from} -> ${to}`);
  const transitionFailures = [];
  validateWorkflowModeContract(transitionFailures, {}, { requireFrozen: true });
  validateTransitionArtifact(to, transitionFailures);
  if (from === "VALIDATED" && to === "DELIVERY_GATE" && state.workflow_mode !== "quick-code") {
    transitionFailures.push("只有 quick-code 可以从 VALIDATED 直接进入 DELIVERY_GATE");
  }
  if (from === "SOL_ADVISORY" && finalNonEmptyLine(state.sol_advisory_path || join(runDir, "SOL-ADVISORY.md")) !== "WORKFLOW_VERDICT: SOL_ADVISORY") {
    transitionFailures.push("离开 SOL_ADVISORY 前需要有效咨询产物");
  }
  if (from === "PAUSED_BY_USER") {
    if (to !== state.resume_target_state) transitionFailures.push(`暂停恢复只能回到原状态 ${state.resume_target_state || "MISSING"}`);
    validateResume(transitionFailures, arg("--resume-decision"));
  }
  if (transitionFailures.length) {
    console.log(JSON.stringify({ ok: false, transition: `${from} -> ${to}`, failures: transitionFailures }, null, 2));
    process.exit(1);
  }
  let gate = { ok: true, failures: [], warnings: [], checks: {} };
  const quickCode = state.workflow_mode === "quick-code";
  if (to === "VALIDATED") gate = validationAudit({ requireReview: true, requireWorktree: true });
  if (to === "DEPLOYING") gate = validationAudit({ requireApproved: true, requireWorktree: true });
  if (to === "DELIVERY_GATE") gate = validationAudit({ requireApproved: !quickCode, requireRemote: true });
  if (to === "COMPLETE") gate = validationAudit({ requireApproved: !quickCode, requireRemote: true, completion: true });
  if (!gate.ok) {
    console.log(JSON.stringify({ ok: false, transition: `${from} -> ${to}`, gate }, null, 2));
    process.exit(1);
  }
  if (to === "PAUSED_BY_USER") {
    state.paused_at = new Date().toISOString();
    state.resume_target_state = from;
  } else if (from === "PAUSED_BY_USER") {
    state.paused_at = null;
    state.resume_target_state = null;
  }
  state.status = to;
  state.last_transition_at = new Date().toISOString();
  commitStateMutation("transition", { from, to });
  updateTaskIndex(state);
  execFileSync("node", [resolve(process.argv[1]), "gen-nav", "--run", runDir], { stdio: "ignore" });
  releaseRunLock();
  const notification = notifyCurrentGate();
  console.log(JSON.stringify({ ok: true, from, to, gate, notification }, null, 2));
  process.exit(0);
}

if (command === "freeze") {
  const requirementsPath = state.requirements_path || join(runDir, "REQUIREMENTS.md");
  const planPath = state.active_plan_path || state.plan_path || join(runDir, "PLAN.md");
  const globalConfigPath = resolve(dirname(process.argv[1]), "..", "config.json");
  if (!state.resolved_config) state.resolved_config = existsSync(globalConfigPath) ? readJson(globalConfigPath) : {};
  if (!state.workflow_mode) state.workflow_mode = state.resolved_config?.workflow?.default_mode || "standard";
  const requirementsText = readFileSync(requirementsPath, "utf8");
  const planText = readFileSync(planPath, "utf8");
  const requestedMode = state.workflow_mode;
  state.requirements_sha256 = hashFile(requirementsPath);
  state.active_plan_sha256 = hashFile(planPath);
  const risk = detectRiskMode(requirementsText, planText, state, repositoryChangedFiles(state));
  state.risk_mode_floor = risk.mode_floor;
  state.risk_triggers = risk.triggers;
  state.risk_assessment_path = state.risk_assessment_path || join(runDir, "RISK-ASSESSMENT.json");
  atomicJson(state.risk_assessment_path, {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    requirements_path: requirementsPath,
    plan_path: planPath,
    requirements_sha256: hashFile(requirementsPath),
    active_plan_sha256: hashFile(planPath),
    declared_mode: requestedMode,
    required_mode: risk.mode_floor,
    triggers: risk.triggers,
    changed_files: risk.changed_files,
    decision: workflowModes.indexOf(requestedMode) < workflowModes.indexOf(risk.mode_floor) ? "auto_upgrade" : "accepted"
  });
  if (workflowModes.indexOf(state.workflow_mode) < workflowModes.indexOf(risk.mode_floor)) {
    state.workflow_mode = risk.mode_floor;
    state.risk_mode_auto_upgraded = true;
  }
  const modeFailures = [];
  validateWorkflowModeContract(modeFailures);
  if (modeFailures.length) throw new Error(modeFailures.join("; "));
  state.requirements_sha256 = hashFile(requirementsPath);
  state.active_plan_sha256 = hashFile(planPath);
  state.workflow_mode_frozen = state.workflow_mode;
  state.workflow_mode_frozen_at = new Date().toISOString();
  state.resolved_config_sha256 = hashText(jsonText(state.resolved_config));
  state.plan_frozen_at = new Date().toISOString();
  commitStateMutation("freeze", { details: { requirements_sha256: state.requirements_sha256, active_plan_sha256: state.active_plan_sha256, workflow_mode: state.workflow_mode, risk_mode_floor: state.risk_mode_floor, risk_triggers: state.risk_triggers, auto_upgraded: state.risk_mode_auto_upgraded === true, resolved_config_sha256: state.resolved_config_sha256 } });
  console.log(JSON.stringify({ requirements_sha256: state.requirements_sha256, active_plan_sha256: state.active_plan_sha256, workflow_mode: state.workflow_mode, risk_mode_floor: state.risk_mode_floor, risk_triggers: state.risk_triggers, resolved_config_sha256: state.resolved_config_sha256, state_revision: state.state_revision }));
  process.exit(0);
}

if (command === "round") {
  if ((state.schema_version || 0) < 4) throw new Error("legacy run must be migrated explicitly before creating a schema v4 round");
  const allowedRoundStates = new Set(["AWAITING_PLAN_APPROVAL", "FINDING_TRIAGE", "ARCHITECTURE_GATE", "ESCALATED"]);
  if (state.workflow_mode === "quick-code") allowedRoundStates.add("REQUIREMENTS_READY");
  if (!allowedRoundStates.has(state.status)) throw new Error(`cannot create round from state ${state.status}`);
  if (!state.requirements_sha256 || !state.active_plan_sha256) throw new Error("freeze requirements and active plan before creating a round");
  const previousStatus = state.status;
  const remediationSource = arg("--remediation");
  const rounds = Array.isArray(state.rounds) ? state.rounds : [];
  const number = rounds.reduce((max, round) => Math.max(max, Number(round.number) || 0), 0) + 1;
  const entryFailures = validateRoundEntry(previousStatus, remediationSource, number);
  if (entryFailures.length) {
    console.log(JSON.stringify({ ok: false, from: previousStatus, failures: entryFailures }, null, 2));
    process.exit(1);
  }
  const roundFamilyAttempts = {};
  if (previousStatus === "FINDING_TRIAGE") {
    const terminal = new Set(["VERIFIED_CLOSED", "DEFERRED_BY_USER", "ACCEPTED_BY_USER", "OUT_OF_SCOPE_BY_USER"]);
    const families = [...new Set((findingEntries() || [])
      .filter((finding) => !terminal.has(String(finding.status || "").toUpperCase()))
      .map(findingFamily))];
    state.finding_family_attempts = { ...(state.finding_family_attempts || {}) };
    for (const family of families) {
      state.finding_family_attempts[family] = (Number(state.finding_family_attempts[family]) || 0) + 1;
      roundFamilyAttempts[family] = state.finding_family_attempts[family];
    }
  }
  const label = String(number).padStart(2, "0");
  const roundDir = join(runDir, "rounds", label);
  if (existsSync(roundDir)) throw new Error(`round directory already exists: ${roundDir}`);
  mkdirSync(roundDir, { recursive: true });
  const metadata = {
    number,
    created_at: new Date().toISOString(),
    requirements_sha256: state.requirements_sha256 || null,
    active_plan_path: state.active_plan_path || state.plan_path || null,
    active_plan_sha256: state.active_plan_sha256 || null,
    implementer: { agent_name: null, pane_id: null, session: null, status: "pending" },
    reviewer: { agent_name: null, pane_id: null, session: null, status: "pending" },
    head_before: null,
    head_after_implementation: null,
    head_reviewed: null,
    reviewed_commits: null,
    verdict: null,
    finding_classifications: [],
    finding_family_attempts: roundFamilyAttempts
  };
  atomicJson(join(roundDir, "metadata.json"), metadata);
  const remediationText = remediationSource
    ? readFileSync(remediationSource, "utf8")
    : "# Remediation\n\nInitial implementation round; no prior findings.\n";
  writeFileSync(join(roundDir, "REMEDIATION.md"), remediationText, "utf8");
  for (const file of ["IMPLEMENTATION.md", "TEST-RESULTS.md", "REVIEW.md"]) {
    writeFileSync(join(roundDir, file), "", "utf8");
  }
  rounds.push({
    number,
    metadata_path: join(roundDir, "metadata.json"),
    remediation_path: join(roundDir, "REMEDIATION.md"),
    implementation_path: join(roundDir, "IMPLEMENTATION.md"),
    test_results_path: join(roundDir, "TEST-RESULTS.md"),
    review_path: join(roundDir, "REVIEW.md"),
    implementer: metadata.implementer,
    reviewer: metadata.reviewer,
    head_before: null,
    head_reviewed: null,
    verdict: null
  });
  state.rounds = rounds;
  state.current_round = number;
  state.status = "IMPLEMENTING";
  state.last_transition_at = new Date().toISOString();
  commitStateMutation("round_created", { from: previousStatus, to: "IMPLEMENTING", details: { round: number } });
  updateTaskIndex(state);
  execFileSync("node", [resolve(process.argv[1]), "gen-nav", "--run", runDir], { stdio: "ignore" });
  console.log(JSON.stringify({ number, round_dir: roundDir, from: previousStatus, to: "IMPLEMENTING" }));
  process.exit(0);
}

function runIdNavTitle(state) {
  // 从 objective 提取简短标题（第一行 / 第一个冒号前），回退到 run 目录名
  const obj = state && state.objective ? String(state.objective).trim() : "";
  if (obj) {
    const first = obj.split("\n")[0].trim();
    const cut = first.split("：")[0].split(":")[0].trim();
    return cut.length > 0 && cut.length <= 60 ? cut : first.slice(0, 60);
  }
  return basename(runDir);
}

const markdownTick = String.fromCharCode(96);

function markdownCode(value) {
  return `${markdownTick}${value}${markdownTick}`;
}

function overviewRoundDirs() {
  const roundsDir = join(runDir, "rounds");
  if (!existsSync(roundsDir)) return [];
  return readdirSync(roundsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => ({ number: Number(entry.name), label: entry.name, path: join(roundsDir, entry.name) }))
    .sort((a, b) => a.number - b.number);
}

function latestReviewEvidence() {
  const candidates = overviewRoundDirs().reverse();
  for (const round of candidates) {
    const path = join(round.path, "REVIEW.md");
    if (existsSync(path) && statSync(path).size > 0) {
      return { number: round.number, path, verdict: finalNonEmptyLine(path) };
    }
  }
  return null;
}

function overviewFindingStats() {
  const entries = findingEntries() || [];
  const terminal = (status) => /^(VERIFIED_CLOSED|DEFERRED_BY_USER|ACCEPTED_BY_USER|OUT_OF_SCOPE_BY_USER)/.test(String(status || "").toUpperCase());
  return {
    total: entries.length,
    closed: entries.filter((finding) => terminal(finding.status)).length,
    open: entries.filter((finding) => !terminal(finding.status)).length
  };
}

function overviewCommit(stateValue, repo, latest) {
  const reviewed = { ...parseCommitMap(stateValue.reviewed_commit), ...parseCommitMap(stateValue.reviewed_commits) };
  const approved = parseCommitMap(stateValue.approved_commit);
  const name = repo.name || "repo";
  return repo.approved_commit || repo.reviewed_commit || approved[name] || reviewed[name]
    || latest?.[`${name}_head`] || latest?.implementer_final?.[`${name}_head`] || null;
}

function overviewRepositoryLines(stateValue) {
  const latest = latestRound(stateValue) || {};
  return repositoryEntries(stateValue).map((repo) => {
    const name = repo.name || "repo";
    const branch = repo.pushed_branch || stateValue.pushed_branch || repo.branch || "unknown";
    const commit = overviewCommit(stateValue, repo, latest);
    return `- ${markdownCode(name)}: branch=${markdownCode(branch)}${commit ? `, commit=${markdownCode(commit)}` : ", commit=未绑定"}`;
  });
}

function overviewRunStart(runId) {
  const match = String(runId || "").match(/^(\d{4})(\d{2})(\d{2})[-_](\d{2})(\d{2})(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}（由 run_id 推断）` : "未记录";
}

const knownTaskTiming = {};

function overviewTimingTable(stateValue) {
  const runId = stateValue.run_id || basename(runDir);
  const known = knownTaskTiming[runId];
  if (known) {
    const phaseRows = known.phases.map((p) =>
      `| **${p.phase}** | \`${p.role}\` | ${p.actions} | **${p.duration}** | **${p.percent}** |`
    ).join("\n");

    return `### 1. 耗时概况
| 任务标识 | 业务需求 | 启动与交付时间 | 自然总跨度 | 有效机器耗时 |
|---|---|---|---|---|
| \`${runId}\` | **${known.req}** | ${known.startEnd} | ${known.totalSpan} | **${known.machineTime}** |

### 2. 各阶段耗时与占比明细
| 研发阶段 | 负责角色 / 模型 | 核心动作 | 阶段耗时 | 耗时占比 |
|---|---|---|---|---|
${phaseRows}`;
  }

  const start = overviewRunStart(runId);
  const end = stateValue.push?.at || stateValue.deployment?.at || stateValue.last_transition_at || "进行中";
  return `| 任务标识 | 启动时间 | 交付/最新时间 | 状态 | 当前轮次 |
|---|---|---|---|---|
| \`${runId}\` | ${start} | ${end} | \`${stateValue.status || "NEW"}\` | Round ${String(stateValue.current_round || 1).padStart(2, "0")} |`;
}

function overviewCoordinatorSession(stateValue) {
  const coord = stateValue.coordinator;
  const sId = coord?.session_id || coord?.id || null;
  const sFile = coord?.session_file || coord?.file || null;
  const cmd = sId
    ? `cd ${process.env.HERDR_WORKSPACE_ROOT || "<project-root>"} && pi --session ${sId}`
    : (sFile ? `pi --session ${sFile}` : "-");

  const sessionStr = sId ? `\`${sId}\`` : (sFile ? `\`${basename(sFile)}\`` : "-");

  return `| 主控角色 | Agent 模型 | 会话标识 (Session ID) | 一键追问 / 恢复命令 |
|---|---|---|---|
| **🎯 Coordinator (总控)** | \`${stateValue.resolved_config?.coordinator?.model || "Pi"}\` | ${sessionStr} | \`${cmd}\` |

> 💡 *子角色（Planner / Implementer / Reviewer）的独立会话已留存在 \`state.json\` 中；恢复主控会话后可直接向主控提问调取，无需手动切换。*`;
}

function overviewTimingLines(stateValue) {
  const lines = [
    `- **任务启动**: ${overviewRunStart(stateValue.run_id)}`,
  ];
  if (stateValue.preflight?.closed_at) {
    lines.push(`- **前置调研完成**: ${stateValue.preflight.closed_at}`);
  }
  if (stateValue.planner?.closed_at) {
    lines.push(`- **规划完成**: ${stateValue.planner.closed_at}`);
  }
  if (stateValue.plan_approved_at) {
    lines.push(`- **计划批准**: ${stateValue.plan_approved_at}`);
  }
  if (stateValue.deployment?.at) {
    lines.push(`- **部署实测**: ${stateValue.deployment.at}`);
  }
  if (stateValue.push?.at) {
    lines.push(`- **分支推送**: ${stateValue.push.at}`);
  }
  if (stateValue.last_transition_at) {
    lines.push(`- **最新状态流转**: ${stateValue.last_transition_at}`);
  }
  return lines.join("\n");
}

function overviewDocsDir(stateValue) {
  const value = stateValue.delivery?.docs_dir || arg("--docs-dir");
  return value ? resolve(value) : null;
}

function overviewBrunoCollections(docsDir) {
  const result = [];
  const seen = new Set();
  const add = (path) => {
    const resolved = resolve(path);
    if (!seen.has(resolved) && existsSync(join(resolved, "bruno.json"))) {
      seen.add(resolved);
      result.push(resolved);
    }
  };
  if (docsDir) add(join(docsDir, "bruno"));
  const roots = [join(runDir, "bruno"), join(runDir, "deliverables")];
  const walk = (current) => {
    if (!existsSync(current) || !statSync(current).isDirectory()) return;
    if (existsSync(join(current, "bruno.json"))) add(current);
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(current, entry.name));
    }
  };
  for (const root of roots) walk(root);
  return result;
}

function runArtifactLink(label, relativePath) {
  const actual = String(relativePath).replace("NN", String(state.current_round || "NN").padStart(2, "0"));
  const path = join(runDir, actual);
  return existsSync(path) && (!statSync(path).isFile() || statSync(path).size > 0)
    ? `[${label}](./${encodeURI(actual)})`
    : `${markdownCode(actual)}（未发现）`;
}

function externalArtifactLink(label, path) {
  return path && existsSync(path) ? `[${label}](${encodeURI(path)})` : `${markdownCode(label)}（未发现）`;
}

function legacyStatusNote(stateValue, review) {
  const schema = Number(stateValue.schema_version) || 0;
  if (schema < 4) {
    return `本 run 使用 legacy schema v${schema || "?"}。本次只补齐导航和交付投影，不改写 ${markdownCode("state.json")}、原始 Review 或历史验收结论；它不能直接通过当前 schema v4 完成门禁。`;
  }
  if (stateValue.status === "COMPLETE" && review && review.verdict !== "WORKFLOW_VERDICT: PASS") {
    return `${markdownCode("state.json")} 标记为 COMPLETE，但最新独立 Review 为 ${markdownCode(review.verdict || "未形成 verdict")}；两者存在冲突，不能把旧状态当作当前认证结果。`;
  }
  return "";
}

function renderDeliveryOverview(stateValue, docsDir) {
  const review = latestReviewEvidence();
  const findingStats = overviewFindingStats();
  const legacy = (Number(stateValue.schema_version) || 0) < 4;
  const runTitle = runIdNavTitle(stateValue);
  const runReadme = join(runDir, "README.md");
  const localDocs = [
    ["前端接口交接文档.md", join(docsDir, "前端接口交接文档.md")],
    ["bruno/", join(docsDir, "bruno")],
    ["sql/", join(docsDir, "sql")],
    ["验收/", join(docsDir, "验收")]
  ].filter(([, path]) => existsSync(path));
  const processArtifacts = [
    ["run 总览与导航", runReadme],
    ["RUN.md", join(runDir, "RUN.md")],
    ["REQUIREMENTS.md", join(runDir, "REQUIREMENTS.md")],
    ["PREFLIGHT.md", join(runDir, "PREFLIGHT.md")],
    ["PLAN.md", join(runDir, "PLAN.md")],
    ["PLAN-SUMMARY.md", join(runDir, "PLAN-SUMMARY.md")],
    ["FINDINGS.json", join(runDir, "FINDINGS.json")],
    ["FINDING-TRACEABILITY.md", join(runDir, "FINDING-TRACEABILITY.md")],
    ["DEPLOYMENT.md", join(runDir, "DEPLOYMENT.md")],
    ["VERIFICATION.md", join(runDir, "VERIFICATION.md")],
    ["FINAL-AUDIT.md", join(runDir, "FINAL-AUDIT.md")]
  ].filter(([, path]) => existsSync(path));
  const latestReviewLine = review ? `Round ${String(review.number).padStart(2, "0")}: ${review.verdict || "未形成 verdict"}` : "未发现 Review";
  const statusLabel = legacy ? `历史归档（state=${stateValue.status || "UNKNOWN"}，未迁移）` : `state=${stateValue.status || "UNKNOWN"}`;
  const docsLines = localDocs.length
    ? localDocs.map(([label, path]) => `- ${externalArtifactLink(label, path)}`).join("\n")
    : "- 当前功能目录没有已归档的交付文件。";
  const processLines = processArtifacts.map(([label, path]) => `- ${externalArtifactLink(label, path)}`).join("\n");
  return `# 📦 ${runTitle} — 任务复盘与交付总览

> 本页是功能目录的业务交接摘要；执行过程的唯一总览入口是 ${externalArtifactLink("run README", runReadme)}。\n> 当前归档状态：**${statusLabel}**。最新独立 Review：**${latestReviewLine}**；Finding：${findingStats.closed}/${findingStats.total} 已闭环，${findingStats.open} 条仍需处理或保留决策。

## ⏱️ 耗时与阶段结构
${overviewTimingTable(stateValue)}

## 🔑 核心会话与追问命令
${overviewCoordinatorSession(stateValue)}

## 🔗 过程产物与交付物索引
### 过程与思考材料
${processLines}

### 功能交接材料
${docsLines}

## 🎯 业务修改点人话摘要
${stateValue.objective ? `- ${stateValue.objective}` : "- 目标未记录。"}

## 🧪 测试请求集合
${existsSync(join(docsDir, "bruno")) ? `- ${externalArtifactLink("统一 Bruno collection", join(docsDir, "bruno"))}` : "- 当前功能目录没有统一 Bruno collection；已有请求材料请先按功能归档后再执行运行时验收。"}

## ⚠️ 残余风险与后续建议
- ${legacyStatusNote(stateValue, review) || "当前页面由 workflow 证据投影生成，详细风险以 RUN.md、最新 Review 和验证报告为准。"}
- 该页不制造测试 PASS、Review PASS、部署成功或用户批准；所有结论必须回到对应原始证据。
`;
}

// P5: 从 state.json 同步 RUN.md 中机器可维护 section 的状态行。
// 策略：仅替换「- Status: ...」形态的行；人工写的多行内容不清除、不覆盖。
function syncRunMdSections(runMd, state) {
  const statusLabel = {
    pending: "PENDING",
    in_progress: "IN_PROGRESS",
    completed: "COMPLETED",
    failed: "FAILED",
    closed: "CLOSED",
  };
  const norm = (s) => statusLabel[String(s || "").toLowerCase()] || String(s || "PENDING").toUpperCase();

  const sectionMap = [
    { header: "## Preflight", value: state.preflight?.status ?? state.preflight?.status },
    { header: "## Planner", value: state.planner?.status },
    { header: "## Sol Advisory", value: state.sol?.status },
    { header: "## Deployment Approval", value: state.deployment_approval?.status ?? (state.status === "AWAITING_DEPLOY_APPROVAL" ? "AWAITING" : (state.status === "DEPLOYING" || state.status === "VERIFYING" || state.status === "COMPLETE" ? "DONE" : undefined)) },
    { header: "## Final Outcome", value: state.status === "COMPLETE" ? "COMPLETE" : state.status === "VALIDATED" ? "VALIDATED" : state.status === "IN_PROGRESS" || state.status.startsWith("IMPLEMENTING") || state.status === "PLANNING" || state.status === "REVIEWING" ? "IN_PROGRESS" : state.status },
  ];

  for (const { header, value } of sectionMap) {
    if (value === undefined || value === null) continue;
    const re = new RegExp(`(${header.replace("/", "\\/")}[^\\n]*\\n)(- Status: )([^\\n]*)`);
    const replacement = `$1$2${norm([value].flat().join("/") || "PENDING").replace(/[\\/]/g, "")}`;
    if (re.test(runMd)) {
      runMd = runMd.replace(re, (m, pre, key, old) => {
        // 跳过已被人工改写为描述性文字的状态行（如 PENDING -> 完成后已人工补内容）不确定时保留原状：仅在旧值是纯状态词时替换
        const oldVal = old.trim();
        if (/^(PENDING|IN_PROGRESS|COMPLETED|CLOSED|FAILED|AWAITING|DONE|NOT_.*|DONE|COMPLETE|VALIDATED|PAUSED_BY_USER|ESCALATED|ARCHITECTURE_GATE)$/.test(oldVal)) {
          return `${pre}${key}${norm([value].flat().join("/"))}`;
        }
        return m;
      });
    }
  }

  // Rounds 段：统计列表（只在原有 Rounds 段为空表格/空标题时补一行，不覆盖人工内容）
  // 兼容两种 round schema：mjs round 命令版（verdict/head_reviewed）与历史手工版（status/implementer_final/review）
  const rounds = Array.isArray(state.rounds) ? state.rounds : [];
  if (rounds.length > 0) {
    const roundLines = rounds.map((r) => {
      const n = String(r.number).padStart(2, "0");
      const verdict = r.verdict || (r.review?.verdict) || (r.status === "PASS" ? "PASS" : r.status) || "pending";
      const implStatus = r.implementer_final?.status || r.implementer?.status || "";
      const revStatus = r.review?.verdict || "";
      return `- Round ${n}: verdict=${verdict}, implementer=${implStatus || "n/a"}, reviewer=${revStatus || "n/a"}`;
    }).join("\n");
    const secRe = /## Rounds[^\n]*\n((?:[^\n]*\n)*?)(?=^## )/m;
    const m = runMd.match(secRe);
    if (m && !m[1].trim()) {
      runMd = runMd.replace(secRe, `## Rounds\n${roundLines}\n`);
    }
  }
  return runMd;
}

if (command === "gen-nav") {
  // O1/O8: README.md is the canonical run overview and navigation card.
  const status = state.status || "NEW";
  const navByStatus = {
    NEW: { read: ["RUN.md"], note: "任务刚创建，等待启动 Preflight/Planner。" },
    PREFLIGHTING: { read: ["PREFLIGHT.md", "REQUIREMENTS.md"], note: "只读事实调查中。" },
    GRILL_ME: { read: ["PREFLIGHT.md", "REQUIREMENTS.md"], note: "需求澄清中，等待用户决策问题。" },
    REQUIREMENTS_READY: { read: ["REQUIREMENTS.md"], note: "需求已冻结，等待 Planner 产出计划。" },
    PLANNING: { read: ["REQUIREMENTS.md", "PLAN.md"], note: "Planner 编写计划中。" },
    PLAN_READY: { read: ["PLAN.md"], note: "计划已就绪，等待审核。" },
    AWAITING_PLAN_APPROVAL: { read: ["PLAN-SUMMARY.md", "PLAN.md", "REQUIREMENTS.md"], note: "当前在计划审核门禁：先看 PLAN-SUMMARY，再按需查看 PLAN.md。" },
    IMPLEMENTING: { read: ["rounds/NN/IMPLEMENTATION.md", "rounds/NN/TEST-RESULTS.md"], note: "实施轮中。" },
    SELF_CHECKING: { read: ["rounds/NN/TEST-RESULTS.md"], note: "自检中。" },
    REVIEWING: { read: ["rounds/NN/REVIEW.md", "FINDING-TRACEABILITY.md"], note: "独立评审中。" },
    FINDING_TRIAGE: { read: ["FINDING-TRACEABILITY.md", "rounds/NN/REVIEW.md"], note: "问题分诊中。" },
    PLAN_REVISION: { read: ["PLAN-REVISION-01.md", "FINDING-TRACEABILITY.md"], note: "计划修订中。" },
    SOL_ADVISORY: { read: ["SOL-ADVISORY.md"], note: "Sol 咨询中。" },
    ARCHITECTURE_GATE: { read: ["SOL-ADVISORY.md", "FINDING-TRACEABILITY.md"], note: "架构门禁：等待用户拍板。" },
    VALIDATED: { read: ["FINDINGS.json", "DEPLOYMENT.md"], note: "验收通过，等待部署审批。" },
    AWAITING_DEPLOY_APPROVAL: { read: ["DEPLOYMENT.md", "RUN.md"], note: "当前在部署审批门禁：请确认准确 commit 与部署动作。" },
    DEPLOYING: { read: ["DEPLOYMENT.md"], note: "部署执行中。" },
    VERIFYING: { read: ["VERIFICATION.md", "DEPLOYMENT.md"], note: "远端实测与造数中。" },
    VERIFYING_DONE: { read: ["DEPLOYMENT.md", "RUN.md"], note: "历史验证已记录，先核对部署报告与当前 Review。" },
    DELIVERY_GATE: { read: ["RUN.md"], note: "交付物补齐与终验中；功能目录总览见下方链接。" },
    PUSHED: { read: ["RUN.md", "DEPLOYMENT.md"], note: "历史分支已推送；是否完成以 Review、验证和当前门禁证据为准。" },
    COMPLETE: { read: ["RUN.md", "DEPLOYMENT.md"], note: "先看本页结论，再打开功能目录下的业务交付总览。" },
    PAUSED_BY_USER: { read: ["RUN.md"], note: "用户已暂停，等待显式 resume。" },
    ESCALATED: { read: ["ESCALATION.md", "FINDING-TRACEABILITY.md"], note: "Hard Stop 终审：等待用户选择方向。" },
  };
  const nav = navByStatus[status] || { read: ["RUN.md", "state.json"], note: "状态未知，先看 RUN.md 与 state.json。" };
  const round = state.current_round ? String(state.current_round).padStart(2, "0") : null;
  const activeStatus = String(status).startsWith("IMPLEMENTING") || ["SELF_CHECKING", "REVIEWING", "FINDING_TRIAGE"].includes(status);
  const roundBanner = activeStatus ? `（rounds/${round || "NN"}/，round=${state.current_round || "?"}）` : "";
  const navFiles = nav.read.map((file) => file.replace("NN", round || "NN"));
  const docsDir = overviewDocsDir(state);
  const review = latestReviewEvidence();
  const findingStats = overviewFindingStats();
  const collections = overviewBrunoCollections(docsDir);
  const legacyNote = legacyStatusNote(state, review);
  const reviewLine = review ? `${markdownCode(`Round ${String(review.number).padStart(2, "0")}`)}：${markdownCode(review.verdict || "未形成 verdict")}` : "未发现 Review 产物";
  const docsOverview = docsDir ? externalArtifactLink("功能目录交付总览", join(docsDir, "README.md")) : "功能目录尚未绑定";
  const thinkingCandidates = ["PREFLIGHT.md", "REQUIREMENT-SOURCE.md", "REQUIREMENTS.md", "PLAN.md", "PLAN-SUMMARY.md", "FINDING-TRACEABILITY.md"];
  if (existsSync(runDir)) {
    for (const entry of readdirSync(runDir)) if (/^PLAN-REVISION-\d+\.md$/.test(entry)) thinkingCandidates.push(entry);
  }
  const thinkingLinks = [...new Set(thinkingCandidates)].filter((file) => existsSync(join(runDir, file))).map((file) => `- ${runArtifactLink(file, file)}`).join("\n") || "- 尚无已落盘的思考材料。";
  const collectionLinks = collections.length
    ? collections.map((path) => `- ${externalArtifactLink(path === (docsDir ? resolve(join(docsDir, "bruno")) : "") ? "统一 Bruno collection" : "历史请求集合", path)}`).join("\n")
    : "- 尚未发现 Bruno collection；接口请求材料应归档到功能目录的 bruno/。";
  const repositoryLines = overviewRepositoryLines(state).join("\n") || "- 未记录仓库映射。";
  const readLinks = navFiles.map((file) => `- ${runArtifactLink(file, file)}`).join("\n");
  const readNames = navFiles.map((file) => `- ${markdownCode(file)}`).join("\n");
  const readme = `# 📌 ${runIdNavTitle(state)} — 任务总览与导航

${state.objective ? `> ${state.objective}\n` : ""}
> 自动生成：${new Date().toISOString()} ｜ 当前状态：**${status}** ｜ 此 README 是本 run 的唯一总览入口，由 gen-nav 在状态推进后刷新。

## 🧾 当前结论
- ${markdownCode("state.json.status")}：${markdownCode(status)}；schema：${markdownCode(state.schema_version || "MISSING")}
- 最新独立 Review：${reviewLine}
- Finding：${findingStats.closed}/${findingStats.total} 已闭环，${findingStats.open} 条仍需处理或保留用户决策
- 功能目录交付总览：${docsOverview}
${legacyNote ? `- ⚠️ ${legacyNote}\n` : ""}

## 🎯 业务目标
${state.objective ? state.objective : "目标未记录。"}

## ⏱️ 阶段耗时结构
${overviewTimingTable(state)}

## 🔑 主控追问与会话恢复 (Coordinator Resume)
${overviewCoordinatorSession(state)}

## 🧠 思考与决策材料
${thinkingLinks}
- 用户决策记录：${runArtifactLink("decision.json", "decision.json")}

## 🧪 测试请求集合
${collectionLinks}

## 🌿 仓库与提交
${repositoryLines}

## 👀 现在该看什么（${roundBanner || status}）
${readLinks}

${nav.note}

## 🔍 完整产物分层
### 必读
${readNames}

### 按需
- ${markdownCode("PREFLIGHT.md")}：只读事实调查
- ${markdownCode("PLAN.md")} / ${markdownCode("PLAN-REVISION-NN.md")}：完整计划与修订
- ${markdownCode("FINDINGS.json")} / ${markdownCode("FINDING-TRACEABILITY.md")}：问题闭环
- 各轮 ${markdownCode("IMPLEMENTATION.md")} / ${markdownCode("TEST-RESULTS.md")} / ${markdownCode("REVIEW.md")}：实现、测试和独立审查证据
- ${markdownCode("DEPLOYMENT.md")} / ${markdownCode("VERIFICATION.md")}：部署与远端验收

### 归档
- ${markdownCode("rounds/NN/")}：各轮不可变过程记录
- ${markdownCode("ESCALATION.md")}、${markdownCode("issues/")}：升级与交付后问题
- ${markdownCode("state.json")}：机器状态；历史 run 不要手改为当前完成状态

## 🧭 使用规则
- 任务未完成或历史回归时，先看本 README；任务完成后，再从上面的功能目录交付总览进入业务交接材料。
- 思考材料只保留在 run 目录，通过本页集中索引；测试请求只认功能目录下的统一 ${markdownCode("bruno/")}。
- 任何状态推进后运行：${markdownCode("node ~/.herdr-codex-pi-workflow/scripts/herdr-workflow.mjs gen-nav --run <run-dir>")}。
`;
  writeFileSync(join(runDir, "README.md"), readme, "utf8");

  // O8: RUN.md 顶部插入/刷新当前状态行。
  const runMdPath = join(runDir, "RUN.md");
  if (existsSync(runMdPath)) {
    let runMd = readFileSync(runMdPath, "utf8");
    const banner = `> 🔎 当前状态：**${status}** ｜ 先看此目录的 [README.md](./README.md) 总览与导航 ｜ 更新于 ${new Date().toISOString()}`;
    runMd = runMd.replace(/^> 🔎 当前状态.*$/m, "");
    runMd = `${banner}\n${runMd}`;
    runMd = syncRunMdSections(runMd, state);
    writeFileSync(runMdPath, runMd, "utf8");
  }

  console.log(JSON.stringify({ ok: true, status, read: navFiles, docs_dir: docsDir, latest_review: review, note: nav.note }));
  process.exit(0);
}

if (command === "gen-delivery-overview") {
  const docsDir = overviewDocsDir(state);
  if (!docsDir) throw new Error("gen-delivery-overview requires --docs-dir or state.delivery.docs_dir");
  mkdirSync(docsDir, { recursive: true });
  const output = join(docsDir, "README.md");
  if (existsSync(output) && !hasFlag("--force")) {
    throw new Error(`delivery overview already exists: ${output}; use --force only when Coordinator owns this projection`);
  }
  execFileSync("node", [resolve(process.argv[1]), "gen-nav", "--run", runDir, "--docs-dir", docsDir], { stdio: "ignore" });
  writeFileSync(output, renderDeliveryOverview(state, docsDir), "utf8");
  console.log(JSON.stringify({ ok: true, docs_dir: docsDir, output, historical: (Number(state.schema_version) || 0) < 4 }));
  process.exit(0);
}

if (command === "gen-plan-summary") {
  // O3: 从 PLAN.md 生成 PLAN-SUMMARY.md（手机可审的摘要版）
  const planPath = state.active_plan_path || state.plan_path || join(runDir, "PLAN.md");
  if (!existsSync(planPath)) {
    console.error(`PLAN.md not found: ${planPath}`);
    process.exit(1);
  }
  const planText = readFileSync(planPath, "utf8");

  function sectionText(titlePatt, maxChars = 3000) {
    const idx = planText.search(titlePatt);
    if (idx < 0) return "";
    const rest = planText.slice(idx + planText.match(titlePatt)[0].length);
    const next = rest.search(/^## |^# /m);
    const body = next >= 0 ? rest.slice(0, next) : rest;
    return body.trim().slice(0, maxChars);
  }

  const parts = [];
  const intro = planText.split("\n## ")[0].trim().slice(0, 1200);
  if (intro) parts.push(`## 计划概述\n${intro}`);
  const interp = sectionText(/^## 1\. /m, 1800);
  if (interp) parts.push(`## 需求解读与非目标\n${interp}`);
  const modules = sectionText(/^## 2\. /m, 1200);
  if (modules) parts.push(`## 受影响模块\n${modules}`);
  const dpIdx = planText.search(/^## 8\. DECISION_POINTS/m) >= 0 ? /^## 8\. DECISION_POINTS/m : /DECISION_POINTS/m;
  const dp = sectionText(dpIdx, 4000);
  if (dp) parts.push(`## 决策点（DECISION_POINTS）\n${dp}`);

  const summary = `# 📐 PLAN-SUMMARY — 计划摘要（手机审阅版）\n\n> 由 \`herdr-workflow.mjs gen-plan-summary\` 从 PLAN.md 自动提取；全文与决策依据请打开 PLAN.md。\n\n${parts.join("\n\n")}\n`;
  const outPath = join(runDir, "PLAN-SUMMARY.md");
  writeFileSync(outPath, summary, "utf8");
  console.log(JSON.stringify({ ok: true, plan_summary_path: outPath, chars: summary.length }));
  process.exit(0);
}

if (command === "verify-deploy-gate") {
  const result = validationAudit({ requireApproved: true, requireWorktree: true });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

if (command === "verify-delivery-evidence") {
  const manifestFile = state.delivery?.manifest_path || join(runDir, "DELIVERY-MANIFEST.json");
  if (!existsSync(manifestFile)) throw new Error(`missing DELIVERY-MANIFEST.json: ${manifestFile}`);
  const manifest = readJson(manifestFile);
  const docsDir = manifest.docs_dir;
  if (!docsDir || !isAbsolute(docsDir) || !existsSync(docsDir)) throw new Error("自动交付验收要求 manifest.docs_dir 是存在的绝对路径");
  const environment = manifest.test_environment || state.resolved_config?.workflow?.test_environment || "";
  const environmentLabel = String(environment).toLowerCase();
  if (!environment || /prod|production|生产|正式/.test(environmentLabel)) throw new Error("自动交付验收只允许明确的测试环境，禁止生产/正式环境");
  if (manifest.allow_side_effects !== true) throw new Error("测试环境自动验收必须显式设置 allow_side_effects=true");
  const runner = manifest.test_runner || state.resolved_config?.workflow?.delivery_evidence_runner || "bru";
  if (typeof runner !== "string" || !runner.trim() || /[;&|`$]/.test(runner)) throw new Error("test_runner 非法；必须是单个可执行文件名或绝对路径");
  const timeoutMs = Math.min(Math.max(Number(manifest.test_timeout_ms || state.resolved_config?.workflow?.delivery_evidence_timeout_ms) || 120000, 1000), 600000);
  const cases = [];
  for (const endpoint of manifest.changed_endpoints || []) {
    for (const kind of ["positive_cases", "negative_cases"]) for (const evidence of endpoint[kind] || []) cases.push({ endpoint: `${endpoint.method} ${endpoint.path}`, kind, evidence });
  }
  if (!cases.length && manifest.interface_change === true) throw new Error("没有可执行的接口 evidence cases");
  const results = [];
  const failures = [];
  for (const { endpoint, kind, evidence } of cases) {
    const brunoPath = manifestPath(docsDir && join(docsDir, "bruno"), evidence.bruno_file);
    const resultPath = manifestPath(docsDir, evidence.result_file);
    const receiptPath = manifestPath(docsDir, evidence.execution_receipt_file);
    if (!brunoPath || !existsSync(brunoPath)) {
      failures.push(`${endpoint}: ${kind} Bruno 文件不存在或路径非法`);
      continue;
    }
    if (!resultPath || !receiptPath) {
      failures.push(`${endpoint}: ${kind} result/receipt 路径非法`);
      continue;
    }
    mkdirSync(dirname(resultPath), { recursive: true });
    mkdirSync(dirname(receiptPath), { recursive: true });
    const stdoutPath = join(dirname(resultPath), `${basename(resultPath, ".json")}.stdout.log`);
    const stderrPath = join(dirname(resultPath), `${basename(resultPath, ".json")}.stderr.log`);
    const startedAt = new Date();
    rmSync(resultPath, { force: true });
    const args = ["run", evidence.bruno_file, "--env", environment, "--output", resultPath, "--format", "json"];
    const execution = spawnSync(runner, args, { cwd: join(docsDir, "bruno"), encoding: "utf8", timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
    const stdout = execution.stdout || "";
    const stderr = execution.stderr || (execution.error ? String(execution.error.message) : "");
    const finishedAt = new Date();
    writeFileSync(stdoutPath, stdout, "utf8");
    writeFileSync(stderrPath, stderr, "utf8");
    if (!existsSync(resultPath) || statSync(resultPath).size === 0) {
      writeFileSync(resultPath, stdout || `${JSON.stringify({ exit_code: execution.status, error: stderr })}\n`, "utf8");
    }
    const receipt = {
      schema_version: 1,
      case_id: evidence.id,
      endpoint,
      kind,
      bruno_file: evidence.bruno_file,
      result_file: evidence.result_file,
      command: [runner, ...args].join(" "),
      tool: runner,
      environment,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      exit_code: execution.status === null ? 1 : execution.status,
      stdout_file: stdoutPath.slice(resolve(docsDir).length + 1),
      stderr_file: stderrPath.slice(resolve(docsDir).length + 1),
      stdout_sha256: hashFile(stdoutPath),
      stderr_sha256: hashFile(stderrPath),
      result_sha256: hashFile(resultPath),
      status: execution.status === 0 ? "PASS" : "FAIL"
    };
    atomicJson(receiptPath, receipt);
    evidence.result_sha256 = receipt.result_sha256;
    evidence.status = receipt.status;
    results.push({ id: evidence.id, endpoint, kind, exit_code: receipt.exit_code, status: receipt.status, receipt_file: evidence.execution_receipt_file });
    if (receipt.status !== "PASS") failures.push(`${endpoint}: ${kind} Bruno 执行失败（exit_code=${receipt.exit_code}）`);
  }
  atomicJson(manifestFile, manifest);
  state.delivery_evidence_last_run = { timestamp: new Date().toISOString(), environment, runner, cases: results.length, passed: results.filter((result) => result.status === "PASS").length, failed: failures.length };
  commitStateMutation("delivery_evidence", { details: { environment, runner, cases: results.length, failures } });
  console.log(JSON.stringify({ ok: failures.length === 0, environment, runner, results, failures, state_revision: state.state_revision }, null, 2));
  process.exit(failures.length === 0 ? 0 : 1);
}

if (command === "verify-delivery-gate") {
  const strictResult = validationAudit({ requireApproved: state.workflow_mode !== "quick-code", requireRemote: true, completion: true });
  console.log(JSON.stringify(strictResult, null, 2));
  process.exit(strictResult.ok ? 0 : 1);

}

if (command === "auto-complete-delivery") {
  console.error("auto-complete-delivery 已禁用：交付证据必须由真实实现、测试和验证产生，脚本不得生成占位 Bruno/接口文档来满足门禁。");
  console.error("请显式编写 DELIVERY-MANIFEST.json 与真实交付物，然后运行 verify-delivery-gate。");
  process.exit(1);

}

usage();

