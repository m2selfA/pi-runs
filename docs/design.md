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

## Foreground / background is a UX choice, not a durability choice

The post-v0.1 design deliberately separates **execution ownership** from **how the user waits**. Every scientific Run is durable in `runwatchd`; foreground and background are only two observation modes over the same Run.

The mode decision is dependency-driven rather than duration-driven:

| Situation | Default Pi behavior | Why |
|---|---|---|
| The next reasoning step needs this result (`run tests and fix failures`, `run refinement then inspect map`) | `runs_submit -> runs_wait` until terminal | Preserve the familiar synchronous command mental model even if the wait lasts minutes or hours. |
| The user explicitly says background / "run this while I do something else" | `runs_submit -> detach` | The user has chosen concurrency. |
| Pi has genuinely independent useful work to do while the Run executes | submit, continue that work, then attach or consume continuation | Backgrounding creates real parallelism instead of merely avoiding a long tool call. |
| The work is unattended / Pi may exit / machine or network may disappear | `runs_submit -> durable continuation -> end turn` | A foreground watcher would add no value and must never become the durability boundary. |

This follows the useful community rule that **a command being slow is not, by itself, a reason to background it**. When the result is required before useful work can continue, foreground waiting is the lower-cognitive-load behavior.

### Synchronous UX over an asynchronous substrate

The normal foreground experience should look like an ordinary long shell command:

```text
user: run the tests and fix whatever fails

Pi
  -> runs_submit                     # durable ownership begins immediately
  -> runs_wait(run_id)               # user-facing synchronous experience
       running  12s
       running  2m 14s
       running  17m 03s
       ...
       succeeded | failed | cancelled
  -> inspect result/logs/artifacts
  -> continue reasoning in the same turn
```

`runs_wait(run_id)` should therefore evolve from P1's 24-hour attachment cap to **no user-level deadline by default**. Omitted `timeout_ms` means "wait until the requested condition or user detach". An explicit timeout remains available for bounded checks; `until=running` remains useful for launch gates, while the normal default is `until=terminal`.

An unbounded user wait must **not** create an unbounded transport operation. It is implemented as bounded local-IPC observation slices over the already-durable Run:

```text
runs_wait(until=terminal, timeout_ms=omitted)
  -> wait_run bounded slice
  -> onUpdate(current snapshot, elapsed, health)
  -> next bounded slice
  -> ... indefinitely from the user's point of view
  -> terminal: return final Run

Escape / watcher AbortSignal / explicit detach
  -> stop only this foreground observer
  -> Run continues in runwatch
  -> persistent Run presence remains visible
  -> completion still follows the normal durable Delivery path
```

Transport/runtime rules:

- no single IPC socket is held for the full scientific runtime; each slice has its own bounded deadline;
- transient daemon restart / local IPC loss enters a visible `reconnecting` watcher state with bounded backoff instead of converting a healthy durable Run into failure;
- semantic errors such as unknown Run, protocol incompatibility or authorization failure still fail closed;
- progress updates replace the same tool-result surface and must not append one LLM-context message per heartbeat;
- heartbeat cadence may back off for very long stable Runs, but state/health changes should be surfaced promptly;
- `runs_cancel` remains the only user/model operation that asks runwatch to cancel scientific work. Detaching a watcher is never cancellation.

### Foreground-to-background transition

A user should be able to start with the familiar synchronous mode and change their mind later. This is the same product pattern as VS Code's "Continue in Background" and attach/detach task UIs:

```text
foreground wait
  -> user keeps waiting: nothing new to learn
  -> user presses Escape: current Pi turn may abort, watcher disappears, Run survives
  -> future UX: /runs detach (or equivalent immediate UI action)
       detaches only the active watcher without aborting the whole agent turn
  -> footer/widget continues to show the Run as active
```

The future `/runs` command is a **user UI command**, not a ninth model-facing Run tool and not another lifecycle authority.

This command also solves a Pi-specific interaction detail: ordinary steering messages are queued until the current assistant tool batch finishes, while extension commands can execute immediately during streaming. An in-flight watcher should therefore have its own abort controller registered by Run id so `/runs detach` can abort that watcher only, let `runs_wait` return a detached observation, and allow the agent turn to continue without sending `runs_cancel`.

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

## Unified Run presence: a Run must be hard to forget

Long-running work needs a **presence model**, not just a status API. The user should be able to switch terminals, work on another prompt, or return after a break and immediately notice that computation is still in flight. This requirement applies equally to foreground and detached Runs.

The UI is layered so no single notification mechanism becomes the source of truth:

### Layer 1 — inline foreground progress

While `runs_wait` is attached, Pi's official `onUpdate` channel updates the existing tool card/result with bounded information:

```text
Waiting: refine-42
running · Slurm <job-id> · 18m 07s · observation fresh
Escape/detach stops waiting; the Run keeps running.
```

Show state, human name/run id, runner/job handle, elapsed time, observation health and the wait condition. Do not dump repeated logs by default; logs remain an explicit bounded surface.

### Layer 2 — persistent footer dock

Use the composable `ctx.ui.setStatus("pi-runs", ...)` entry as an **always-present dock whenever there is active or attention-worthy Run state**. Clear it when truly idle rather than spending permanent footer space on `Runs idle`.

Examples:

```text
Runs ● refine 18m [attached]
Runs ● 2 active · 1 other
Runs ○ refine queued 4m · 2 other live
Runs ⚠ refine failed · 1 other live
Runs ⚠ 1 rebind · 2 active
Runs ↻ reconnecting · 2 active
```

Priority is: current foreground attachment -> current-session active Run -> current-session continuation/rebind/failure -> global failure/probe attention -> other live Runs. A current-session named Run should be shown directly when space permits; counts are the narrow-terminal fallback.

