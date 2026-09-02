import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { newRunId } from "./parse.mjs";
import { runDir, runsHome } from "./paths.mjs";
import { getRun, loadAll, upsertRun } from "./store.mjs";
import { applyStatus, isTerminal } from "./state.mjs";
import { chooseRunner, chooseWakeup } from "./detect.mjs";
import { runnerFor } from "./runners/index.mjs";
import { sidecar, wakeupFor } from "./wakeup/index.mjs";
import { fire as fireWebhook } from "./wakeup/webhook.mjs";

function nowIso() {
  return new Date().toISOString();
}

export async function submitRun(req) {
  if (!req?.command || !String(req.command).trim()) {
    throw new Error("command is required");
  }
  const runner = await chooseRunner(req.runner || "auto");
  const wakeup = chooseWakeup(req.wakeup || "auto", runner);
  const run_id = newRunId();
  const dir = runDir(run_id);
  await mkdir(dir, { recursive: true });
  const workdir = req.workdir || process.cwd();
  const record = {
    run_id,
    name: req.name || run_id,
    command: req.command,
    runner,
    wakeup,
    status: "submitted",
    workdir,
    run_dir: dir,
    stdout_path: join(dir, "stdout.log"),
    stderr_path: join(dir, "stderr.log"),
    terminal_path: join(dir, "terminal"),
    created_at: nowIso(),
    updated_at: nowIso(),
    output_specs: req.output_specs || [],
    webhook_url: req.webhook_url,
  };
  await upsertRun(record);
  const handle = await runnerFor(runner).submit(record, req);
  record.handle = handle;
  record.status = "pending";
  await upsertRun(record);
  try {
    await wakeupFor(wakeup).arm(record);
  } catch (err) {
    record.notes = `wakeup arm failed (${wakeup}): ${err.message}`;
    await upsertRun(record);
  }
  return record;
}

export async function refreshRun(runId) {
  const record = await getRun(runId);
  if (!record) throw new Error(`unknown run ${runId}`);
  if (isTerminal(record.status)) return record;
  const side = await sidecar.readSidecar(record);
  if (side) {
    const next = applyStatus(record, side.status, { exit_code: side.exit_code });
    await upsertRun(next);
    if (next.webhook_url) {
      try { await fireWebhook(next); } catch { /* best effort */ }
    }
    return next;
  }
  const snap = await runnerFor(record.runner).poll(record);
  if (snap?.status && snap.status !== record.status) {
    const next = applyStatus(record, snap.status, { exit_code: snap.exit_code ?? record.exit_code });
    await upsertRun(next);
    if (isTerminal(next.status) && next.webhook_url) {
      try { await fireWebhook(next); } catch { /* best effort */ }
    }
    return next;
  }
  return record;
}

export async function waitRun(runId, opts = {}) {
  // Legacy compatibility only. Long scientific waits must be handed to runwatchd;
  // keeping this default short prevents a Pi tool call from becoming the watcher.
  const timeoutMs = opts.timeout_ms ?? 30_000;
  const intervalMs = opts.interval_ms ?? 2_000;
  const start = Date.now();
  let last = await refreshRun(runId);
  while (!isTerminal(last.status)) {
    if (Date.now() - start > timeoutMs) {
      return { ...last, wait: "timeout", should_poll: true, poll_after_ms: intervalMs };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await refreshRun(runId);
  }
  return { ...last, wait: "terminal", should_poll: false, terminal_state_reached: true };
}

export async function statusRun(runId) {
  if (!runId) {
    return loadAll();
  }
  return refreshRun(runId);
}

export async function logsRun(runId, tail = 80) {
  const record = await getRun(runId);
  if (!record) throw new Error(`unknown run ${runId}`);
  async function tailFile(path) {
    try {
      const text = await readFile(path, "utf8");
      const lines = text.split(/\n/);
      return lines.slice(Math.max(0, lines.length - tail)).join("\n");
    } catch {
      return "";
    }
  }
  return {
    run_id: runId,
    status: record.status,
    stdout: await tailFile(record.stdout_path),
    stderr: await tailFile(record.stderr_path),
  };
}

export async function cancelRun(runId) {
  const record = await getRun(runId);
  if (!record) throw new Error(`unknown run ${runId}`);
  if (isTerminal(record.status)) return record;
  const next = applyStatus(record, "cancelling");
  await upsertRun(next);
  await runnerFor(record.runner).cancel(record);
  const done = applyStatus(next, "cancelled");
  await upsertRun(done);
  try { await wakeupFor(record.wakeup).disarm(record); } catch { /* ignore */ }
  return done;
}

export async function harvestRun(runId) {
  const record = await refreshRun(runId);
  const specs = record.output_specs || [];
  const artifacts = [];
  if (specs.length === 0) {
    artifacts.push({ path: record.stdout_path });
    artifacts.push({ path: record.stderr_path });
  }
  record.artifacts = artifacts;
  record.harvested_at = nowIso();
  await upsertRun(record);
  return record;
}

export function homeInfo() {
  return { PI_RUNS_HOME: process.env.PI_RUNS_HOME || join(homedir(), ".pi", "runs"), store: join(runsHome(), "runs.jsonl") };
}
