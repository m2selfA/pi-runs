# pi-runs Development Checkpoint

Last updated: 2026-09-02

This is the authoritative migration checkpoint for pi-runs. **Every completed development phase must update this file before starting the next phase.**

## Product target

pi-runs is the **Pi Agent Integration Plane** for long-running scientific computation.

- `runwatchd` is the durable Run Lifecycle Authority.
- `pi-runs` owns Pi-native tools, session/branch binding, continuation messages and UX.
- `pi-ssh-tools` owns Pi-online remote workspace read/write/edit/shell.

Shared workspace semantic:

```text
RemoteWorkspaceRef { host_alias, cwd }
```

pi-runs does not import pi-ssh-tools; it may detect its tools and guide the model to explicitly activate the recorded workspace.

## Frozen architecture decisions

1. Long jobs default to `runs_submit -> continuation armed -> end turn`; long `runs_wait` is not the normal path.
2. Pi session identity is captured from extension context, not supplied by the model.
3. Target continuation binding includes session file/id and origin leaf, not only session_id.
4. The runwatch daemon is the target canonical backend; `~/.pi/runs`, local runners and wakeups are legacy migration paths.
5. pi-runs should gain a runwatch client abstraction before deleting the legacy backend, so migration is staged and testable.
6. Remote science workspace manipulation stays in pi-ssh-tools; runwatch/pi-runs only carry `RemoteWorkspaceRef` metadata and Run observability.
7. Tool failures throw; cancellation propagates; output is bounded; Pi-native lifecycle hooks are used for live session registration.
8. Pi is the only Agent Integration target for the current v1 release. Other coding-agent integrations are design backlog only until `runwatch` + `pi-runs` v1 is complete; they must not expand pi-runs or turn runwatch into an agent-specific host.

## Milestones

| Phase | Scope | Status |
|---|---|---|
| P0 | Repository hygiene + Git baseline | **completed 2026-09-02** |
| R0 | Architecture/Skill freeze with runwatch + pi-ssh-tools boundary | **completed 2026-08-31** |
| R3a | Introduce backend/runwatch-client abstraction with explicit legacy compatibility | **completed 2026-08-31** |
| R3b | Move status/logs/cancel to runwatch backend + Pi-native status surface | **completed for current runwatch capabilities 2026-08-31** |
| R3c | Move remote Slurm/LSF submit to daemon-owned durable submission | **real hpc.example combined HPC acceptance passed 2026-08-31** |
| R3e | Windows Local × Process through runwatch single authority | **durable process/daemon-restart lifecycle accepted 2026-09-01** |
| R4 | Pi live session bridge + completion message | **real Pi live terminal-delivery gate passed 2026-08-31** |
| R5 | Pi offline exact-session continuation | **real exact-session + hpc.example provider-success acceptance passed 2026-08-31** |
| R6 | origin-leaf lineage + `runs_rebind` | **real same-session `/tree` block + rebind recovery passed 2026-08-31** |
| R7 | unattended/fault matrix with remote HPC | **core crash/restart matrix completed 2026-08-31; multi-hour soak remains release hardening** |
| R8 | Pi-first v1 production closure | **in progress 2026-09-02 — installation/readiness, repeatable real-Pi release gate, soak/endurance, legacy retirement and release candidate** |
| R9 | Export AgentAdapter lessons to future non-Pi integrations | **deferred post-v1 — design only; no Codex/other-agent project work until runwatch + pi-runs v1 is complete** |

## P0 repository baseline — completed 2026-09-02

- [x] Initialized `pi-runs` as a standalone Git repository on `main` only after the real Pi + runwatch continuation path had already passed live/provider/HPC acceptance.
- [x] Added cross-platform text normalization and ignore rules for local environment files, coverage/cache output, TypeScript build metadata and temporary files.
- [x] Pre-commit high-risk credential scan found **0 hits**; no `node_modules`, `dist`, `.env`, database, key material or large generated files are present in the repository baseline.
- [x] Baseline regression: `npm test` — **37 passed, 0 failed, 1 explicit real-Pi live gate skipped by default**.
- [x] The initial commit **`<opaque-id>` — `feat: establish runwatch-backed pi-runs baseline`** intentionally captures the current runwatch-backed Pi integration as the historical baseline; legacy runner/wakeup code remains compatibility-only and is not re-authorized as a second durable control plane.

## R0 completion record

Completed:

- Reframed pi-runs from a durable control plane into the Pi integration adapter.
- Updated Skill: long scientific jobs no longer default to `runs_wait(long timeout)`.
- Frozen the explicit `pi-ssh-tools` collaboration: prepare/inspect remote workspace there; durable Run lifecycle stays in runwatch.
- Defined target session/branch-safe continuation and explicit SSH reactivation after resume.
- Marked current runners/wakeups/store as compatibility implementation, not architecture to extend.

## R3a completion record — 2026-08-31

Completed:

- [x] Added `src/backend.mjs`, separating Pi tools from the legacy `core.mjs` implementation.
- [x] Added `src/runwatch-client.mjs` as the explicit local-IPC client boundary. At R3a completion it was intentionally fail-closed until a real daemon protocol existed; R3b later replaced that stub with the live client.
- [x] Added backend selection through `PI_RUNS_BACKEND=auto|legacy|runwatch`.
  - At R3a completion, `auto` selected legacy because daemon IPC was not yet available.
  - explicit `runwatch` failed closed instead of silently falling back.
- [x] Extension tools now call the backend abstraction rather than importing the legacy core directly.
- [x] Tool failures now propagate as thrown errors instead of ordinary successful `{ error }` results.
- [x] Added submit/wait `promptSnippet` and `promptGuidelines` for durable hand-off semantics.
- [x] Legacy `runs_wait` default reduced from 1 hour / 5 s polling to 30 s / 2 s polling; long waits are no longer the default workflow.
- [x] Updated package metadata toward Pi package best practices with Pi/typebox peer dependencies.
- [x] Added backend selection/fail-closed regression tests.

Validation:

- `npm test` — **14 passed, 0 failed**.

Deferred within the broader R3 migration:

- Official typed `ExtensionAPI` + TypeBox conversion of every existing tool schema is still pending.
- Cancellation propagation needs the real runwatch IPC request layer.
- `runs_logs` / `runs_cancel` / `runs_submit` still execute through legacy until runwatch advertises the corresponding capabilities; `runs_status` has now migrated when the daemon is online.

## R3b status/read slice — completed 2026-08-31

Completed:

- [x] Replaced the runwatch-client stub with a real Node local-IPC client using Windows named pipes (and a Unix-socket path for non-Windows development).
- [x] Added per-request UUID correlation, response-id validation, bounded timeout, and `AbortSignal` cancellation support in the client transport.
- [x] Added `hello` protocol-version validation and capability discovery.
- [x] Backend selection is now **capability-aware**, not merely daemon-aware:
  - `auto` uses runwatch only for operations the daemon advertises.
  - explicit `runwatch` fails closed if the daemon is offline or the requested capability is absent.
- [x] `runs_status` / list now use runwatch `get_run` / `list_runs` automatically when `runwatchd` is online.
- At this historical status/read slice, submit/logs/cancel/artifacts still remained on legacy when their daemon capabilities were absent. Later R3b/R3c slices migrated remote submit, logs and cancel as the daemon capabilities landed.
- [x] Cross-project live integration passed against the actual runwatch daemon named pipe. Observed selection:

```text
read_backend=runwatch
submit_backend=legacy
capabilities=hello,list_runs,get_run
```

Validation:

- `npm test` — **14 passed, 0 failed**.
- live `pi-runs -> runwatchd named pipe -> SQLite` list/status probe — passed.

### R3b Pi status surface — completed 2026-08-31

Completed:

- [x] Added a composable Pi extension status entry using `ctx.ui.setStatus("pi-runs", ...)` instead of replacing the entire footer.
- [x] Status publication is **session-scoped**: start/reload on `session_start`, bounded low-frequency refresh every 10 seconds, immediate refresh after relevant Run tools / `turn_end`, and cleanup on `session_shutdown`. No long-lived timer is started from the extension factory itself.
- [x] Added compact summary semantics focused on actionable state rather than history. Examples:
  - `Runs 2 running · 1 queued`
  - `Runs 1 running · 1 failed`
  - `Runs idle`
  - `Runs 2 queued · legacy` when the compatibility backend is selected.
- [x] Historical succeeded/cancelled Runs do not consume footer space; failed/timed-out/lost and unknown states surface as attention.
- [x] The status source follows the same capability-aware backend selection as `runs_status`, so daemon-online status comes from canonical runwatch SQLite while migration/offline operation is explicitly marked `legacy`.
- [x] Converted the current extension factory to typed `ExtensionAPI` and current tool schemas to TypeBox while implementing the status surface.
- [x] Threaded tool `AbortSignal` through the backend selection/client call boundary. The remaining legacy runner implementation does not yet honor every signal internally and remains migration debt.
- [x] Fixed five leftover pre-refactor `register(...)` calls so every current tool is now registered through typed `pi.registerTool(...)`.
- [x] Fixed a pre-existing missing-comma TypeScript syntax defect in the `runs_status` tool definition that ordinary `.mjs` unit tests did not exercise.

Validation:

- `npm test` — **18 passed, 0 failed** at the UI slice; later R3c work raises the suite to 21 tests.
- Installed Pi version on cap00: **0.84.4**.
- Real Pi extension loader check: `pi --offline --no-extensions -e ./extensions/runs/index.ts --list-models` — passed with exit 0.
- Stronger extension-factory RPC smoke: `echo '' | pi --offline --no-extensions -e ./extensions/runs/index.ts --mode rpc --no-session` — extension loaded and emitted an actual `extension_ui_request` for `setStatus` with `statusKey=pi-runs`.

Current scope deliberately shows a global Run summary. Once R4 session binding exists, the default status will prioritize Runs bound to the current Pi research session/branch while retaining global attention indicators for failed/blocked deliveries.

