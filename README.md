<p align="center">
  <img src="assets/icon.svg" width="120" alt="pi-runs icon"/>
</p>

# pi-runs

Pi integration for durable **Runs** managed by runwatch. Submit long scientific computation, end the active wait, and resume the same research workflow when the Run finishes.

- 痛点：[docs/pain-points.md](docs/pain-points.md)
- 设计：[docs/design.md](docs/design.md)
- 开发进度：[docs/DEVELOPMENT_CHECKPOINT.md](docs/DEVELOPMENT_CHECKPOINT.md)

`runwatchd` is the single durable Run Lifecycle Authority. The pre-runwatch local runner/wakeup implementation is archived under `legacy/` for historical migration/reference only and is no longer selectable by the active runtime; `PI_RUNS_BACKEND=legacy` fails closed. `pi-ssh-tools` remains the Pi-online remote workspace layer.

## V1 scope freeze

The current release target is deliberately limited to **Pi + pi-runs + runwatch**, with `pi-ssh-tools` providing Pi-online remote workspace access. The real Pi/provider/HPC continuation loop already works; current development is focused on installation/readiness, repeatable release acceptance, endurance testing and legacy retirement. Support for Codex or any other coding agent is deferred until this v1 path is complete and should live in a separate Agent Integration project rather than in pi-runs.
The frozen v1 adapter/release contract is documented in `docs/V1_RELEASE_CANDIDATE.md`.

`sbatch` / `bsub` / process launch succeeding only means work was submitted. Unattended long scientific waits should be handed off durably instead of keeping Pi alive merely to poll; an explicit foreground run-to-completion request may stay attached with `runs_wait` without changing runwatch's ownership of the Run.

## Install

```bash
pi install /path/to/pi-runs
# or later: pi install npm:pi-runs
```

## Tools

| Tool | Role |
|---|---|
| `runs_doctor` | read-only Pi v1 readiness: runwatch protocol/service/storage/capabilities/backend selection |
| `runs_submit` | durable hand-off; return `run_id` + execution status/handle |
| `runs_wait` | foreground observer for an existing durable Run; explicit run-to-completion wait with progress, timeout/abort detach only |
| `runs_status` | canonical runwatch snapshot; fails closed if the durable control plane is unavailable |
| `runs_logs` | tail |
| `runs_harvest` | record artifacts |
| `runs_cancel` | durable scancel / bkill / Local Process cancellation request through runwatch |
| `runs_rebind` | explicitly attach a branch-blocked completion to the current Pi session branch |

`runs_wait` is an observation lifecycle, not a Run lifecycle. It defaults to a 30-second attachment, accepts `until=terminal|running`, emits progress on bounded slices (5 seconds by default), and caps one foreground attachment at 24 hours. A timeout or Escape/Abort ends only the watcher; the durable Run keeps executing until it reaches terminal state or `runs_cancel` is explicitly requested. For hours-to-days unattended work, `runs_submit` + durable continuation remains the default because Pi can exit completely.

## Pi v1 release acceptance

The formal release gate is explicit opt-in and always uses a real Pi provider plus an explicit packaged `runwatch` executable. It creates unique isolated runwatch/Pi state under ignored `acceptance-output/`, stops spawned test processes in `finally`, and preserves the evidence directory for review instead of recursively deleting it.

```text
npm run accept:release -- --confirm-real-provider --mode local-process --runwatch-exe <path-to-packaged-runwatch> --model <provider/model>
npm run accept:release -- --confirm-real-provider --mode slurm --runwatch-exe <path-to-packaged-runwatch> --model <provider/model> --host <ssh-alias> --workdir </shared/persistent/workspace>
```

The Slurm/LSF workdir must be the same persistent shared filesystem on login and compute nodes. A successful gate requires one initial `runs_doctor`, one `runs_submit`, full initiating-Pi exit, one durable terminal Delivery/AgentInvocation, one persisted `runwatch/completion`, one settlement receipt, result inspection in the exact resumed Pi session, and no resubmission.

For resident fault/endurance qualification, use the same real-provider contract through `npm run accept:soak`. The soak driver can resume one frozen evidence session across bounded invocations while reusing the same SQLite data directory, IPC endpoint, package/code fingerprints and monotonically increasing rounds. It can combine Local Process + Slurm, serve-child restart, same-session branch divergence/rebind, completion-before-settlement crash recovery, and a real SSH transport interruption routed only through an evidence-local localhost relay. The relay never edits user SSH config/firewall/sshd and derives host trust only from already-trusted `known_hosts`; runwatch alone uses an explicit `RUNWATCH_SSH_CONFIG`. Formal >=7200 s fault endurance additionally freezes a bounded initiating-Pi seed timeout and requires `run_delay >= seed_timeout + 60s`, so an early scheduler submission cannot finish merely because another real provider seed is retrying; Slurm walltime is derived from the workload delay instead of being fixed at two minutes. Inspect preserved evidence without launching a provider via `node scripts/acceptance/pi_v1_soak.mjs --report-evidence-dir <soak-dir>`. V1 is complete only when that report says `v1_endurance.qualified=true`: target and clean active time are at least 7200 seconds, Local + Slurm both ran, and serve restart / SSH loss-recovery / branch rebind / settlement-crash each recovered at least twice with no dirty segment history. Short `--rounds`/low-target runs are qualification only.

