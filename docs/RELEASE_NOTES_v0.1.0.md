# pi-runs v0.1.0 Release Notes

Release date: 2026-09-04
Qualification completed: 2026-09-03

## Overview

`pi-runs` v0.1.0 is the Pi integration for durable long-running scientific Runs owned by `runwatchd`. The active v1 runtime is intentionally runwatch-only: `pi-runs` provides Pi tools, status and exact-session continuation semantics while `runwatch` remains the single durable Run authority and `pi-ssh-tools` remains the Pi-online remote workspace plane.

The archived pre-runwatch backend remains under `legacy/` for history/manual migration reference and is not shipped in the npm package. `PI_RUNS_BACKEND=legacy` fails closed.

## Frozen Pi v1 tool contract

- `runs_doctor`
- `runs_submit`
- `runs_wait`
- `runs_status`
- `runs_logs`
- `runs_harvest`
- `runs_cancel`
- `runs_rebind`

`runs_submit.runner` is `auto|process|slurm|lsf`. Active backend selection is `PI_RUNS_BACKEND=auto|runwatch`.

## Continuation semantics

- `live_armed`: stop active waiting but leave the current Pi process alive.
- `armed`: the binding is durable and Pi may exit completely; runwatch can relaunch the exact saved session.
- `binding_persisted_delivery_pending`: identity is durable but automatic continuation is not currently armed.
- Same-session branch divergence becomes `needs_rebind`; only explicit `runs_rebind` may move the blocked completion to the current Pi branch.
- Successful terminal continuation requires one persisted `runwatch/completion` and one `runwatch/completion-settled` receipt for the exact Delivery.
- Live and offline continuation share the same retry-safe settlement boundary.

## Execution support

- Windows Local Process through runwatch's durable Process runner.
- Remote Slurm and LSF through runwatch using the user's existing SSH trust/configuration.
- Remote scheduler workspaces must be persistent shared storage visible at the same path on login and compute nodes; node-local `/tmp` is not a supported default.
- Remote post-completion verification explicitly loads only pi-runs plus the installed `pi-ssh-tools` extension when running under `--no-extensions`.

## Distribution boundary

Final `npm pack --dry-run --json` contains **23 files / 185,363 bytes unpacked**. The package includes the active extension, active `src/`, acceptance scripts, Skill/reference material and assets. It excludes `legacy/`, old systemd wakeup units, `pi-runs-wake`, old runner/store/wakeup code and legacy parser tests.

The release tag may sit on documentation-only commits after authority-tree `<opaque-id>`; `git diff --name-only <opaque-id>..HEAD` was verified to contain only release documentation, so the tagged tree has no runtime/acceptance-code drift from the qualified authority.

## Final release validation

- `npm test`: **57 passed / 0 failed / 1 skipped**.
- Explicit Pi extension loader: exit 0.
- Explicit `PI_RUNS_REAL_LIVE_ACCEPTANCE=1` live bridge: **1/1 passed**.
- Final fixed-package Local release gate: `acceptance-output/<local-process-evidence>`; one `runs_doctor`, one `runs_submit`, Delivery attempt=1, one completed AgentInvocation, completion=1, settlement=1 and exact `runs_status/runs_logs/read` result inspection.
- Final fixed-package hpc.example Slurm release gate: `acceptance-output/<slurm-evidence>`, Job <job-id> on `/shared/workspace`; one doctor, one submit, Delivery attempt=1, one completed AgentInvocation, completion=1, settlement=1 and exact `runs_status/runs_logs/ssh_activate/ssh_read` result inspection.
- Qualified runwatch archive SHA-256: `<sha256>`; final Rust `xtask verify` returned `ok=true`.
- Formal current-binary endurance authority: `acceptance-output/<soak-evidence>` — **7800.220 s / 11 rounds / 22 real cases / 3 clean segments / 0 failed segments**; Local=11, Slurm=11, serve restarts=11, SSH recoveries=5, rebind recoveries=5, settlement-crash recoveries=3; machine `v1_endurance.qualified=true` with `reasons=[]`.

## Compatibility

The validated Pi release baseline is Pi 0.84.4. This is evidence, not a declared minimum-version promise. `runs_doctor` determines compatibility through runwatch protocol v1, `service=runwatchd`, `storage=sqlite-wal` and the complete required capability set; exact runwatch semver equality is not required.

## Known non-blocking debt

- Non-Pi AgentAdapters are intentionally deferred until after v0.1.0 and should live in independent integration projects rather than expanding pi-runs.
- Provider availability/quota remains an external operational dependency; acceptance evidence deliberately distinguishes provider failures from runwatch/pi-runs durability failures.