### R3b completion additions — 2026-08-31

- [x] Added daemon `logs` capability and migrated `runs_logs` through the capability-aware runwatch client when available.
- [x] Logs remain bounded by the daemon (500 lines / 64 KiB per stdout/stderr stream) and cannot request arbitrary remote paths.
- [x] Added daemon `cancel_run` mutation and migrated `runs_cancel` when available. A successful call reports a cancel **request**; pi-runs does not claim terminal Cancelled until runwatch later observes it.
- [x] Added daemon `artifacts` capability and migrated `runs_harvest` for runwatch-owned Runs. The payload is deliberately a lifecycle inventory for the durable Attempt (`script/stdout/stderr/terminal/receipt`); arbitrary/scientific remote file inspection remains in `pi-ssh-tools`.
- [x] Live cross-project named-pipe smoke against the newly built daemon confirmed `logs_backend=runwatch` and `cancel_backend=runwatch`; advertised capabilities include both operations alongside submit/live/offline continuation.
- [x] Threaded Pi tool `AbortSignal` through current backend/client calls. Legacy local runners remain unable to honor every cancellation point.
- [x] Converted current extension registration to typed `ExtensionAPI` + TypeBox schemas.
- [x] Started live session registration from Pi lifecycle hooks with exclusive owner leases and durable delivery claim/ack.

### R3c — daemon-owned remote Slurm/LSF submit slice — completed 2026-08-31

Completed:

- [x] Added a runwatch-client `SubmitRunSpec` adapter carrying only the shared semantic contract: stable `run_id`, `RemoteWorkspaceRef { host_alias, cwd }`, explicit Slurm/LSF runner, science command and resource fields. pi-runs does not import pi-ssh-tools.
- [x] Added capability selection `submit_run_v2` only when the Pi tool call explicitly contains a remote `host + workdir` and `runner=slurm|lsf`.
- [x] Remote durable requests **fail closed** if runwatchd/`submit_run_v2` is unavailable. `auto` never silently falls back to local legacy `sbatch`/`bsub` for a request that was explicitly remote.
- [x] `runs_submit` accepts the `~/.ssh/config` Host alias and absolute remote workspace path prepared/confirmed through pi-ssh-tools.
- [x] A stable Run ID is generated from the Pi tool-call id when the model does not supply one. Any ambiguous failure message tells Pi to reuse that exact Run ID for retry, matching runwatch's remote receipt idempotency contract.
- [x] runwatch-client normalizes the daemon result into the existing Pi tool result shape without inventing a second scheduler record.
- [x] Automatic continuation is **not falsely advertised** yet: a successfully daemon-submitted Run returns `continuation=pending_agent_binding` until R4 binding/delivery is implemented. Therefore the Skill's “end the turn after continuation is armed” rule remains safe.
- [x] Added client/backend tests for remote capability selection, workspace/resource mapping and stable identity requirements.

Validation:

- `npm test` — **21 passed, 0 failed**.
- Remote submit has not been exercised against a real cluster in this stage; that belongs to the remote HPC fault/acceptance matrix after session binding and delivery are ready.

### R4/R6 — durable binding, live Pi continuation and explicit rebind — completed 2026-08-31

Completed:

- [x] `runs_submit` captures Pi `session_id`, `session_file`, `origin_leaf_id` and project cwd directly from `ctx.sessionManager`; the model never supplies them.
- [x] Remote submission passes this internal `ContinuationBinding` to runwatch, where it is committed in the same SQLite transaction as the Run/Attempt `submission_intent`.
- [x] Added a random per-Pi-process `owner_instance_id` and session-scoped live lease registration/refresh. A second live Pi owner for the same session is rejected instead of racing writes to one session JSONL.
- [x] Added a 10-second live bridge loop alongside the status refresh. It exists only for the active Pi session lifecycle; `session_shutdown` releases the lease and TTL expiry remains crash-safe cleanup.
- [x] The bridge pulls bounded pending Deliveries from runwatch rather than accepting an arbitrary daemon push channel.
- [x] Before delivery, pi-runs verifies session id, session file and that the Run `origin_leaf_id` is still present in the current `ctx.sessionManager.getBranch()` lineage.
- [x] Diverged completion is acknowledged as `needs_rebind` instead of being injected into the wrong branch.
- [x] Deliverable completions are aggregated (maximum 8 at once) into a Pi custom message and sent with `triggerTurn: true, deliverAs: "followUp"`; the message points Pi back to `runs_status`/`runs_logs` and explicit `ssh_activate` of the recorded workspace.
- [x] A successful send is followed by durable `delivered` ack. Send failure requests `retry`; if that ack is itself lost, runwatch's claim expiry makes the Delivery retryable.
- [x] Added session delivery counts to the status surface:
  - `· N continuation` for pending/delivering/retrying completion work;
  - `· N rebind` warning for branch-blocked completion;
  - `· session busy` when another Pi owns this session lease;
  - `· bridge offline` when canonical runwatch is visible but the live continuation bridge is unavailable.
- [x] Added `runs_rebind(run_id)`. The tool reads the Run workspace, captures the **current** Pi session/file/leaf itself, rewrites the durable binding through runwatch, requeues the Run's `needs_rebind` Delivery, and immediately resynchronizes the live bridge.
- [x] Tightened continuation result semantics:
  - `live_armed` = binding durable + this Pi instance owns the live lease; end the current turn and **leave Pi running**.
  - `binding_persisted_delivery_pending` = binding is durable but live bridge is not armed; do not promise automatic continuation.
  - `armed` is reserved for the later R5 offline/relaunch-capable mode.

Validation:

- `npm test` — **23 passed, 0 failed**.
- Real Pi 0.84.4 RPC factory smoke — passed and emitted `extension_ui_request(setStatus, statusKey=pi-runs)` with the live-bridge code loaded.
- Cross-project named-pipe smoke against a real runwatch daemon — passed:
  - discovered submit/live/rebind capabilities;
  - first owner lease succeeded;
  - clean delivery-status returned zero counts;
  - second owner was rejected while the first lease was live;
  - release allowed the second owner to acquire the session.

`live_armed` still means the interactive Pi process itself should remain running. Remote daemon submissions can report `armed` when runwatch advertises `offline_pi_continuation`: a real cap00 close-seed-Pi -> daemon relaunch -> exact-session completion -> `agent_settled` -> durable ack -> worker-exit acceptance now passes. A single clean real-Slurm/provider-success rerun and divergence/crash gates remain before the broader release gate closes.

### R5/R6 — offline exact-session continuation + branch-safe recovery — exact-session and `/tree` rebind gates passed; combined HPC/crash gates next

Implemented across pi-runs + runwatch:

- [x] runwatch reserves a terminal Pi Delivery for offline invocation only after the live-session lease grace window expires.
- [x] runwatch starts `pi --mode rpc --session <exact session_file> -e <pi-runs adapter>` in the recorded project root, under the same exclusive session lease used by live Pi.
- [x] The exact Delivery is bootstrapped through `RUNWATCH_OFFLINE_DELIVERY_B64`; pi-runs does not fabricate a user message.
- [x] On `session_start`, pi-runs validates project trust, exact session file and origin-leaf lineage before injecting the completion custom message.
- [x] Untrusted/diverged offline continuation becomes `needs_rebind`; there is no implicit `--approve`/trust bypass.
- [x] pi-runs waits for the injected offline agent turn to reach `agent_settled` before durable `delivered` ack and `ctx.shutdown()`.
- [x] Spawn/injection failures request retry or rely on lease/claim expiry; runwatch bounds offline launch rate and worker runtime.
- [x] Tightened offline completion semantics after real Pi testing exposed that `agent_settled` is **not** a success signal by itself. pi-runs now records the final non-retrying `agent_end` assistant outcome and uses `agent_settled` only as the settlement boundary.
- [x] A final assistant `stopReason=error|aborted`, or a settled run without a final assistant message, now acks the Delivery as `retry` with the provider/agent error instead of falsely marking it `delivered`; only a successful final assistant outcome can produce `delivered`.
- [x] Added regression coverage for successful, provider-error, aborted, and missing-final-assistant outcomes.
- [x] Real cap00 testing found and fixed a Windows launcher dependency in runwatch: Pi 0.84.4 is installed through Volta shell shims, so Rust `Command::new("pi")` could not launch it. runwatch now selects a native `pi.exe` or native `volta.exe run pi` path and does not trust `.cmd/.bat` shims for unattended continuation.
- [x] Real full-chain testing found and fixed a synchronous Pi lifecycle race: `pi.sendMessage(..., { triggerTurn: true })` can emit `agent_start` before the call returns. The adapter now marks the offline bootstrap active **before** triggering the turn, so `agent_start/agent_end/agent_settled` are attributed to the exact Delivery; an injection exception resets the gate.

Partial real Pi 0.84.4 acceptance completed:

