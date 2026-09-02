import * as slurm from "./slurm.mjs";
import * as lsf from "./lsf.mjs";
import * as powershell from "./powershell.mjs";

const table = { slurm, lsf, powershell };

export function runnerFor(kind) {
  const r = table[kind];
  if (!r) throw new Error(`unknown runner ${kind}`);
  return r;
}
