import { homedir } from "node:os";
import { join } from "node:path";

export function runsHome() {
  if (process.env.PI_RUNS_HOME) return process.env.PI_RUNS_HOME;
  return join(homedir(), ".pi", "runs");
}

export function runDir(runId) {
  return join(runsHome(), runId);
}

export function storePath() {
  return join(runsHome(), "runs.jsonl");
}
