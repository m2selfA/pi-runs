import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { platform } from "node:os";

const execFileAsync = promisify(execFile);

async function hasCmd(cmd) {
  const finder = platform() === "win32" ? "where" : "which";
  try {
    await execFileAsync(finder, [cmd]);
    return true;
  } catch {
    return false;
  }
}

export async function detectRunners() {
  const slurm = await hasCmd("sbatch");
  const lsf = await hasCmd("bsub");
  const powershell = (await hasCmd("pwsh")) || (await hasCmd("powershell"));
  return { slurm, lsf, powershell, platform: platform() };
}

export async function chooseRunner(requested) {
  const found = await detectRunners();
  if (requested && requested !== "auto") {
    if (!found[requested]) {
      throw new Error(`runner ${requested} not found on PATH`);
    }
    return requested;
  }
  if (found.slurm) return "slurm";
  if (found.lsf) return "lsf";
  if (found.powershell) return "powershell";
  throw new Error("no runner detected (need sbatch, bsub, or pwsh/powershell)");
}

export function chooseWakeup(requested, runner, foundPlatform = platform()) {
  if (requested && requested !== "auto") return requested;
  if (foundPlatform === "win32" && runner === "powershell") return "powershell-event";
  if (foundPlatform !== "win32") return "systemd-user";
  return "sidecar";
}
