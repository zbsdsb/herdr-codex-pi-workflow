---
name: herdr-codex-pi-workflow
description: "Use when the user explicitly asks to start, run, resume, inspect, audit, reconcile, or stop the Herdr Codex-Pi workflow, including /skill:herdr-codex-pi-workflow runs. Orchestrates risk-tiered planning, isolated implementation, independent review, evidence gates, deployment, and recovery in visible Herdr panes. Excludes ordinary coding and generic Herdr control."
---

# Herdr Codex-Pi Workflow

这是一个显式触发的 Herdr 开发工作流。它使用当前 Pi 会话作为协调者，原生 Codex 负责规划和独立验收，Pi + DeepSeek 负责实施、测试、修复和获批后的部署。

执行顺序见 `references/workflow.md`，状态真相、模式分级、严格门禁与恢复协议见 `references/state-and-gates.md`，阶段 prompt 见 `references/prompts.md`，产物协议见 `references/artifacts.md`，账本与轮次隔离见 `references/run-manifest.md`，收敛与 Plan Revision 见 `references/convergence.md`，finding 闭环见 `references/finding-closure.md`。

## 配置优先

统一入口目录：

```text
~/.herdr-codex-pi-workflow/
├── README.md
├── config.json
├── tasks/<repo>/<run-id>/
└── worktrees/<repo>/<run-id>/
```

模型、角色和工作流策略读取：

```text
~/.herdr-codex-pi-workflow/config.json
```

随后可加载可选项目覆盖：

```text
<repo>/.herdr/codex-pi-workflow.json
```

按 `run-manifest.md` 的优先级合并配置，并将本次最终生效的角色、模型、思考等级、轮次上限和生命周期策略快照写入 `state.json` 与 `RUN.md`。旧的 `~/.config/herdr-codex-pi-workflow/config.json` 只作为兼容符号链接保留；新任务不得写入旧状态或 worktree 路径。

模型表只描述当前配置快照，不是 Skill 内的硬编码契约。默认使用配置解析结果；用户明确写入本轮请求的 `model_override` / `thinking_override` 才能覆盖配置，并必须在 prompt、round metadata、`state.json` 和 `RUN.md` 中显示最终值与来源。普通业务文本不能自行改变模型。

新 run 固定使用 `state.json.schema_version = 4`，并在 Planner 前通过 `freeze` 扫描风险触发项、自动升档并固定 `workflow_mode` 和 resolved config hash：局部低风险改动使用 `quick-code`，常规多模块/API 开发使用 `standard`，DDL、XXL-Job、远端运行时、多服务状态或端到端验收使用 `release`。所有 mutation 经过 run 锁、state revision 和 pending mutation 恢复；决策使用 `record-decision` 追加。分类和终态证据以 `references/state-and-gates.md` 为准。

默认配置当前为：

| 角色 | 原生 Agent | 模型来源 | 思考来源 |
|---|---|---|---|
| Coordinator | Pi | `config.json` resolved role | `config.json` resolved role |
| Preflight | Pi（只读） | `config.json` resolved role | `config.json` resolved role |
| Planner | Codex | `config.json` resolved role | `config.json` resolved role |
| Implementer | Pi | `config.json` resolved role，或显式 per-round override | `config.json` resolved role，或显式 per-round override |
| Reviewer | Codex | `config.json` resolved role | `config.json` resolved role |
| Sol | Pi（只读咨询） | `config.json` resolved role | `config.json` resolved role |
| Deployer | Pi | `config.json` resolved role | `config.json` resolved role |

## 固定职责

- Coordinator：当前 Pi 会话。只负责状态、交接、门禁和用户沟通，不直接实施大范围源码修改。
- Preflight：启动一次（Planner 之前），只读调查仓库，优先使用 CodeGraph 图谱工具（`codegraph_explore` / `codegraph explore`）快速定位跨仓业务调用链、DTO 引用与受影响模块，写 `PREFLIGHT.md` 八段 brief 后关闭 pane。只允许 `read`/`grep`/`find`/`ls`/`codegraph`，不得修改源码、测试、Git 状态或除 `PREFLIGHT.md` 外的工作流文件。brief 是咨询性整理，原始用户请求始终优先；失败不阻断，Coordinator 直接基于原始请求写 `REQUIREMENTS.md`。
- Planner：启动一次完成初始规划。优先使用 CodeGraph（`codegraph_explore`、`codegraph_callers`、`codegraph_node`）分析上下游调用关系与修改影响面（Blast Radius）。写完 `PLAN.md`（verdict `PLAN_READY`）后，**Planner Pane 保持待命（Standby）进入 `AWAITING_PLAN_APPROVAL`**。若用户在计划审核时提出修改意见，直接在原会话中利用热上下文极速微调 `PLAN.md`（无需从头重查）；**只有用户明确拍板批准计划准备实施时，才正式关闭销毁 Planner Pane** 并冻结 plan hash。实施阶段后续若发生架构重构/门禁打回，才启动独立的 Plan Revision 会话。
- Implementer：每一轮都是新的原生 Pi pane/session；是该轮唯一源码写入者。
- Reviewer：每一轮都是新的原生 Codex pane/session；职责只读，绝不复用 Planner 或之前 Reviewer。
- Sol：只有 Coordinator 在具体高风险决策（架构/安全/持久化宿主/公共契约/验证失败/用户要求）上显式调用，一次只回答一个问题；只读咨询，写 `SOL-ADVISORY.md`，不接管实现、不改文件、不做最终决定。
- Deployer：只有用户明确批准绑定的 commit 后才能执行。

## 触发规则

以下任一条件成立时，必须启动本工作流，不得把任务降级为普通单代理开发：

- 当前用户消息包含由 Pi 注入的 `<skill name="herdr-codex-pi-workflow" ...>` 上下文；这就是显式 Skill 调用，即使后面的自然语言只描述功能需求；
- 用户明确说“启动/使用 Herdr Codex-Pi 工作流”；
- 用户要求恢复这个 Skill 已创建的 run。

只有在消息中**没有**上述 Skill 调用上下文、也没有明确启动/恢复指令时，普通开发请求才不得自行触发。不得因为用户在 Skill 调用后直接写功能需求，就把显式调用误判为普通开发请求。

