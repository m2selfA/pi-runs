# 设计：pi-runs

对应痛点见 [pain-points.md](pain-points.md)，开发阶段见 [DEVELOPMENT_CHECKPOINT.md](DEVELOPMENT_CHECKPOINT.md)。

## 一句话

**pi-runs 是 Pi coding agent 的 Agent Integration Plane，不再是第二套 Durable Run runtime。**

Run 的 durable lifecycle、scheduler handle、远端观察、终态和 delivery 最终由常驻 `runwatchd` 统一负责；pi-runs 只把这些能力变成 Pi-native tools、session/branch binding 和 continuation UX。

目标体验不是“Pi 在一个 tool call 里等几小时”，而是：

```text
Pi 准备科研任务
  -> runs_submit
  -> continuation armed
  -> 当前 turn 结束，Pi 可以退出
  -> runwatchd 独立观察几小时/几天
  -> Run terminal
  -> 恢复正确 Pi session/branch
  -> Pi 查看日志和远端结果
  -> 继续科研分析
```

## 三项目边界

```text
Pi coding agent
│
├── pi-ssh-tools ── Remote Workspace Plane
│     ssh_read / ssh_write / ssh_edit / ssh_bash
│
├── pi-runs ─────── Agent Integration Plane
│     tools / skill / session binding / continuation UI
│                       │
│                       │ local IPC
│                       ▼
└────────────────── runwatchd ── Durable Run Plane
```

| 组件 | 权威职责 | 不负责 |
|---|---|---|
| `pi-ssh-tools` | Pi 在线时操作远端 workspace | durable Run、Pi 离线 watcher |
| `pi-runs` | Pi tool 语义、session/branch binding、continuation | 第二份 durable ledger、长时 scheduler polling |
| `runwatch` | Run/Attempt/Event/Delivery、SSH lifecycle、scheduler、重试 | 通用远端编辑/科研推理 |

pi-runs 不 import `pi-ssh-tools`，也不要求它存在；只在工具可用时通过能力检测给模型更好的恢复指导。

当前 v1 范围冻结为这三个 Pi-facing 平面。其它 coding agent 的 session identity、resume 机制和 UX 不进入 pi-runs；等 `runwatch` + `pi-runs` v1 结束后，如需支持 Codex 等 agent，应建立独立 Agent Integration 项目并只复用 runwatch 的 agent-neutral durable contract。

后端选择同样遵守 single-authority：`PI_RUNS_BACKEND=auto|runwatch` 只使用 runwatch，daemon 离线或缺少 capability 时 fail closed；`PI_RUNS_BACKEND=legacy` 已从 active runtime 退役并显式失败。旧 `~/.pi/runs` 数据格式、runner/wakeup 源码只保留在 `legacy/` 作为人工迁移/历史参考。

### Pi v1 readiness

`runs_doctor` 是 Pi-facing 的只读 readiness surface，不是安装器。它直接读取 runwatch local IPC `hello`，要求 protocol v1、`service=runwatchd`、`storage=sqlite-wal`，并核对 Pi v1 实际依赖的完整 capability 集：durable submit/status/wait/logs/artifacts/cancel、live session lease/delivery/rebind、offline invocation ownership 与 `offline_pi_continuation`。任何缺失都返回 `ready=false` 和明确原因；请求已退役的 `PI_RUNS_BACKEND=legacy` 同样返回 `ready=false`，不会启动第二份 ledger。

安装边界保持简单：runwatch 的 portable release 独立提供 `runwatch/runwatch-mcp/runwatch-gui`，pi-runs 作为 Pi package 单独安装并通过 local IPC 使用 resident `runwatchd`。pi-runs 不复制 runwatch binary、不管理第二个 daemon，也不因为 readiness 失败回退到旧 ledger。

Release endurance 也复用同一 authority，而不是再造测试 daemon。`pi_v1_soak.mjs` 在一个 packaged supervisor / SQLite / local IPC 生命周期里反复运行真实 Pi/provider workload；fault injection 的合法边界是 initiating Pi 已成功得到 `continuation=armed` 并退出、且每个 Run 已持久化非 `submitting` 状态与 execution handle 之后。之后可以杀 isolated `serve` 验证 supervisor replacement，而 scheduler/local scientific workload继续独立执行。每条 completion 仍必须满足与 R8b 相同的 exact-session、exactly-once Delivery/Invocation/settlement 和显式 workspace result verification；短轮次只做 qualification，multi-hour duration 才能关闭 endurance gate。

## RemoteWorkspaceRef

三项目共享的最小语义对象：

```text
RemoteWorkspaceRef {
  host_alias,
  cwd
}
```

