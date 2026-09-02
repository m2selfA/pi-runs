#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";

import { clientInfo, statusRun } from "../../src/runwatch-client.mjs";
import {
  buildAcceptanceSpec,
  buildSeedPrompt,
  closeProcessLogs,
  endpointFor,
  inspectInitialEvents,
  inspectPersistedSession,
  openProcessLogs,
  piCommand,
  preflightPiSshTools,
  readDatabaseEvidence,
  readJsonLines,
  terminateTree,
  waitFor,
  waitForExit,
} from "./pi_v1_release.mjs";

const DEFAULT_TIMEOUT_SEC = 600;
const DEFAULT_RUN_DELAY_SEC = 60;
const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled", "timed_out", "lost"]);

function safeNonce() {
  return `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

export function parseModes(value) {
  const modes = String(value || "local-process,slurm")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const unique = [...new Set(modes)];
  if (unique.length === 0) throw new Error("--modes must select at least one execution shape");
  for (const mode of unique) {
    if (mode !== "local-process" && mode !== "slurm") {
      throw new Error(`unsupported soak mode ${JSON.stringify(mode)}`);
    }
  }
  return unique;
}

export function buildSoakPlan(options) {
  const modes = parseModes(options.modes);
  const rounds = options.rounds === undefined ? 1 : Number(options.rounds);
  const durationSec = options.durationSec === undefined ? undefined : Number(options.durationSec);
  const runDelaySec = Number(options.runDelaySec ?? DEFAULT_RUN_DELAY_SEC);
  const restartEvery = Number(options.restartEvery ?? 1);
  const timeoutSec = Number(options.timeoutSec ?? DEFAULT_TIMEOUT_SEC);

  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 1000) {
    throw new Error("--rounds must be an integer between 1 and 1000");
  }
  if (durationSec !== undefined && (!Number.isFinite(durationSec) || durationSec < 30 || durationSec > 86_400)) {
    throw new Error("--duration-sec must be between 30 and 86400");
  }
  if (!Number.isInteger(runDelaySec) || runDelaySec < 2 || runDelaySec > 600) {
    throw new Error("--run-delay-sec must be an integer between 2 and 600");
  }
  if (!Number.isInteger(restartEvery) || restartEvery < 0 || restartEvery > 1000) {
    throw new Error("--restart-every must be an integer between 0 and 1000");
  }
  if (!Number.isFinite(timeoutSec) || timeoutSec < 60 || timeoutSec > 3600) {
    throw new Error("--timeout-sec must be between 60 and 3600");
  }
  if (modes.includes("slurm")) {
    if (!options.host) throw new Error("Slurm soak requires --host");
    if (!options.workdir || !String(options.workdir).startsWith("/")) {
      throw new Error("Slurm soak requires an absolute shared persistent --workdir");
    }
  }
  if (modes.includes("local-process") && process.platform !== "win32") {
    throw new Error("local-process soak is currently Windows-only");
  }

  return {
    modes,
    rounds,
    durationSec,
    runDelaySec,
    restartEvery,
    timeoutSec,
  };
}

function parseArgs(argv) {
  const result = {
    confirm: false,
    thinking: "low",
    modes: "local-process,slurm",
    rounds: 1,
    runDelaySec: DEFAULT_RUN_DELAY_SEC,
    restartEvery: 1,
    timeoutSec: DEFAULT_TIMEOUT_SEC,
    evidenceRoot: resolve("acceptance-output"),
  };
  const valueFlags = new Set([
    "--runwatch-exe",
    "--model",
    "--thinking",
    "--host",
    "--workdir",
    "--modes",
    "--rounds",
    "--duration-sec",
    "--run-delay-sec",
    "--restart-every",
    "--timeout-sec",
    "--evidence-root",
    "--pi-executable",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--confirm-real-provider") {
      result.confirm = true;
      continue;
    }
    if (!valueFlags.has(arg)) throw new Error(`unknown argument ${arg}`);
    const value = argv[++index];
    if (!value) throw new Error(`${arg} requires a value`);
    switch (arg) {
      case "--runwatch-exe": result.runwatchExe = resolve(value); break;
      case "--model": result.model = value; break;
      case "--thinking": result.thinking = value; break;
      case "--host": result.host = value; break;
      case "--workdir": result.workdir = value; break;
      case "--modes": result.modes = value; break;
      case "--rounds": result.rounds = Number(value); break;
      case "--duration-sec": result.durationSec = Number(value); break;
      case "--run-delay-sec": result.runDelaySec = Number(value); break;
      case "--restart-every": result.restartEvery = Number(value); break;
      case "--timeout-sec": result.timeoutSec = Number(value); break;
      case "--evidence-root": result.evidenceRoot = resolve(value); break;
      case "--pi-executable": result.piExecutable = value; break;
      default: throw new Error(`unhandled argument ${arg}`);
    }
  }
  if (!result.confirm) throw new Error("real-provider soak requires explicit --confirm-real-provider");
  if (!result.runwatchExe || !existsSync(result.runwatchExe)) {
    throw new Error("--runwatch-exe must point to an existing packaged runwatch executable");
  }
  if (!result.model) throw new Error("--model is required");
  result.plan = buildSoakPlan(result);
  return result;
}

function readHeartbeatPid(path) {
  const payload = JSON.parse(readFileSync(path, "utf8"));
  const pid = Number(payload?.pid);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid PID heartbeat ${path}`);
  return pid;
}

