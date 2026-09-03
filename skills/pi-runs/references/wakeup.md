# Wakeup backends

These backends describe the **retired legacy pi-runs runtime**. Their source/templates are archived under `legacy/` for historical migration reference only and are not loaded by the active package. Do not extend them for new durable behavior.

The target wakeup path is runwatchd's durable Delivery outbox plus the Pi continuation adapter. `runs_wait` is an optional foreground observation window, not a wakeup backend or a durable owner; it may block when run-to-completion is explicitly requested, and detaching it leaves the Run and Delivery path intact.

Legacy `sidecar`, `systemd-user`, `powershell-event`, webhook, `pi-runs-wake`, and systemd templates are archived only for reference. The supported wakeup path is runwatch Delivery + Pi continuation.
