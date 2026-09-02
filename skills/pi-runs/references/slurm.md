# Slurm runner

Handle is the JobID from `Submitted batch job N`, never the sbatch PID.

Probe before first submit on a cluster:

```bash
sinfo -o "%P %a %l %G"
sacctmgr show assoc user=$USER format=Account,Partition,QOS -p
```

Poll: `squeue` while live, `sacct -P -o JobID,State,ExitCode` after it leaves the queue.

The legacy generated script writes a terminal sentinel. In the target architecture, runwatchd owns the durable scheduler observation and sentinel fallback; Pi should not stay alive in a long `runs_wait` call.