它可直接转换为 `pi-ssh-tools` 的 `host:/remote/path`。SSH activation **不持久恢复**：自动 continuation 后模型必须显式调用 `ssh_activate`，避免把本地/远端执行环境悄悄混淆。

对于 `runner=slurm|lsf`，`cwd` 还有一个不可省略的 durable invariant：它必须是登录节点与 scheduler compute node **共同可见、路径一致、可持久读写**的 workspace。runwatch 在该路径下写 `.runwatch/<run_id>/attempt-*.sh`、stdout/stderr、terminal sentinel 和 receipt；任务本身及 continuation 后的 Pi 也以同一个路径解释科学输出。登录节点本地 `/tmp`、计算节点 local scratch 等只有在集群明确保证跨节点共享时才能使用，否则 scheduler 可以成功退出而登录节点无法看到 sentinel/结果。pi-runs 不尝试猜测文件系统拓扑，因此这项约束由调用方/集群配置显式满足。

## Pi RunSpec

Pi 侧提交对象面向科研意图，而不是暴露 runwatch 内部表：

```text
workspace:
  kind: local | ssh
  host_alias?: hpc.example
  cwd: /share/project

execution:
  runner: process | slurm | lsf
  command: python run.py
  resources:
    partition / queue / account / time / cpus / mem / gpus

outputs:
  expected artifacts...

continuation:
  policy: auto | manual
```

Pi session 信息不应让模型手填。extension 在 `runs_submit` 时从 Pi context 捕获 session file/session id/origin leaf/project，并作为 `ContinuationBinding` 交给 runwatch。

## 工具面

目标工具：

| 工具 | 语义 |
|---|---|
| `runs_submit` | 创建 durable Run，自动绑定当前 Pi continuation，立即返回 |
| `runs_status` | 读取 daemon snapshot；不负责长期轮询 |
| `runs_logs` | bounded tail Run stdout/stderr / scheduler reason |
| `runs_artifacts` / `runs_harvest` | artifact inventory，不替代科研分析 |
| `runs_cancel` | 请求 cancel，由 daemon 最终确认 |
| `runs_wait` | foreground observer；可显式等待 `running` / terminal 并持续更新，但不拥有 Run 生命周期 |
| `runs_rebind` | 将已有 Run 显式绑定到当前 Pi branch |
| `runs_adopt` | 兼容性接管已有 scheduler job；不是正常 submit 路径 |

正常长任务流程：

```text
runs_submit
  -> continuation=live_armed | armed
  -> end current turn
  -> live_armed: keep Pi running
  -> armed: runwatch may relaunch exact Pi session after Pi exits
```

默认仍只有在用户明确要求“等它跑到某个条件再继续”时使用 `runs_wait`；这类 foreground wait 可以持续数分钟甚至更久，并不是 Pi API 的禁区。关键边界不是“必须短”，而是 watcher 必须可观察、可 Abort/detach，并且 timeout/abort 绝不能变成 `runs_cancel`。无人值守、小时到天级任务仍优先结束当前 turn，让 durable continuation 接管。

Foreground observation uses the existing daemon-owned `wait_run` snapshot capability in bounded slices rather than starting a second scheduler poller:

```text
runs_wait(until=terminal|running, timeout_ms=T)
  -> wait_run slice
  -> Pi onUpdate(status, handle, elapsed, condition)
  -> repeat while attached
  -> condition met: return snapshot
  -> timeout / Escape / AbortSignal: detach watcher only
  -> Run remains durable in runwatch
```

## 与 pi-ssh-tools 的标准科研循环

提交前：

```text
ssh_activate hpc.example:/share/project
ssh_read / ssh_edit / ssh_bash   # 准备输入和快速验证
runs_submit                      # durable hand-off
```

恢复后：

```text
runs_status
runs_logs
ssh_activate hpc.example:/share/project
ssh_read / ssh_bash              # 检查真实科研输出
继续科研推理
```

`runs_logs` 仍由 runwatch 提供，因为 stdout/stderr、scheduler reason、exit code 属于 Run observability；大体积科研文件和任意分析命令属于 `pi-ssh-tools`。

## Pi status surface

Long-wait semantics make passive visibility part of the product, but pi-runs should not take over Pi's entire footer. It publishes one composable extension status entry:

```text
status key: pi-runs

Runs 2 running · 1 queued
Runs 1 running · 1 failed
Runs idle
```

Design rules:

- use `ctx.ui.setStatus("pi-runs", ...)`, not a custom `setFooter`, so it coexists with `pi-ssh-tools` and user footer extensions;
- show live/attention state only; do not fill the footer with historical success counts;
- warning tone for failed/timed-out/lost/unknown, accent for live Runs, muted for idle;
- refresh in a session-scoped loop only while UI exists: initialize on `session_start`, refresh after relevant tool/turn changes, clear on `session_shutdown`;
- all status reads are bounded and non-blocking from the agent turn's perspective;
- active v1 status is runwatch-only；请求已退役的 `PI_RUNS_BACKEND=legacy` 必须 fail closed，`auto` 在 runwatch 不可用时直接显示 control-plane failure；

With the canonical runwatch backend, the base live count is **session-scoped**: Runs bound to the current Pi session are expanded normally, unrelated active Runs are compressed to `N other live`, and failures/unknown states outside the session are surfaced as `N global attention` so important global problems are never hidden. runwatch Observation sidecars keep execution and visibility separate: a current live Run can remain `running` while `observation.health=unreachable|probe_error`, in which case the footer adds `N probe issue(s)` and warning tone; live probe failures from another Pi session contribute to `global attention`. Normal `fresh` observations stay silent. Current-session continuation attention adds `N continuation`, `N rebind`, `session busy`, and `bridge offline`. Run/observation/bridge composition is kept in a pure summary function with regression tests, while UI publication remains session-scoped.

## Pi session / branch binding

Pi session 不是单一线性对话。目标 binding 至少保存：

```text
agent_kind = pi
session_id
session_file
origin_leaf_id
project_root
workspace_ref
binding_version
continuation_policy
```

若 completion 到来时当前 branch 仍包含 origin leaf，可以自动继续；若同一 session JSONL 已通过 `/tree` 等方式 divergence，live/offline bridge ack 为 `needs_rebind`，绝不能仅凭 session_id 强行投递。`runs_rebind(run_id)` 显式读取 Run workspace，并用当前 Pi session/file/leaf 重写 durable binding；runwatch 同事务刷新未 claim Delivery 的 binding 快照再重新 pending，且 in-flight `delivering` 状态禁止 rebind。真实同文件 `/tree -> needs_rebind -> runs_rebind -> delivered` 门禁已通过。Pi `/fork` 会生成新的 session file/id，因此原绑定 exact-session 的恢复仍是正确行为。

## Extension lifecycle

长期 watcher 不应驻留在 Pi extension factory 中。pi-runs 只在 Pi session 活着时建立轻量 session bridge：

```text
session_start
  -> register/refresh exclusive live session lease with runwatchd
  -> claim pending completion Delivery
  -> verify branch lineage

10s session loop / turn_end
  -> refresh lease + delivery/status

session_shutdown
  -> release live lease
```

Pi 退出不会影响 Run lifecycle，因为 runwatchd 独立常驻。

## Continuation

### Pi 在线

`runs_submit` 的 continuation 结果严格区分：

- `live_armed`：durable binding 已保存且本 Pi 已取得 live lease；结束当前 turn，但保持 Pi 进程运行；
- `binding_persisted_delivery_pending`：binding durable，但 live bridge 未成功 armed；不能承诺自动继续；
- `armed`：daemon 已公布 offline continuation 能力，binding durable；Pi 可以完全退出，runwatch 可在没有 live lease 时恢复准确 session。真实 cap00 exact-session relaunch / successful settle / durable ack、combined hpc.example HPC clean-success、daemon/scheduler crash recovery 与 same-session branch-divergence/rebind recovery 均已通过。

runwatchd 将 terminal completion 持久化成 deterministic pending Delivery。live pi-runs bridge 在独占 session lease 下 pull/claim；验证 session file 与 origin-leaf lineage 后，把最多 8 个 completion 聚合成 Pi custom message，并以 `triggerTurn: true, deliverAs: "followUp"` 触发下一 turn。成功后 ack delivered，失败 ack retry；branch 不匹配 ack needs_rebind。不要伪造普通用户消息。

该 live 路径已有独立 real-Pi gate：隔离 fake runwatch 从真实 `register_agent_session` 动态取得 session identity，再提供 terminal Delivery；真实 Pi persisted `runwatch/completion`、发出 `agent_start` 并收到 live `delivered` ack。这个门禁只证明“live session 已接受并触发 continuation”，不把 provider 最终推理成功混进 Delivery 语义。

### Pi 离线