显式 Skill 调用后的第一阶段必须是编排，不是源码调研：Coordinator 只能做启动前检查、写 `state.json`、创建 pane/worktree，需要时启动只读 Preflight 取得 `PREFLIGHT.md`，再写 `REQUIREMENTS.md` 并启动原生 Codex Planner。Coordinator 不得自己搜索业务代码、形成实施计划或开始修改。

## 启动前检查

1. 运行 `test "${HERDR_ENV:-}" = 1`。失败时停止，不从 Herdr 外部控制会话。
2. 运行 `herdr --version`、`herdr integration status`，确认 Pi 和 Codex integration 为 current。
3. 运行 `git status --short --branch`。主工作区不干净时，不自动 stash、commit 或清理；询问用户。
4. 读取仓库 `AGENTS.md` / `CLAUDE.md` 和项目发布规则。
5. **基于代码事实的决策原则（Grounded Grill-me）**：
   - **禁止在未查代码前盲目提问**：Coordinator 不得在调研前向用户抛出“你认为该怎么改、顺序是什么”等空洞技术问题；凡是能从代码、配置、Mapper、数据库口径查到的事实，必须由 AI 自行调查查清。
   - **Preflight 负责代码事实**：只读摸清仓库现状、调用链与受影响模块，输出 `PREFLIGHT.md`；若发现明显的宏观范围分歧（如字段是否双端对齐），由 Coordinator 基于代码事实向用户做针对性确认并写入 `REQUIREMENTS.md`。
   - **Planner 负责深度取舍并提炼决策点**：Planner 在深挖源码时若发现具体的业务分叉、字段回退优先级、空值兜底策略等真实取舍，必须在 `PLAN.md` 中专门列出 **`DECISION_POINTS`（决策清单与推荐依据）**。
   - **在 `AWAITING_PLAN_APPROVAL` 集中 Grill-me 确认**：计划完成后，Coordinator 将这些基于代码证据的明确决策点连同计划摘要呈递给用户，通过 `ask_user` + Telegram 通知由用户拍板确认，确认结论直接冻结进计划再开始编码。从根本上杜绝“脱离代码凭空提问”和“未看代码先让用户做设计”。
6. 需求涉及非平凡仓库事实时，先启动只读 Preflight（见“Herdr 与 Git 编排”），取得 `PREFLIGHT.md` 后再整理需求；Preflight 负责代码事实，`grill-me` 负责用户决策问题。两者结论合并冻结至 `REQUIREMENTS.md`。
7. 只有形成可测试的需求、非目标和验收标准后才启动 Planner。低风险跳过 grill-me 时也必须在 `RUN.md` 记录理由。
8. 不依赖 pi-herd，不调用 `herdr wait`。Herdr 0.8.0 的 agent 等待接口是 `herdr agent wait`。
9. **图谱自动同步**：启动 Preflight 前，Coordinator 在项目根目录执行 `codegraph sync`（若未初始化则自动 `codegraph init`），确保 Preflight 和 Planner 检索到的是当前分支的最新调用图谱。实施轮次编码完成后、Reviewer 启动前，Coordinator 再次执行 `codegraph sync` 刷新图谱。

## 测试与验证环境

- 本机只运行不依赖外部服务的静态检查、纯单元测试和必要的本地编译。
- 任何需要启动后端、Docker/Compose、Postgres、Redis、真实 HTTP、端到端浏览器或多服务依赖的测试，默认转到用户明确配置的隔离测试环境；禁止为了测试在开发机启动生产依赖。
- 远程命令、上传、下载和环境探针必须遵守 `ssh-skill`，使用其 bundled scripts 和 SSH alias，不得直接调用裸 `ssh`/`scp`/`rsync`。
- 测试报告必须记录 `local-no-service` 或配置的远程测试环境标识，以及实际命令、退出码、环境和残余风险。远程测试环境不是生产环境；任何部署、数据写入或服务重启仍需单独确认。
- Codex 使用有上限的启动观察：启动后执行 `codex_mcp_startup_grace_ms`（默认 60 秒）的无输入保护期，保护期结束即可注入 Planner/Reviewer 任务。MCP `ready/failed/unknown` 只作为运行证据和降级风险记录，不再作为发送业务任务的硬门禁；`codex_mcp_require_all_enabled=false` 时，部分 MCP 失败、启动中断或状态未知不得触发重复重启。


向 Planner/Reviewer 发送 Codex 任务前必须满足（Preflight 为 Pi 只读会话，不适用 Codex MCP 握手，但同样不得修改业务代码）：

1. 已创建本次 run 目录和非空 `state.json`、`REQUIREMENTS.md`；
2. `state.json.status` 为 `PLANNING`；
3. 已创建一个新的原生 Codex Planner pane；
4. `herdr agent get <planner-name>` 显示 agent kind 为 `codex`；
5. Planner 启动命令明确包含 resolved Planner model 和 reasoning 配置；
6. 已完成 Codex 启动观察：经过配置的无输入保护期，读取并记录模型标题、输入提示和可见 MCP 状态；ready/failed/unknown 均允许进入降级注入；
7. 已通过一次非阻塞 `herdr agent prompt ...` 将规划任务交给 Planner，并用有界 `herdr agent wait`/产物 verdict 观察完成；在 `state.json`/`RUN.md` 记录耗时、session ID 和降级风险。

除 MCP 观察中的 `failed/unknown` 外，任何启动前置项失败时，Coordinator 必须停止并向用户报告具体失败步骤，不能由当前 DeepSeek Coordinator 接管规划或实施。MCP 降级时仍应在 Herdr 中保留新的 Codex Planner；在 PLAN_READY 之前，DeepSeek Implementer 可以尚未启动。

## 运行目录

在统一根目录下保存共享状态：

```text
~/.herdr-codex-pi-workflow/tasks/<repo>/<run-id>/
```

代码 worktree 使用：

```text
~/.herdr-codex-pi-workflow/worktrees/<repo>/<run-id>/
```