- [x] In an isolated temporary `--session-dir`, a minimal Pi agent turn was accepted, reached `agent_settled`, and `get_state` returned an exact persisted `sessionFile/sessionId`.
- [x] A fresh Pi RPC process opened that exact `--session` file and returned the same session id/file and the expected message count, proving exact-session reopen on the installed Pi rather than a guessed/partial resume.
- [x] During harness diagnosis, confirmed Pi RPC uses strict LF-delimited JSONL; Windows PowerShell BOM-producing pipes are invalid, while native byte pipes work. Production runwatch keeps RPC stdin open and does not serialize bootstrap through PowerShell/cmd text pipelines.
- [x] The isolated real Pi turn provided the failure case that motivated the stricter settlement rule: the turn reached `agent_settled` while its persisted assistant had `stopReason=error` from a provider URL failure. This failure will now remain retryable instead of being silently acknowledged.
- [x] Created a second isolated Pi session with `provider/example-model`; its seed turn completed with final `agent_end.stopReason=stop`, reached `agent_settled`, and persisted exact session file/id/leaf. This provided a valid target for a real HPC continuation test without modifying global Pi settings.
- [x] Real hpc.example Slurm acceptance through the actual pi-runs client succeeded through offline injection: `submit_run_v2` created Run `<run-id>`, Slurm JobID <job-id>, and runwatch later reopened the exact Pi session and appended a `runwatch/completion` custom message containing the correct Run, JobID, remote workspace and offline invocation id.
- [x] The continuation inference then hit a real provider HTTP 429. Because settlement semantics were tightened, the completion was not falsely acknowledged. The offline invocation stayed outstanding while Pi could retry; after deliberate worker termination for fault injection, runwatch durably changed the Delivery to `retrying` and preserved the succeeded Run.
- [x] This closes the real **failure/recovery** acceptance path: durable remote submit -> real Slurm terminal -> offline exact-session relaunch -> pi-runs bootstrap -> agent failure -> no false delivery -> retryable durable state.
- [x] A second real Slurm attempt (JobID <job-id>) used a provider-successful `provider/example-model` session and proved deeper three-plugin flow: exact offline Pi resumed, `runs_status`/`runs_logs` used runwatch, and the automatically loaded `pi-ssh-tools` then executed `ssh_read`/`ssh_bash` on `hpc.example:/tmp`.
- [x] That attempt exposed a capability-boundary bug: `runs_harvest` fell back to the legacy store because runwatch did not advertise `artifacts`, producing `unknown run` inside an otherwise runwatch-owned workflow. The new `artifacts` migration closes this cross-backend seam before the final clean success rerun.
- [x] A separate provider-successful isolated acceptance then closed the final exact-session settlement half without touching the normal runwatch store: real Pi 0.84.4 session + `provider/example-model`, seed Pi fully exited, daemon reserved/started the offline worker, the exact JSONL received exactly one `runwatch/completion`, final assistant ended with `stop`, Delivery transitioned `pending -> delivering -> delivered`, Invocation `running -> completed`, `continuation_delivered` + `agent_invocation_exit` were durable, and the exact-session lease count returned to zero.
- [x] The first iteration of that gate reproduced the pre-fix race exactly: the model turn finished successfully while Delivery remained `delivering`; the second iteration after pre-arming the bootstrap gate passed cleanly. This gives a regression-quality real-runtime proof for the event ordering fix.
- [x] runwatch now also contains a default-ignored `real_pi_offline_continuation_acceptance` harness. With explicit isolated `RUNWATCH_DATA_DIR`, unique `RUNWATCH_ENDPOINT`, real Pi session file/id/origin leaf and adapter path, it starts an isolated IPC server, creates a synthetic terminal Delivery, launches the real offline Pi RPC worker and asserts durable `delivered`. The cap00 gate passed in **63.18 s** against Pi 0.84.4 / `provider/example-model`.

Real same-session branch safety and recovery are now validated end to end:

- [x] Used Pi 0.84.4 `SessionManager.branch()` on the same JSONL to reproduce `/tree` semantics: the active leaf moved from the Run's origin to a sibling branch without creating a new session file/id.
- [x] Offline continuation correctly acked `needs_rebind`; the wrong branch received **zero** `runwatch/completion` messages, the Invocation finalized as `blocked`, and the exact-session lease returned to zero.
- [x] This exposed a blocked-worker shutdown edge: `needs_rebind` can be decided in `session_start` before any agent event. runwatch now closes RPC stdin after Delivery leaves `delivering`, letting Pi honor `ctx.shutdown()` even when no agent turn was started.
- [x] The first real `runs_rebind` retry exposed stale durable Delivery binding snapshots. runwatch now atomically updates `continuation_bindings` and every unclaimed Delivery payload binding, and rejects rebind while a Delivery is in flight.
- [x] Repeating `runs_rebind` on the same blocked Run then recovered the **same Delivery** to `delivered`: canonical and Delivery origin leaf both became `<opaque-id>` instead of old `<opaque-id>`, completion appeared exactly once, lease count returned to zero, and Pi ended with `stop`.
- [x] Pi RPC `/fork` was separately examined and creates a new session file/id; exact-session continuation to the original bound file is therefore expected and is not a branch-lineage violation.

The final combined remote-HPC/provider-success acceptance also passes:

- [x] A fresh real Pi 0.84.4 session called the actual `runs_submit` tool exactly once for Run `<run-id>`, `hpc.example:/tmp`, Slurm JobID <job-id>, then the submitting Pi process exited completely.
- [x] runwatch independently observed the Run as `succeeded` and later relaunched the exact saved session. Delivery completed on attempt 1, the offline Invocation completed, and the session lease returned to zero.
- [x] The resumed exact session received exactly one completion and then exercised the intended three-project loop: `runs_status -> runs_logs -> runs_harvest -> ssh_activate -> ssh_read/ssh_bash`, inspecting `/tmp/runwatch-<marker>.txt` before the final assistant ended with `stop`.
- [x] This closes the formerly split acceptance halves in one Run: daemon-owned real scheduler submit/observation + Pi fully offline + provider-successful exact-session settlement + runwatch observability/artifacts + explicit pi-ssh-tools workspace/result inspection, with no human “continue”.

Acceptance still required:

- [x] Clean **combined real Slurm + provider-success** acceptance passed in one Run (hpc.example JobID <job-id>) after the artifacts migration.
- [x] Same-session `/tree` divergence -> `needs_rebind` -> explicit `runs_rebind` -> same Delivery delivered passed. `/fork` new-session semantics were separately confirmed.
- [x] Crash/restart correctness passed across reserve/spawn/ack windows and real Windows daemon restart. Multi-hour soak remains before production release.

### R7a — stale-worker / daemon-restart ownership safety — implementation landed 2026-08-31

- [x] pi-runs now calls runwatch `verify_offline_invocation` after refreshing its exact-session owner lease and before injecting the offline completion. The daemon verifies invocation id, Delivery id, owner id, Invocation state, Delivery=`delivering`, and an unexpired matching lease.
- [x] If a daemon restart has already reconciled/requeued that Invocation, a late old worker marks its bootstrap finished and shuts down **without** sending the stale completion.
- [x] Surviving workers retain authority by refreshing the same owner lease every 10 seconds; runwatch gives them a 30-second daemon-restart reconnect grace before orphan reconciliation.
- [x] This prevents the dangerous recovery race where one old worker wakes late after a new worker has already taken the same Delivery.
- `npm test` — **26 passed, 0 failed** after the ownership-verification client/adapter wiring.

### R7b — session-side exactly-once completion evidence — acceptance passed 2026-08-31

- [x] Successful offline `agent_settled` writes a `runwatch/completion-settled` Pi custom session entry before acking runwatch. The receipt is durable branch-local extension state and is excluded from LLM context.
- [x] Offline startup now classifies exact-branch evidence before sending anything: `settled`, existing completion + persisted final assistant `stop`, existing completion but incomplete, or absent.
- [x] `settled` / persisted successful completion repairs the runwatch Delivery without sending another completion. Incomplete/failed prior handling uses `runwatch/completion-recovery` instead of duplicating `runwatch/completion`.
- [x] Real isolated replay gate passed: after successful delivery, only the SQLite ack side was rewound to retrying. The second real offline worker restored Delivery on attempt 2 with **1 total completion, 0 recovery messages, 1 settlement receipt**, two completed Invocations and no remaining lease.
- `npm test` — **28 passed, 0 failed** with session evidence/recovery classification coverage; real Pi 0.84.4 extension loader also exits 0.

### R7c — real daemon kill/restart + remote HPC recovery — passed 2026-08-31

- [x] Real injected-before-settled kill: after the exact Pi session had one persisted `runwatch/completion`, runwatch daemon PID <pid> was force-killed. The old worker was reconciled, a replacement handled attempt 2 with a `runwatch/completion-recovery`, and final session evidence was **1 original completion, 1 recovery, 1 settlement receipt**, Delivery delivered and lease released.
- [x] Real remote scheduler restart: Pi submitted Run `<run-id>` to hpc.example Slurm JobID <job-id> and exited. The Run was confirmed `running` when local runwatch daemon PID <pid> was killed; after 7 seconds a new daemon opened the same store, the remote Job continued independently to success, and exact-session offline continuation completed normally.
- [x] The recovered Job <job-id> session contained exactly one completion/receipt and exercised `runs_status`, `runs_logs`, `ssh_activate`, `ssh_read`, and `ssh_bash` on `/tmp/runwatch-<run-id>.txt`, ending with assistant `stop`.
- [x] R7 functional crash correctness is closed. A multi-hour workload/daemon soak remains a production endurance gate, not an unresolved continuation protocol issue.

### Status-surface hardening + current validation — 2026-08-31

- [x] Refactored footer composition into pure `summarizePiRunsStatus(...)` logic so Run counts, continuation/rebind attention and bridge health are regression-testable without a live TUI.
- [x] Status remains composable under key `pi-runs`; it does not replace Pi's footer and therefore coexists with `pi-ssh-tools`' `ssh-tools` status.
- [x] Added tests for continuation/rebind overlays and bridge-offline/session-busy semantics while keeping historical successes out of the status line.
- [x] Refined the footer to prioritize Runs bound to the **current Pi session**. Other-session live work is compressed to `N other live`, while failures/unknown states outside the current session remain visible as `N global attention`; legacy backend summaries stay global because legacy Runs do not have reliable durable session binding.
- [x] The current session id is sourced from `ctx.sessionManager.getSessionId()` at publication time, so `/resume`/session switches do not rely on stale plugin-global identity.
- `npm test` — **26 passed, 0 failed** after offline final-agent-outcome settlement coverage.
- `npm test` — **31 passed, 0 failed** after session-scoped status + cross-session attention coverage.
- Real Pi 0.84.4 extension-loader smoke after the status change still emitted `extension_ui_request(setStatus, statusKey=pi-runs)`; the PowerShell test pipe also reconfirmed the previously documented BOM caveat without affecting extension loading.
- Live runwatch capability smoke — passed: `logs` and `cancel_run` are discovered and selected by the `auto` backend.
- [x] Migrated the short synchronous `runs_wait` client to runwatch's daemon-owned `wait_run` capability. `auto` now selects runwatch when that capability is advertised; a real isolated named-pipe smoke returned the daemon's `unknown run missing-run`, proving the call no longer hits the old fail-closed stub or the legacy process-local waiter.
- `npm test` remains **26 passed, 0 failed** after the artifacts client migration; the next live daemon smoke will verify `artifacts` selection alongside the final success rerun.

