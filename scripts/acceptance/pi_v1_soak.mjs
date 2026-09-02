#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";

import { clientInfo, request, statusRun } from "../../src/runwatch-client.mjs";
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
import { prepareRunwatchSshFaultProfile } from "./ssh_fault_relay.mjs";

const DEFAULT_TIMEOUT_SEC = 600;
const DEFAULT_RUN_DELAY_SEC = 60;
const DEFAULT_REBIND_EVERY = 0;
const DEFAULT_SETTLEMENT_CRASH_EVERY = 0;
const DEFAULT_SSH_FAULT_EVERY = 0;
const DEFAULT_SSH_FAULT_SEC = 8;
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
  const rebindEvery = Number(options.rebindEvery ?? DEFAULT_REBIND_EVERY);
  const settlementCrashEvery = Number(options.settlementCrashEvery ?? DEFAULT_SETTLEMENT_CRASH_EVERY);
  const sshFaultEvery = Number(options.sshFaultEvery ?? DEFAULT_SSH_FAULT_EVERY);
  const sshFaultSec = Number(options.sshFaultSec ?? DEFAULT_SSH_FAULT_SEC);
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
  if (!Number.isInteger(rebindEvery) || rebindEvery < 0 || rebindEvery > 1000) {
    throw new Error("--rebind-every must be an integer between 0 and 1000");
  }
  if (!Number.isInteger(settlementCrashEvery) || settlementCrashEvery < 0 || settlementCrashEvery > 1000) {
    throw new Error("--settlement-crash-every must be an integer between 0 and 1000");
  }
  if (!Number.isInteger(sshFaultEvery) || sshFaultEvery < 0 || sshFaultEvery > 1000) {
    throw new Error("--ssh-fault-every must be an integer between 0 and 1000");
  }
  if (!Number.isInteger(sshFaultSec) || sshFaultSec < 2 || sshFaultSec > 120) {
    throw new Error("--ssh-fault-sec must be an integer between 2 and 120");
  }
  if (sshFaultEvery > 0 && !modes.includes("slurm")) {
    throw new Error("--ssh-fault-every requires slurm mode");
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
    rebindEvery,
    settlementCrashEvery,
    sshFaultEvery,
    sshFaultSec,
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
    rebindEvery: DEFAULT_REBIND_EVERY,
    settlementCrashEvery: DEFAULT_SETTLEMENT_CRASH_EVERY,
    sshFaultEvery: DEFAULT_SSH_FAULT_EVERY,
    sshFaultSec: DEFAULT_SSH_FAULT_SEC,
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
    "--rebind-every",
    "--settlement-crash-every",
    "--ssh-fault-every",
    "--ssh-fault-sec",
    "--pi-api-module",
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
      case "--rebind-every": result.rebindEvery = Number(value); break;
      case "--settlement-crash-every": result.settlementCrashEvery = Number(value); break;
      case "--ssh-fault-every": result.sshFaultEvery = Number(value); break;
      case "--ssh-fault-sec": result.sshFaultSec = Number(value); break;
      case "--pi-api-module": result.piApiModule = resolve(value); break;
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

export function piApiModuleForShimPath(shimPath) {
  return join(
    dirname(resolve(shimPath)),
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "index.js",
  );
}

function resolvePiApiModule(options) {
  if (options.piApiModule) {
    if (!existsSync(options.piApiModule)) throw new Error(`--pi-api-module does not exist: ${options.piApiModule}`);
    return resolve(options.piApiModule);
  }
  if (options.piExecutable && /[\\/]/.test(options.piExecutable)) {
    const candidate = piApiModuleForShimPath(options.piExecutable);
    if (existsSync(candidate)) return candidate;
  }
  const probe = process.platform === "win32"
    ? spawnSync("volta.exe", ["which", "pi"], { windowsHide: true, encoding: "utf8" })
    : spawnSync("which", ["pi"], { encoding: "utf8" });
  if (probe.status !== 0 || !String(probe.stdout || "").trim()) {
    throw new Error("same-session rebind soak requires --pi-api-module when the Pi package cannot be discovered");
  }
  const candidate = piApiModuleForShimPath(String(probe.stdout).trim());
  if (!existsSync(candidate)) {
    throw new Error(`could not derive Pi API module from executable shim: ${candidate}`);
  }
  return candidate;
}

export function deliverySessionCounts(rows, deliveryId) {
  let completion = 0;
  let settlement = 0;
  for (const row of rows) {
    if (
      row?.type === "custom_message" &&
      row?.customType === "runwatch/completion" &&
      Array.isArray(row?.details?.delivery_ids) &&
      row.details.delivery_ids.includes(deliveryId)
    ) {
      completion += 1;
    }
    if (
      row?.type === "custom" &&
      row?.customType === "runwatch/completion-settled" &&
      row?.data?.delivery_id === deliveryId &&
      row?.data?.outcome === "delivered"
    ) {
      settlement += 1;
    }
  }
  return { completion, settlement };
}

async function divergePersistedSession(item, shared) {
  const dbPath = join(shared.runwatchDataDir, "runwatch.db");
  const durable = await waitFor(
    () => {
      const evidence = readDatabaseEvidence(dbPath, item.spec.runId);
      return evidence?.binding?.session_file && evidence?.binding?.origin_leaf_id ? evidence : null;
    },
    15_000,
    `continuation binding for ${item.spec.runId}`,
    100,
  );
  const api = await import(pathToFileURL(shared.piApiModule).href);
  assert.equal(typeof api.SessionManager?.open, "function", "Pi API must export SessionManager.open");
  const manager = api.SessionManager.open(durable.binding.session_file);
  assert.equal(manager.getSessionId(), durable.binding.session_id, "Pi API session id must match runwatch binding");
  const origin = manager.getEntry(durable.binding.origin_leaf_id);
  assert.ok(origin, `origin leaf ${durable.binding.origin_leaf_id} must exist in persisted Pi session`);
  const branchFromId = origin.parentId;
  assert.ok(branchFromId, "acceptance origin leaf must have a parent so a sibling branch can be created");
  manager.branch(branchFromId);
  const newLeafId = manager.appendCustomEntry("runwatch/acceptance-branch-divergence", {
    run_id: item.spec.runId,
    abandoned_origin_leaf_id: durable.binding.origin_leaf_id,
  });
  assert.equal(manager.getLeafId(), newLeafId);
  const activeIds = new Set(manager.getBranch().map((entry) => entry.id));
  assert.equal(activeIds.has(durable.binding.origin_leaf_id), false, "diverged active branch must exclude bound origin leaf");
  assert.equal(manager.getSessionId(), durable.binding.session_id, "branch mutation must keep the same Pi session id");
  return {
    session_id: durable.binding.session_id,
    session_file: durable.binding.session_file,
    old_origin_leaf_id: durable.binding.origin_leaf_id,
    branch_from_id: branchFromId,
    new_leaf_id: newLeafId,
  };
}

function inspectExplicitRebindEvents(events, item) {
  const runId = item.spec.runId;
  const marker = `R8C_REBOUND:${runId}`;
  const markerIndex = events.findIndex((event) => {
    const message = event?.type === "message_end" ? event.message : null;
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return false;
    const text = message.content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
    return text === marker && message.stopReason === "stop";
  });
  assert.ok(markerIndex >= 0, "explicit rebind Pi turn must persist the exact rebound marker with assistant stop");

  const starts = events.filter((event) => event?.type === "tool_execution_start");
  const rebindCalls = starts.filter((event) => event.toolName === "runs_rebind");
  assert.equal(rebindCalls.length, 1, "explicit rebind Pi turn must call runs_rebind exactly once");
  assert.equal(rebindCalls[0]?.args?.run_id, runId, "runs_rebind must target the blocked Run");
  const allowed = new Set(["runs_rebind", ...item.spec.verificationTools]);
  for (const start of starts) {
    assert.ok(allowed.has(start.toolName), `rebind/completion turn used unexpected tool ${start.toolName}`);
  }
  const startsBeforeMarker = events
    .slice(0, markerIndex + 1)
    .filter((event) => event?.type === "tool_execution_start");
  assert.deepEqual(
    startsBeforeMarker.map((event) => event.toolName),
    ["runs_rebind"],
    "no verification tool may run before explicit rebind succeeds",
  );

  const end = events.find((event) => event?.type === "tool_execution_end" && event.toolName === "runs_rebind");
  assert.ok(end, "explicit rebind Pi turn must persist a runs_rebind result");
  assert.equal(end.isError, false, "runs_rebind must succeed");
  assert.equal(end.result?.details?.run_id, runId);
  assert.equal(end.result?.details?.rebound, true, "runs_rebind must report rebound=true");
  assert.ok(Number(end.result?.details?.reset_deliveries) >= 1, "runs_rebind must reset the blocked Delivery");
  assert.ok(events.some((event) => event?.type === "agent_settled"), "explicit rebind Pi process must settle before exit");
  return {
    tool_calls: 1,
    reset_deliveries: Number(end.result.details.reset_deliveries),
    continuation: end.result?.details?.continuation,
    marker,
    verification_calls_after_rebind: starts.filter((event) => event.toolName !== "runs_rebind").map((event) => event.toolName),
  };
}

async function runExplicitRebindTurn(item, shared, timeoutMs) {
  const prompt = [
    "This is an explicit Pi v1 branch-rebind acceptance. Follow the sequence exactly and do not improvise.",
    `Call runs_rebind exactly once with arguments ${JSON.stringify({ run_id: item.spec.runId })}.`,
    `Before a runwatch/completion message arrives, do not call any tool other than runs_rebind. If runs_rebind succeeds, reply with exactly ${JSON.stringify(`R8C_REBOUND:${item.spec.runId}`)} and stop that turn.`,
    `If runwatch/completion arrives in this same resumed Pi process, follow the original persisted completion instructions already present in this session: never resubmit, perform the exact verification tools, verify the marker, and finally reply with exactly ${JSON.stringify(`R8B_RELEASE_OK:${item.spec.runId}:${item.spec.token}`)} and stop.`,
  ].join(" ");
  await writeFile(join(item.caseDir, "rebind-prompt.txt"), `${prompt}\n`, "utf8");
  const logs = openProcessLogs(item.caseDir, "pi-rebind");
  const explicitExtensions = ["-e", shared.extension];
  if (item.mode === "slurm") {
    assert.ok(shared.piSshToolsExtension, "remote rebind acceptance requires an explicit pi-ssh-tools extension path");
    explicitExtensions.push("-e", shared.piSshToolsExtension);
  }
  const args = [
    "--no-extensions",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--tools",
    ["runs_rebind", ...item.spec.verificationTools].join(","),
    "--model",
    shared.model,
    "--thinking",
    shared.thinking,
    "--mode",
    "json",
    "--session",
    item.branchFault.session_file,
    ...explicitExtensions,
    "-p",
    prompt,
  ];
  const launch = piCommand(args, shared.piExecutable);
  const child = spawn(launch.executable, launch.args, {
    cwd: process.cwd(),
    env: shared.env,
    windowsHide: true,
    stdio: ["ignore", logs.stdoutFd, logs.stderrFd],
  });
  try {
    const settled = await waitFor(
      () => {
        const evidence = readDatabaseEvidence(join(shared.runwatchDataDir, "runwatch.db"), item.spec.runId);
        if (!evidence?.delivery?.delivery_id || !evidence?.binding?.session_file) return null;
        const counts = deliverySessionCounts(
          readJsonLines(evidence.binding.session_file),
          evidence.delivery.delivery_id,
        );
        if (
          evidence.delivery.state === "delivered" &&
          counts.completion === 1 &&
          counts.settlement === 1
        ) {
          return { evidence, counts };
        }
        return null;
      },
      timeoutMs,
      `explicit runs_rebind Pi durable settlement ${item.spec.runId}`,
      200,
    );
    const events = readJsonLines(join(item.caseDir, "pi-rebind.stdout.log"));
    const tool = inspectExplicitRebindEvents(events, item);
    const sessionRows = readJsonLines(settled.evidence.binding.session_file);
    const session = inspectPersistedSession(
      sessionRows,
      item.spec,
      settled.evidence.delivery.delivery_id,
    );
    assert.equal(session.session_id, item.branchFault.session_id);
    return { ...tool, session };
  } finally {
    // A live Pi session is allowed to remain resident after settlement. Once the acceptance has
    // durable completion + settlement + Delivery ack evidence, terminate only this disposable
    // acceptance child instead of treating process liveness as a product failure.
    terminateTree(child);
    closeProcessLogs(logs);
  }
}

async function waitForBlockedAndRebind(item, shared, timeoutMs) {
  const dbPath = join(shared.runwatchDataDir, "runwatch.db");
  const blocked = await waitFor(
    () => {
      const evidence = readDatabaseEvidence(dbPath, item.spec.runId);
      if (evidence?.delivery?.state === "needs_rebind" && evidence?.invocation?.state === "blocked") return evidence;
      if (evidence?.delivery?.state === "delivered") {
        throw new Error(`branch-diverged Delivery ${item.spec.runId} was delivered before explicit rebind`);
      }
      return null;
    },
    timeoutMs,
    `needs_rebind for ${item.spec.runId}`,
    100,
  );
  const beforeRows = readJsonLines(blocked.binding.session_file);
  const beforeCounts = deliverySessionCounts(beforeRows, blocked.delivery.delivery_id);
  assert.deepEqual(beforeCounts, { completion: 0, settlement: 0 }, "wrong branch must receive no completion before rebind");
  assert.equal(blocked.binding.session_id, item.branchFault.session_id);
  assert.equal(blocked.binding.origin_leaf_id, item.branchFault.old_origin_leaf_id);

  const tool = await runExplicitRebindTurn(item, shared, timeoutMs);
  return {
    blocked_invocation_id: blocked.invocation.invocation_id,
    attempts_before_rebind: blocked.delivery.attempts,
    completion_before_rebind: beforeCounts.completion,
    settlement_before_rebind: beforeCounts.settlement,
    new_origin_leaf_id: item.branchFault.new_leaf_id,
    reset_deliveries: tool.reset_deliveries,
    rebind_tool: tool,
  };
}

async function waitForSettlementWindowAndRestart(item, shared, timeoutMs) {
  const dbPath = join(shared.runwatchDataDir, "runwatch.db");
  const window = await waitFor(
    () => {
      const evidence = readDatabaseEvidence(dbPath, item.spec.runId);
      if (!evidence?.delivery || !evidence?.binding?.session_file) return null;
      const counts = deliverySessionCounts(readJsonLines(evidence.binding.session_file), evidence.delivery.delivery_id);
      if (counts.settlement > 0 || evidence.delivery.state === "delivered") {
        throw new Error(`missed settlement crash window for ${item.spec.runId}; settlement completed before fault injection`);
      }
      if (
        evidence.delivery.state === "delivering" &&
        evidence.invocation?.state === "running" &&
        counts.completion === 1 &&
        counts.settlement === 0
      ) {
        return { evidence, counts };
      }
      return null;
    },
    timeoutMs,
    `completion-before-settlement window for ${item.spec.runId}`,
    25,
  );
  const restart = await restartServe(shared);
  return {
    delivery_id: window.evidence.delivery.delivery_id,
    invocation_id: window.evidence.invocation.invocation_id,
    invocation_pid: window.evidence.invocation.pid,
    completion_before_crash: window.counts.completion,
    settlement_before_crash: window.counts.settlement,
    restart,
  };
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

async function injectTransientSshLoss(item, shared, timeoutMs) {
  assert.equal(item.mode, "slurm", "SSH transport fault must target a Slurm Run");
  assert.ok(shared.sshFault?.relay, "SSH transport fault requires the isolated localhost relay");
  const runId = item.spec.runId;
  const tick = async () => request("tick", {}, { env: shared.env, timeout_ms: 30_000 });
  await tick();
  const before = await statusRun(runId, { env: shared.env, timeout_ms: 2_000 });
  assert.ok(before.job_id, "SSH fault target must have a scheduler job id");
  assert.equal(TERMINAL_STATES.has(String(before.status)), false, "SSH fault target must still be active");
  assert.equal(before.observation?.health, "fresh", "SSH fault target must have a fresh baseline observation");

  shared.sshFault.relay.cut();
  let degraded;
  try {
    degraded = await waitFor(
      async () => {
        await tick();
        const run = await statusRun(runId, { env: shared.env, timeout_ms: 2_000 });
        if (TERMINAL_STATES.has(String(run.status))) {
          throw new Error(`SSH fault target ${runId} became terminal before degraded transport was observed`);
        }
        return ["unreachable", "probe_error"].includes(String(run.observation?.health)) ? run : null;
      },
      timeoutMs,
      `SSH transport degradation for ${runId}`,
      250,
    );
    await new Promise((resolvePromise) => setTimeout(resolvePromise, shared.sshFaultSec * 1000));
  } finally {
    shared.sshFault.relay.restore();
  }

  const recovered = await waitFor(
    async () => {
      await tick();
      const run = await statusRun(runId, { env: shared.env, timeout_ms: 2_000 });
      return run.observation?.health === "fresh" ? run : null;
    },
    timeoutMs,
    `SSH transport recovery for ${runId}`,
    250,
  );
  assert.equal(recovered.job_id, before.job_id, "SSH recovery must retain the same scheduler job id");
  return {
    run_id: runId,
    job_id: before.job_id,
    relay_port: shared.sshFault.relayPort,
    target: `${shared.sshFault.effective.hostname}:${shared.sshFault.effective.port}`,
    before: {
      status: before.status,
      health: before.observation?.health,
      observed_at: before.observation?.observed_at,
    },
    degraded: {
      status: degraded.status,
      health: degraded.observation?.health,
      source: degraded.observation?.source,
      reason: degraded.observation?.reason,
      observed_at: degraded.observation?.observed_at,
    },
    recovered: {
      status: recovered.status,
      health: recovered.observation?.health,
      source: recovered.observation?.source,
      observed_at: recovered.observation?.observed_at,
    },
  };
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

  let rebindFault = null;
  if (item.injectRebind) {
    rebindFault = await waitForBlockedAndRebind(item, shared, timeoutMs);
  }

  let settlementCrashFault = null;
  if (item.injectSettlementCrash) {
    settlementCrashFault = await waitForSettlementWindowAndRestart(item, shared, timeoutMs);
  }

  const durable = await waitFor(
    () => {
      const evidence = readDatabaseEvidence(join(shared.runwatchDataDir, "runwatch.db"), item.spec.runId);
      if (!evidence) return null;
      if (evidence.delivery?.state === "needs_rebind") {
        throw new Error(`Delivery ${item.spec.runId} still needs_rebind after explicit recovery: ${evidence.delivery.last_error || "no reason"}`);
      }
      if (evidence.delivery?.state !== "delivered") return null;
      if (evidence.invocation?.state === "completed") return evidence;
      if (item.injectRebind && evidence.invocation?.state === "blocked" && evidence.binding?.session_file) {
        const counts = deliverySessionCounts(
          readJsonLines(evidence.binding.session_file),
          evidence.delivery.delivery_id,
        );
        if (counts.completion === 1 && counts.settlement === 1) return evidence;
      }
      return null;
    },
    timeoutMs,
    `Delivery/AgentInvocation completion for ${item.spec.runId}`,
    250,
  );
  if (item.injectRebind) {
    const api = await import(pathToFileURL(shared.piApiModule).href);
    const manager = api.SessionManager.open(durable.binding.session_file);
    const activeBranch = manager.getBranch();
    const activeIds = activeBranch.map((entry) => entry.id);
    const branchMarkerIndex = activeIds.indexOf(item.branchFault.new_leaf_id);
    const reboundOriginIndex = activeIds.indexOf(durable.binding?.origin_leaf_id);
    assert.ok(branchMarkerIndex >= 0, "final active Pi branch must retain the SessionManager-generated divergence marker");
    assert.ok(
      reboundOriginIndex > branchMarkerIndex,
      "runs_rebind must capture a current leaf descended from the generated sibling-branch marker",
    );
    assert.equal(
      activeIds.includes(item.branchFault.old_origin_leaf_id),
      false,
      "final active Pi branch must not return to the abandoned origin leaf",
    );
    rebindFault.final_origin_leaf_id = durable.binding.origin_leaf_id;
    rebindFault.branch_marker_leaf_id = item.branchFault.new_leaf_id;
  }
  const injectedExtraAttempts = Number(Boolean(item.injectRebind)) + Number(Boolean(item.injectSettlementCrash));
  if (item.injectRebind && !item.injectSettlementCrash) {
    assert.equal(durable.delivery.attempts, 2, "branch divergence plus explicit rebind must retry the same Delivery exactly once");
    assert.ok(
      durable.invocation_count >= 1 && durable.invocation_count <= 2,
      "rebind may recover through the resumed live Pi process or one replacement offline Invocation",
    );
  } else if (item.allowGlobalCrashRetry) {
    assert.ok(
      durable.delivery.attempts >= 1 && durable.delivery.attempts <= 2,
      "non-target case may have at most one retry from the round's injected serve crash",
    );
    assert.ok(
      durable.invocation_count >= 1 && durable.invocation_count <= 2,
      "non-target case may have at most one extra AgentInvocation from the round's injected serve crash",
    );
  } else {
    assert.equal(
      durable.delivery.attempts,
      1 + injectedExtraAttempts,
      "Delivery attempts must match only the explicitly injected rebind/crash windows",
    );
    assert.equal(
      durable.invocation_count,
      1 + injectedExtraAttempts,
      "AgentInvocation count must match only the explicitly injected rebind/crash windows",
    );
  }
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
    rebind_fault: rebindFault,
    settlement_crash_fault: settlementCrashFault,
    initial,
  };
}

async function runRound(options, shared, round) {
  const roundDir = join(shared.evidenceDir, `round-${String(round).padStart(4, "0")}`);
  await mkdir(roundDir, { recursive: true });
  const cases = await Promise.all(options.plan.modes.map((mode) => seedCase(options, shared, round, mode)));
  try {
    for (const item of cases) {
      await finishSeedCase(item, options.plan.timeoutSec * 1000);
    }
    const submitted = await waitForSubmittedCases(
      cases,
      shared.env,
      options.plan.timeoutSec * 1000,
    );
    const activeBeforeRestart = submitted.filter((run) => !TERMINAL_STATES.has(String(run.status)));
    const activeRunIds = new Set(activeBeforeRestart.map((run) => run.run_id));
    const activeCases = cases.filter((item) => activeRunIds.has(item.spec.runId));
    const rebindScheduled = options.plan.rebindEvery > 0 && round % options.plan.rebindEvery === 0;
    const settlementCrashScheduled =
      options.plan.settlementCrashEvery > 0 && round % options.plan.settlementCrashEvery === 0;
    const sshFaultScheduled = options.plan.sshFaultEvery > 0 && round % options.plan.sshFaultEvery === 0;
    if ((rebindScheduled || settlementCrashScheduled || sshFaultScheduled) && activeCases.length === 0) {
      throw new Error("all soak Runs became terminal before fault injection; increase --run-delay-sec");
    }

    let rebindTarget = null;
    if (rebindScheduled) {
      rebindTarget = activeCases.find((item) => item.mode === "local-process") || activeCases[0];
      rebindTarget.injectRebind = true;
      rebindTarget.branchFault = await divergePersistedSession(rebindTarget, shared);
    }
    if (settlementCrashScheduled) {
      const crashTarget = activeCases.find((item) => item !== rebindTarget);
      if (!crashTarget && rebindTarget) {
        throw new Error(
          "rebind and settlement-crash faults require separate active Runs when scheduled in the same round; use mixed modes or separate focused rounds",
        );
      }
      const target = crashTarget || activeCases[0];
      target.injectSettlementCrash = true;
      for (const item of cases) {
        if (item !== target) item.allowGlobalCrashRetry = true;
      }
    }

    let sshFault = null;
    if (sshFaultScheduled) {
      const sshTarget = activeCases.find((item) => item.mode === "slurm");
      if (!sshTarget) throw new Error("scheduled SSH fault requires an active Slurm Run");
      sshFault = await injectTransientSshLoss(sshTarget, shared, options.plan.timeoutSec * 1000);
    }

    let restart = null;
    if (options.plan.restartEvery > 0 && round % options.plan.restartEvery === 0) {
      if (activeBeforeRestart.length === 0) {
        throw new Error(
          "all soak Runs became terminal before daemon restart injection; increase --run-delay-sec",
        );
      }
      restart = await restartServe(shared);
    }

    const results = await Promise.all(
      cases.map((item) => inspectCompletedCase(item, shared, options.plan.timeoutSec * 1000)),
    );
    const summary = {
      round,
      submitted: submitted.map((run) => ({ run_id: run.run_id, status: run.status, job_id: run.job_id })),
      active_before_restart: activeBeforeRestart.map((run) => run.run_id),
      restart,
      rebind_scheduled: rebindScheduled,
      settlement_crash_scheduled: settlementCrashScheduled,
      ssh_fault_scheduled: sshFaultScheduled,
      ssh_fault: sshFault,
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
  const piSshToolsExtension = options.plan.modes.includes("slurm")
    ? preflightPiSshTools({ mode: "slurm", piExecutable: options.piExecutable })
    : null;
  const nonce = safeNonce();
  const evidenceDir = resolve(options.evidenceRoot, `soak-${nonce}`);
  await mkdir(evidenceDir, { recursive: false });
  const sshFault = options.plan.sshFaultEvery > 0
    ? await prepareRunwatchSshFaultProfile({ alias: options.host, evidenceDir, env: process.env })
    : null;
  const runwatchDataDir = join(evidenceDir, "runwatch-data");
  const endpoint = endpointFor(`soak-${nonce}`);
  const env = {
    ...process.env,
    RUNWATCH_DATA_DIR: runwatchDataDir,
    RUNWATCH_ENDPOINT: endpoint,
    PI_RUNS_BACKEND: "auto",
  };
  const runwatchEnv = sshFault
    ? { ...env, RUNWATCH_SSH_CONFIG: sshFault.configPath }
    : env;
  const extension = resolve("extensions/runs/index.ts");
  const piApiModule = options.plan.rebindEvery > 0 ? resolvePiApiModule(options) : null;
  const shared = {
    nonce,
    evidenceDir,
    runwatchDataDir,
    endpoint,
    env,
    extension,
    piApiModule,
    piSshToolsExtension,
    model: options.model,
    thinking: options.thinking,
    piExecutable: options.piExecutable,
    sshFault,
    sshFaultSec: options.plan.sshFaultSec,
  };
  const supervisorLogs = openProcessLogs(evidenceDir, "runwatch-supervisor");
  const supervisor = spawn(options.runwatchExe, ["supervise", "--interval", "1"], {
    cwd: dirname(options.runwatchExe),
    env: runwatchEnv,
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
      rebind_every: options.plan.rebindEvery,
      settlement_crash_every: options.plan.settlementCrashEvery,
      ssh_fault_every: options.plan.sshFaultEvery,
      ssh_fault_sec: options.plan.sshFaultSec,
      pi_api_module: piApiModule,
      pi_ssh_tools_extension: piSshToolsExtension,
      rounds_completed: rounds.length,
      total_cases: rounds.reduce((sum, item) => sum + item.cases.length, 0),
      runwatch: {
        executable: options.runwatchExe,
        protocol_version: readiness.protocol_version,
        service: readiness.service,
        storage: readiness.storage,
        ssh_config: sshFault?.configPath || null,
        ssh_fault_relay_port: sshFault?.relayPort || null,
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
    await sshFault?.relay.close();
  }
}

function usage() {
  return [
    "Pi v1 resident endurance/fault soak",
    "",
    "One-round qualification:",
    "  node scripts/acceptance/pi_v1_soak.mjs --confirm-real-provider --runwatch-exe <packaged runwatch> --model <provider/model> --host <ssh-alias> --workdir </shared/workspace> --rounds 1",
    "",
    "Focused branch-rebind qualification:",
    "  node scripts/acceptance/pi_v1_soak.mjs --confirm-real-provider --runwatch-exe <packaged runwatch> --model <provider/model> --modes local-process --rounds 1 --run-delay-sec 45 --restart-every 0 --rebind-every 1 --settlement-crash-every 0",
    "",
    "Focused settlement-crash qualification:",
    "  node scripts/acceptance/pi_v1_soak.mjs --confirm-real-provider --runwatch-exe <packaged runwatch> --model <provider/model> --modes local-process --rounds 1 --run-delay-sec 45 --restart-every 0 --rebind-every 0 --settlement-crash-every 1",
    "",
    "Duration soak:",
    "  node scripts/acceptance/pi_v1_soak.mjs --confirm-real-provider --runwatch-exe <packaged runwatch> --model <provider/model> --host <ssh-alias> --workdir </shared/workspace> --duration-sec 7200 --run-delay-sec 30 --rebind-every 5 --settlement-crash-every 7 --ssh-fault-every 3 --ssh-fault-sec 8",
    "",
    "The same packaged supervisor/SQLite/IPC runtime is reused across all rounds. Active-run restarts kill only the isolated serve child. Rebind rounds use Pi's exported SessionManager API to make a real sibling branch in the same persisted session, require needs_rebind with zero completion injection, then explicitly rebind the same Delivery. Settlement-crash rounds kill serve only after one completion is persisted and before the settlement receipt, then require orphan recovery without duplicating completion. SSH-fault rounds route only runwatch's SSH transport through an evidence-local localhost relay, require an unreachable/probe_error Observation after cut, then require a fresh Observation on the same scheduler job after restore. Evidence is preserved under acceptance-output/.",
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
