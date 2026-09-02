export type SchedulerKind = "slurm" | "lsf" | "powershell";

export type WakeupKind =
  | "auto"
  | "poll"
  | "sidecar"
  | "systemd-user"
  | "powershell-event"
  | "webhook";

export type RunStatus =
  | "submitted"
  | "pending"
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "lost";

export const TERMINAL: readonly RunStatus[] = [
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "lost",
];

export function isTerminal(status: RunStatus): boolean {
  return (TERMINAL as string[]).includes(status);
}

export type RunHandle =
  | { kind: "slurm"; jobId: string }
  | { kind: "lsf"; jobId: string; queue?: string }
  | {
      kind: "powershell";
      instanceId: string;
      pid?: number;
      computerName?: string;
    };

export type OutputSpec = {
  glob: string;
  required?: boolean;
};

export type HarvestedArtifact = {
  path: string;
  bytes?: number;
  sha256?: string;
};

export type RunRecord = {
  run_id: string;
  name?: string;
  command: string;
  runner: SchedulerKind;
  wakeup: Exclude<WakeupKind, "auto">;
  handle?: RunHandle;
  status: RunStatus;
  exit_code?: number | null;
  workdir: string;
  run_dir: string;
  stdout_path: string;
  stderr_path: string;
  terminal_path: string;
  created_at: string;
  updated_at: string;
  harvested_at?: string;
  output_specs?: OutputSpec[];
  artifacts?: HarvestedArtifact[];
  webhook_url?: string;
  notes?: string;
};

export type SubmitRequest = {
  command: string;
  name?: string;
  runner?: SchedulerKind | "auto";
  wakeup?: WakeupKind;
  workdir?: string;
  output_specs?: OutputSpec[];
  webhook_url?: string;
  extra_headers?: string[];
  time?: string;
  queue?: string;
  partition?: string;
  account?: string;
  cpus?: number;
  mem?: string;
  gpus?: number;
};