至少创建 `README.md`、`RUN.md`、`state.json`、`events.jsonl`、`PREFLIGHT.md`（如启动 Preflight）、`REQUIREMENTS.md`、`FINDINGS.json`、`FINDING-TRACEABILITY.md`、`PLAN.md`、`PLAN-SUMMARY.md`、`DELIVERY-MANIFEST.json`、`rounds/01/{metadata.json,REMEDIATION.md,IMPLEMENTATION.md,TEST-RESULTS.md,REVIEW.md}` 和 `DEPLOYMENT.md`；`release` 模式再创建 `VERIFICATION.md` 与 `FINAL-AUDIT.md`。同时更新 `tasks/index.json`。`state.json` 是唯一机器真相，`events.jsonl` 是追加式迁移历史，其余文件都是证据或投影。每轮只保留 4 个 Markdown 文件，FIX-REPORT 已并入 IMPLEMENTATION。细节遵循 `references/state-and-gates.md`、`references/run-manifest.md` 和 `references/finding-closure.md`。将绝对路径传给每个 agent，产物不得包含凭据或原始业务数据。

## 产物单一入口与归档分层

每个 run 只有一个执行总览入口：`~/.herdr-codex-pi-workflow/tasks/<repo>/<run-id>/README.md`。

- `README.md`：由 `gen-nav` 维护的总览与导航卡。任何阶段、历史回归或恢复任务都先看它；其中集中展示当前状态、最新 Review/Finding、思考材料入口、测试集合入口、仓库/commit 和下一步。
- `RUN.md`：详细过程账本和人工复盘，不作为第一入口；`gen-nav` 只在顶部同步状态指引，不覆盖人工事实记录。
- `state.json` / `events.jsonl`：机器状态和迁移历史，只用于审计、恢复和脚本校验。
- `docs/开发功能/<功能名>/README.md`：面向业务交接的交付摘要。任务完成后从 run README 的链接进入，不与执行账本争夺“唯一入口”定位。
- `docs/开发功能/<功能名>/` 只放业务交接材料：`README.md`、`前端接口交接文档.md`、`bruno/`、`sql/` 和真实 `验收/` 证据；Preflight、Requirements、Plan、Round、Finding、Deployment 等过程材料只放 run 目录。
- 每个功能只保留一套测试请求集合，统一放在功能目录的 `bruno/`；run 中的 `deliverables/` 只能作为历史来源并在总览中标明，不能继续作为第二套可执行集合。
- 思考材料不复制到 docs：`PREFLIGHT.md`、`REQUIREMENTS.md`、`PLAN.md`、`PLAN-SUMMARY.md`、`PLAN-REVISION-NN.md` 和决策记录由 run README 集中链接。

完成门禁前，Coordinator 必须执行：

```bash
node ~/.herdr-codex-pi-workflow/scripts/herdr-workflow.mjs gen-nav --run <run-dir>
node ~/.herdr-codex-pi-workflow/scripts/herdr-workflow.mjs gen-delivery-overview --run <run-dir> --docs-dir <docs-dir>
```

`gen-delivery-overview` 只生成事实投影，不生成测试 PASS、Review PASS、部署成功或用户批准。已有人工交付 README 时，先审阅再决定是否使用 `--force`；覆盖前必须保留其中的真实业务内容。

### 历史 run 回归整理

旧 `schema_version < 4` 的 run 不自动迁移，也不允许为了“看起来完成”改写 `state.json` 或原始 verdict。需要回归归档时：

1. 运行 `audit`，记录 legacy schema、缺失证据和状态冲突；
2. 运行 `gen-plan-summary` 和 `gen-nav`，补齐 run 内的思考摘要与唯一总览入口；
3. 将真实请求集合整理到功能目录唯一的 `bruno/`，保留来源路径和“未重新执行”说明；
4. 缺少功能交付 README 时运行 `gen-delivery-overview`，已有 README 则按原始证据修正状态和链接；
5. 在总览中明确“历史已记录”“本次已重新验证”“当前门禁未通过”三种状态，不把投影整理写成新的完成认证。

`legacy` 回归只改变导航、摘要和交付投影，不改变旧 run 的生命周期；如需真正迁移到 schema v4，必须另行生成迁移报告并取得明确 migration/resume 决策。

## 默认界面拓扑

除非用户明确要求新 tab 或新 workspace，所有角色必须显示在**调用 Skill 时所在的当前 Herdr tab**，通过分割 pane 组织：

```text
Coordinator | Preflight（需求阶段创建，完成后关闭）
            | Planner
            | Implementer
            | Reviewer（实施完成后创建，可复用已关闭 Planner 的位置）
            | Verifier（部署完成后创建，按项目已有测试和数据准备规范实测，完成后关闭）
            | Sol（仅 gate 前按需创建，咨询后关闭）
```

- 不使用 `herdr workspace create`、`herdr worktree create` 或 `herdr tab create`。
- 不把 Git worktree 自动注册成新的 Herdr workspace。
- Git 隔离目录和 Herdr 界面拓扑是两件事：使用普通 `git worktree add` 创建目录，再让当前 tab 内的新 pane 以该目录为 cwd。
- 分割前读取 `herdr pane layout --current`；宽 pane 默认向右分，窄/高 pane 默认向下分，避免创建不可用的狭窄布局。
- 所有后台 pane 使用 `--no-focus`，不要抢用户焦点。

## Herdr 与 Git 编排

1. 使用普通 Git 创建隔离目录，不创建 Herdr workspace：

```bash
git worktree add -b workflow/<slug> <absolute-worktree-path> <base>
```

路径放在统一根目录：`~/.herdr-codex-pi-workflow/worktrees/<repo>/<run-id>`。从 `git worktree list --porcelain` 验证路径、分支和基准提交。
2. 在调用 Skill 时的当前 tab 内，从 Coordinator pane 分割 Preflight pane（需求阶段）：

```bash
herdr pane split --current --direction <right-or-down> --cwd <repo> --no-focus
```

3. 从 Coordinator pane 或合适的同 tab pane 再分割 Planner pane，cwd 指向主仓库：

```bash
herdr pane split --pane <same-tab-pane> --direction <right-or-down> --cwd <repo> --no-focus
```

4. 从 Coordinator pane 或合适的同 tab pane 分割 Implementer pane，cwd 指向普通 Git worktree：

```bash
herdr pane split --pane <same-tab-pane> --direction <right-or-down> --cwd <absolute-worktree-path> --no-focus
```

