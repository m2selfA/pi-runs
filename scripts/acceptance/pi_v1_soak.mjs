#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
const DEFAULT_SEED_TIMEOUT_SEC = 180;
const FORMAL_ENDURANCE_MIN_TARGET_SEC = 7200;
const FORMAL_FAULT_ARM_MARGIN_SEC = 60;
const DEFAULT_REBIND_EVERY = 0;
const DEFAULT_SETTLEMENT_CRASH_EVERY = 0;
const DEFAULT_SSH_FAULT_EVERY = 0;
const DEFAULT_SSH_FAULT_SEC = 8;
const ENDURANCE_SESSION_FILE = "endurance-session.json";
const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled", "timed_out", "lost"]);
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TREE_SKIP_DIRS = new Set([".git", "node_modules", "acceptance-output"]);

function safeNonce() {
  return `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function collectTreeFiles(path, files = []) {
  const stat = statSync(path);
  if (stat.isFile()) {
    files.push(resolve(path));
    return files;
  }
  if (!stat.isDirectory()) return files;
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && TREE_SKIP_DIRS.has(entry.name)) continue;
    collectTreeFiles(join(path, entry.name), files);
  }
  return files;
}

function sha256Paths(paths, baseDir, predicate = () => true) {
  const files = paths.flatMap((path) => collectTreeFiles(path)).filter(predicate);
  const hash = createHash("sha256");
  for (const path of files.sort((a, b) => a.localeCompare(b))) {
    const label = relative(baseDir, path).replaceAll("\\", "/");
    hash.update(label);
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function nearestPackageRoot(path) {
  let current = dirname(resolve(path));
  while (true) {
    if (existsSync(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error(`could not locate package.json above ${path}`);
    current = parent;
  }
}

function piRunsContractTreeSha256() {
  return sha256Paths(
    [
      join(PACKAGE_ROOT, "package.json"),
      join(PACKAGE_ROOT, "extensions"),
      join(PACKAGE_ROOT, "src"),
      join(PACKAGE_ROOT, "scripts", "acceptance"),
    ],
    PACKAGE_ROOT,
  );
}

function externalExtensionCodeSha256(extensionPath) {
  if (!extensionPath) return null;
  const root = nearestPackageRoot(extensionPath);
  return sha256Paths(
    [root],
    root,
    (path) => {
      const rel = relative(root, path).replaceAll("\\", "/");
      if (rel.startsWith("docs/") || /(^|\/)test(s)?\//i.test(rel) || /\.test\.[^.]+$/i.test(rel)) return false;
      return rel === "package.json" || /\.(?:[cm]?js|ts|json)$/i.test(rel);
    },
  );
}

function frozenPlan(plan) {
  return {
    modes: [...plan.modes],
    run_delay_sec: plan.runDelaySec,
    seed_timeout_sec: plan.seedTimeoutSec,
    restart_every: plan.restartEvery,
    rebind_every: plan.rebindEvery,
    settlement_crash_every: plan.settlementCrashEvery,
    ssh_fault_every: plan.sshFaultEvery,
    ssh_fault_sec: plan.sshFaultSec,
  };
}

export function buildEnduranceContract(options, resources) {
  return {
    model: options.model,
    thinking: options.thinking,
    host: options.host || null,
    workdir: options.workdir || null,
    target_duration_sec: options.targetDurationSec ?? null,
    plan: frozenPlan(options.plan),
    artifacts: {
      runwatch_sha256: sha256File(options.runwatchExe),
      pi_runs_contract_tree_sha256: piRunsContractTreeSha256(),
      pi_runs_extension_sha256: sha256File(resources.extension),
      pi_api_module_sha256: resources.piApiModule ? sha256File(resources.piApiModule) : null,
      pi_api_code_sha256: externalExtensionCodeSha256(resources.piApiModule),
      pi_ssh_tools_extension_sha256: resources.piSshToolsExtension
        ? sha256File(resources.piSshToolsExtension)
        : null,
      pi_ssh_tools_code_sha256: externalExtensionCodeSha256(resources.piSshToolsExtension),
    },
  };
}

export function assertEnduranceContract(expected, actual) {
  assert.deepEqual(actual, expected, "resume invocation must match the frozen endurance contract");
}

export function aggregateEnduranceProgress(segmentSummaries) {
  const summaries = [...segmentSummaries].sort((a, b) => Number(a.segment) - Number(b.segment));
  return {
    segments_completed: summaries.length,
    rounds_completed: summaries.reduce((sum, item) => sum + Number(item.rounds_completed || 0), 0),
    total_cases: summaries.reduce((sum, item) => sum + Number(item.total_cases || 0), 0),
    active_elapsed_sec: Number(
      summaries.reduce((sum, item) => sum + Number(item.elapsed_sec || 0), 0).toFixed(3),
    ),
    last_round: summaries.reduce((max, item) => Math.max(max, Number(item.round_end || 0)), 0),
  };
}

export function summarizeEnduranceCoverage(segmentSummaries) {
  const rounds = segmentSummaries.flatMap((segment) => segment.rounds || []);
  const cases = rounds.flatMap((round) => round.cases || []);
  return {
    rounds: rounds.length,
    local_process_cases: cases.filter((item) => item.mode === "local-process").length,
    slurm_cases: cases.filter((item) => item.mode === "slurm").length,
    serve_restarts: rounds.filter((round) => Boolean(round.restart)).length,
    ssh_loss_recoveries: rounds.filter((round) => Boolean(round.ssh_fault)).length,
    rebind_recoveries: cases.filter((item) => Boolean(item.rebind_fault)).length,
    settlement_crash_recoveries: cases.filter((item) => Boolean(item.settlement_crash_fault)).length,
  };
}

export function evaluateV1EnduranceQualification({
  targetDurationSec,
  progress,
  segmentSummaries,
  dirtySegments = [],
}) {
  const coverage = summarizeEnduranceCoverage(segmentSummaries);
  const target = Number(targetDurationSec);
  const requirements = {
    target_duration_at_least_7200: Number.isFinite(target) && target >= 7200,
    active_time_meets_target:
      Number.isFinite(target) && Number(progress?.active_elapsed_sec || 0) >= target,
    no_dirty_segments: dirtySegments.length === 0,
    at_least_two_rounds: coverage.rounds >= 2,
    mixed_local_and_slurm: coverage.local_process_cases > 0 && coverage.slurm_cases > 0,
    serve_restart_repeated: coverage.serve_restarts >= 2,
    ssh_loss_recovery_repeated: coverage.ssh_loss_recoveries >= 2,
    branch_rebind_repeated: coverage.rebind_recoveries >= 2,
    settlement_crash_recovery_repeated: coverage.settlement_crash_recoveries >= 2,
  };
  const reasons = Object.entries(requirements)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  return { qualified: reasons.length === 0, requirements, coverage, reasons };
}

async function existingSegmentState(evidenceDir) {
  const entries = await readdir(evidenceDir, { withFileTypes: true });
  const segmentIds = [];
  let maxRound = 0;
  const summaries = [];
  const failedSegments = [];
  const incompleteSegments = [];
  const ambiguousSegments = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const segmentMatch = /^segment-(\d{4})$/.exec(entry.name);
      if (segmentMatch) {
        const segment = Number(segmentMatch[1]);
        segmentIds.push(segment);
        const summaryPath = join(evidenceDir, entry.name, "segment-summary.json");
        const failurePath = join(evidenceDir, entry.name, "failure.json");
        const hasSummary = existsSync(summaryPath);
        const hasFailure = existsSync(failurePath);
        if (hasSummary && hasFailure) ambiguousSegments.push(segment);
        else if (hasSummary) summaries.push(JSON.parse(await readFile(summaryPath, "utf8")));
        else if (hasFailure) failedSegments.push(segment);
        else incompleteSegments.push(segment);
      }
      const roundMatch = /^round-(\d{4})$/.exec(entry.name);
      if (roundMatch) maxRound = Math.max(maxRound, Number(roundMatch[1]));
    }
  }
  const maxSegment = segmentIds.length ? Math.max(...segmentIds) : 0;
  const segmentSet = new Set(segmentIds);
  const missingSegments = [];
  for (let segment = 1; segment <= maxSegment; segment += 1) {
    if (!segmentSet.has(segment)) missingSegments.push(segment);
  }
  return {
    next_segment: maxSegment + 1,
    next_round: maxRound + 1,
    summaries,
    failed_segments: failedSegments,
    incomplete_segments: incompleteSegments,
    ambiguous_segments: ambiguousSegments,
    missing_segments: missingSegments,
    progress: aggregateEnduranceProgress(summaries),
  };
}

export function assertResumableEnduranceState(prior) {
  const blockers = [
    ["failed", prior.failed_segments || []],
    ["incomplete", prior.incomplete_segments || []],
    ["ambiguous", prior.ambiguous_segments || []],
    ["missing", prior.missing_segments || []],
  ].filter(([, segments]) => segments.length > 0);
  if (blockers.length === 0) return;
  const detail = blockers.map(([kind, segments]) => `${kind}=${segments.join(",")}`).join(" ");
  throw new Error(
    `endurance session is not resumable because a prior segment is not cleanly successful: ${detail}; start a new endurance session after diagnosing the preserved evidence`,
  );
}

export async function inspectEnduranceEvidence(evidenceDir) {
  const root = resolve(evidenceDir);
  const sessionPath = join(root, ENDURANCE_SESSION_FILE);
  if (!existsSync(sessionPath)) throw new Error(`endurance evidence missing ${sessionPath}`);
  const session = JSON.parse(await readFile(sessionPath, "utf8"));
  const state = await existingSegmentState(root);
  const dirtySegments = [
    ...(state.failed_segments || []).map((segment) => `failed:${segment}`),
    ...(state.incomplete_segments || []).map((segment) => `incomplete:${segment}`),
    ...(state.ambiguous_segments || []).map((segment) => `ambiguous:${segment}`),
    ...(state.missing_segments || []).map((segment) => `missing:${segment}`),
  ];
  const v1Endurance = evaluateV1EnduranceQualification({
    targetDurationSec: session?.contract?.target_duration_sec,
    progress: state.progress,
    segmentSummaries: state.summaries,
    dirtySegments,
  });
  return {
    schema_version: 1,
    evidence_dir: root,
    session_nonce: session?.nonce || null,
    created_at: session?.created_at || null,
    target_duration_sec: session?.contract?.target_duration_sec ?? null,
    progress: state.progress,
    dirty_segments: dirtySegments,
    v1_endurance: v1Endurance,
  };
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
  const targetDurationSec = options.targetDurationSec === undefined ? undefined : Number(options.targetDurationSec);
  const runDelaySec = Number(options.runDelaySec ?? DEFAULT_RUN_DELAY_SEC);
  const restartEvery = Number(options.restartEvery ?? 1);
  const rebindEvery = Number(options.rebindEvery ?? DEFAULT_REBIND_EVERY);
  const settlementCrashEvery = Number(options.settlementCrashEvery ?? DEFAULT_SETTLEMENT_CRASH_EVERY);
  const sshFaultEvery = Number(options.sshFaultEvery ?? DEFAULT_SSH_FAULT_EVERY);
  const sshFaultSec = Number(options.sshFaultSec ?? DEFAULT_SSH_FAULT_SEC);
  const timeoutSec = Number(options.timeoutSec ?? DEFAULT_TIMEOUT_SEC);
  const seedTimeoutSec = Number(options.seedTimeoutSec ?? Math.min(DEFAULT_SEED_TIMEOUT_SEC, timeoutSec));

  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 1000) {
    throw new Error("--rounds must be an integer between 1 and 1000");
  }
  if (durationSec !== undefined && (!Number.isFinite(durationSec) || durationSec < 30 || durationSec > 86_400)) {
    throw new Error("--duration-sec must be between 30 and 86400");
  }
  if (
    targetDurationSec !== undefined &&
    (!Number.isFinite(targetDurationSec) || targetDurationSec < 60 || targetDurationSec > 86_400)
  ) {
    throw new Error("--target-duration-sec must be between 60 and 86400");
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
  if (!Number.isInteger(seedTimeoutSec) || seedTimeoutSec < 60 || seedTimeoutSec > 540) {
    throw new Error("--seed-timeout-sec must be an integer between 60 and 540");
  }
  if (seedTimeoutSec > timeoutSec) {
    throw new Error("--seed-timeout-sec must not exceed --timeout-sec");
  }
  const hasActiveFault = restartEvery > 0 || rebindEvery > 0 || settlementCrashEvery > 0 || sshFaultEvery > 0;
  if (
    targetDurationSec !== undefined &&
    targetDurationSec >= FORMAL_ENDURANCE_MIN_TARGET_SEC &&
    hasActiveFault &&
    runDelaySec < seedTimeoutSec + FORMAL_FAULT_ARM_MARGIN_SEC
  ) {
    throw new Error(
      `formal endurance with active fault injection requires --run-delay-sec >= --seed-timeout-sec + ${FORMAL_FAULT_ARM_MARGIN_SEC}`,
    );
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
    targetDurationSec,
    runDelaySec,
    seedTimeoutSec,
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
    seedTimeoutSec: undefined,
    evidenceRoot: resolve("acceptance-output"),
    resumeEvidenceDir: undefined,
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
    "--target-duration-sec",
    "--run-delay-sec",
    "--restart-every",
    "--rebind-every",
    "--settlement-crash-every",
    "--ssh-fault-every",
    "--ssh-fault-sec",
    "--pi-api-module",
    "--timeout-sec",
    "--seed-timeout-sec",
    "--evidence-root",
    "--resume-evidence-dir",
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
      case "--target-duration-sec": result.targetDurationSec = Number(value); break;
      case "--run-delay-sec": result.runDelaySec = Number(value); break;
      case "--restart-every": result.restartEvery = Number(value); break;
      case "--rebind-every": result.rebindEvery = Number(value); break;
      case "--settlement-crash-every": result.settlementCrashEvery = Number(value); break;
      case "--ssh-fault-every": result.sshFaultEvery = Number(value); break;
      case "--ssh-fault-sec": result.sshFaultSec = Number(value); break;
      case "--pi-api-module": result.piApiModule = resolve(value); break;
      case "--timeout-sec": result.timeoutSec = Number(value); break;
      case "--seed-timeout-sec": result.seedTimeoutSec = Number(value); break;
      case "--evidence-root": result.evidenceRoot = resolve(value); break;
      case "--resume-evidence-dir": result.resumeEvidenceDir = resolve(value); break;
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

export function faultAttemptBounds(item) {
  const rebindRetry = Number(Boolean(item?.injectRebind));
  const settlementCrashRetry = Number(Boolean(item?.injectSettlementCrash));
  const optionalGlobalCrashRetry = Number(Boolean(item?.allowGlobalCrashRetry));
  const deliveryMin = 1 + rebindRetry + settlementCrashRetry;
  return {
    delivery_min: deliveryMin,
    delivery_max: deliveryMin + optionalGlobalCrashRetry,
    invocation_min: 1 + settlementCrashRetry,
    invocation_max: 1 + settlementCrashRetry + rebindRetry + optionalGlobalCrashRetry,
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
  const faultBounds = faultAttemptBounds(item);
  assert.ok(
    durable.delivery.attempts >= faultBounds.delivery_min &&
      durable.delivery.attempts <= faultBounds.delivery_max,
    `Delivery attempts ${durable.delivery.attempts} outside injected-fault bounds ${faultBounds.delivery_min}..${faultBounds.delivery_max}`,
  );
  assert.ok(
    durable.invocation_count >= faultBounds.invocation_min &&
      durable.invocation_count <= faultBounds.invocation_max,
    `AgentInvocation count ${durable.invocation_count} outside injected-fault bounds ${faultBounds.invocation_min}..${faultBounds.invocation_max}`,
  );
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

export async function settleConcurrentInspections(inspections) {
  const outcomes = await Promise.allSettled(inspections);
  const failed = outcomes.find((outcome) => outcome.status === "rejected");
  if (failed) throw failed.reason;
  return outcomes.map((outcome) => outcome.value);
}

async function runRound(options, shared, round) {
  const roundDir = join(shared.evidenceDir, `round-${String(round).padStart(4, "0")}`);
  await mkdir(roundDir, { recursive: true });
  const cases = await Promise.all(options.plan.modes.map((mode) => seedCase(options, shared, round, mode)));
  try {
    for (const item of cases) {
      await finishSeedCase(item, options.plan.seedTimeoutSec * 1000);
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

    const results = await settleConcurrentInspections(
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
  const extension = resolve("extensions/runs/index.ts");
  const piApiModule = options.plan.rebindEvery > 0 ? resolvePiApiModule(options) : null;
  const resources = { extension, piApiModule, piSshToolsExtension };
  const contract = buildEnduranceContract(options, resources);

  let nonce;
  let evidenceDir;
  let runwatchDataDir;
  let endpoint;
  if (options.resumeEvidenceDir) {
    evidenceDir = resolve(options.resumeEvidenceDir);
    const sessionPath = join(evidenceDir, ENDURANCE_SESSION_FILE);
    if (!existsSync(sessionPath)) throw new Error(`resume endurance session missing ${sessionPath}`);
    const session = JSON.parse(await readFile(sessionPath, "utf8"));
    if (session?.schema_version !== 1 || !session?.nonce || !session?.runtime) {
      throw new Error(`invalid endurance session manifest ${sessionPath}`);
    }
    assertEnduranceContract(session.contract, contract);
    nonce = session.nonce;
    runwatchDataDir = session.runtime.runwatch_data_dir;
    endpoint = session.runtime.endpoint;
  } else {
    nonce = safeNonce();
    evidenceDir = resolve(options.evidenceRoot, `soak-${nonce}`);
    await mkdir(evidenceDir, { recursive: false });
    runwatchDataDir = join(evidenceDir, "runwatch-data");
    endpoint = endpointFor(`soak-${nonce}`);
    const session = {
      schema_version: 1,
      nonce,
      created_at: new Date().toISOString(),
      contract,
      runtime: {
        runwatch_data_dir: runwatchDataDir,
        endpoint,
      },
    };
    await writeFile(
      join(evidenceDir, ENDURANCE_SESSION_FILE),
      `${JSON.stringify(session, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
  }

  const prior = await existingSegmentState(evidenceDir);
  assertResumableEnduranceState(prior);
  const segment = prior.next_segment;
  const segmentDir = join(evidenceDir, `segment-${String(segment).padStart(4, "0")}`);
  await mkdir(segmentDir, { recursive: false });
  const sshFault = options.plan.sshFaultEvery > 0
    ? await prepareRunwatchSshFaultProfile({ alias: options.host, evidenceDir: segmentDir, env: process.env })
    : null;
  const env = {
    ...process.env,
    RUNWATCH_DATA_DIR: runwatchDataDir,
    RUNWATCH_ENDPOINT: endpoint,
    PI_RUNS_BACKEND: "auto",
  };
  const runwatchEnv = sshFault
    ? { ...env, RUNWATCH_SSH_CONFIG: sshFault.configPath }
    : env;
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
  const supervisorLogs = openProcessLogs(segmentDir, "runwatch-supervisor");
  const supervisor = spawn(options.runwatchExe, ["supervise", "--interval", "1"], {
    cwd: dirname(options.runwatchExe),
    env: runwatchEnv,
    windowsHide: true,
    stdio: ["ignore", supervisorLogs.stdoutFd, supervisorLogs.stderrFd],
  });
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  const deadline = options.plan.durationSec === undefined ? undefined : startedAt + options.plan.durationSec * 1000;
  const rounds = [];
  const roundStart = prior.next_round;
  try {
    const readiness = await waitForRuntime(env);
    let round = roundStart;
    while (true) {
      rounds.push(await runRound(options, shared, round));
      if (deadline !== undefined) {
        if (Date.now() >= deadline) break;
      } else if (rounds.length >= options.plan.rounds) {
        break;
      }
      round += 1;
    }
    const elapsedSec = Number(((Date.now() - startedAt) / 1000).toFixed(3));
    const segmentSummary = {
      schema_version: 1,
      ok: true,
      segment,
      started_at: startedAtIso,
      ended_at: new Date().toISOString(),
      elapsed_sec: elapsedSec,
      round_start: roundStart,
      round_end: rounds.at(-1)?.round || roundStart - 1,
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
    };
    await writeFile(
      join(segmentDir, "segment-summary.json"),
      `${JSON.stringify(segmentSummary, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    const completedSegments = [...prior.summaries, segmentSummary];
    const progress = aggregateEnduranceProgress(completedSegments);
    const targetDurationSec = options.targetDurationSec ?? null;
    const v1Endurance = evaluateV1EnduranceQualification({
      targetDurationSec,
      progress,
      segmentSummaries: completedSegments,
      dirtySegments: [],
    });
    const summary = {
      schema_version: 2,
      ok: prior.failed_segments.length === 0,
      session_nonce: nonce,
      model: options.model,
      thinking: options.thinking,
      modes: options.plan.modes,
      target_duration_sec: targetDurationSec,
      target_met:
        targetDurationSec === null
          ? null
          : prior.failed_segments.length === 0 && progress.active_elapsed_sec >= targetDurationSec,
      current_segment: segment,
      segment_elapsed_sec: elapsedSec,
      segments_completed: progress.segments_completed,
      failed_segments: prior.failed_segments,
      rounds_completed: progress.rounds_completed,
      total_cases: progress.total_cases,
      active_elapsed_sec: progress.active_elapsed_sec,
      last_round: progress.last_round,
      v1_endurance: v1Endurance,
      run_delay_sec: options.plan.runDelaySec,
      seed_timeout_sec: options.plan.seedTimeoutSec,
      restart_every: options.plan.restartEvery,
      rebind_every: options.plan.rebindEvery,
      settlement_crash_every: options.plan.settlementCrashEvery,
      ssh_fault_every: options.plan.sshFaultEvery,
      ssh_fault_sec: options.plan.sshFaultSec,
      pi_api_module: piApiModule,
      pi_ssh_tools_extension: piSshToolsExtension,
      runwatch: segmentSummary.runwatch,
      evidence_dir: evidenceDir,
      resume_command_requires_same_contract: true,
      preserved: true,
    };
    await writeFile(join(evidenceDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    return summary;
  } catch (error) {
    const failure = {
      schema_version: 1,
      ok: false,
      segment,
      started_at: startedAtIso,
      ended_at: new Date().toISOString(),
      elapsed_sec: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
      round_start: roundStart,
      rounds_completed: rounds.length,
      error: error instanceof Error ? error.stack || error.message : String(error),
      evidence_dir: evidenceDir,
      preserved: true,
    };
    await writeFile(
      join(segmentDir, "failure.json"),
      `${JSON.stringify(failure, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
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
    "One-process duration soak:",
    "  node scripts/acceptance/pi_v1_soak.mjs --confirm-real-provider --runwatch-exe <packaged runwatch> --model <provider/model> --host <ssh-alias> --workdir </shared/workspace> --duration-sec 7200 --target-duration-sec 7200 --run-delay-sec 600 --seed-timeout-sec 480 --rebind-every 5 --settlement-crash-every 7 --ssh-fault-every 3 --ssh-fault-sec 8",
    "",
    "Resumable endurance session:",
    "  first segment: add --target-duration-sec 7200 and a bounded --duration-sec <segment-seconds>",
    "  later segments: repeat the frozen model/host/workdir/fault arguments and add --resume-evidence-dir <existing-soak-dir>",
    "  read-only qualification report: node scripts/acceptance/pi_v1_soak.mjs --report-evidence-dir <existing-soak-dir>",
    "",
    "A resumable session freezes runwatch, the active pi-runs runtime/acceptance tree, Pi API, pi-ssh-tools code, model, workspace and fault cadence in endurance-session.json. Formal >=7200 s fault endurance also requires scientific run delay to exceed the bounded initiating-Pi seed timeout by a safety margin, so early submissions remain active until all seed sessions have armed; Slurm walltime is derived from that delay rather than fixed at two minutes. Each invocation reuses the same runwatch data directory, IPC endpoint and monotonically increasing round numbers, but writes a new immutable segment-NNNN checkpoint. Segment-boundary supervisor restart is explicit additional fault coverage; only clean successful segment active time accumulates toward --target-duration-sec. A failed, interrupted/incomplete, ambiguous or missing prior segment makes the session non-resumable and is a release-blocking failure; after diagnosis, start a new endurance session rather than washing the failure out with later time. Active-run restarts kill only the isolated serve child. Rebind rounds use Pi's exported SessionManager API to make a real sibling branch in the same persisted session, require needs_rebind with zero completion injection, then explicitly rebind the same Delivery. Settlement-crash rounds kill serve only after one completion is persisted and before the settlement receipt, then require orphan recovery without duplicating completion. SSH-fault rounds route only runwatch's SSH transport through an evidence-local localhost relay, require an unreachable/probe_error Observation after cut, then require a fresh Observation on the same scheduler job after restore. Evidence is preserved under acceptance-output/.",
  ].join("\n");
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(usage());
    return;
  }
  const reportIndex = process.argv.indexOf("--report-evidence-dir");
  if (reportIndex >= 0) {
    const evidenceDir = process.argv[reportIndex + 1];
    if (!evidenceDir) throw new Error("--report-evidence-dir requires a path");
    console.log(JSON.stringify(await inspectEnduranceEvidence(evidenceDir), null, 2));
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
