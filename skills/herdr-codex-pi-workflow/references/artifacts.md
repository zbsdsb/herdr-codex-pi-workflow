# Artifact Contracts

All files are UTF-8 Markdown. Use absolute paths when instructing agents. Artifact completion is determined by the exact final non-empty line.

## Canonical Reading Order

- `tasks/<repo>/<run-id>/README.md` is the single run-level overview and navigation entry. It is refreshed by `gen-nav` at creation, recovery, every transition, and legacy backfill.
- `RUN.md` is the detailed ledger, not the first-read document.
- `docs/开发功能/<功能名>/README.md` is the business handoff summary for a completed or historically archived feature; it links back to the run README and must not silently claim a stronger status than the run evidence.
- Process/thinking artifacts stay in the run directory. A feature has one executable request collection at `docs/开发功能/<功能名>/bruno/`.

## PREFLIGHT.md

Read-only source-investigation brief produced before `REQUIREMENTS.md`. It is advisory and never overrides the original user request. Must contain exactly these top-level sections:

- `USER_INTENT` — what the user actually asked, restated;
- `IN_SCOPE` — concrete work implied by the request;
- `OUT_OF_SCOPE` — explicitly excluded or not implied work;
- `ACCEPTANCE_CRITERIA` — observable, testable criteria derivable from the request;
- `REPOSITORY_FOCUS` — relevant modules, files, symbols, and data/API touchpoints found;
- `IMPLEMENTATION_GUIDANCE` — concrete facts that constrain the implementation;
- `VERIFICATION` — service-free checks that can validate the change;
- `RISKS_AND_OPEN_QUESTIONS` — risks and questions whose answers require the user.

Final line:

```text
WORKFLOW_VERDICT: PREFLIGHT_READY
```

Hard rule: the original user request remains authoritative. A failed or timed-out preflight does not block the run; the Coordinator writes `REQUIREMENTS.md` from the original request directly and records the failure in `RUN.md`.

## REQUIREMENTS.md

Must contain:

- objective;
- acceptance criteria;
- non-goals or scope boundary;
- target repository and base branch;
- user-provided deployment expectation, if any.

It has no model verdict because it is user/coordinator-owned.

## SOL-ADVISORY.md

Optional bounded consultation note produced only when the Coordinator explicitly calls a Sol consultation for one concrete risk decision. Must contain:

- the single precise question asked;
- the risk class (`architecture`, `security`, `persistent-host`, `public-contract`, `failed-verification`, or `user-requested`);
- compact context and evidence supplied;
- the Sol recommendation and its stated uncertainty;
- explicit note that the decision remains with the user/Coordinator.

Final line:

```text
WORKFLOW_VERDICT: SOL_ADVISORY
```

Sol never modifies the worktree, never implements, and never replaces the user's decision. A Sol advisory is input to an `ARCHITECTURE_GATE` or escalation decision, not an authorization to proceed.

## PLAN.md

Required sections:

- interpretation and non-goals;
- affected modules/symbols;
- implementation sequence;
- tests and verification;
  - **Filter Benchmark Matrix (筛选条件基准矩阵)**: 对于任何带筛选条件的查询/明细/导出接口，必须逐一列出每个 Query Parameter（如小类、业务类型、日期区间、机构号）的正向匹配（包含该条件时精准返回目标数据）与反向隔离（不匹配时剔除或返回空，排除其他分类数据）基准测试用例；
  - **Cross-Channel Parity (多端入口一致性对齐)**: 涉及多端入口（如后管+PAD+会员中心+APP）共享同一业务域时，必须显式定义跨端输入参数映射契约，严禁各端 Controller/Manager 私自篡改或不一致覆盖核心参数（如 `brNo`、`cifNo`）；
- risks and compatibility;
- acceptance mapping.

Final line:

```text
WORKFLOW_VERDICT: PLAN_READY
```

## `rounds/NN/IMPLEMENTATION.md`

One immutable implementation report per numbered round. Required:

- current branch and HEAD;
- changed files;
- implementation decisions;
- deviations from plan;
- **finding disposition table** (合并原 FIX-REPORT 职责): every open/reopened finding mapped to disposition (已修复/接受不修/已回退/已处理), code evidence (symbol/file), verification evidence, and unresolved risks;
- remaining risks.

Final line:

```text
WORKFLOW_VERDICT: IMPLEMENTED
```

`FIX-REPORT.md` 已废弃：其内容并入本文件的 finding disposition table，每轮产物由 5 文件减为 4 文件（REMEDIATION / IMPLEMENTATION / TEST-RESULTS / REVIEW）。

## `rounds/NN/TEST-RESULTS.md`

One immutable test report per numbered round. For each command record:

- exact command;
- working directory;
- exit status;
- concise relevant result;
- reason for skipped checks;
- **Filter & Parity Verification Evidence (筛选基准与跨端一致性证据)**:
  - 针对查询接口，必须包含逐一参数正负向隔离测试证据（如只传小类 A 时查出且仅查出 A 类流水，传小类 B 时查出且仅查出 B 类流水，禁止仅做无筛选全量测试）；
  - 针对多端接口，必须包含同客户在各端入口（PAD/后管/会员中心）等价调用的对比断言证据。

Final line:

```text
WORKFLOW_VERDICT: TESTS_PASSED
```

or:

```text
WORKFLOW_VERDICT: TESTS_INCOMPLETE
```

## FINDINGS.json

Machine-readable finding registry. Every Reviewer finding gets a stable ID and `family`. The registry records classification, requirement/plan references, fix round/commit/files, exact tests, independent verification, related findings, and status. A finding is closed only when an independent Reviewer writes `VERIFIED_CLOSED` in the closure matrix.

## FINDING-TRACEABILITY.md

Human-readable report mapping every finding to its root invariant, remediation, evidence, and current status. It must explain reopened/related findings and scope or architecture gates.

## rounds/NN/REMEDIATION.md

Required before every reimplementation round. It must map each open/reopened finding to the exact root cause, intended fix, symbols/files, tests, expected evidence, and residual risk. A generic implementation summary is not sufficient.

## `rounds/NN/REVIEW.md`

One immutable review report per numbered round. Required:

- reviewed commit SHA per repository; the same map must be written to `rounds/NN/metadata.json.reviewed_commits`;
- blocking finding count;
- prior finding closure matrix with stable IDs;
- full acceptance matrix;
- findings with severity, classification, family, and file/line;
- test gaps;
- **Filter Effectiveness & Cross-Channel Parity Audit (筛选条件有效性与多端一致性审查)**:
  - 必须逐一核对 SQL `WHERE` 条件与底层实体/表字段的真实语义匹配（严禁大类字段过滤小类入参、严禁虚假过滤）；
  - 必须核对各端 Controller/Manager 是否存在私自篡改或覆盖入参（如 `brNo` 覆盖）导致跨端数据不一致的缺陷；
- scope delta and architecture-gate result;
- residual risks.

Final line is exactly one of:

```text
WORKFLOW_VERDICT: PASS
WORKFLOW_VERDICT: CHANGES_REQUESTED
WORKFLOW_VERDICT: BLOCKED
```

A PASS is invalid if the reviewed commit differs from current implementation HEAD, the worktree has unreviewed changes, or blocking findings are nonzero.

## DEPLOYMENT.md

Required:

- approved and reviewed commit;
- exact external operations;
- command/workflow results;
- remote artifacts/releases/images verified;
- online smoke result;
- rollback target;
- ambiguity or residual risk.

Final line is exactly one of:

```text
WORKFLOW_VERDICT: DEPLOYED
WORKFLOW_VERDICT: DEPLOYMENT_FAILED
WORKFLOW_VERDICT: DEPLOYMENT_UNCERTAIN
```

## DELIVERY-MANIFEST.json