### Layer 3 — compact Run widget / dashboard

When there are multiple Runs or attention state, use Pi's `setWidget` as a compact below-editor/above-editor task dock, inspired by Pi community background-task docks and long-task sidebars. Keep only a few prioritized rows visible so the conversation is not displaced:

```text
Runs
▶ refine-map      running 18m   hpc.example/slurm #<job-id>   attached
● preprocess      running  7m   local/process        async
○ reconstruction  queued   3m   hpc.example/slurm #<job-id>
! mask-fit        failed   11m ago                    attention
```

A future `/runs` interactive command opens the complete list and actions (`attach`, `detach`, `logs`, explicit `cancel`, `rebind` where legal). This is user-facing navigation; model-facing tools stay frozen.

### Layer 4 — terminal transition notification

Use `ctx.ui.notify` as a one-shot *attention accelerator*, never as the only record that work existed:

- foreground-attached completion normally needs no duplicate toast because the tool itself returns terminal;
- detached/async success gets one concise completion notification when Pi UI is active;
- detached failure/cancellation/rebind/observation-loss gets warning/error attention;
- notifications must be deduplicated by Run terminal transition and routed to the correct session/project context; never inject a completion into an unrelated active session merely because it happens to be on screen;
- completion that happens while Pi is closed is reconstructed from runwatch/Delivery state on the next session start. A small pi-runs **UX-only seen cursor** may suppress duplicate toasts, but it is not a scheduler, ledger or source of Run truth.

Native desktop/terminal notifications can be an opt-in adapter later (similar to iTerm2's long-command completion alert), but core correctness must not depend on them.

### Presence is reconstructed, not owned, by Pi

`RunPresence` is a derived projection:

```text
RunPresence {
  run_id / display_name
  relation: attached | current_session | same_project | other
  execution: queued | running | terminal
  runner / durable_handle / elapsed
  observation_health
  continuation: none | live_armed | armed | pending | needs_rebind
  attention
}
```

The authoritative fields come from runwatch plus the exact Pi continuation binding. Any local `seen`/collapsed preference is disposable UI metadata only.

`display_name` is a first-class UX requirement, but **naming is not a required user task**. `runs_submit.name` remains optional: if the user explicitly names the work, preserve that intent; if the user says only "run the full tests" or "start reconstruction", Pi may infer a concise name; if no useful name is supplied at all, pi-runs must generate one automatically. Every Run presented to a human therefore has a readable `display_name` even though the caller never has to think about naming.

Naming resolution is intentionally separate from durable identity:

```text
requested name?  -> sanitize/bound -> display_name
        no
        v
safe semantic stem from normalized RunSpec? -> display_name
        no
        v
deterministic mnemonic fallback from stable Run identity -> display_name
```

Generation rules:

- Prefer a short semantic stem such as the script/module/test target or meaningful executable action: `scripts/refine_map.py` -> `refine-map`, a resume test target -> `resume-test`. Generic launchers such as `python`, `bash`, `pwsh` or `node` are not useful names by themselves.
- Keep the result compact (normally 1-4 words) and normalize it into a readable slug; do not expose the full shell command in the dock just to manufacture a name.
- Reject unsafe/high-entropy candidates. Raw arguments, environment values, URLs, credentials/tokens, UUID-like blobs and absolute paths must never be copied into an automatically generated label. If the safe semantic signal is weak, use a deterministic mnemonic word pair derived from stable Run identity instead, for example `quiet-cedar`.
- Generate the fallback **once before/during durable submission and persist it with the Run**. Do not recompute it from the currently active task list, so Pi restart, runwatch restart, continuation and later status views all show the same name.
- Names are not globally unique identifiers. If two relevant Runs would present the same `display_name`, keep the first name unchanged and append a stable mnemonic suffix derived from the new Run identity (for example `refine-map-cedar`), rather than an unstable counter such as `(2)` or a timestamp.
- Retry/Attempt replacement does not rename the Run. A scheduler JobID may change across attempts while `run_id` and `display_name` remain stable.
- A future user-only rename action may change `display_name` without changing `run_id`, continuation binding, scheduler handle or artifact identity.

`run_id` remains the immutable authority key and JobID/process handle remains execution detail. `display_name` is a durable human label only: UI/actions may show it prominently, but internal mutation/cancel/rebind operations resolve against `run_id`, never against a possibly ambiguous name.

On every `session_start` / resume / reload, pi-runs immediately rebuilds presence from runwatch before relying on remembered UI state. Therefore:

- switching away and back still shows active Runs;
- opening another Pi session still shows `N other live` / global attention without stealing completion delivery;
- killing/restarting Pi loses only the watcher, never the Run;
- restarting runwatch temporarily changes health/presence to reconnecting, then reconstructs the same durable Runs;
- headless/JSON/RPC modes receive the same tool partial updates and terminal result but simply omit footer/widget/toast surfaces.

### Multi-Run and notification-noise policy

Persistent visibility should be high-signal rather than noisy. Community experience with background-agent notifications shows that "some background work changed" is not the same as "the user needs attention now". Therefore:

- active work is represented continuously in the dock/widget, not by periodic toasts;
- success toast once; failure/rebind/control-plane loss gets stronger attention;
- intermediate heartbeats never trigger toast/bell;
- if several Runs finish together, coalesce them (`3 Runs completed · 1 failed`) and let `/runs` expand details;
- a busy agent turn may queue the correct-session completion follow-up, but UI presence can update immediately without starting another model turn;
- exact-session durable Delivery remains the mechanism for continuing scientific reasoning after async completion.

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
