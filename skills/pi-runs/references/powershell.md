# Windows Local Process

For minutes-to-days local Windows work, use the runwatch Local Process runner through `runs_submit` with no host and `runner=process` (or local `auto`). It uses a detached process identity, durable attempt/terminal records and runwatch-owned cancellation/observation rather than a session-bound PowerShell job.

The old `Start-Job` implementation is archived under `legacy/` and is not selectable by the active runtime. If runwatch cannot establish the required Windows process durability boundary, fail closed instead of recreating a PowerShell-session owner. `runs_wait` may foreground-observe the durable Process when explicitly requested, even for a long run-to-completion step, but it never owns that Process; watcher timeout/Escape/Abort only detaches and does not terminate the Run.