Coordinator-authored machine contract for the exact delivery directory and interface evidence. It must contain `schema_version: 2`, absolute `docs_dir`, and explicit `interface_change`. Interface changes must list every changed endpoint with `method`, `path`, at least one positive case, and at least one negative case. Each case is structured evidence binding a real Bruno file, an execution receipt, a result file, a `PASS` status, and matching SHA-256 values for result/stdout/stderr. The receipt records the actual command, tool, environment, timestamps, and exit code. For internal-only changes, set `interface_change=false` and provide `interface_change_reason`.

The script never invents this content. In test environments, `verify-delivery-evidence` executes the declared runner and refreshes result/receipt files; it does not bypass endpoint assertions. Before the gate, run `gen-nav` and `gen-delivery-overview`; those commands only create factual projections and never manufacture evidence. Placeholder health checks, TODO/TBD text, generic templates, and unspecified endpoints fail delivery validation.

## DELIVERY_GATE Artifacts (Mandatory Deliverables)

Before entering `COMPLETE` or sending the completion notification, the Coordinator must verify all deliverables via `herdr-workflow.mjs verify-delivery-gate`:

0. **`tasks/<repo>/<run-id>/README.md`** (run-level canonical overview):
   - current state and schema;
   - latest Review/Finding summary;
   - repository/commit summary;
   - **`⏱️ 阶段耗时结构`** (task start, planning, approval, deploy, transition milestones);
   - **`🔑 会话追踪与追问恢复 (Session Resume Commands)`** (Preflight, Planner, Implementer, and Reviewer session IDs with copy-pasteable `codex resume <id>` and `pi --session <file>` commands);
   - links to thinking/decision artifacts, the single Bruno collection, and the next action.
1. **`docs/开发功能/<功能名>/README.md`** (《任务复盘与交付总览》):
   - `⏱️ 耗时与阶段结构` (启动时间 / 交付时间 / 总跨度 / 四阶段耗时占比表);
   - `🔗 过程产物与交付物索引` (REQUIREMENTS, PLAN, 各轮 IMPLEMENTATION/REVIEW, DEPLOYMENT, Bruno 目录, MR 链接);
   - `🎯 业务修改点人话摘要`;
   - `⚠️ 残余风险与后续建议`.
2. **`docs/开发功能/<功能名>/前端接口交接文档.md`**:
   - 覆盖所有改动页面、表格列顺序、字段定义（`dirInvitePoint` / `inDirInvitePoint` 等）、请求/响应报文示例与空值安全说明（纯内部无接口变动须在 README 中显式声明豁免）。
3. **`docs/开发功能/<功能名>/bruno/`**:
   - 必须包含 `bruno.json`、`environments/*.bru` 及按业务场景分类的全部 `.bru` 请求用例文件。
4. **`RUN.md`**:
   - 必须同步更新耗时结构与过程产物索引。
5. **Lifecycle and Git evidence**:
   - latest Review is PASS and every acceptance row is PASS;
   - all findings are independently closed or explicitly accepted/deferred by the user;
   - every repository's remote commit equals its reviewed and approved commit (quick-code: reviewed commit);
   - every manifest interface case has an existing Bruno file, PASS result file, and matching SHA-256;
   - requirements and active-plan hashes match;
   - every round contains non-empty metadata and four Markdown artifacts; metadata includes attempt/session identity, prompt hash, checkpoint, failure classification, exact tests, frozen hashes, and Git heads.
6. **Release-mode runtime evidence**:
   - `VERIFICATION.md` ends with `WORKFLOW_VERDICT: VERIFIED`;
   - `FINAL-AUDIT.md` ends with `WORKFLOW_VERDICT: AUDITED_PASS`.

## Validation Rules

- The final verdict must be the final non-empty line, not embedded in prose.
- A file existing is not enough; required sections and concrete evidence must be present.
- Agent terminal state is transport evidence only, never phase-completion evidence.
- Do not accept claims such as "tests passed" without exact commands/results.
- Do not accept deployment success without remote and smoke verification; quick-code must explicitly state that no deployment occurred.
- Do not auto-generate evidence to satisfy a failed gate; create only artifacts backed by actual implementation/test/verification results.
- Complete notifications require an explicit run directory and a passing strict delivery gate.
