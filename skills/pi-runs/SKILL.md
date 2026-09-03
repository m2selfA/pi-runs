---
name: pi-runs
description: Submit and resume long-running scientific computation as durable Runs. Use for runwatch-backed Windows Local Process or Slurm/LSF remote HPC jobs that may take minutes to days and must continue the same Pi research workflow after completion without manual polling.
---

# pi-runs

Pi integration for durable **Runs**. `runwatchd` owns the long-lived Run lifecycle; pi-runs binds it to the current Pi research context.

## Rules

1. Long scientific jobs go through `runs_submit`; do not `sleep` + `squeue` / `bjobs`. `runs_submit` establishes durable ownership first, then choose observation mode from workflow dependency rather than duration.
2. If the next reasoning step needs the result, call `runs_wait` with no timeout and stay attached until terminal even if the Run may take hours. If the user asked for concurrency/unattended work or Pi can do genuinely independent work, detach/end the turn and rely on the durable continuation (`armed` may exit Pi completely; `live_armed` may leave Pi running).
3. `continuation=binding_persisted_delivery_pending` means the Run/session binding is durable but neither live nor offline continuation is currently armed. Do not claim automatic resume yet.
4. `sbatch` / `bsub` / process-launch success only means submitted/started. Scientific success is a later terminal state plus the relevant exit/result evidence.
5. `runs_wait` is a foreground observer for an existing durable Run. Omitted `timeout_ms` means no user-level deadline; bounded IPC slices continue until the condition/terminal state, with transient control-plane loss shown as reconnecting. Explicit timeout, Escape/Abort, or `/runs detach` only detaches the watcher and never cancels the Run.
6. For remote HPC, do not run heavy compute directly on login nodes; use Slurm/LSF scheduler-backed Runs. The remote `workdir` must be persistent shared storage visible at the same path from both the SSH login node and scheduler compute nodes; do not use node-local `/tmp`/scratch unless the cluster explicitly makes it shared. For long computation on the Windows workstation itself, omit `host` and use the durable runwatch Local Process path.
7. When a Run belongs to a remote workspace and `ssh_activate` is available, explicitly activate the recorded `host:/cwd` before reading/editing scientific outputs. Never assume SSH mode persisted across Pi sessions.
8. On continuation, inspect `runs_status` / `runs_logs`, then inspect expected artifacts and continue the scientific reasoning that created this Run. Do not resubmit merely because the previous Pi process disappeared.
9. If continuation reports a branch mismatch / `needs_rebind`, do not force it into the current branch; rebind explicitly.
10. The active runtime is runwatch-only and never falls back to the legacy `~/.pi/runs` ledger. Treat runwatch unavailability/capability gaps as durable-control-plane failures. `PI_RUNS_BACKEND=legacy` is retired and must fail closed; `legacy/` is historical migration reference only.
11. Windows local long jobs use runwatch `Process` (`runner=process`, or `auto` with no host). Never substitute the legacy PowerShell `Start-Job` backend. If runwatch reports that Windows Job breakaway is denied, treat that as a durability failure and use the resident `runwatch supervise` / autostart service rather than bypassing the check.

## Tools

- `runs_submit` — durable hand-off; returns a `run_id`, stable human `display_name`, and execution handle/status. `name` is optional; pi-runs generates a safe memorable fallback when omitted.
- `runs_status` — snapshot of durable state; not a polling loop.
- `runs_logs` — bounded stdout/stderr and Run-level diagnostics.
- `runs_harvest` / artifacts — inventory outputs after terminal.
- `runs_cancel` — request cancellation.
- `runs_wait` — foreground `until=terminal|running` observer; omitted timeout waits indefinitely from the user's perspective over bounded/reconnectable progress slices; detach/abort never cancels.
- `runs_rebind` — bind an existing Run to the current Pi branch when supported.

## Typical long-job flow

1. If remote, use `ssh_activate` plus `ssh_read` / `ssh_edit` / `ssh_bash` to prepare and quickly validate the workspace.
2. Call `runs_submit` with command/resources/workspace information.
3. Report the readable Run name plus `run_id` when useful. If the next reasoning step depends on completion, call `runs_wait` and stay attached; otherwise detach and use durable continuation. `/runs detach` may change an in-progress foreground wait to background without transferring or cancelling Run ownership. If only the binding is persisted, report that limitation.
4. When resumed after terminal, call `runs_status` and `runs_logs`.
5. Explicitly reactivate the recorded remote workspace if needed, inspect artifacts, and continue the research step.
6. Submit another Run only if the scientific result actually requires another computation.