5. 从每次 split 的 JSON 响应读取 pane ID，不猜测 ID，并验证返回 pane 的 tab ID 等于 Coordinator 的 tab ID；不相等时停止。
6. Preflight 在主仓库 pane 中启动，职责只读（仅 `read`/`grep`/`find`/`ls`），写 `PREFLIGHT.md` 后关闭。
7. Planner 在主仓库 pane 中启动；职责只读。
8. Implementer 在隔离 worktree pane 中启动；是唯一源码写入者。
9. Reviewer 在实现完成后于**同一个当前 tab**创建全新 pane 和全新 Codex 会话，cwd 指向实现 worktree；不得 resume Planner。
10. Sol 咨询仅在 gate 前按需创建新 pane 和全新只读会话（cwd 指向实现 worktree 或主仓库），写 `SOL-ADVISORY.md` 后关闭。
11. 同一 worktree 只有 Implementer 可以写源码。Coordinator、Preflight、Planner、Reviewer、Sol 不修改实现文件。
12. 不移动当前正在工作的 agent pane。若布局空间不足，停止并询问用户是否允许创建新 tab，而不是自行创建。

启动参数：

Codex Planner/Reviewer 必须使用 run 专属的非 Trellis 启动目录，避免项目 `.codex/hooks.json` 的 `UserPromptSubmit` 自动注入 `trellis-bootstrap`。这个隔离只针对当前 Codex 进程：保留用户级 Herdr 生命周期 hook，不要默认设置 `features.hooks=false`。

```bash
mkdir -p <absolute-codex-cwd>
herdr agent start <planner-name> --kind codex --pane <planner-pane> -- \
  --cd <absolute-codex-cwd> \
  --model <resolved-planner-model> \
  -c 'model_reasoning_effort="<resolved-planner-reasoning-effort>"' \
  --dangerously-bypass-approvals-and-sandbox \
  --add-dir <absolute-main-repo> \
  --add-dir <absolute-implementation-worktree> \
  --add-dir <absolute-run-dir>
```

```bash
herdr agent start <implementer-name> --kind pi --pane <implementer-pane> -- \
  --model <resolved-implementer-model> \
  --thinking <resolved-implementer-thinking>
```

`<absolute-codex-cwd>` 必须位于 run 根目录之外的独立空目录，且不得向其中复制 `.trellis`、`.codex/hooks.json` 或其他项目 hook。Planner/Reviewer 仍通过 `--add-dir` 读取真实仓库、隔离 worktree 和 run 产物；prompt 中必须显式提供仓库规则路径。将 `codex_cwd`、`hook_isolation=project-trellis-hook-muted` 和所有 `--add-dir` 路径写入 `state.json`/`RUN.md`。

`<resolved-implementer-model>` 和 thinking 必须来自当前 run 的配置快照；若 Coordinator 在本轮请求中明确声明 override，则使用 override，并在启动前向用户/账本显示 `model`, `thinking`, `source` 和 `reason`。不得因为 Skill 默认值或历史轮次自动替换它。

Reviewer 使用与 Planner 相同的 Codex 参数（包括 `--cd <absolute-codex-cwd>`、本次绝对 run 目录和实现 worktree的 `--add-dir`），但必须使用新的唯一 agent name 和新会话。Planner/Reviewer 每轮前后都记录主仓库或实现 worktree 的 `git status --short` 与 HEAD；出现非预期源码修改时阶段失败，停止并报告，不得自动接受。

### Codex 启动观察与降级注入

启动观察有明确上限，不把 MCP 可用性变成业务任务的重复重启门禁：

1. 启动前运行 `codex mcp list`，保存本次 `enabled` server 的期望清单；不需要的 MCP 可以在本次进程参数中明确 disabled，但不为修复 MCP 阻塞业务任务。
2. 启动无业务任务的 Codex session 后进入 `codex_mcp_startup_grace_ms`（默认 60 秒）的无输入保护期：禁止发送 prompt、Enter、模型切换、pane focus/resize 或其他终端输入。`interactive_ready` 不得提前结束这段保护。
3. 保护期结束后，读取启动输出；能读到时记录模型标题、稳定输入提示、MCP `ready/failed/unknown`、warning 和实际耗时。不要为了补齐清单强制发送 `MCP_HANDSHAKE_PROBE`；只有用户或 Coordinator 明确要求诊断时才使用。
4. 保护期结束即允许发送一次 Planner/Reviewer 业务 prompt。MCP 部分失败、`MCP startup interrupted`、状态未知或没有完整 ready 清单时，标记启动状态为 `DEGRADED`，继续注入任务，并把风险写入 `state.json`/`RUN.md`。
5. 若业务 prompt 发送失败，记录为 workflow/environment incident；不要盲目重复 prompt 或自动重启。只有确认 pane/session 已退出且用户或 Coordinator 要求重试时，才创建新的 Codex session。
6. Planner/Reviewer 任务仍必须满足 pane、agent kind、resolved model/reasoning、run directory、requirements/plan artifact 等工作流门禁；本规则只放宽 MCP 可用性门禁。

使用 `herdr pane wait-output`、agent 状态或等价事件式等待实现保护期，不用 `sleep`。60 秒是无输入保护期的上限，不是 MCP ready 的证明；最终证据是启动输出和账本中的 `ready/failed/unknown` 分类。

## 正确等待方式

非阻塞投递一次业务任务：

```bash
herdr agent prompt <agent-name> "<prompt>"
```

使用有界事件等待观察 transport 状态；阶段完成只认产物 verdict 与 Git 证据：

```bash
herdr agent wait <agent-name> --timeout 1800000
```

长时间编排固定使用“非阻塞 prompt + 有界 agent wait + 产物 verdict”，避免 fullscreen TUI 高频重绘。若返回 `blocked`，先执行：

```bash
herdr agent get <agent-name>
herdr agent read <agent-name> --source recent-unwrapped --lines 160
```

不得盲目发送 Enter、批准权限或重复 prompt。`unknown` 不代表完成，agent settled 也不代表阶段成功。断连或超时按 `references/state-and-gates.md` 记录 attempt/checkpoint，优先从现有 worktree 和产物 resume。

## 问题闭环与范围门禁

