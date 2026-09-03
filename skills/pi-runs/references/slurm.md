# Slurm runner

Handle is the JobID from `Submitted batch job N`, never the sbatch PID.

Probe before first submit on a cluster:

```bash
sinfo -o "%P %a %l %G"
sacctmgr show assoc user=$USER format=Account,Partition,QOS -p
```

Poll: `squeue` while live, `sacct -P -o JobID,State,ExitCode` after it leaves the queue.

runwatch writes the attempt wrapper, stdout/stderr and terminal sentinel inside the shared durable workspace, and owns scheduler observation plus sentinel fallback. Pi does not need to stay alive for unattended work. If the user explicitly wants run-to-completion observation, `runs_wait` may stay attached and stream bounded progress, but it remains only a watcher: timeout/Escape/Abort detaches it and never sends scheduler cancellation.
