# Finding Closure And Scope Gates

## Purpose

每个 Reviewer finding 都必须形成可审计闭环。实现者的“已修复”不是关闭证据；只有独立 Reviewer 在固定 commit 上验证通过，finding 才能变成 `VERIFIED_CLOSED`。

任务根目录必须包含：

```text
FINDINGS.json
FINDING-TRACEABILITY.md
```

`FINDINGS.json` 是机器状态，`FINDING-TRACEABILITY.md` 是人类可读报告。每轮 `rounds/NN/` 还必须包含：

```text
REMEDIATION.md
REVIEW.md
```

## Finding Registry

每条记录至少包含：

```json
{
  "id": "R2-F3",
  "family": "combined-import-atomicity",
  "introduced_round": 2,
  "severity": "HIGH",
  "classification": "implementation_bug|test_gap|plan_gap|architecture_gap|workflow_gap|environment_failure",
  "requirement_refs": ["R7"],
  "plan_refs": ["PLAN:5.3"],
  "summary": "...",
  "fix_round": 3,
  "fix_commit": "...",
  "changed_files": ["..."],
  "tests": [{"command": "...", "result": "..."}],
  "review_verification": "...",
  "status": "OPEN|CLAIMED_FIXED|VERIFIED_CLOSED|REOPENED|PARTIALLY_CLOSED|DEFERRED_BY_USER|BLOCKED",
  "related": ["R3-F1"]
}
```

`family` 是稳定不变量标识，不随轮次变化。例如：

```text
combined-import-atomicity
provider-key-delete-prune
user-group-provider-key-scope-merge
```

如果后续 Reviewer 发现的是同一 `family` 的另一失败面，必须标记为 `REOPENED` 或关联到原 finding，不能伪装成完全独立的新问题，也不能只写“已修复上一轮”。

## Remediation Report

每次重新实施前，Coordinator 必须生成 `rounds/NN/REMEDIATION.md`。每个 open/reopened finding 一行：

| Finding | 根因 | 本轮修复策略 | 具体文件/符号 | 测试命令 | 预期证据 | 状态 |
|---|---|---|---|---|---|---|
| R4-F1 | ... | ... | ... | ... | ... | OPEN |

Implementer 必须逐项补充：

- 实际修改的文件和符号；
- 没有采用的替代方案及原因；
- exact test command、exit status、关键结果；
- 与原 finding 不同的新增边界；
- 仍未解决的风险。

禁止使用没有映射的泛化描述，例如“完善回滚”“补充测试”“修复导入”。

## Review Closure Matrix

Reviewer 每轮必须在 `REVIEW.md` 中输出两张表。

### Prior finding closure

| Finding | 本轮声称修复 | 代码证据 | 测试证据 | 复验结果 | 结论 |
|---|---|---|---|---|---|
| R4-F1 | yes/no | path:line | command + result | PASS/FAIL/NOT_EVIDENCED | CLOSED/OPEN/REOPENED |

### Full acceptance matrix

每条原始验收标准必须是：

```text
PASS
FAIL
NOT_EVIDENCED
```

`PASS` 的前提：

- 对应代码路径已检查；
- 对应测试或可重复命令有证据；
- 没有相关 open finding；
- reviewed commit 与实际 HEAD 一致；
- worktree clean。

任何 finding 只有在 Reviewer 明确写出 `VERIFIED_CLOSED` 后才能从 open 列表移除。

## Repeated Finding Rule

满足任一条件时，禁止直接启动下一轮 Implementer：

- 同一 `family` 在连续两次 Review 中仍为 blocking；
- 一个 finding 修复后，Reviewer 在同一不变量上发现等价的新失败面；
- 新缺口要求共享事务、锁、数据恢复、跨服务一致性或新的持久化边界；
- changed files 相对初始计划增加超过 50%，或新增了未在计划中列出的 subsystem；
- 单轮新增超过 25 个文件或 1,000 行生产代码，且这些变化不在原始 acceptance matrix 中。

此时必须进入 `ARCHITECTURE_GATE`：

1. 生成 Plan Revision；
2. 写清楚原始需求是否真的要求该边界；
3. 比较真实 transaction/UoW、缩小范围、拆分任务、接受风险四个选项；
4. 需要新增 subsystem 或不可逆数据语义时，等待用户明确选择；
5. 不允许把 architecture gap 当作普通 implementation bug 继续堆补偿代码。

进入 `ARCHITECTURE_GATE` 或硬停止前，如存在具体高风险决策且 Coordinator 判定需要专业评估，可先执行一次 Sol 咨询（只读，写 `SOL-ADVISORY.md`，见 `run-manifest.md` 的 Sol Consultation），把结论并入用户决策包；Sol 意见不替代用户决定。

当前 key-scope 任务在 `R2-F3 -> R3-F1` 时就应该触发该门禁，并拆出 combined import atomicity 子任务。

## Scope Delta Gate

每次 Review 前生成 `SCOPE-DELTA.md`，比较：

- 原始 objective；
- active plan 的模块/资源族；
- 本轮 changed files、生产代码行数、测试代码行数；
- 新增的事务、锁、恢复、缓存、外部副作用。

下列变化必须暂停：

```text
权限功能 → 导入事务系统
局部数据字段 → 全资源恢复
单请求逻辑 → 并发一致性协议
普通错误处理 → rollback failure protocol
```

Scope gate 未通过时，Reviewer 不能 PASS，Coordinator 不能启动下一轮实施。

## Pause And Recovery Gate

- `state.status == PAUSED_BY_USER` 时，任何自动流程不得创建 agent、发送 prompt、push、启动 CI 或改变状态；只有明确的用户 resume 指令才可恢复。
- 所有等待使用 `herdr agent wait`，禁止 Coordinator 通过长 `sleep` 保持自动推进。
- 每次 transition 前重新读取 `state.json`；暂停、schema 不兼容、当前 HEAD/branch/worktree 不匹配时立即停止。
- `schema_version < 4` 的旧 run 不得自动恢复或通过完成门禁；必须先生成迁移报告并由用户显式 migration/resume。
- Stop 操作必须中断 Coordinator、当前 Implementer 和当前 Reviewer，并确认没有任何目标 agent 仍为 `working`。

## Completion Rule

任务完成前必须满足：

```text
all required findings = VERIFIED_CLOSED
all acceptance criteria = PASS
no scope gate open
no architecture gate open
reviewed HEAD == worktree HEAD
worktree clean
```

如果任一条件不满足，状态只能是 `REVIEWING`、`ARCHITECTURE_GATE`、`PAUSED_BY_USER` 或 `ESCALATED`，不能进入 `VALIDATED`。