### R3 documentation consistency closeout — 2026-08-31

- [x] Updated README to describe pi-runs as the Pi integration layer rather than the durable authority.
- [x] Updated PowerShell/Slurm/wakeup Skill references so none recommend overnight/default `runs_wait` behavior.
- [x] Final `npm test` after documentation/client changes: **14 passed, 0 failed**.

### R3d — single-authority backend selection closeout — completed 2026-08-31

- [x] Removed implicit `auto -> legacy` fallback. `PI_RUNS_BACKEND=auto` now selects runwatch only and fails closed if the daemon is unavailable or does not advertise the requested capability.
- [x] Kept `PI_RUNS_BACKEND=legacy` as an explicit migration escape hatch so old JSONL Runs can still be inspected deliberately without making that ledger a hidden second authority.
- [x] This closes a dangerous ownership seam: a temporary runwatch outage can no longer make `runs_status/logs/harvest/cancel/wait` act on `~/.pi/runs` and potentially report or mutate unrelated stale state.
- [x] At this historical R3d closeout, default local submission still failed closed because Local × Process had not landed. **R3e supersedes that restriction:** current default local `runner=auto|process` uses runwatch's durable Process runner; legacy PowerShell `Start-Job` remains explicit compatibility only.
- [x] README/Skill/design were intentionally conservative at R3d; R3e updates the current documentation to advertise Local Process only after its real process/daemon durability gate passed.
- [x] `npm test` after the single-authority change — **32 passed, 0 failed, 1 real-Pi live acceptance skipped by default**.
- [x] Real Pi RPC lifecycle smoke with an intentionally missing runwatch endpoint emitted `Runs unavailable`, cleared the status on shutdown and exited 0; fail-closed backend selection does not destabilize `session_start`.

### R3e — Windows Local × Process through runwatch — lifecycle acceptance passed 2026-09-01

- [x] `normalizeSubmitRequest()` now treats no-host `runner=auto|process` as a durable local Process request and defaults `workdir` to the current Pi cwd. Supplying a remote host with `process`, or Slurm/LSF without a host, fails before backend selection.
- [x] `buildSubmitSpec()` maps the request to `workspace={host_alias:"local", cwd}`, `runner="process"`, no scheduler resources, and the same internal Pi ContinuationBinding used by remote Runs.
- [x] The extension's `runs_submit` description/prompt guidance already uses runwatch Process for local Windows work; README/design/Skill have now been synchronized so they no longer claim the runner is merely planned.
- [x] A real restricted-host negative smoke proved runwatch refuses a local launch when Windows Job breakaway is denied. The improved error explains that bypassing breakaway would be non-durable and points to the resident supervisor/autostart path.
- [x] Representative real resident-path smoke passed using the actual pi-runs runwatch client: Run `local_durable_0901` returned handle `local:<handle>`; runwatchd was terminated during the 8-second science command; the Task Scheduler supervisor replaced daemon PID <pid> while supervisor PID <pid> remained; the science process still produced `local-process-ok`; canonical status became `succeeded`; pi-runs read `stdout=science-finished` and artifacts `script/stdout/stderr/terminal/receipt`.
- [x] Disposable task/process/temp cleanup returned to zero.

This closes local **execution durability** and default-client routing. A single combined Local Process + real-provider exact-session Pi continuation Run remains optional release-hardening because the continuation/Delivery pipeline itself is runner-independent and already has independent live/offline real-Pi acceptance.

Local Process routing/documentation regression at R3e closeout: `npm test` — **35 passed, 0 failed, 1 real-Pi live gate skipped by default**. Current R3f regression is 37 passed / 0 failed / 1 skipped.

### R3f — Observation-aware Pi status — completed 2026-09-01

- [x] runwatch `get_run` / `list_runs` now return first-class Observation sidecars without changing the existing Run payload contract; pi-runs merges the matching `(run_id, attempt_no)` observation into Run views returned by `statusRun()`.
- [x] Pi footer remains execution-first and compact: `fresh` observations add no text; a live current-session Run with `probe_error`/`unreachable` adds `N probe issue(s)` and warning tone while preserving `running/queued`; another session's live probe failure contributes to `N global attention` so it is not hidden.
- [x] Real isolated smoke passed through the actual runwatch client: `obs_smoke_0901` remained `running` after an unreachable SSH alias probe, returned `observation.health=unreachable` / `source=transport`, and summarized exactly as `Runs 1 running · 1 probe issue`.
- [x] `npm test` after this status slice — **37 passed, 0 failed, 1 real-Pi live gate skipped by default**.

### R4 dedicated live-terminal acceptance — passed 2026-08-31

- [x] Added a default-skipped, repeatable real-Pi gate using a unique synthetic runwatch named pipe and temporary Pi session directory. The fake daemon derives the Delivery binding from Pi's actual `register_agent_session` request instead of fabricating a session id/file.
- [x] Real Pi runtime claimed one synthetic terminal Delivery, pi-runs injected a `runwatch/completion` custom message with `triggerTurn=true` / `deliverAs=followUp`, and the Pi RPC stream emitted a real `agent_start`.
- [x] The exact Pi session JSONL persisted both `customType=runwatch/completion` and the Delivery id before the gate completed.
- [x] The live bridge durable-acked `delivery_id=live-bridge-smoke:a1:terminal` with `outcome=delivered`.
- [x] Explicit command `PI_RUNS_REAL_LIVE_ACCEPTANCE=1 node --test test/live-bridge-real-pi.test.mjs` — **1 passed, 0 failed** in about 2.3s. The gate uses an invalid temporary provider key and terminates after delivery acceptance; provider success is deliberately not part of live-delivery correctness.

## R8 — Pi-first v1 production closure — in progress 2026-09-02

The functional Pi path is already proven. R8 turns that path into a repeatable product release and intentionally blocks new AgentAdapter work until closure.

### R8a — installation/readiness surface — completed 2026-09-02

- [x] Added read-only `runs_doctor`. Pi v1 readiness now verifies runwatch local IPC protocol v1, `service=runwatchd`, `storage=sqlite-wal`, and the complete capability set actually required by durable submit/status/wait/logs/artifacts/cancel plus live/offline Pi continuation, rebind and offline invocation ownership. Output is structured as `ready`, requested/selected backend, runwatch identity/capabilities, `missing_capabilities`, and actionable `reasons`.
- [x] Readiness never mutates configuration or starts/stops runwatch. `PI_RUNS_BACKEND=auto|runwatch` succeeds only on the canonical runwatch authority; explicit `legacy` is reported as a migration backend and never as Pi v1-ready. Missing daemon, capability gaps and unexpected service identity all fail closed in regression coverage.
- [x] The installation contract is now explicit in README/design: install the runwatch portable release and pi-runs Pi package separately; pi-runs connects through local IPC and neither copies runwatch binaries nor becomes a second daemon manager.
- [x] Real cross-project packaged smoke passed against the R11a extracted Windows package: packaged `runwatch.exe serve` reached IPC-ready on an isolated data dir/named pipe; the current pi-runs `doctorInfo` returned `ready=true`, `selected_backend=runwatch`, protocol 1, `runwatchd`/`sqlite-wal`, and **0 missing capabilities**; the test daemon was stopped in `finally`. A default-endpoint probe with no resident daemon returned `ready=false`/ENOENT as intended.
- [x] Pi itself still loads the modified extension: `volta.exe run pi --offline --no-extensions -e ./extensions/runs/index.ts --list-models` exited 0 after `runs_doctor` registration. No provider turn is required for this loader smoke.
- [x] R8a final regression: `npm test` passed **39 tests / 0 failed / 1 skipped**; readiness coverage includes daemon unavailable, capability gap, unexpected service identity, explicit legacy, and healthy Pi v1 capability contract.

### R8b — repeatable real-Pi release acceptance — completed 2026-09-02

- [x] Encode the already-passed real Pi provider + exact-session continuation + hpc.example Slurm loop as an explicit opt-in release gate using isolated runwatch/Pi state and guaranteed bounded cleanup.
- [x] Exercise both remote Slurm and Windows Local × Process execution shapes while reusing the same continuation/settlement contract.
- [x] Require exactly-once Pi session evidence (`runwatch/completion` / settlement receipt), durable Delivery/Invocation completion and explicit remote workspace reactivation/result inspection.
- [x] Added `scripts/acceptance/pi_v1_release.mjs` as an explicit `--confirm-real-provider` release harness. It requires a packaged runwatch executable, isolated named pipe/data/session state, structured Pi JSON events, a real provider model, bounded timeouts, and unique ignored `acceptance-output/` evidence. Child processes are stopped in `finally`; evidence directories are deliberately preserved rather than recursively deleted.
- [x] Windows Local × Process gate passed against the extracted R11a package with `provider/example-model`: Run `r8b_<execution>` succeeded; Delivery `...:a1:terminal` reached `delivered` in **1 attempt**; exactly **1** AgentInvocation reached `completed`; the exact Pi session persisted **1** `runwatch/completion` and **1** settlement receipt, then called exactly `runs_status`, `runs_logs`, and built-in `read` before verifying the token marker and emitting the exact release-success marker. Evidence is preserved under `acceptance-output/<local-process-evidence>`.
- [x] The first real Local Process attempt exposed an acceptance-only normalization seam: Pi supplied neutral optional tool arguments as `""`, `0`, and `wakeup=auto`. The harness now requires all contract fields exactly while allowing only a fixed allowlist of semantically neutral defaults; any non-neutral extra remains fail-closed. Regression suite remains green after the fix.
- [x] Remote Slurm release shape passed on the shared `hpc.example:/shared/workspace` workspace with packaged runwatch + real `provider/example-model`. Slurm Job <job-id> reached Run `succeeded`; Delivery reached `delivered` in **1 attempt**; exactly **1** AgentInvocation reached `completed`; the exact persisted Pi session contained **1** completion and **1** settlement receipt, then called exactly `runs_status`, `runs_logs`, `ssh_activate`, and `ssh_read`, verified the remote token marker, and emitted the exact release-success marker without resubmission.
- [x] The release gate also exposed two harness/product-contract seams and now covers them explicitly: scheduler workdirs must be shared persistent storage across login/compute nodes (the earlier Job <job-id> `/tmp` experiment proved why), and `waitForExit` now unreferences and clears its timeout after child exit so a successful provider turn no longer keeps the acceptance process alive for the remaining 180-second timeout. `npm test` after the fix passes **45 tests / 0 failed / 1 skipped**.