每次 Review finding 都必须登记到 `FINDINGS.json`，并在 `FINDING-TRACEABILITY.md` 中关联原始需求、计划、修复轮次、commit、文件、测试和独立复验结果。重新实施前必须创建 `rounds/NN/REMEDIATION.md`，逐条回答“修复哪个问题、根因是什么、改了哪里、如何证明、还剩什么”。

同一不变量连续两次阻断、出现新的 transaction/lock/recovery subsystem、或变更范围显著超出原计划时，进入 `ARCHITECTURE_GATE`，不得直接创建下一轮 Implementer。详见 `references/finding-closure.md`。


Reviewer 采用分级评审策略：Round 01 执行基于需求与计划的全量验收评审（建立基线）；Round 02+（修复轮）执行「Finding 闭环验证 + Git Diff 增量深度审查」，既严格核验旧问题闭环与测试变异敏感性（拒绝反射绕过、拒绝参数不敏感假桩），又对本轮新产生的 diff 深度挑刺（防二次回归），同时避免对未改动代码做重复全量扫描。详见 `references/convergence.md`。

Implementer 启动前强制注入变异测试质量标准：新增/修改的测试必须具备失败敏感性（生产条件反转/赋错值时必须红灯），禁止单纯反射调用私有方法当做公共接口证据，打桩 Mock 必须根据入参返回对应对象。详见 `references/prompts.md`。

- 所有默认实施轮次继续使用当前 resolved active profile；不在 Skill 中假定 Flash、Pro、Terra 或任何固定 provider。
- Round 3 若是 plan/architecture/repeated finding，先启动新的 Codex Plan Revision；这不代表自动改变 Implementer 模型。
- 不因轮次阈值自动切换模型。模型变化只能来自配置变更后的新 run，或用户明确写入并记录的本轮 `model_override` / `thinking_override`。
- Round 4 是硬停止轮次：生成 `ESCALATION.md` 或进入 `ARCHITECTURE_GATE`，请求用户决定继续使用当前 resolved model、拆分任务、调整计划、接受残余风险或手动批准其他 profile；不能静默继续或扩大范围。
- workflow/environment/missing-artifact 不消耗实现轮次，也不触发模型变更。

只有有效的 Implementer 产物和 Reviewer verdict 都完成时才计为一轮。


- Planner 在用户正式批准计划后关闭 pane，冻结计划、hash 和 session metadata；进入实施后不再保持 idle。
- 每轮 Implementer 必须新开 pane 和原生 Pi session；实施前读取 `REMEDIATION.md`，验证 `rounds/NN/IMPLEMENTATION.md`、`rounds/NN/TEST-RESULTS.md` 及 Git 证据后，将会话信息写入账本并关闭该 pane。
- 每轮 Reviewer 必须新开 pane 和原生 Codex session；验证 `rounds/NN/REVIEW.md` 的 prior finding closure matrix 和 full acceptance matrix 后，将会话信息写入账本并关闭该 pane。
- `CHANGES_REQUESTED` 不允许默认唤醒旧 Implementer；同一 finding family 连续阻断或范围扩大时必须进入 `ARCHITECTURE_GATE`。
- `PAUSED_BY_USER` 是硬门禁；没有新的用户 resume 指令，任何 Coordinator/监督器不得推进。
- 只关闭本工作流创建、已 settled、产物完整的精确 pane。

## 全员 CodeGraph 导航规范

本项目已建立完整的 CodeGraph 知识图谱（10,223 文件、31.5 万节点、51.6 万调用边）。**所有角色（Preflight、Planner、Implementer、Reviewer、Verifier）在代码探索、排查调用链与定位影响面时，必须全员优先使用 CodeGraph 工具**：
- `codegraph explore <业务/接口/实体名称>`：单次获取关联类源码 + 上下游调用链路；
- `codegraph callers <方法名/类名>`：精确查找所有上游调用方与控制器入口；
- `codegraph node <类名>`：获取类的完整依赖与被依赖关系（包含字段、方法与注解）；
- `codegraph query <关键词>`：精准检索图谱节点与符号定义。

严禁在未查图谱前盲目进行全仓粗暴 grep！

## 阶段推进

严格按 `references/workflow.md`：

0. PREFLIGHTING（只读事实调查，写 `PREFLIGHT.md`）
1. REQUIREMENTS（含强制 `grill-me` 澄清未决决策）
2. PLANNING（原生 Codex 写 `PLAN.md`）
3. AWAITING_PLAN_APPROVAL（**计划确认门禁**：呈现计划摘要/模块/顺序/验收矩阵，触发 Telegram + 桌面通知 + 自动发送 `PLAN.md` 附件，取得用户明确批准后才进入实施）
4. IMPLEMENTING（原生 Pi 隔离编码与单测）
5. SELF_CHECKING
6. REVIEWING（分级独立评审：Round 01 全量，Round 02+ 闭环+Diff 审查）
7. CHANGES_REQUESTED 回流，或 VALIDATED
8. AWAITING_DEPLOY_APPROVAL（**部署审批门禁**：触发通知，等待用户对准确 reviewed commit 的明确批准）
9. DEPLOYING
10. VERIFYING（**隔离环境实测**：自动分窗启动 `Verifier` Agent，按项目已有测试与数据准备规范实测并产出 `VERIFICATION.md`）
11. FINAL_AUDITING（**独立最终验收审计**：由独立 Codex `Auditor` 对 `VERIFICATION.md` 的真实性、造数 SQL、响应数值与负向覆盖进行第三方审查并签名 `AUDITED_PASS`）
12. DELIVERY_GATE（**严格证据门禁**：执行 `verify-delivery-gate`，不生成占位证据，缺一票否决）
13. COMPLETE（任务完成与全渠道通知）

每一步只通过统一迁移命令推进：

```bash
node ~/.herdr-codex-pi-workflow/scripts/herdr-workflow.mjs transition --run <run-dir> --to <STATE>
```

命令原子校验门禁、更新 `state.json`、追加 `events.jsonl`、刷新 `tasks/index.json`/导航；失败时保持原状态。Coordinator 不直接手改生命周期字段。达到 hard stop、architecture gate、plan approval 或 deploy approval 时，调用 `workflow_notify.py` 通知用户。

