# Wakeup backends

These backends describe the **legacy pi-runs runtime** and are retained only during migration. Do not extend them for new durable behavior.

The target wakeup path is runwatchd's durable Delivery outbox plus the Pi continuation adapter. `runs_wait` is a short synchronous wait and is not a wakeup backend for long scientific work.

Legacy `sidecar`, `systemd-user`, `powershell-event`, webhook, and `pi-runs-wake` code remains available only until the corresponding runwatch capabilities are migrated.