### R8c — multi-hour soak/endurance — in progress 2026-09-02

- [x] Added `scripts/acceptance/pi_v1_soak.mjs` and `npm run accept:soak`. The driver reuses one packaged runwatch supervisor/SQLite/IPC runtime across rounds, supports `local-process`, `slurm` or both, real provider/model selection, bounded `--rounds` qualification or `--duration-sec` endurance, configurable scientific delay and serve-restart cadence, isolated preserved evidence, and the exact R8b continuation/session settlement inspectors.
- [x] The first mixed qualification intentionally exposed an invalid fault boundary: the driver treated a persisted `status=submitting` row as durable submission and killed serve while Slurm `runs_submit` was still awaiting IPC. Local had already armed successfully, while Slurm correctly returned `runwatch IPC closed without a response`. The original ambiguous Run was recovered with the same run_id/spec/binding through runwatch's receipt-aware retry, yielding Job <job-id>, then explicitly `cancel_run` requested; evidence is preserved. The driver now requires each initiating Pi to finish successfully first and every Run to have a persisted `job_id` with `status != submitting` before restart injection. Inspection was sequential at this milestone; later combined-fault work made it concurrent, and the final cleanup hardening below preserves that concurrency while awaiting all sibling inspectors before propagating failure.
- [x] Corrected one-round mixed qualification passed in **173.802 s** against the packaged runtime with real `provider/example-model`. Before fault injection both Runs were `running`: Local handle `local:<handle>` and hpc.example Slurm Job <job-id>. Isolated serve PID <pid> was killed and the same supervisor PID <pid> restored IPC with serve PID <pid>. Both Runs then reached `succeeded`; each terminal Delivery was `delivered` in 1 attempt, each had exactly 1 completed AgentInvocation, 1 persisted completion and 1 settlement receipt. Local verified through `runs_status/runs_logs/read`; Slurm verified through `runs_status/runs_logs/ssh_activate/ssh_read`. Evidence: `acceptance-output/<soak-evidence>`.
- [x] Completion-before-settlement crash recovery is now a repeatable real-provider fault gate. Evidence `acceptance-output/<soak-evidence>` killed isolated serve after exactly one completion and before settlement; recovery retained one completion, wrote one final settlement, retried the same Delivery exactly once (attempts=2), used two AgentInvocations, and completed the exact verification sequence/marker without resubmission.
- [x] Same-session branch divergence/rebind is now repeatable using Pi 0.84.4's exported `SessionManager`, never JSONL mutation. Evidence `acceptance-output/<soak-evidence>` produced a real sibling branch with zero wrong-branch completion/settlement, `needs_rebind` + blocked Invocation, exactly one real `runs_rebind`, a final canonical origin leaf descended from the generated branch marker, Delivery attempts=2, completion=1, settlement=1, and exact `runs_status/runs_logs/read` verification.
- [x] That rebind gate exposed and closed a live-continuation durability gap: the live bridge previously acked `delivered` immediately after `sendMessage`. Live Delivery is now one-at-a-time and uses the same two-phase contract as offline continuation: completion/recovery message -> successful final agent outcome -> persisted `runwatch/completion-settled` -> final Delivery ack. A failed triggered Pi turn retains completion, writes no false settlement, and acks `retry`; the explicit real-Pi failure regression passes 1/1.
- [x] Real transient SSH-loss/recovery is now repeatable without changing the user's SSH config, firewall or hpc.example sshd. The acceptance-only localhost relay derives trust only from existing `known_hosts`; runwatch alone receives an explicit `RUNWATCH_SSH_CONFIG`. hpc.example Slurm Job <job-id> stayed `running` with the same JobID while Observation changed `fresh -> unreachable(source=transport, Channel send error) -> fresh(source=scheduler)`, then reached `succeeded` with Delivery attempts=1, Invocation=1, completion=1, settlement=1 and exact `runs_status/runs_logs/ssh_activate/ssh_read` verification. Evidence: `acceptance-output/<soak-evidence>`.
- [x] Current harness regression passes **45 tests / 0 failed / 1 skipped**; the ignored live-bridge regression also passes explicitly and verifies failure => durable completion + retry, never false settlement. Relay setup is fail-closed, preserves evidence, and closes its listener on setup failure; cleanup stops the isolated supervisor before closing the relay.
- [x] Current-HEAD packaged repeat qualification exposed and fixed a remote-rebind harness gap: the explicit rebind Pi child kept `--no-extensions` but therefore lacked `ssh_activate/ssh_read` when the active rebind target was Slurm. The harness now resolves the installed `pi-ssh-tools` package from `pi list`, validates its declared `pi.extensions` entry, and loads only that extension plus pi-runs explicitly. Failed evidence `acceptance-output/<soak-evidence>` is preserved; no product Delivery/branch corruption was hidden.
- [x] After that fix, a **456.473 s / 2-round / 4-case** current-package repeat qualification passed from runwatch HEAD `<opaque-id>`. Each round ran concurrent Windows Local Process + hpc.example Slurm and injected a serve restart plus real same-session rebind. Slurm Jobs <job-id> and <job-id> succeeded with exactly one Delivery/Invocation/completion/settlement and `runs_status/runs_logs/ssh_activate/ssh_read`; both Local Runs recovered `needs_rebind -> runs_rebind -> delivered` with completion=1 and settlement=1. Serve recovered `<pid> -> <pid>`. Evidence: `acceptance-output/<soak-evidence>`.
- [x] Regression after the remote-rebind fix was **46 passed / 0 failed / 1 skipped**; subsequent resumable-endurance hardening raises the current regression to **50 passed / 0 failed / 1 skipped**. The publish surface remains **23 files**, now **175,150 bytes unpacked**, with no `legacy/` surface.
- [x] Focused current-package **Slurm-only rebind** gate passed after the explicit `pi-ssh-tools` extension resolution change. Using verified runwatch ZIP SHA-256 `<sha256>`, hpc.example Job <job-id> ran for one 172.806 s round. The wrong sibling branch received completion=0/settlement=0, `runs_rebind` executed exactly once, the same Delivery completed on attempt 2, and the resumed Pi used exactly `runs_status/runs_logs/ssh_activate/ssh_read` before the success marker. The harness recorded the concrete installed extension `<local-path>`. Evidence: `acceptance-output/<soak-evidence>`.
- [x] Added fail-closed **resumable endurance sessions** so the formal multi-hour gate can cross bounded test invocations without pretending separate tests are continuous evidence. `endurance-session.json` freezes the runwatch executable hash, the complete active pi-runs runtime/acceptance tree hash, Pi API package code hash, pi-ssh-tools code hash, model, workspace, target duration and fault cadence. Each invocation reuses the same SQLite data directory + IPC endpoint and writes a new immutable `segment-NNNN` checkpoint with monotonically increasing rounds. Only clean successful segment active time accumulates; any failed, interrupted/incomplete, ambiguous or missing prior segment makes that evidence session non-resumable and release-blocking.
- [x] Real two-segment resume qualification passed with packaged runwatch + `provider/example-model` on Local Process. Evidence `acceptance-output/<soak-evidence>` reused the same nonce/SQLite/IPC across segment 1 (**109.485 s**, round 1) and segment 2 (**83.710 s**, round 2), accumulating **193.195 s** while correctly keeping `target_met=false` against a deliberately unreachable 600 s qualification target. A real mismatched-cadence resume was rejected by the frozen contract before `segment-0003` was created.
- [x] Added a machine-verifiable v1 endurance verdict and read-only `--report-evidence-dir`. `v1_endurance.qualified=true` requires a frozen target >= **7200 s**, clean active time meeting that target, >=2 rounds, both Local Process + Slurm, and at least **2 successful recoveries each** for serve restart, SSH loss/recovery, branch rebind and completion-before-settlement crash, with zero dirty segment history. The real `<opaque-id>` two-segment qualification report correctly returns `qualified=false` and enumerates every missing requirement instead of allowing a low-duration smoke to masquerade as release evidence.
- [x] The first formal 7200-second evidence session (`acceptance-output/<soak-evidence>`) correctly became **permanently dirty/non-resumable** rather than being papered over. Round 1 passed concurrent Local + hpc.example Slurm Job <job-id> across serve <pid> -> <pid> with exactly-once final continuation. In round 2, the Local initiating provider encountered real **524 -> 524 -> 503** errors and recovered only about seven minutes later; Slurm Job <job-id>, submitted much earlier with the old 60-second workload, had already succeeded by the scheduled SSH-fault boundary. The driver therefore failed closed with `scheduled SSH fault requires an active Slurm Run`; `failure.json` records **624.521 s / 1 completed round**, and read-only reporting returns `dirty_segments=[failed:1]`, `qualified=false`, zero credited active endurance time.
- [x] Hardened the formal endurance timing contract from that failure: seed/model arming now has an independent bounded `--seed-timeout-sec` (**60..540 s**); formal >=7200-second fault sessions require `run_delay >= seed_timeout + 60 s`; and Slurm walltime is derived as workload delay + 120 seconds rather than hard-coded to 2 minutes (for example delay 600 -> `00:12:00`). The recommended formal contract uses `run_delay=600`, `seed_timeout=480`, `timeout=1200`. Current regression is **53 passed / 0 failed / 1 skipped**; npm dry-run is **23 files / 181,938 bytes unpacked**, with no legacy surface.
- [x] Formal endurance session #2 is now a **clean resumable authority** at `acceptance-output/<soak-evidence>`. Segment 1 passed in **1004.342 s** using the hardened profile. Local handle `local:<handle>` and hpc.example Slurm Job <job-id> were both `running` before isolated serve <pid> -> <pid>. Both reached `succeeded`; each finished with Delivery attempts=1, AgentInvocation=1, completion=1, settlement=1. Local verification was `runs_status/runs_logs/read`; Slurm was `runs_status/runs_logs/ssh_activate/ssh_read`. Read-only reporting now shows `segments_completed=1`, `active_elapsed_sec=1004.342`, `dirty_segments=[]`, mixed Local+Slurm coverage and one successful serve restart; `qualified=false` remains correct because the 7200 s/repeated-fault requirements are not yet met.
- [x] Formal segment 2 / round 2 passed in **706.141 s**, bringing clean active time to **1710.483 s** with zero dirty segments. Local handle `local:<handle>` and hpc.example Slurm Job <job-id> were both active across serve <pid> -> <pid>. The scheduled SSH cut on the same JobID produced Observation `fresh -> unreachable(source=transport, Channel send error) -> fresh(source=scheduler)` while status remained `running`. The Local branch was intentionally diverged: wrong-branch completion=0/settlement=0, one blocked Invocation, exactly one `runs_rebind`, Delivery attempt 2, final completion=1/settlement=1; Slurm remained exactly once and verified `runs_status/runs_logs/ssh_activate/ssh_read`. Evaluator coverage is now rounds=2, Local=2, Slurm=2, serve restarts=2, SSH recoveries=1, rebind recoveries=1, settlement-crash recoveries=0.
- [x] Formal segment 3 / round 3 passed in **758.707 s**, cumulative clean active time **2469.190 s**. Local `local:<handle>` and hpc.example Slurm Job <job-id> were active across serve <pid> -> <pid>. The Local continuation reached the exact crash window with completion=1 and settlement=0; isolated serve <pid> -> <pid>, then orphan recovery completed the same Delivery with attempts=2, AgentInvocations=2, final completion=1 and settlement=1. Slurm also survived the global crash with attempts=2 / invocations=2 but one final completion/settlement and normal `ssh_activate/ssh_read`. Evaluator coverage is now rounds=3, serve restarts=3, SSH recoveries=1, rebind recoveries=1, settlement-crash recoveries=1, `dirty_segments=[]`.
- [x] Formal segment 4 / round 4 passed in **761.042 s**, bringing cumulative clean active time to **3230.232 s** with zero dirty segments. Local handle `local:<handle>` and hpc.example Slurm Job <job-id> were active across serve <pid> -> <pid>. The scheduled SSH cut on Job <job-id> produced `fresh -> unreachable(source=transport, Channel send error) -> fresh(source=scheduler)` while the same JobID remained running. The Local session also exercised the second real branch divergence: wrong-branch completion=0/settlement=0, exactly one `runs_rebind`, Delivery attempt 2, final completion=1/settlement=1. Coverage is now rounds=4, Local=4, Slurm=4, serve restarts=4, SSH recoveries=2, rebind recoveries=2, settlement-crash recoveries=1; the read-only evaluator is still correctly `qualified=false` only because active time is below 7200 s and settlement-crash recovery has occurred once rather than twice.
- [x] Formal session #2 is now intentionally **dirty/non-resumable** after segment 5 exposed a verifier bug rather than a product-state failure. Round 5 itself passed Local `local:<handle>` + Slurm Job <job-id> across serve <pid> -> <pid>, both with Delivery attempt=1, Invocation=1, completion=1 and settlement=1. Round 6 then combined all scheduled fault dimensions on Local `local:<handle>` + Slurm Job <job-id>: the Slurm completion-before-settlement crash produced completion=1/settlement=0 before retry and recovered to attempts=2 with final completion=1/settlement=1; the Local wrong branch still received completion=0/settlement=0, then the same global crash plus explicit rebind correctly produced attempts=3 and final completion=1/settlement=1. The old verifier hard-coded rebind attempts=2 and therefore failed after **1552.697 s** even though durable product evidence had settled correctly. `segment-0005/failure.json` is preserved and read-only reporting now returns `dirty_segments=[failed:5]`; no time from that segment is credited.
- [x] Fixed that combination-accounting defect without weakening exactly-once checks. `faultAttemptBounds()` now requires each case's own retry sources and allows at most one additional retry/Invocation from another case's injected global serve crash; the new regression explicitly covers `rebind + global settlement-crash restart`. Default `npm test` is now **53 passed / 0 failed / 1 skipped**.