function killPid(pid) {
  if (process.platform === "win32") {
    const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/F"], {
      windowsHide: true,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(`taskkill ${pid} failed: ${(result.stderr || result.stdout || "").trim()}`);
    }
    return;
  }
  process.kill(pid, "SIGKILL");
}

async function waitForRuntime(env, timeoutMs = 20_000) {
  return waitFor(
    async () => {
      const info = await clientInfo({ env, timeout_ms: 750 });
      return info.available && info.service === "runwatchd" ? info : null;
    },
    timeoutMs,
    "packaged runwatchd readiness",
  );
}

async function seedCase(options, shared, round, mode) {
  const shortMode = mode === "slurm" ? "slurm" : "local";
  const caseDir = join(shared.evidenceDir, `round-${String(round).padStart(4, "0")}`, shortMode);
  await mkdir(join(caseDir, "pi-sessions"), { recursive: true });
  const nonce = `${shared.nonce}-r${round}-${shortMode}`;
  const spec = buildAcceptanceSpec(
    {
      mode,
      host: options.host,
      workdir: mode === "slurm" ? options.workdir : undefined,
      evidenceDir: caseDir,
      delaySec: options.plan.runDelaySec,
    },
    nonce,
  );
  const prompt = buildSeedPrompt(spec);
  await writeFile(join(caseDir, "prompt.txt"), `${prompt}\n`, "utf8");
  const logs = openProcessLogs(caseDir, "pi-initial");
  const args = [
    "--no-extensions",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--tools",
    "runs_doctor,runs_submit",
    "--model",
    options.model,
    "--thinking",
    options.thinking,
    "--mode",
    "json",
    "--session-dir",
    join(caseDir, "pi-sessions"),
    "-e",
    shared.extension,
    "-p",
    prompt,
  ];
  const launch = piCommand(args, options.piExecutable);
  const child = spawn(launch.executable, launch.args, {
    cwd: process.cwd(),
    env: shared.env,
    windowsHide: true,
    stdio: ["ignore", logs.stdoutFd, logs.stderrFd],
  });
  return { mode, caseDir, spec, child, logs };
}

async function finishSeedCase(item, timeoutMs) {
  const initialExit = await waitForExit(item.child, timeoutMs, `initial Pi ${item.spec.runId}`);
  closeProcessLogs(item.logs);
  item.logs = null;
  if (initialExit !== 0) throw new Error(`initial Pi ${item.spec.runId} exited ${initialExit}`);
  const initialEvents = readJsonLines(join(item.caseDir, "pi-initial.stdout.log"));
  item.initial = inspectInitialEvents(initialEvents, item.spec);
  return item.initial;
}

export function isDurablySubmittedRun(run) {
  return Boolean(run?.job_id) && String(run?.status) !== "submitting";
}

async function waitForSubmittedCases(cases, env, timeoutMs) {
  return waitFor(
    async () => {
      const rows = [];
      for (const item of cases) {
        try {
          const run = await statusRun(item.spec.runId, { env, timeout_ms: 1200 });
          if (!isDurablySubmittedRun(run)) return null;
          rows.push(run);
        } catch {
          return null;
        }
      }
      return rows;
    },
    timeoutMs,
    "all soak Runs to have durable execution handles",
    200,
  );
}

