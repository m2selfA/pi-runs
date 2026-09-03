# Slurm runner

Handle is the JobID from `Submitted batch job N`, never the sbatch PID.

Probe before first submit on a cluster:

```bash
sinfo -o "%P %a %l %G"
sacctmgr show assoc user=$USER format=Account,Partition,QOS -p
```

Poll: `squeue` while live, `sacct -P -o JobID,State,ExitCode` after it leaves the queue.

runwatch writes the attempt wrapper, stdout/stderr and terminal sentinel inside the shared durable workspace, and owns scheduler observation plus sentinel fallback. Pi does not need to stay alive for unattended work. When the next reasoning step depends on this job, `runs_wait` may stay attached with no user-level deadline while streaming bounded/reconnectable progress; it remains only a watcher, and timeout/Escape/Abort/`/runs detach` never sends scheduler cancellation.