- [x] Started formal endurance authority #3 at `acceptance-output/<soak-evidence>` from current HEAD `<opaque-id>`, preserving the exact hardened product/fault contract: packaged runwatch `rc-<opaque-id>`, `provider/example-model`, Local Process + hpc.example Slurm on `/shared/workspace`, delay 600 / seed timeout 480 / round timeout 1200, restart=1, rebind=2, settlement-crash=3, SSH-fault=2 for 8 s. Round 1 is clean: Local `local:<handle>` + Slurm Job <job-id> were active across serve <pid> -> <pid>, both then succeeded with Delivery attempts=1, AgentInvocation=1, completion=1 and settlement=1. The resumed Local session verified `runs_status/runs_logs/read`; Slurm verified `runs_status/runs_logs/ssh_activate/ssh_read`; both exact release markers passed. The one-process endurance driver continued directly into round 2 rather than closing the segment.
- [x] Formal authority #3 is now preserved as **failed/non-resumable** after segment 1 failed in round 2 at **1347.466 s** with only round 1 credited inside the interrupted segment and therefore zero formal active-time credit. The durable rebind path itself completed: `runs_rebind` returned `rebound=true/reset_deliveries=1`, the resumed exact Pi session received `runwatch/completion`, `runs_status` and `runs_logs` succeeded, and `read` returned the exact marker-file token `R8B_TOKEN_<nonce>`. The real provider then emitted a terminal `R8B_RELEASE_OK` string whose copied token omitted `<opaque-id>`; the current verifier correctly found zero **exact free-text success markers** and failed closed. This is distinct from the prior retry-accounting defect: durable Delivery/session evidence was present, but the acceptance gate currently conflates verified tool/result state with nondeterministic model string copying. The failed evidence is preserved and must not be repaired or resumed.
- [x] Separated durable release invariants from redundant free-text token copying without weakening the gate. `inspectPersistedSession()` still requires exactly one completion and delivered settlement for the exact Delivery, only the frozen verification tools, each non-read tool exactly once, verification-tool order, no resubmit/`runs_wait`, an exact token observed in a successful `read`/`ssh_read` tool result, and exactly one final `stop` acknowledgement bound to the completed Run. The acknowledgement's copied token field is recorded but is no longer a second source of truth for the token already verified by the tool result. Regression coverage accepts the observed provider copy-error shape, rejects a success acknowledgement bound to the wrong Run, and rejects reordered verification tools. Focused release tests pass **6/6**; default `npm test` remains **53 passed / 0 failed / 1 skipped**, including the real Pi extension loader.
- [x] Replayed the new verifier read-only against authority #3's actual failed round-2 Pi JSONL. It reports session `<session-id>`, completion=1, settlement=1, verification tools exactly `runs_status/runs_logs/read`, preserves the provider's imperfect terminal marker as observed evidence, and records `success_marker_exact=false` against the canonical expected marker. No evidence file, DB or session JSONL was changed.
- [x] Started formal authority #4 at `acceptance-output/<soak-evidence>` from pi-runs `<opaque-id>`, with the same packaged runwatch and frozen product/fault contract, using a bounded 1800 s resumable segment against the unchanged 7200 s target. Round 1 is clean: Local `local:<handle>` + hpc.example Slurm Job <job-id> were both active across serve <pid> -> <pid> and both succeeded. Each ended with Delivery=1, AgentInvocation=1, completion=1, settlement=1; Local verification is exactly `runs_status/runs_logs/read`, Slurm exactly `runs_status/runs_logs/ssh_activate/ssh_read`.
- [x] Authority #4 round 2 is clean and exercises both scheduled recovery dimensions. Local `local:<handle>` intentionally diverged to a sibling Pi branch, produced a blocked Invocation with completion=0/settlement=0 on the wrong branch, then exactly one real `runs_rebind` (`reset_deliveries=1`) recovered the same Delivery on attempt 2 with final completion=1/settlement=1 and exact `runs_status/runs_logs/read`. hpc.example Slurm Job <job-id> stayed `running` with the same JobID through the isolated relay transition `fresh -> unreachable(source=transport, Channel send error) -> fresh(source=scheduler)`, then succeeded exactly once with `runs_status/runs_logs/ssh_activate/ssh_read`. serve <pid> -> <pid>.
- [x] Authority #4 round 3 and segment 1 closed cleanly. Local `local:<handle>` and hpc.example Slurm Job <job-id> were active across serve <pid> -> <pid>. The Local continuation then reached the exact completion-before-settlement crash window (completion=1, settlement=0, Invocation PID <pid>); killing isolated serve <pid> -> <pid> recovered the same Delivery with attempts=2, AgentInvocations=2 and final completion=1/settlement=1. Slurm also survived the global crash with attempts=2 / invocations=2 and one final completion/settlement. The bounded segment exited 0 after **2229.353 s / 3 rounds / 6 cases**; read-only reporting confirms `dirty_segments=[]`, Local=3, Slurm=3, serve restarts=3, SSH recovery=1, rebind recovery=1, settlement-crash recovery=1. Qualification is correctly false only because active time is below 7200 s and each of SSH/rebind/settlement-crash has occurred once rather than repeatedly.
- [x] Closed the acceptance cleanup defect without serializing combined faults. `settleConcurrentInspections()` starts all case inspectors concurrently, awaits `Promise.allSettled()`, returns successful results in input order, and only then propagates the first rejection; `runRound()` now uses it before entering its child-process `finally`. Regression proves an immediate first-inspector rejection cannot escape while a delayed sibling is still active, and also verifies successful result ordering. Focused soak regression passes **17/17**; default `npm test` is now **55 passed / 0 failed / 1 skipped**, including the real Pi extension loader. Authority #4 remains preserved clean evidence but is intentionally not resumed because this acceptance-tree change creates a new frozen contract hash.
- [x] Started final formal authority #5 at `acceptance-output/<soak-evidence>` from cleanup-fixed pi-runs `<opaque-id>`. Frozen target/cadence remains 7200 s, Local Process + hpc.example Slurm on `/shared/workspace`, delay 600 / seed timeout 480 / round timeout 1200, restart=1, rebind=2, settlement-crash=3, SSH-fault=2 for 8 s. Round 1 is clean: Local `local:<handle>` + Slurm Job <job-id> were both active across serve <pid> -> <pid>, then each reached succeeded with Delivery=1, Invocation=1, completion=1, settlement=1 and exact Local/Slurm verification sequences.
- [x] Authority #5 round 2 is clean and exercises the scheduled rebind + SSH-loss dimensions. Local `local:<handle>` reached real same-session branch divergence with completion=0/settlement=0 before recovery; exactly one `runs_rebind` returned `rebound=true`, `reset_deliveries=1`, kept continuation armed, and recovered the same Delivery on attempt 2 with final completion=1/settlement=1 plus exact `runs_status/runs_logs/read`. Slurm Job <job-id> remained `running` with the same JobID while the isolated relay produced `fresh -> unreachable(source=transport, Channel send error) -> fresh(source=scheduler)`, then succeeded with Delivery=1, Invocation=1, completion=1, settlement=1 and exact `runs_status/runs_logs/ssh_activate/ssh_read`. serve <pid> -> <pid>.
- [x] Authority #5 round 3 / segment 1 closed cleanly. Local `local:<handle>` + hpc.example Slurm Job <job-id> survived the normal serve <pid> -> <pid>. Local then reached the exact completion-before-settlement crash window with completion=1, settlement=0 and Invocation PID <pid>; isolated serve <pid> -> <pid> recovery finished the same Delivery with attempts=2 / Invocations=2 and final completion=1/settlement=1. Slurm also survived the global crash with attempts=2 / Invocations=2 and one final completion/settlement. Segment 1 exited 0 after **2174.382 s / 3 rounds / 6 cases**. Read-only reporting confirms `dirty_segments=[]`, Local=3, Slurm=3, serve restarts=3, SSH recovery=1, rebind recovery=1, settlement-crash recovery=1; qualification is false only for remaining duration and second SSH/rebind/settlement-crash repetitions.
- [x] Authority #5 round 4 is clean and establishes the second real SSH + rebind recoveries required by the v1 gate. Local `local:<handle>` reached sibling-branch `needs_rebind` with completion=0/settlement=0, then exactly one `runs_rebind` recovered the same Delivery on attempt 2 with final completion=1/settlement=1 and exact `runs_status/runs_logs/read`. hpc.example Slurm Job <job-id> stayed `running` with the same JobID through `fresh -> unreachable(source=transport, Channel send error) -> fresh(source=scheduler)`, then completed with Delivery=1, Invocation=1, completion=1, settlement=1 and exact `runs_status/runs_logs/ssh_activate/ssh_read`. Segment-2 serve <pid> -> <pid>. Across authority #5, repeated SSH and repeated rebind requirements are now satisfied.
- [x] Authority #5 is now intentionally **dirty/non-resumable** after segment 2 failed closed in round 5 before the next fault boundary. Round 4 itself remains valid clean evidence, but segment 2 is not credited. The Local initiating provider first encountered a real 503 and recovered, then supplied scheduler-only `mem="1G"` and `time="00:10:00"` on a `runner=process` call whose frozen acceptance spec did not contain those fields. `assertSubmitArgsMatch()` rejected the first non-neutral extra (`mem`) and wrote `segment-0002/failure.json` after **760.528 s**, `rounds_completed=1`. Read-only reporting now returns `dirty_segments=[failed:2]`, so authority #5 must never be resumed or repaired in place. The isolated segment-2 supervisor/serve PIDs 96984/96568 are confirmed stopped by `finally`; evidence remains preserved.
- [x] Closed the Process optional-resource false-negative boundary by making acceptance use the **actual production `buildSubmitSpec()` normalization**. The verifier now compares the real model tool call and the frozen expected request after production normalization, so Local Process scheduler-only extras that provably collapse to `resources:{}` do not fail endurance; the same non-neutral resource on Slurm changes the normalized spec and still hard-fails. Unknown tool arguments still fail; retired `wakeup/webhook_url` remain allowed only at neutral defaults; run_id/name/runner/workdir/command are still strict because they survive normalization. A focused regression covers the observed Local `mem="1G"`, `time="00:10:00"` shape plus remote rejection. Default `npm test` is **55 passed / 0 failed / 1 skipped**. Read-only replay of authority #5 round-5 `pi-initial.stdout.log` now passes `doctor_calls=1`, `submit_calls=1`, `submitted_marker=true` without changing that failed evidence. Disposable Local PID <pid> has naturally exited.
- [x] Started formal authority #6 at `acceptance-output/<soak-evidence>` from corrected pi-runs `<opaque-id>`; frozen contract-tree SHA-256 is `<sha256>`. The target/cadence remains 7200 s, Local Process + hpc.example Slurm on `/shared/workspace`, delay 600 / seed timeout 480 / round timeout 1200, restart=1, rebind=2, settlement-crash=3, SSH-fault=2 for 8 s. Round 1 is clean: Local `local:<handle>` + Slurm Job <job-id> were active across serve <pid> -> <pid> and both reached succeeded with Delivery=1, Invocation=1, completion=1, settlement=1 plus exact Local/Slurm verification sequences and exact success markers. Slurm seed recovered automatically from one real provider 503 within the bounded seed timeout. A burst of Windows named-pipe `os error 232` messages occurred while both Runs remained live, but round-1 durable invariants and final settlements all passed; preserve this observation without treating log noise alone as qualification or failure.
- [x] Authority #6 segment 1 closed cleanly after **2249.112 s / 3 rounds / 6 cases**. Round 2 exercised the scheduled branch-rebind + SSH-loss pair: Local `local:<handle>` reached zero wrong-branch completion/settlement, exactly one `runs_rebind`, Delivery attempt 2 and final completion/settlement=1/1; hpc.example Job <job-id> remained the same running JobID through `fresh -> unreachable(source=transport, Channel send error) -> fresh(source=scheduler)` and then settled exactly once. serve <pid> -> <pid>. Round 3 then exercised completion-before-settlement recovery: Local `local:<handle>` reached completion=1/settlement=0 before isolated serve <pid> -> <pid> and recovered the same Delivery with attempts=2 / Invocations=2 and final completion/settlement=1/1; Job <job-id> also survived the global crash with attempts=2 / Invocations=2 and one final settlement. Read-only summary is `dirty_segments=[]`, active elapsed **2249.112 s**, Local=3, Slurm=3, restart=3, SSH=1, rebind=1, settlement-crash=1.
- [x] Authority #6 round 4 itself passed before the later segment failure. Local `local:<handle>` completed a second real sibling-branch recovery: zero wrong-branch completion/settlement, exactly one `runs_rebind` with `rebound=true/reset_deliveries=1`, exact `runs_status/runs_logs/read`, exact token read and one delivered settlement. hpc.example Slurm Job <job-id> completed the paired scheduled SSH-loss/recovery verifier and settled exactly once; the round returned successfully and created round 5, proving both scheduled round-4 fault inspectors closed. Segment-2 serve <pid> -> <pid>.
- [x] Authority #6 is now intentionally **dirty/non-resumable** after segment 2 failed closed in round 5. The real Local provider materially rewrote the frozen workspace from `acceptance-output\\<soak-evidence>\\...` to `acceptance-output\\soak\\<opaque-id>-<opaque-id>\\...`, and rewrote the marker command path the same way. Production `runs_submit` rejected that nonexistent Local workspace before creating a Local Run, while the strict acceptance comparator independently rejected the semantic workspace/command mismatch. The Slurm sibling had already armed Job <job-id>; it was confirmed RUNNING and explicitly cancelled with `scancel`, after which `squeue` returned no entry. Segment-2 supervisor/serve PIDs 94912/71384 are stopped. `segment-0002/failure.json` records **702.391 s / one completed round**; read-only reporting returns `dirty_segments=[failed:2]`, credits only segment 1 (**2249.112 s**) and authority #6 must never be resumed or repaired in place.
- [x] Removed the stochastic long-Windows-path transcription burden without weakening the gate. Formal soak Local Process cases now use the stable acceptance-only workspace `acceptance-output\\local-workspace`; their scientific command writes only a unique relative `local-marker-<nonce>.txt`, while `markerPath` still resolves to the exact absolute file for result inspection. The model's `runs_submit` is still compared through production `buildSubmitSpec()`, so workdir/command mutations remain hard failures. Focused release tests pass **6/6** and default `npm test` remains **55 passed / 0 failed / 1 skipped**. A real-provider Local smoke `acceptance-output/<soak-evidence>` passed **143.891 s / 1 case / exit 0**; its actual tool call used `workdir=<local-path>` and a relative marker command, proving the fix is exercised by real Pi rather than only unit tests.
- [x] Started formal authority #7 at `acceptance-output/<soak-evidence>` from pi-runs `<opaque-id>`; frozen contract-tree SHA-256 is `<sha256>`. Round 1 is clean: Local `local:<handle>` + hpc.example Slurm Job <job-id> remained active for the full 600-second workload, both transitioned `Running -> Succeeded` with zero failures, and the full round verifier returned successfully before round 2 was created. The scheduled serve <pid> -> <pid>. This proves the shortened Local workspace survives the actual formal workload as well as the short real-provider smoke.
- [x] Authority #7 round 2 passed the first scheduled SSH + sibling-branch rebind pair. Local `local:<handle>` recovered the same Delivery only after the real same-session divergence/rebind gate; hpc.example Slurm Job <job-id> passed the isolated SSH-loss/recovery verifier on the same scheduler JobID and final exactly-once inspection. The round returned successfully and created round 3; scheduled serve <pid> -> <pid>. This establishes SSH=1 and rebind=1 for authority #7 without changing the frozen tree.
- [x] Authority #7 segment 1 closed cleanly at **2176.025 s / 3 rounds / 6 cases**, with `dirty_segments=[]`. Round 3 established the first completion-before-settlement crash recovery: Local `local:<handle>` and hpc.example Job <job-id> were active across scheduled serve <pid> -> <pid>; the Local Delivery then reached exactly completion=1/settlement=0, isolated serve <pid> -> <pid>, and orphan recovery finished the same Delivery with attempts=2 / Invocations=2 but final completion=1/settlement=1. The Slurm sibling also recovered with attempts=2 / Invocations=2 and one final settlement. Machine summary now reports restart=3, SSH=1, rebind=1, settlement-crash=1; only repeated SSH/rebind/settlement-crash plus active duration remain.
- [x] Authority #7 segment 2 closed cleanly at **2277.415 s / rounds 4-6 / 6 cases**, bringing cumulative clean active time to **4453.440 s / 6 rounds / 12 cases** with `dirty_segments=[]`. Round 4 delivered the second scheduled SSH + branch-rebind pair: Local `local:<handle>` had zero wrong-branch completion/settlement then exactly one `runs_rebind` and final completion/settlement=1/1; hpc.example Job <job-id> remained the same running JobID through `fresh -> unreachable(source=transport, Channel send error) -> fresh(source=scheduler)`. Round 5 Local `local:<handle>` + Job <job-id> passed normally. Round 6 combined SSH + rebind + completion-before-settlement crash: Local `local:<handle>` completed with Delivery attempts=3 / Invocations=2 and one final completion/settlement; Job <job-id> hit completion=1/settlement=0 and recovered across isolated serve restart with attempts=2 / Invocations=2 and one final settlement. Machine coverage is now restart=6, SSH=3, rebind=3, settlement-crash=2; every repeated-fault requirement is true.
- [x] Authority #7 round 7 passed despite real provider instability without changing durable semantics. Local `local:<handle>` and hpc.example Job <job-id> both armed offline continuation and survived scheduled serve <pid> -> <pid>. The Slurm initiating turn recovered from one provider 503; after Job <job-id> succeeded, its resumed exact Pi session completed `runs_status/runs_logs/ssh_activate/ssh_read`, read the exact token, then absorbed two stall-watchdog retries before one terminal release acknowledgement. Final DB evidence is Delivery attempts=1 and one completed AgentInvocation for each Local/Slurm case, with one completion and one settlement each; round 8 was created only after these invariants passed.
- [x] Authority #7 round 8 passed the scheduled SSH + sibling-branch rebind pair. Local `local:<handle>` and hpc.example Job <job-id> were active across serve <pid> -> <pid>. Job <job-id> remained `running` on the same JobID while the isolated relay produced `fresh -> unreachable(source=transport, Channel send error) -> fresh(source=scheduler)`. Local wrong-branch evidence remained completion=0/settlement=0; exactly one `runs_rebind` returned `rebound=true/reset_deliveries=1/continuation=armed`, then the same Delivery finished on attempt 2 with Invocation=1, completion=1 and settlement=1 plus exact `runs_status/runs_logs/read`. Slurm finished attempt=1, Invocation=1, completion=1, settlement=1 with exact `runs_status/runs_logs/ssh_activate/ssh_read`; round 9 was created only after both inspectors passed.
- [ ] Continue only authority #7 under the identical frozen tree until clean active time reaches 7200 s. At **4453.440 s**, the sole remaining machine reason is `active_time_meets_target`; no code/harness change is justified while this authority remains clean.