## 自动化推进 Hook 机制 (Auto-Advancement Hooks)

为确保多代理协作不发生空等与停滞，工作流实行**工件落盘驱动的自动化流转 Hook 链**：

1. **`OnPlanReady` Hook（热上下文问答与附件直达）**：
   - Codex Planner 输出 `PLAN.md`（`WORKFLOW_VERDICT: PLAN_READY`）且 Agent `idle` 时，Coordinator 先执行 `herdr-workflow.mjs gen-plan-summary` 生成 `PLAN-SUMMARY.md`（摘要+决策点，手机可审），再提取决策点 ➔ 自动触发 `workflow_notify.py --event plan_approval`（**自动将 `PLAN-SUMMARY.md` 附件直推至 Telegram，`PLAN.md` 全文按需索取**）并弹出 `ask_user` 等待用户确认；同时执行 `gen-nav` 刷新导航卡、`update_goal_task` 标记 PLANNING→AWAITING_PLAN_APPROVAL；**此时禁止销毁 Planner Pane**，Planner 保持待命（Standby）；
   - **用户提问与调整路由**：若用户在计划审核阶段提出疑问、修改要求或需要澄清细节，Coordinator 将问题原样非阻塞投递给待命 Planner，再通过有界 agent wait 与 `PLAN.md` verdict 获取结果；Planner 利用热上下文解答或增量微调计划，Coordinator 回传结果；
   - **何时关闭**：只有用户明确点击/回复“批准计划（approve_and_implement）”时，Coordinator 才执行 `herdr-workflow.mjs freeze` 冻结 Hash 并关闭销毁 Planner Pane！
2. **`OnPlanApproved` Hook**：用户批准计划后，自动关闭 Planner ➔ 自动初始化 Round 01 ➔ 自动分割 Pane 启动 `Implementer` Agent 并注入 Prompt；
3. **`OnImplementationDone` Hook**：Implementer 产出 `IMPLEMENTATION.md` + `TEST-RESULTS.md` 且 `done` 时，自动校验产物 ➔ 自动关闭 Implementer ➔ 自动分割 Pane 启动全新 `Reviewer` (Codex) 并注入审查 Prompt；
4. **`OnReviewDone` Hook**：Reviewer 产出 `REVIEW.md` 且 `done` 时，自动关闭 Reviewer ➔ 解析 Verdict：
   - `CHANGES_REQUESTED`（未超限）：自动更新 `FINDINGS.json` ➔ 自动生成 `REMEDIATION.md` ➔ 自动启动下一轮 Implementer 修复；
   - `CHANGES_REQUESTED`（达 Hard-Stop）：自动生成 `ESCALATION.md` ➔ 自动触发 `workflow_notify.py --event escalation` 并弹出 `ask_user` 终审门禁；
   - `PASS`：自动进入 `AWAITING_DEPLOY_APPROVAL` ➔ 自动触发 `workflow_notify.py --event deploy_approval` 并请求部署审批；
   - 每个 Hook 落地后：执行 `gen-nav` 刷新导航卡 + `update_goal_task` 同步 goal（如适用）；

5. **`OnDeployApproved` Hook**：用户批准部署后，按项目约定推送分支并释放 Worktree 锁 ➔ **自动分割 Pane 启动 `Verifier` Agent (Pi)** ➔ 在用户批准的隔离环境进行部署确认、准备合成测试数据、执行 API 测试与必要的数据库核验，产出 `VERIFICATION.md`；
6. **`OnVerificationDone` ➔ `OnFinalAudit` Hook（独立终验与打回督促回归闭环）**：
   - **初审提交**：Verifier 产出 `VERIFICATION.md`（`WORKFLOW_VERDICT: VERIFIED`）且 `done` 时，自动关闭 Verifier ➔ 自动分窗启动独立 **`Auditor` (Codex)** 对 `VERIFICATION.md` 进行第三方独立终验（校验造数数据契约、返回数值非假桩、负向分支与日志无异常）；
   - **情况 A：终验通过（`AUDITED_PASS`）**：Auditor 签名 `WORKFLOW_VERDICT: AUDITED_PASS` 后关闭 Auditor ➔ Coordinator 根据真实实现/验证证据编写 `DELIVERY-MANIFEST.json` 与业务交付内容 ➔ 运行 `gen-nav` 固化 run 唯一总览，再运行 `gen-delivery-overview` 生成/刷新功能目录交付摘要 ➔ 运行 `verify-delivery-gate` ➔ 通过 `transition --to COMPLETE` 原子完成 ➔ 更新 goal/Second Brain ➔ 显式携带 `--run` 发送完成通知。脚本不生成占位 Bruno、接口文档或 PASS 证据。
   - **情况 B：终验打回与督促重测（`VERIFICATION_CHANGES_REQUESTED`）**：
     - 若 Auditor 发现造数缺失、断言放水或未覆盖负向场景，Auditor 产出缺陷清单；
     - 自动触发 **`OnVerificationFailed` 回流 Hook**：自动生成 `VERIFICATION-REMEDIATION.md` ➔ 重新分窗启动 `Verifier` 并注入打回意见 ➔ **督促 Verifier 补充造数 SQL、重新发起真实测试并查库对账** ➔ 更新 `VERIFICATION.md` 后再次提交 Auditor 复审（限 2 轮回归，超限触发终审门禁由用户决策），杜绝测试放水！

## Telegram 会话隔离与子频道支持 (Forum Topics / Threaded Mode)

为防止多个并发或历史任务的消息、按钮与附件在 Telegram 主窗口相互串线混淆，系统支持 **Telegram 原生 Forum Topics（超级群组论坛子话题）** 与 **`pi-telegram` Threaded Mode**：

1. **自动创建功能专属子话题 (Topic)**：
   - 若配置了开启 Forum 功能的 Telegram 群组，工作流在任务启动（`PREFLIGHT`）时，Bot 自动调用 `createForumTopic(name="📦 [<功能名>]")` 生成专属 `message_thread_id`；
   - 本任务生命周期内的所有消息（计划摘要、决策按钮、`PLAN.md` 附件、部署审批、实测报告）**全量定向推送到该专属 Topic 线程**中，不同开发任务物理隔离、井井有条；
