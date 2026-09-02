# pi-runs v1 Release Candidate Contract

Status: **public adapter contract frozen; v1 tag blocked on endurance evidence**.

## Scope

V1 supports Pi only. `runwatchd` is the single durable Run authority and `pi-ssh-tools` is the Pi-online remote workspace plane. Other coding agents are deferred to separate post-v1 integration projects.

The validated Pi release baseline is Pi 0.84.4. This is evidence, not a declared minimum-version promise; the formal compatibility gate below is what pi-runs can verify automatically.

## Frozen Pi tools

```text
runs_doctor
runs_submit
runs_wait
runs_status
runs_logs
runs_harvest
runs_cancel
runs_rebind
```

`runs_submit.runner` is `auto|process|slurm|lsf`. Remote scheduler submissions require a host alias and a persistent shared absolute workspace; local long jobs use Process. `powershell`, webhook/wakeup knobs and the pre-runwatch ledger are retired.

Active backend selection is `PI_RUNS_BACKEND=auto|runwatch`. `legacy` fails closed and the archived implementation is not shipped in the npm package.

## Continuation contract

The v1 handoff states are:

- `live_armed`: stop actively waiting but leave the current Pi process alive;
- `armed`: the binding is durable and Pi may exit completely; runwatch can relaunch the exact saved session;
- `binding_persisted_delivery_pending`: identity is durable but automatic continuation is not currently armed.

Branch divergence must produce `needs_rebind`; only explicit `runs_rebind` may move the blocked Run to the current branch. Completion is exactly-once through the persisted `runwatch/completion` plus `runwatch/completion-settled` receipt contract.

## runwatch compatibility

A ready installation requires:

```text
protocol_version = 1
service = runwatchd
storage = sqlite-wal
```

and these capabilities:

```text
hello
list_runs
get_run
submit_run_v2
wait_run
logs
artifacts
cancel_run
register_agent_session
release_agent_session
claim_deliveries
delivery_status
ack_delivery
rebind_continuation
verify_offline_invocation
offline_pi_continuation
```

`hello.version` is surfaced by `runs_doctor` for diagnostics only. Exact semver equality is not a gate; a daemon with protocol 1 and the required capabilities is compatible.
A real isolated cross-project smoke with a freshly rebuilt runwatch executable returned `version=0.1.0`, `ready=true`, protocol 1 and zero missing capabilities. External compatibility gates must rebuild the actual executable they launch; a test-harness rebuild alone is not sufficient.

## Distribution boundary

The npm `files` allowlist ships only the active extension, active src, acceptance scripts, Skill/reference material and assets. `legacy/`, old systemd units, `pi-runs-wake`, old runner/store/wakeup code and legacy parser tests are Git history/reference only and must not enter the package.

The latest dry run contains **23 files / 163,586 bytes unpacked**. Formal acceptance helpers remain inside the allowlist while legacy/runtime-retired surfaces stay excluded. Remote rebind keeps `--no-extensions` and explicitly resolves/loads only the installed `pi-ssh-tools` package alongside pi-runs, so remote verification does not depend on arbitrary user extensions. `npm test` includes a real Pi extension-loader regression when Pi is available, so TypeScript parse/load failures are release blockers rather than manual-smoke surprises.

## Release gates

Already qualified:

- unit + Pi loader regression;
- explicit real-Pi live bridge;
- packaged runwatch readiness/doctor;
- real provider Windows Local Process exact-session continuation;
- real provider hpc.example Slurm exact-session continuation on shared storage;
- exactly-once Delivery/AgentInvocation/session settlement;
- mixed Local + Slurm resident serve-restart qualification;
- Windows resident upgrade/uninstall lifecycle: Task Scheduler `/End` plus verified supervisor-only termination released supervisor/serve ownership without process-tree cancellation; runwatch refuses unregister while an independent owner remains.
- focused completion-before-settlement crash recovery with one completion, one settlement and retry-safe recovery;
- focused same-session sibling-branch `needs_rebind -> runs_rebind -> delivered` using real Pi SessionManager lineage and live two-phase settlement;
- focused real hpc.example SSH transport cut/recovery on Job <job-id>: `fresh -> unreachable -> fresh`, same JobID, then exactly-once offline continuation;
- explicit real-Pi live failure regression: completion remains durable, no false settlement is written, and Delivery is retried rather than acked delivered;
- current-HEAD packaged repeat qualification: 456.473 s, 2 rounds / 4 real cases, concurrent Local + Slurm, two resident serve restarts, two real same-session rebind recoveries, Slurm Job <job-id>, and exactly-once final continuation evidence. This increases repetition evidence but is intentionally not counted as the multi-hour gate.

Still blocking a v1 tag:

- one true multi-hour endurance run from the current packaged layout that repeatedly combines concurrent Local + scheduler workloads with resident restart, SSH loss/recovery, branch rebind and completion/settlement crash recovery. The focused fault dimensions are already qualified; duration/repetition under one resident authority is the remaining gate.

No formal gate may require a human `continue` message.