### R8d — legacy compatibility retirement — completed 2026-09-02

- [x] Inventoried the pre-runwatch compatibility surface: `~/.pi/runs` JSONL/store schema, scheduler runner/parser modules, wakeup backends, `pi-runs-wake`, systemd templates, PowerShell `Start-Job`, webhook callback behavior and their parser tests. R8b/R8c proved the release path no longer depends on any of them.
- [x] Retired the legacy backend from the active runtime. `PI_RUNS_BACKEND=legacy` now fails closed; `runner=powershell` is rejected; active `src/` and the Pi extension no longer import legacy runner/store/wakeup code; package.json no longer exposes the `pi-runs-wake` bin.
- [x] Preserved the old implementation by Git rename under `legacy/` rather than destructive deletion: runner/store/parser/wakeup code, callback bin, parser test and systemd templates remain available for historical/manual migration reference. Any future old-data migration must be a new explicit read-only importer, never a hidden second authority.
- [x] Active tool/schema/status surfaces were narrowed accordingly: `runs_submit.runner` is now `auto|process|slurm|lsf`; webhook/wakeup knobs are no longer exposed; status is runwatch-only; README/design/Skill/AGENTS all describe the archived boundary.
- [x] Final R8d regression passes **39 tests / 0 failed / 1 skipped**. A new default `npm test` loader regression makes real Pi parse/load `extensions/runs/index.ts` when Pi is available; it immediately caught and fixed a missing-comma syntax regression that ordinary JS tests could not see. The explicit real-Pi live bridge then passed **1/1** again.
- [x] At R8d closure, `npm pack --dry-run --json` confirmed the publish surface was **22 files / 124,773 bytes unpacked** and contained no `legacy/`, systemd wakeup units, callback bin, old runner/store code or legacy parser tests. Git keeps the archive; the distributed Pi package does not.