async function restartServe(shared) {
  const pidPath = join(shared.runwatchDataDir, "serve.pid");
  const oldPid = await waitFor(
    () => (existsSync(pidPath) ? readHeartbeatPid(pidPath) : null),
    10_000,
    "serve heartbeat before restart injection",
  );
  killPid(oldPid);
  const newPid = await waitFor(
    async () => {
      if (!existsSync(pidPath)) return null;
      let candidate;
      try {
        candidate = readHeartbeatPid(pidPath);
      } catch {
        return null;
      }
      if (candidate === oldPid) return null;
      const info = await clientInfo({ env: shared.env, timeout_ms: 750 });
      return info.available && info.service === "runwatchd" ? candidate : null;
    },
    30_000,
    "supervisor replacement serve",
    250,
  );
  return { old_pid: oldPid, new_pid: newPid };
}

async function inspectCompletedCase(item, shared, timeoutMs) {
  assert.ok(item.initial, `initial Pi ${item.spec.runId} must be validated before fault injection`);
  const initial = item.initial;

  const run = await waitFor(
    async () => {
      const record = await statusRun(item.spec.runId, { env: shared.env, timeout_ms: 1200 });
      return TERMINAL_STATES.has(String(record.status)) ? record : null;
    },
    timeoutMs,
    `Run ${item.spec.runId} terminal state`,
    500,
  );
  assert.equal(String(run.status), "succeeded", `Run ${item.spec.runId} must succeed`);

  const durable = await waitFor(
    () => {
      const evidence = readDatabaseEvidence(join(shared.runwatchDataDir, "runwatch.db"), item.spec.runId);
      if (!evidence) return null;
      if (evidence.delivery?.state === "needs_rebind") {
        throw new Error(`Delivery ${item.spec.runId} needs_rebind: ${evidence.delivery.last_error || "no reason"}`);
      }
      if (evidence.delivery?.state === "delivered" && evidence.invocation?.state === "completed") {
        return evidence;
      }
      return null;
    },
    timeoutMs,
    `Delivery/AgentInvocation completion for ${item.spec.runId}`,
    500,
  );
  assert.equal(durable.delivery.attempts, 1, "clean soak round requires one Delivery attempt");
  assert.equal(durable.invocation_count, 1, "clean soak round requires one AgentInvocation");
  const sessionRows = readJsonLines(durable.binding.session_file);
  const session = inspectPersistedSession(sessionRows, item.spec, durable.delivery.delivery_id);
  assert.equal(session.session_id, durable.binding.session_id);
  if (item.mode === "local-process") {
    assert.equal(await readFile(item.spec.markerPath, "utf8"), item.spec.token);
  }
  return {
    mode: item.mode,
    run_id: item.spec.runId,
    job_id: durable.run.job_id,
    status: durable.run.status,
    delivery_attempts: durable.delivery.attempts,
    invocation_count: durable.invocation_count,
    completion_count: session.completion_count,
    settlement_count: session.settlement_count,
    verification_tools: session.verification_tools,
    success_marker: session.success_marker,
    initial,
  };
}

