/** Scheduler output parsers. Plain ESM so tests run without a TS loader. */

export function parseSbatchOutput(text) {
  const m = String(text).match(/Submitted batch job\s+(\d+(?:_\d+)?)/i);
  if (!m) return null;
  return { kind: "slurm", jobId: m[1] };
}

export function mapSlurmState(state) {
  const s = String(state || "").toUpperCase().split("+")[0];
  if (s === "PENDING" || s === "CONFIGURING") return "pending";
  if (s === "RUNNING" || s === "COMPLETING") return "running";
  if (s === "COMPLETED") return "succeeded";
  if (s === "FAILED" || s === "NODE_FAIL" || s === "OUT_OF_MEMORY" || s === "OOM") return "failed";
  if (s === "TIMEOUT" || s === "DEADLINE") return "timed_out";
  if (s === "CANCELLED" || s === "CANCELED") return "cancelled";
  return null;
}

export function parseSqueueLine(text) {
  const line = String(text).trim().split(/\n/).pop() || "";
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const jobId = parts[0];
  const state = mapSlurmState(parts[1]);
  if (!state) return { jobId, status: "running" };
  return { jobId, status: state };
}

export function parseSacctLine(text) {
  const line = String(text).trim().split(/\n/).filter(Boolean).pop() || "";
  const parts = line.split("|");
  if (parts.length < 3) return null;
  const jobId = parts[0].replace(/\.batch$/, "");
  const state = mapSlurmState(parts[1]);
  const exit = parts[2] || "";
  const code = Number.parseInt(exit.split(":")[0], 10);
  return {
    jobId,
    status: state || "lost",
    exit_code: Number.isFinite(code) ? code : null,
  };
}

export function parseBsubOutput(text) {
  const m = String(text).match(/Job\s+<(\d+)>\s+is submitted to (?:queue\s+<([^>]+)>|the queue)/i);
  if (!m) return null;
  const handle = { kind: "lsf", jobId: m[1] };
  if (m[2]) handle.queue = m[2];
  return handle;
}

export function mapLsfState(state) {
  const s = String(state || "").toUpperCase();
  if (s === "PEND" || s === "PSUSP" || s === "WAIT") return "pending";
  if (s === "RUN" || s === "SSUSP" || s === "USUSP") return "running";
  if (s === "DONE") return "succeeded";
  if (s === "EXIT") return "failed";
  if (s === "UNKWN" || s === "ZOMBI") return "lost";
  return null;
}

export function parseBjobsLine(text) {
  const line = String(text).trim().split(/\n/).filter((l) => !l.startsWith("JOBID")).pop() || "";
  const parts = line.trim().split(/\s+/);
  if (parts.length < 3) return null;
  const jobId = parts[0];
  const status = mapLsfState(parts[2]) || mapLsfState(parts[1]);
  return { jobId, status: status || "running" };
}

export function parseBhistExit(text) {
  const done = /Done successfully/i.test(text);
  const exit = text.match(/Exited with exit code\s+(\d+)/i);
  if (done) return { status: "succeeded", exit_code: 0 };
  if (exit) return { status: "failed", exit_code: Number(exit[1]) };
  if (/killed|cancelled|canceled/i.test(text)) return { status: "cancelled", exit_code: null };
  return null;
}

export function parsePowershellJobId(text) {
  const guid = String(text).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (guid) return { kind: "powershell", instanceId: guid[0] };
  const id = String(text).match(/Id\s*[:=]\s*(\d+)/i);
  if (id) return { kind: "powershell", instanceId: id[1] };
  const bare = String(text).trim();
  if (/^\d+$/.test(bare)) return { kind: "powershell", instanceId: bare };
  return null;
}

export function mapPowershellState(state) {
  const s = String(state || "").toLowerCase();
  if (s === "notstarted") return "pending";
  if (s === "running" || s === "blocked") return "running";
  if (s === "completed") return "succeeded";
  if (s === "failed") return "failed";
  if (s === "stopped" || s === "stopping") return "cancelled";
  return null;
}

export function parseTerminalFile(text) {
  const line = String(text).trim().split(/\n/).filter(Boolean).pop() || "";
  const parts = line.trim().split(/\s+/);
  const token = (parts[0] || "").toLowerCase();
  const code = parts[1] != null ? Number.parseInt(parts[1], 10) : null;
  if (token === "succeeded" || token === "success" || token === "ok") {
    return { status: "succeeded", exit_code: Number.isFinite(code) ? code : 0 };
  }
  if (token === "failed" || token === "fail" || token === "error") {
    return { status: "failed", exit_code: Number.isFinite(code) ? code : 1 };
  }
  if (token === "timed_out" || token === "timeout") {
    return { status: "timed_out", exit_code: Number.isFinite(code) ? code : null };
  }
  if (token === "cancelled" || token === "canceled") {
    return { status: "cancelled", exit_code: Number.isFinite(code) ? code : null };
  }
  return null;
}

export function newRunId() {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `run_${t}_${r}`;
}
