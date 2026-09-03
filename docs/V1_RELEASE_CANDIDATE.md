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

The latest dry run contains **23 files / 181,938 bytes unpacked**. Formal acceptance helpers remain inside the allowlist while legacy/runtime-retired surfaces stay excluded. Remote rebind keeps `--no-extensions` and explicitly resolves/loads only the installed `pi-ssh-tools` package alongside pi-runs, so remote verification does not depend on arbitrary user extensions. `npm test` includes a real Pi extension-loader regression when Pi is available, so TypeScript parse/load failures are release blockers rather than manual-smoke surprises.

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
- focused packaged Slurm-only rebind qualification on Job <job-id> after explicit `pi-ssh-tools` extension resolution: zero wrong-branch completion/settlement, exactly one `runs_rebind`, Delivery attempt 2 final success, and exact `runs_status/runs_logs/ssh_activate/ssh_read` result inspection.
- current follow-up Slurm-only rebind revalidation on Job <job-id> used the concrete resolved `pi-ssh-tools` extension path under `--no-extensions`: wrong-branch completion=0/settlement=0, one blocked Invocation, exactly one `runs_rebind`, the same Delivery succeeded on attempt 2, final completion=1/settlement=1, and verification was exactly `runs_status/runs_logs/ssh_activate/ssh_read`.
- resumable-endurance contract qualification: two real Local Process segments reused one nonce/SQLite/IPC authority with rounds 1 -> 2 and accumulated 193.195 s of clean active time; a changed-cadence resume failed before creating segment 3. Formal resumed evidence freezes runwatch plus Pi/pi-runs/pi-ssh-tools code hashes and permanently rejects failed/incomplete/ambiguous/missing segment history;
- read-only endurance reporting is machine-gated: `--report-evidence-dir` requires no provider/Run launch and emits `v1_endurance.qualified`. Qualification requires target >=7200 s, clean active time meeting target, >=2 rounds, both Local + Slurm, and >=2 successful recoveries each for serve restart, SSH loss/recovery, branch rebind and settlement-crash. The 193.195 s resume smoke correctly reports false with explicit missing requirements.
- the first formal 7200 s session `<soak-evidence>` is preserved as a **failed/non-resumable** release-blocking sample: round 1 passed Local + Slurm Job <job-id> across resident restart; round 2 saw real provider 524/524/503 retry latency, while the old 60-second Slurm Job <job-id> finished before the scheduled SSH cut. The harness failed closed, wrote `failed:1`, and credits zero endurance time.
- formal fault-session timing is now part of the frozen gate: bounded `seed_timeout_sec` is separate from round timeout, scientific `run_delay_sec` must exceed it by at least 60 seconds for a >=7200 s target, and Slurm walltime is generated as delay + 120 seconds. The current formal profile is delay 600 / seed timeout 480 / round timeout 1200.
- clean formal session #2 `<soak-evidence>` has started under that hardened contract. Segment 1 is valid: 1004.342 s active time, Local + Slurm Job <job-id>, both active across serve <pid> -> <pid> restart, both exactly-once terminal continuations, and zero dirty segments. It is resumable but not yet qualified; remaining duration and repeated SSH/rebind/settlement-crash coverage must occur in the same frozen evidence session.
- formal segment 2 is also clean: cumulative active time 1710.483 s; serve restart count reached 2; hpc.example Job <job-id> survived a real SSH transport cut `fresh -> unreachable -> fresh`; Local same-session divergence produced zero wrong-branch delivery before exactly one `runs_rebind` recovered the same Delivery on attempt 2. Zero dirty segments remain.
- formal segment 3 is clean: cumulative active time 2469.190 s. Local completion-before-settlement crash occurred at completion=1/settlement=0, serve <pid> -> <pid> recovery finished the same Delivery with attempts=2/invocations=2 but still exactly one completion + settlement; Job <job-id> also recovered without duplicate terminal delivery. Settlement-crash coverage is now 1, with no dirty segments.
- formal segment 4 is clean: cumulative active time **3230.232 s**. Both Local + Job <job-id> survived serve <pid> -> <pid>; the second SSH cut recovered `fresh -> unreachable -> fresh` on the same Slurm JobID, and the second Local same-session divergence recovered through exactly one `runs_rebind`. Coverage now satisfies repeated serve restart/SSH/rebind requirements; only total clean duration and a second settlement-crash recovery remain.
- formal session #2 is preserved as non-resumable after segment 5 exposed an acceptance-verifier false negative. Round 5 passed Local + Job <job-id> exactly once across serve <pid> -> <pid>. In round 6, Job <job-id> hit the intended completion=1/settlement=0 crash window and recovered to final completion=1/settlement=1 on Delivery attempt 2, while the Local sibling branch received zero completion/settlement before explicit rebind and then finished with one completion/settlement. Because the same global crash also retried the Local Delivery, its correct attempt count was 3; the old verifier incorrectly required rebind attempt 2 and failed segment 5 after **1552.697 s**. The evidence remains `dirty_segments=[failed:5]` and contributes no additional formal time.
- the verifier now models combined fault retry sources explicitly: a case must account for its own rebind/settlement-crash retries and may receive at most one extra retry from another case's injected global serve crash. A dedicated regression covers the observed rebind+global-crash shape; current default tests are **53 passed / 0 failed / 1 skipped**.