### R8e — v1 release candidate — in progress 2026-09-02

- [x] Frozen Pi v1 tool/schema/Skill/backend semantics in `docs/V1_RELEASE_CANDIDATE.md`: active tools are `runs_doctor`, `runs_submit`, `runs_wait`, `runs_status`, `runs_logs`, `runs_harvest`, `runs_cancel`, `runs_rebind`; submit runners are `auto|process|slurm|lsf`; active backends are `auto|runwatch`; retired legacy/powershell/webhook/wakeup paths stay fail-closed/archive-only.
- [x] Frozen runwatch compatibility as protocol/capability based rather than exact-version based. `hello.version` is now diagnostic metadata propagated through `clientInfo`/`runs_doctor`; Pi v1 still requires protocol 1, `runwatchd`/`sqlite-wal`, and the exact required capability set.
- [x] Real isolated cross-project doctor smoke passed against a freshly rebuilt runwatch executable: `ready=true`, `runwatch.version=0.1.0`, protocol 1 and zero missing capabilities. The first smoke deliberately exposed a stale `target/debug/runwatch.exe` after `cargo test`, so the release contract now requires explicitly rebuilding the actual executable used by external smokes.
- [x] Frozen the npm publish boundary: the package allowlist excludes `legacy/`, callback bin, systemd wakeup units and old parser tests. Current dry-run surface is **23 files / 181,938 bytes unpacked**; formal acceptance helpers include the fail-closed resumable-endurance contract/report and seed/workload timing invariant while remote rebind explicitly resolves only the installed `pi-ssh-tools` extension instead of enabling arbitrary user extensions.
- [x] The final non-endurance runwatch lifecycle blocker is closed. Real disposable Windows Task Scheduler acceptance proved `/End` alone can leave the supervisor child alive (`natural_release=false`); runwatch now terminates only the PID verified by `supervise.lock` + `supervise.pid`, avoids `/T`, waits for supervisor/serve ownership release, and only then removes the task. The gate finished with `runtime_released=true`; breakaway Local Process science and remote scheduler jobs are not cancelled by maintenance stop.
- [x] All focused endurance fault dimensions are now individually green: resident serve restart, completion-before-settlement crash recovery, same-session branch divergence + real `runs_rebind` with live two-phase settlement, and real hpc.example SSH transport loss/recovery. R8e is blocked only on running those semantics for true multi-hour duration/repetition from the current packaged release layout.
- [ ] Re-run the final unit, live-bridge, real-provider, remote-HPC, local-Process and **true endurance** gates from the supported release/install layout before tagging v1. R8c endurance remains the release blocker, not a reason to weaken the RC checklist.

### Post-v1 AgentAdapter policy

The Codex experiment in runwatch proved that a second agent can use the durable continuation model, but it is not current pi-runs scope. After v1, other agents should receive independent Agent Integration projects (for example a future `codex-runs`) rather than being added to pi-runs or further embedded into runwatch. No such project is created during R8.

## Legacy archive (retired from active runtime)

`legacy/` contains the frozen pre-runwatch implementation: JSONL/store helpers, scheduler runner/parser modules, wakeup backends, callback bin, systemd templates and parser regression. Active package code must not import it and package metadata must not expose it as an executable path. Historical `~/.pi/runs` user data is not automatically read or mutated by v1.

If real migration demand appears later, add an explicit bounded/read-only importer that translates old records into the canonical runwatch authority. Never restore `auto -> legacy`, `runner=powershell`, best-effort webhook wakeup or a second durable writer.

## End-to-end product gate

```text
Pi prepares an SSH workspace using pi-ssh-tools
  -> runs_submit
  -> Pi exits completely
  -> remote Slurm/LSF computation runs for hours
  -> runwatch detects terminal and delivers continuation
  -> exact Pi session/branch resumes
  -> Pi explicitly ssh_activate's the recorded workspace
  -> Pi inspects artifacts and continues scientific reasoning
```

No human “continue” message is allowed in the acceptance path.