async function runRound(options, shared, round) {
  const roundDir = join(shared.evidenceDir, `round-${String(round).padStart(4, "0")}`);
  await mkdir(roundDir, { recursive: true });
  const cases = await Promise.all(options.plan.modes.map((mode) => seedCase(options, shared, round, mode)));
  try {
    for (const item of cases) {
      await finishSeedCase(item, Math.min(options.plan.timeoutSec * 1000, 180_000));
    }
    const submitted = await waitForSubmittedCases(
      cases,
      shared.env,
      Math.min(options.plan.timeoutSec * 1000, 240_000),
    );
    const activeBeforeRestart = submitted.filter((run) => !TERMINAL_STATES.has(String(run.status)));
    let restart = null;
    if (options.plan.restartEvery > 0 && round % options.plan.restartEvery === 0) {
      if (activeBeforeRestart.length === 0) {
        throw new Error(
          "all soak Runs became terminal before daemon restart injection; increase --run-delay-sec",
        );
      }
      restart = await restartServe(shared);
    }

    const results = [];
    for (const item of cases) {
      results.push(await inspectCompletedCase(item, shared, options.plan.timeoutSec * 1000));
    }
    const summary = {
      round,
      submitted: submitted.map((run) => ({ run_id: run.run_id, status: run.status, job_id: run.job_id })),
      active_before_restart: activeBeforeRestart.map((run) => run.run_id),
      restart,
      cases: results,
    };
    await writeFile(join(roundDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    return summary;
  } finally {
    for (const item of cases) {
      terminateTree(item.child);
      closeProcessLogs(item.logs);
    }
  }
}

export async function runSoak(options) {
  if (options.plan.modes.includes("slurm")) preflightPiSshTools({ mode: "slurm", piExecutable: options.piExecutable });
  const nonce = safeNonce();
  const evidenceDir = resolve(options.evidenceRoot, `soak-${nonce}`);
  await mkdir(evidenceDir, { recursive: false });
  const runwatchDataDir = join(evidenceDir, "runwatch-data");
  const endpoint = endpointFor(`soak-${nonce}`);
  const env = {
    ...process.env,
    RUNWATCH_DATA_DIR: runwatchDataDir,
    RUNWATCH_ENDPOINT: endpoint,
    PI_RUNS_BACKEND: "auto",
  };
  const extension = resolve("extensions/runs/index.ts");
  const shared = { nonce, evidenceDir, runwatchDataDir, endpoint, env, extension };
  const supervisorLogs = openProcessLogs(evidenceDir, "runwatch-supervisor");
  const supervisor = spawn(options.runwatchExe, ["supervise", "--interval", "1"], {
    cwd: dirname(options.runwatchExe),
    env,
    windowsHide: true,
    stdio: ["ignore", supervisorLogs.stdoutFd, supervisorLogs.stderrFd],
  });
  const startedAt = Date.now();
  const deadline = options.plan.durationSec === undefined ? undefined : startedAt + options.plan.durationSec * 1000;
  const rounds = [];
  try {
    const readiness = await waitForRuntime(env);
    let round = 1;
    while (true) {
      rounds.push(await runRound(options, shared, round));
      if (deadline !== undefined) {
        if (Date.now() >= deadline) break;
      } else if (round >= options.plan.rounds) {
        break;
      }
      round += 1;
    }
    const summary = {
      schema_version: 1,
      ok: true,
      model: options.model,
      thinking: options.thinking,
      modes: options.plan.modes,
      configured_rounds: options.plan.rounds,
      duration_sec: options.plan.durationSec,
      elapsed_sec: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
      run_delay_sec: options.plan.runDelaySec,
      restart_every: options.plan.restartEvery,
      rounds_completed: rounds.length,
      total_cases: rounds.reduce((sum, item) => sum + item.cases.length, 0),
      runwatch: {
        executable: options.runwatchExe,
        protocol_version: readiness.protocol_version,
        service: readiness.service,
        storage: readiness.storage,
      },
      rounds,
      evidence_dir: evidenceDir,
      preserved: true,
    };
    await writeFile(join(evidenceDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    return summary;
  } catch (error) {
    const failure = {
      schema_version: 1,
      ok: false,
      model: options.model,
      modes: options.plan.modes,
      rounds_completed: rounds.length,
      error: error instanceof Error ? error.stack || error.message : String(error),
      evidence_dir: evidenceDir,
      preserved: true,
    };
    await writeFile(join(evidenceDir, "failure.json"), `${JSON.stringify(failure, null, 2)}\n`, "utf8");
    throw error;
  } finally {
    terminateTree(supervisor);
    closeProcessLogs(supervisorLogs);
  }
}

function usage() {
  return [
    "Pi v1 resident endurance/fault soak",
    "",
    "One-round qualification:",
    "  node scripts/acceptance/pi_v1_soak.mjs --confirm-real-provider --runwatch-exe <packaged runwatch> --model <provider/model> --host <ssh-alias> --workdir </shared/workspace> --rounds 1",
    "",
    "Duration soak:",
    "  node scripts/acceptance/pi_v1_soak.mjs --confirm-real-provider --runwatch-exe <packaged runwatch> --model <provider/model> --host <ssh-alias> --workdir </shared/workspace> --duration-sec 7200 --run-delay-sec 30",
    "",
    "The same packaged supervisor/SQLite/IPC runtime is reused across all rounds. By default each round submits one Windows Local Process and one Slurm Run, force-kills only the isolated serve child, requires supervisor PID replacement, then verifies exact-session offline continuation and exactly-once Delivery/Invocation settlement. Evidence is preserved under acceptance-output/.",
  ].join("\n");
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(usage());
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  const summary = await runSoak(options);
  console.log(JSON.stringify(summary));
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(`PI_V1_SOAK_FAIL: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    process.exitCode = 1;
  });
}
