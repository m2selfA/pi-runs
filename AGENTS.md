# AGENTS

This package is the Pi coding-agent integration layer for durable Runs.

- `runwatchd` is the target Run Lifecycle Authority. Do not add a second durable scheduler/watch control plane to pi-runs.
- `pi-ssh-tools` owns Pi-online remote workspace read/write/edit/shell. Do not duplicate those generic SSH tools here.
- V1 is Pi-only. Do not add Codex/Claude/Grok/other-agent integration to pi-runs; future agents get separate Agent Integration projects after runwatch + pi-runs v1 is complete.
- Choose foreground/background by dependency, not job duration. `runs_submit` always establishes durable ownership first; if the next reasoning step depends on the result, `runs_wait` may remain attached without a user-level deadline. Detach/end the turn for explicit concurrency or unattended work. Foreground waiting must surface progress/reconnect state, respect AbortSignal, and watcher detach/timeout/abort must never cancel the Run.
- Pre-runwatch runners/wakeup/store/callback code is archived under `legacy/` and is not part of the active runtime. Do not import or expand it; any future old-data migration must be explicit and read-only.
- New backend work should go through the runwatch client/adapter boundary.
- Do not expand runwatch with new agent-specific behavior from this project. Treat the agent-neutral durable contract as the boundary; agent-specific identity/resume/settlement stays in its integration project.
- Pi session/branch identity must come from extension context, not model-supplied guesses.
- Tool failures should throw; respect cancellation; keep tool/log outputs bounded.
- Active scheduler parsing/observation belongs to runwatch. `legacy/src/parse.mjs` is historical reference only.
