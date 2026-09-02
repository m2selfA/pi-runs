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

### R8a — installation/readiness surface — next

- [ ] Define the supported installation relationship between the Pi package and the runwatch release layout without copying runwatch binaries into pi-runs or creating a second daemon manager.
- [ ] Make missing/incompatible runwatchd, unavailable capabilities, extension-load failure and backend selection diagnosable from the Pi-facing surface while remaining fail-closed.
- [ ] Keep `PI_RUNS_BACKEND=legacy` an explicit migration escape hatch only; installation/readiness must never silently select it.

### R8b — repeatable real-Pi release acceptance

- [ ] Encode the already-passed real Pi provider + exact-session continuation + hpc.example Slurm loop as an explicit opt-in release gate using isolated runwatch/Pi state and guaranteed bounded cleanup.
- [ ] Exercise both remote Slurm and Windows Local × Process execution shapes while reusing the same continuation/settlement contract.
- [ ] Require exactly-once Pi session evidence (`runwatch/completion` / settlement receipt), durable Delivery/Invocation completion and explicit remote workspace reactivation/result inspection.

### R8c — multi-hour soak/endurance

- [ ] Run concurrent long workloads across daemon restarts, transient SSH loss, scheduler completion and offline Pi relaunch.
- [ ] Include same-session branch divergence/rebind and crash windows around completion injection/settlement so exactly-once guarantees survive prolonged operation.

### R8d — legacy compatibility retirement

- [ ] Inventory real user migration needs for `~/.pi/runs`, `src/runners/*`, `src/wakeup/*`, `pi-runs-wake` and historical callbacks.
- [ ] Delete or convert obsolete legacy paths to explicit import/migration tooling only after the release path no longer needs them; never restore automatic fallback.

### R8e — v1 release candidate

- [ ] Freeze Pi tool/schema/Skill semantics, installation documentation and runwatch protocol compatibility expectations.
- [ ] Re-run unit, live-bridge, real-provider, remote-HPC, local-Process and endurance gates from the supported release/install layout before tagging v1.

### Post-v1 AgentAdapter policy

The Codex experiment in runwatch proved that a second agent can use the durable continuation model, but it is not current pi-runs scope. After v1, other agents should receive independent Agent Integration projects (for example a future `codex-runs`) rather than being added to pi-runs or further embedded into runwatch. No such project is created during R8.

## Legacy compatibility debt

Do not expand these paths:

- `~/.pi/runs/runs.jsonl`
- `src/runners/*`
- `src/wakeup/*`
- `bin/pi-runs-wake.mjs`
- PowerShell `Start-Job` durability assumptions
- best-effort webhook delivery
- process-local long wait loop

They are now unreachable from the default `auto` backend and will be deleted or converted to import tooling after any required legacy-data migration. First-class Local × Process now lives in runwatch and is the default durable local path; the old `Start-Job` implementation must not regain automatic routing.

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
