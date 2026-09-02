# PowerShell runner (Windows first-class)

The legacy backend uses `Start-Job` via `pwsh` or Windows PowerShell. This path is migration compatibility only: PowerShell jobs and session-bound events are not a durable unattended runtime once their owning PowerShell session exits.

For minutes-to-days local Windows work, use the runwatch Local Process runner now available through `runs_submit` with no host and `runner=process` (or local `auto`). It uses a detached process identity + durable terminal protocol rather than session-bound `Start-Job`. `runs_wait` remains a short synchronous tool, not an overnight watcher.