2. **私聊模式下的会话隔离**：
   - 在个人私聊（Direct Message）中，消息头部自动附带唯一的任务标识标签 `【任务: <功能名>】`，且每次发送关键决策时自动 Pin 置顶最新状态，避免多任务按钮混淆。

## 严格交付证据门禁 (DELIVERY_GATE)

进入 `COMPLETE` 前，由 Coordinator 根据真实实现、测试和远端验证编写 `DELIVERY-MANIFEST.json` 与交付文档，然后执行：

```bash
node ~/.herdr-codex-pi-workflow/scripts/herdr-workflow.mjs verify-delivery-gate --run <run-dir>
node ~/.herdr-codex-pi-workflow/scripts/herdr-workflow.mjs transition --run <run-dir> --to COMPLETE
```

门禁一票否决：最新 Review 必须 PASS、finding 全闭环、两仓远端 commit 等于 reviewed/approved commit（quick-code 等于 reviewed commit）、hash 未漂移、每轮证据完整、交付清单无占位内容；`release` 模式还必须有 `VERIFICATION.md: VERIFIED` 与 `FINAL-AUDIT.md: AUDITED_PASS`。必须存在 `RISK-ASSESSMENT.json`，并由需求/计划与实际 Git 变更共同证明最低 workflow mode；每个接口正/负场景必须绑定真实 Bruno 文件、PASS 执行回执、退出码 0、stdout/stderr/result 文件及 hash。legacy schema 不能通过完成审计，manifest 的 docs_dir 不能被 `--docs-dir` 覆盖。`auto-complete-delivery` 已禁用，默认 health 请求、TODO/TBD、泛化接口模板不能作为交付证据。

测试环境可执行 `node ~/.herdr-codex-pi-workflow/scripts/herdr-workflow.mjs verify-delivery-evidence --run <run-dir>`，由 manifest 的 runner 实际运行 Bruno 场景并生成回执；`allow_side_effects=true` 只对明确测试环境有效，生产/正式环境会被硬拒绝。`workflow_notify.py --event complete` 必须显式传入 `--run <run-dir>`，且只在严格门禁通过后发送；禁止从 active/latest 任务猜测通知对象。完整契约和 manifest 示例见 `references/state-and-gates.md` 与 `assets/DELIVERY-MANIFEST.example.json`。

## 决策通知与交付总览联动

在 `AWAITING_PLAN_APPROVAL`、`ARCHITECTURE_GATE`、`ESCALATED`、`AWAITING_DEPLOY_APPROVAL` 与 `COMPLETE` 时，Coordinator 通过 `workflow_notify.py` 发送通知。通知使用持久化 outbox，ID 绑定 `run_id:state-entry-revision:event`；失败通道可用 `--retry-pending` 幂等重试，不回滚已提交的状态迁移。

Telegram 按钮使用 `wf:<event>:<gate-revision>:<choice>`，历史 `hdrw:` 只做输入兼容，callback 必须匹配当前 gate 和 revision。若 Pi Telegram runtime 正在轮询，通知器只发送，不启动第二个 `getUpdates` 消费者；否则才允许通知器进入显式 fallback polling。

通知配置只从环境变量和本机 Telegram 配置读取，不把 token、收件人或 SMTP 密码写入 run。推荐设置 `PI_TELEGRAM_CONFIG`、`PI_TELEGRAM_PROFILE`、`SMTP_SERVER`、`SMTP_PORT`、`SMTP_FROM`、`SMTP_TO`、`SMTP_PASS` 和 `SMTP_SSL`。完成通知必须显式传入 `--run`，并先通过严格 delivery gate。

状态注入、自动推进和硬阻断是三层不同机制：Pi `before_agent_start` 只提供当前状态上下文；Coordinator 按产物和规则自动推进普通阶段；canonical CLI gate 与 Pi `tool_call` 拦截拒绝非法迁移、过期决策、机器真相文件直写和只读阶段 Git 写操作。架构、升级、暂停恢复、部署和发布仍要求用户明确决定。

- **任务复盘与交付总览**：`tasks/<repo>/<run-id>/README.md` 是每个 run 的唯一执行总览入口，必须在创建、恢复、状态推进和历史回归时刷新；它至少展示当前状态、最新 Review/Finding、仓库与 commit、思考材料索引、测试集合和下一步。完成 run 另在 `docs/开发功能/<功能名>/README.md` 提供业务交接摘要，但该页只做交付投影并链接回 run README，不复制整套过程文件。

## 产物导航与文档精简（O1-O3 / O8）

### O1: run 总览与导航（README.md）
每次 run 创建、状态推进、恢复和历史回归时，Coordinator 执行：

```bash
node ~/.herdr-codex-pi-workflow/scripts/herdr-workflow.mjs gen-nav --run <run-dir> [--docs-dir <docs-dir>]
```

生成/刷新 run 根目录 `README.md`，它是用户的第一阅读入口：
- 「当前结论」：状态、schema、最新 Review、Finding 闭环统计和功能目录交付总览；
- 「⏱️ 阶段耗时结构」：任务启动、规划、批准、部署与状态流转时间戳；
- 「🔑 会话追踪与追问恢复」：Preflight/Planner/各轮 Implementer/Reviewer 的 Agent 名称、模型、会话 ID 及一键复制运行的 `codex resume <id>` / `pi --session <file>` 恢复命令；
- 「思考与决策材料」：集中链接 `PREFLIGHT`、`REQUIREMENTS`、`PLAN`、`PLAN-SUMMARY`、Plan Revision 和决策记录；
- 「测试请求集合」：优先指向功能目录唯一的 `bruno/`，历史来源单独标明；
- 「现在该看什么」：按 `state.json.status` 映射 2-3 个必读文件；
- 「完整产物分层」：必读/按需/归档三级，避免用户面对 30+ 文件无从下手；
- 同步在 `RUN.md` 顶部写入「当前状态＋先看 README.md 总览与导航」动态行。

完成门禁前生成功能目录交付摘要：

```bash
node ~/.herdr-codex-pi-workflow/scripts/herdr-workflow.mjs gen-delivery-overview --run <run-dir> --docs-dir <docs-dir>
```

