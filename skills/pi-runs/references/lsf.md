# LSF runner

Handle is `Job <id>` from `bsub`. Queue name is stored when present.

`bjobs` only sees live jobs. Terminal state comes from `bhist -l` (`Done successfully` vs `Exited with exit code N`).

Do not treat a successful `bsub` as a finished calculation.

Useful probe:

```bash
bqueues
bhosts
```