Additional formal evidence:

- formal authority #3 `<soak-evidence>` is preserved as failed/non-resumable. Round 1 passed Local + Slurm Job <job-id> across serve <pid> -> <pid> with exactly-once durable continuation. Round 2 then completed the Local branch-rebind durable path and exact marker-file read, but the real provider copied the verified token incorrectly in its terminal free-text acknowledgement by omitting `<opaque-id>`; the current verifier requires exact equality of that assistant string and therefore failed segment 1 after **1347.466 s**. No failed-segment time is credited. This failure does not justify changing DB/session evidence or accepting the old authority in place.

- the verifier now separates deterministic durability evidence from redundant LLM copying. Exact token verification remains authoritative in the successful `read`/`ssh_read` tool result; completion/settlement exactly-once, verification-tool allowlist/count/order, no resubmit/polling, and one final `stop` acknowledgement bound to the completed Run remain hard gates. The acknowledgement text is preserved in evidence and may expose an imperfect copied token without overriding the exact tool-result token. Regression covers the authority-#3 copy error, wrong-Run acknowledgement rejection and reordered-tool rejection. Focused release tests are **6/6** and default tests are **53 passed / 0 failed / 1 skipped** with the real Pi loader passing.
- a read-only replay of authority #3's actual round-2 session now verifies completion=1, settlement=1 and `runs_status/runs_logs/read` while explicitly recording that the observed acknowledgement differs from the canonical requested marker (`success_marker_exact=false`). No failed evidence was rewritten.

Additional cleanup qualification:

- clean authority #4 `<soak-evidence>` passed a bounded **2229.353 s / 3-round / 6-case** segment from `<opaque-id>`: mixed Local+Slurm, three serve restarts, one real SSH loss/recovery, one branch rebind recovery and one completion-before-settlement crash recovery, all with final exactly-once completion/settlement. Its read-only report has `dirty_segments=[]`; it is intentionally not resumed because a subsequent acceptance-only cleanup fix changes the frozen tree.
- concurrent combined-fault inspection now uses an all-settled barrier: every inspector starts concurrently, all siblings settle before any rejection propagates, and `runRound()` reaches child cleanup without orphaning another inspector's timers/polls. Focused soak tests pass **17/17**; default regression is **55 passed / 0 failed / 1 skipped**, including the real Pi loader.

Still blocking a v1 tag:

- start the final frozen formal endurance authority from the cleanup-fixed acceptance tree and run/resume it under the same 7200 s target and fault cadence until the read-only report returns `v1_endurance.qualified=true`. All earlier authorities remain preserved; only clean segments from this final authority may count.

No formal gate may require a human `continue` message.