已有人工交付 README 时，先审阅其真实内容再使用 `--force`；此命令只投影事实，不替代 `DELIVERY-MANIFEST.json`、验收证据或用户审批。

### O2: 合并 FIX-REPORT（每轮 5→4 文件）
- `FIX-REPORT.md` 已废弃。原职责（finding → 处置 → 代码证据 → 验证证据 → 残余风险）并入 `rounds/NN/IMPLEMENTATION.md` 的 **finding disposition table** 章节；
- `rounds/NN/` 只保留 4 个文件：REMEDIATION.md / IMPLEMENTATION.md / TEST-RESULTS.md / REVIEW.md；
- prompts.md Implementer 提示已同步（不再写 FIX_REPORT_PATH）。

### O3: PLAN 摘要版（手机可审）
Plan 审核通知发送前，Coordinator 先执行：

```bash
node ~/.herdr-codex-pi-workflow/scripts/herdr-workflow.mjs gen-plan-summary --run <run-dir>
```

生成 `PLAN-SUMMARY.md`（计划概述 + 需求解读 + 受影响模块 + DECISION_POINTS 摘要），作为 Telegram 默认附件；`PLAN.md` 全文保留为按需查看。若摘要生成失败（如 PLAN.md 结构异常），回退发送 PLAN.md 并记录到 RUN.md。

### O8: RUN.md 状态行与导航联动
`gen-nav` 每次刷新时会同步更新 `RUN.md` 顶部状态行，保证打开账本时能回到唯一 `README.md` 总览；`RUN.md` 继续保留完整人工过程记录，不作为交付入口。

## Goal 集成（O6）

工作流 run 是跨小时/跨天的长任务，与 pi 的 goal 机制天然匹配。规则：

1. **run 创建时（REQUIREMENTS_READY 后）**：Coordinator 调用 `create_goal`（objective = 用户原始需求 + 验收标准），把 run 生命周期映射为 goal，使工作流进度可通过 `/goal` 在任意终端/Telegram 查看；
2. **阶段映射**：按冻结的 workflow mode 建立任务树；quick-code 省略 Preflight/Planner，standard 到 DELIVERY_GATE，release 包含 VERIFYING/FINAL_AUDITING。goal 映射 `state.json.status`；
3. **同步推进**：每次状态推进时调用 `update_goal_task` 标记对应任务（start/complete），并保持 `state.json` 为机器真相源、goal 为观察镜像；两者不一致时以 `state.json` 为准并修正 goal；
4. **终态**：COMPLETE 时 `update_goal`（status=complete，completion_summary 附正式分支/commit/交付物路径）；PAUSED_BY_USER 时 `update_goal`（status=paused，reason=用户暂停）；ESCALATED/ARCHITECTURE_GATE 时保持 in-progress 等待用户决策；
5. **边界**：goal 创建只绑定当前 Coordinator 会话（用户显式启动工作流 = 明确目标），多 run 并发时一次只聚焦一个 goal，其他 run 用 state.json 管理。

## Second-Brain 记忆集成（O7）

1. **任务完成（COMPLETE 后）**：Coordinator 可调用记忆工具保存 run_id、功能名、各仓库 HEAD、验收结论、交付物路径和残余风险要点。让后续任务/排障直接复用，不用重翻 run 目录；
2. **关键用户决策（拍板时）**：用户对 ARCHITECTURE_GATE / 计划审批 / 部署审批的裁定（含“哪个条件不符合”的理由）用 `second-brain_remember`（volatility=state）记录，跨会话保留决策上下文；
3. **禁止写入**：不保存 token/凭据/.env 内容/完整客户数据；只记结论与路径，不复制长报告正文。

## 交付后问题

`COMPLETE` run 保持不可变。用户提供该 run 路径和新问题时，加载 `herdr-task-triage`，将诊断追加到 `<run-dir>/issues/<timestamp>-<slug>.md`。需要代码修复时新建 linked patch run，记录 `parent_run_id`、原 approved commits、症状和缩小后的验收标准，并重新执行独立 Review/验证；不得改写原 run 的 PASS/COMPLETE 证据。

## 部署门禁

- Reviewer PASS 只允许进入 VALIDATED，不允许自动部署。
- 记录 `reviewed_commit`、当前 worktree HEAD 和 clean status。
- 向用户展示验收摘要、测试证据、commit 和具体部署动作。
- 本机 `cargo check`/service-free compile 只用于诊断，不是 Release 构建，也不能替代 GitHub Actions 证据；本机禁止执行 Release 镜像构建。
- 隔离测试环境上的 debug/test build 和独立容器只用于验收，不是正式发布产物。
- 用户确认准确 commit、目标和发布动作后，才 push/触发 GitHub Actions；GitHub Actions 是最终构建、镜像和 Release 的权威来源。若 workflow 需要 tag 或 `workflow_dispatch`，必须按真实触发条件执行并核对 Actions/Packages/Release 产物，不能用本地构建冒充。
- 在用户确认前禁止 push、tag、GitHub Release、镜像发布或生产部署。
- 只有用户明确批准该 commit 后，写入 `approved_commit` 并执行。
- 执行前再次确认：`HEAD == reviewed_commit == approved_commit`，worktree clean。
- commit、diff、目标分支或发布配置变化时批准立即失效，必须重新验收。
- 部署完成必须验证远端 workflow、镜像/Release 和线上冒烟；push 本身不等于上线完成。

## 收尾与分支释放

- **推送与分支升级**：经用户批准推送时，按项目分支约定将临时 `workflow/<slug>` 分支重命名并推送远端，与投产发布分支明确区隔开。
- **自动释放 Worktree 锁**：推送成功后，自动在主仓库执行 `git worktree remove <worktree-path>` 与 `git worktree prune` 释放隔离目录，解除 Git 对该分支的独占锁，确保用户在主工作副本直接 `git checkout <branch>` 查验代码时，绝不出现 `already used by worktree` 报错。
- 保留已验收任务分支与历史提交，未经用户明确要求不自动合并、不删除分支。
- 关闭本 Skill 创建的临时 Planner/Reviewer pane 前先确认产物完整。
- 自动生成《任务复盘与交付总览》（含超链接），并通过 Telegram + 邮件发送完成通知。
- 汇报角色、模型、正式分支名、产物路径、测试与验证结论。