## Pi status

While an interactive Pi session is active, pi-runs publishes a compact composable status entry such as:

```text
Runs 2 running · 1 queued
Runs 1 running · 1 failed
Runs idle
Runs 1 running · 1 continuation
Runs idle · 1 rebind
```

The extension uses its own `pi-runs` status key rather than replacing Pi's footer, so it can coexist with `pi-ssh-tools` and other footer/status extensions. The active v1 status surface is runwatch-only; durable-control-plane failures are shown as attention rather than switching ledgers. Current-session continuation work adds `continuation`, `rebind`, `session busy`, or `bridge offline` attention without filling the footer with historical successes.

## Backend safety

`PI_RUNS_BACKEND=auto` and `PI_RUNS_BACKEND=runwatch` use the canonical runwatch control plane and fail closed when it is unavailable or lacks the requested capability. `PI_RUNS_BACKEND=legacy` is retired from the active runtime and also fails closed. Historical source/data-format reference remains under `legacy/` for explicit manual migration work only.

`runs_doctor` is the supported read-only readiness surface. It probes only runwatch's local `hello`, reports the daemon build `version` for diagnosis, verifies protocol/service/storage identity, checks the complete Pi v1 capability contract, and reports `ready`, `missing_capabilities`, and actionable `reasons`. Exact version equality is not required: compatibility is protocol 1 + required capabilities. It never installs runwatch, starts/stops services, edits Pi/runwatch configuration, or selects a second ledger. A production-ready Pi v1 environment reports `selected_backend=runwatch`; requesting retired `legacy` reports `ready=false` with an explicit retirement reason.

Production durable execution includes **Windows Local × Process** as well as remote Slurm/LSF. Local `runs_submit` with no host and `runner=auto|process` is normalized to runwatch `Process`; the archived PowerShell `Start-Job` implementation is not reachable from the active runtime. Local Process is deliberately fail-closed if the Windows host Job Object does not permit process breakaway, because launching a child that dies with runwatchd would violate the durability contract.

For remote Slurm/LSF, `workdir` is a **shared durable workspace contract**, not merely a directory that exists on the SSH login host. The path must resolve to the same persistent filesystem from the login node and scheduler compute nodes so runwatch can observe its wrapper sentinel/logs and Pi can inspect scientific outputs after continuation. Node-local paths such as `/tmp` are unsupported unless that cluster explicitly provides them as shared storage.

## Live continuation

For runwatch-backed Runs — Windows Local Process or remote Slurm/LSF — `runs_submit` durably captures the current Pi session file/id/origin leaf together with the Run submission intent. When it returns:

- `continuation=live_armed`: stop actively waiting and leave Pi running. runwatch will deliver terminal completion back as a Pi follow-up.
- `continuation=armed`: runwatch advertises offline Pi continuation; the binding is durable and the Pi process may exit. The daemon can relaunch the exact recorded session through a headless RPC worker when no live lease remains.
- `continuation=binding_persisted_delivery_pending`: the binding is durable, but no live/offline continuation is currently armed; do not assume automatic resume.

If the user changes the active branch of the same Pi session while a Run is waiting, completion is blocked as `needs_rebind` instead of being injected into the wrong research branch. `runs_rebind` explicitly moves that Run to the current branch and refreshes the durable Delivery binding snapshot. The repeatable real Pi gate uses `SessionManager.branch()` to create a sibling branch, proves zero wrong-branch completion/settlement, then invokes the actual `runs_rebind` tool and validates that the final binding leaf is a descendant of the generated branch marker.

Live and offline continuation now share the same crash-safe settlement boundary. A live terminal Delivery is claimed one at a time, injects either `runwatch/completion` or a recovery message, waits for a successful final agent outcome, persists `runwatch/completion-settled`, and only then acks `delivered`. If that triggered turn fails, completion stays durable, no false settlement is written and the Delivery is retried. Real provider rebind acceptance proves the live success path with exactly one completion + settlement; the explicit real-Pi failure regression proves the retry path. Offline exact-session relaunch has the same completion/settlement contract and has also passed hpc.example Slurm, daemon-crash and SSH-loss recovery gates.

Crash recovery also carries session-side idempotency: successful offline settlement writes a hidden `runwatch/completion-settled` session receipt before the daemon ack. If runwatch loses that ack and retries later, pi-runs repairs the Delivery from the saved receipt instead of injecting a second completion. If a prior completion exists but was interrupted, the retry uses a recovery message to continue the existing context rather than duplicating the original completion.

## Layout

```
extensions/runs/     active Pi tools + live/offline continuation bridge
src/                 active runwatch client/backend/status adapter
scripts/acceptance/  repeatable release + soak gates
skills/pi-runs/       Pi workflow/safety guidance
legacy/              archived pre-runwatch runners/wakeup/store/callback code
assets/              icon + wordmark
```

## Legacy archive

`legacy/` is not loaded by the package and exposes no npm `bin`. It preserves the old JSONL store, scheduler wrappers, wakeup backends, callback entry point, parser test and systemd templates only as migration/history reference. New durable behavior must not be added there.

## Tests

```bash
npm test
# explicit real Pi live bridge gate:
PI_RUNS_REAL_LIVE_ACCEPTANCE=1 node --test test/live-bridge-real-pi.test.mjs
```