当前实现由 runwatchd 在 live lease grace period 后为 pending Delivery 预留 offline AgentInvocation，并在同一 exact-session execution lease 下启动 `pi --mode rpc --session <session_file> -e <pi-runs adapter>`。Delivery 通过受限 bootstrap 环境值交给插件；插件在 `session_start` 重新校验 project trust、session file 与 origin leaf。完成 lease refresh 后，它还必须调用 `verify_offline_invocation(invocation_id, delivery_id, owner_instance_id)`，只有 daemon 确认该 Invocation 仍是 `starting|running`、Delivery 仍为 `delivering` 且同 owner lease 未过期，才允许处理 completion；被 daemon crash recovery 回收的迟到 worker直接 shutdown。处理前还会扫描当前 Pi branch 的 durable session evidence：若已有 `runwatch/completion-settled` receipt，或原 `runwatch/completion` 后已持久化 final assistant `stop`，则只修复 runwatch ack，不再次注入 completion；若原 completion 已存在但 turn 未完成/失败，则发送 `runwatch/completion-recovery` 继续既有上下文。`triggerTurn` 可能在 `sendMessage()` 返回前同步发出 `agent_start`，因此 adapter 必须先 arm bootstrap lifecycle gate 再触发 turn。最终非重试 `agent_end` 提供 success/error outcome，而 `agent_settled` 是唯一的成功 settlement 边界；成功 settle 先 append 不进入 LLM context 的 `runwatch/completion-settled` custom entry，再 ack delivered。对于 trust/branch 在 `session_start` 就被阻断、没有 agent turn 的情况，pi-runs durable ack `needs_rebind` 并请求 shutdown，runwatch 观察 Delivery 已离开 `delivering` 后关闭 RPC stdin，使 headless worker可靠退出。spawn 成功或单独的 settled 都不算成功；失败/未 ack invocation 回到 durable retry 路径。

### Project trust

自动恢复不得偷偷批准未信任项目。无法安全恢复时 Delivery 应进入明确 blocked 状态，等待用户处理。

## Legacy archive

pre-runwatch 实现已经从 active runtime 退役并整体归档到 `legacy/`：旧 JSONL store/schema、scheduler runner/parser、wakeup backends、`pi-runs-wake` callback、systemd user templates 与 parser test 都只用于人工迁移/历史参考。package 不再暴露 `pi-runs-wake` npm bin，active `src/` / extension 不 import `legacy/`，`runner=powershell` 与 `PI_RUNS_BACKEND=legacy` 都显式 fail closed。

远端 Slurm/LSF 与 Windows 本地 Process 的 durable submit/status/logs/artifacts/cancel/wait 已全部进入 runwatch 单一 authority。本地长任务不再以 legacy PowerShell `Start-Job` 冒充 durable 能力；若宿主 Windows Job Object 不允许 breakaway，runwatch 必须 fail closed，而不是降级成非持久子进程。历史 `~/.pi/runs` 数据若未来确有迁移需求，应新增**显式只读 import 工具**，而不是重新启用旧 runtime。

## Pi extension best practices

迁移时同步收紧：

- 使用正式 `ExtensionAPI` 类型，不使用 `any` fallback 注册器；
- 参数使用 TypeBox / Pi 推荐 schema helper；
- 真正 tool failure 直接 throw，而不是返回普通 `{ error }` result；
- 尊重 `AbortSignal`，IPC wait 必须可取消；
- bounded logs/output；
- tool `promptSnippet` / `promptGuidelines` 明确写：长任务 `runs_submit` 后不要主动轮询；
- Skill 负责 progressive disclosure，但关键安全/等待规则不能只藏在 Skill；
- Pi 核心包使用 peerDependencies，不重复打包。
- lightweight persistent UI uses extension-scoped `setStatus`; do not replace the user's footer just to show Run state.

## MCP 的位置

Pi v1 唯一主链路是：

```text
pi-runs -> local runwatch client/IPC -> runwatchd
```

不是 `pi-runs -> MCP -> runwatch`。MCP 可以继续作为 runwatch 的通用协议面，但其它 agent 的 identity/resume/settlement/onboarding 应在 v1 之后进入独立 Agent Integration 项目；不能为了未来 agent 迫使 Pi 放弃自己的 session lifecycle / custom message 能力，也不能继续把 agent-specific 逻辑堆进 runwatch。

## 当前完成顺序

1. R0–R7：三项目 authority、runwatch client migration、Pi live/offline continuation、branch safety 和核心 fault matrix（已完成主要功能验证）。
2. R8a：supported install/readiness surface。
3. R8b：repeatable real-Pi release acceptance。
4. R8c：multi-hour soak/endurance。
5. R8d：legacy compatibility retirement。
6. R8e：v1 release candidate。
7. **只有 v1 完成后**，才重新评估 agent-neutral adapter extraction 和 Codex/其它 agent 的独立 integration projects。

详细状态必须以 [DEVELOPMENT_CHECKPOINT.md](DEVELOPMENT_CHECKPOINT.md) 为准。
