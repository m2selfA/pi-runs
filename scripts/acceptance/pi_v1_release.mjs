#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  statSync,
} from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

import { clientInfo, statusRun } from "../../src/runwatch-client.mjs";

const MAX_EVIDENCE_FILE_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_SEC = 300;
const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled", "timed_out", "lost"]);

function safeNonce() {
  return `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

export function endpointFor(nonce) {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\pi-runs-release-${nonce}`
    : join(process.env.TMPDIR || "/tmp", `pi-runs-release-${nonce}.sock`);
}

export function piCommand(args, executable = process.env.PI_RUNS_REAL_PI_EXECUTABLE) {
  if (executable) return { executable, args };
  if (process.platform === "win32") {
    return { executable: "volta.exe", args: ["run", "pi", ...args] };
  }
  return { executable: "pi", args };
}

function quotePowerShellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function quotePosixLiteral(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function buildAcceptanceSpec(options, nonce) {
  const mode = options.mode;
  const runId = `r8b_${mode === "slurm" ? "slurm" : "local"}_${nonce}`.replace(
    /[^A-Za-z0-9_.-]/g,
    "_",
  );
  const token = `R8B_TOKEN_${nonce}`.replace(/[^A-Za-z0-9_.-]/g, "_");
  const delaySec = Number(options.delaySec ?? 2);
  if (!Number.isInteger(delaySec) || delaySec < 1 || delaySec > 600) {
    throw new Error("acceptance delaySec must be an integer between 1 and 600");
  }
  if (runId.length > 96) throw new Error(`generated run_id is too long: ${runId}`);

  if (mode === "slurm") {
    if (!options.host) throw new Error("--host is required for --mode slurm");
    if (!options.workdir) throw new Error("--workdir is required for --mode slurm");
    if (!String(options.workdir).startsWith("/")) {
      throw new Error("Slurm --workdir must be an absolute POSIX path");
    }
    const markerName = `runwatch-r8b-${nonce}.txt`;
    const markerProgram = `from pathlib import Path; Path(${JSON.stringify(markerName)}).write_text(${JSON.stringify(token)}, encoding="utf-8")`;
    // Keep the seed prompt safe across Windows Volta/Pi argv reconstruction: avoid cmd.exe
    // metacharacters such as > | & < ^ in the remote command text embedded inside -p.
    const command = `sleep ${delaySec}; python3 -c ${quotePosixLiteral(markerProgram)}`;
    return {
      mode,
      runId,
      token,
      markerName,
      delaySec,
      markerPath: `${String(options.workdir).replace(/\/$/, "")}/${markerName}`,
      submitArgs: {
        run_id: runId,
        runner: "slurm",
        name: runId,
        host: options.host,
        workdir: options.workdir,
        command,
        time: "00:02:00",
        cpus: 1,
      },
      verificationTools: ["runs_status", "runs_logs", "ssh_activate", "ssh_read"],
      verificationInstructions: [
        `Call ssh_activate exactly once with target ${JSON.stringify(`${options.host}:${options.workdir}`)}.`,
        `Then call ssh_read on ${JSON.stringify(markerName)} and verify its contents are exactly ${JSON.stringify(token)}.`,
      ],
    };
  }

  if (mode !== "local-process") throw new Error(`unsupported mode ${JSON.stringify(mode)}`);
  if (process.platform !== "win32") {
    throw new Error("local-process release acceptance is currently Windows-only");
  }
  const workdir = options.workdir ? resolve(options.workdir) : resolve(options.evidenceDir);
  if (!isAbsolute(workdir)) throw new Error("local-process workdir must be absolute");
  const markerPath = resolve(options.evidenceDir, `local-marker-${nonce}.txt`);
  const command = [
    `Start-Sleep -Seconds ${delaySec}`,
    `[IO.File]::WriteAllText(${quotePowerShellLiteral(markerPath)}, ${quotePowerShellLiteral(token)}, [Text.UTF8Encoding]::new($false))`,
  ].join("; ");
  return {
    mode,
    runId,
    token,
    markerName: basename(markerPath),
    delaySec,
    markerPath,
    submitArgs: {
      run_id: runId,
      runner: "process",
      name: runId,
      workdir,
      command,
      cpus: 1,
    },
    verificationTools: ["runs_status", "runs_logs", "read"],
    verificationInstructions: [
      `Then call the built-in read tool on the exact local path ${JSON.stringify(markerPath)} and verify its contents are exactly ${JSON.stringify(token)}.`,
    ],
  };
}

export function buildSeedPrompt(spec) {
  const futureSteps = spec.verificationInstructions.map((line, index) => `${index + 4}. ${line}`);
  const finalStep = futureSteps.length + 4;
  return [
    "This is an explicit Pi v1 release acceptance. Follow the sequence exactly and do not improvise.",
    "Initial turn:",
    "1. Call runs_doctor exactly once. If ready is not true, stop and report the failure; do not submit anything.",
    `2. Call runs_submit exactly once with these exact arguments: ${JSON.stringify(spec.submitArgs)}.`,
    "3. Do not call runs_wait, runs_status, runs_logs, shell, SSH, or any other tool in this initial turn after runs_submit.",
    `4. If runs_submit reports continuation=armed, reply with exactly ${JSON.stringify(`R8B_SUBMITTED:${spec.runId}`)} and stop immediately so the Pi process can exit completely.`,
    "",
    "When runwatch later injects runwatch/completion into this same persisted session:",
    `1. Never resubmit Run ${spec.runId}.`,
    `2. Call runs_status exactly once for ${spec.runId}.`,
    `3. Call runs_logs exactly once for ${spec.runId}.`,
    ...futureSteps,
    `${finalStep}. Only after the marker is verified, reply with exactly ${JSON.stringify(`R8B_RELEASE_OK:${spec.runId}:${spec.token}`)} and stop.`,
  ].filter(Boolean).join(" ");
}

function extractAssistantText(message) {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("");
}

function toolCallsFromMessage(message) {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content
    .filter((item) => item?.type === "toolCall" && typeof item.name === "string")
    .map((item) => ({ id: item.id, name: item.name, arguments: item.arguments || {} }));
}

function toolResultText(message) {
  if (!message || message.role !== "toolResult" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("");
}

const NEUTRAL_OPTIONAL_SUBMIT_ARGS = Object.freeze({
  account: "",
  cpus: 0,
  gpus: 0,
  host: "",
  mem: "",
  name: "",
  partition: "",
  queue: "",
  time: "",
  wakeup: "auto",
  webhook_url: "",
});

export function assertSubmitArgsMatch(actual, expected) {
  assert.ok(actual && typeof actual === "object" && !Array.isArray(actual), "runs_submit args must be an object");
  for (const [key, expectedValue] of Object.entries(expected)) {
    assert.deepEqual(actual[key], expectedValue, `runs_submit argument ${key} must match the acceptance contract`);
  }
  for (const [key, actualValue] of Object.entries(actual)) {
    if (Object.hasOwn(expected, key)) continue;
    assert.ok(
      Object.hasOwn(NEUTRAL_OPTIONAL_SUBMIT_ARGS, key),
      `runs_submit supplied unexpected argument ${key}`,
    );
    assert.deepEqual(
      actualValue,
      NEUTRAL_OPTIONAL_SUBMIT_ARGS[key],
      `runs_submit optional argument ${key} must remain the neutral default`,
    );
  }
}

export function inspectInitialEvents(events, spec) {
  const starts = events.filter((event) => event?.type === "tool_execution_start");
  const doctorCalls = starts.filter((event) => event.toolName === "runs_doctor");
  const submitCalls = starts.filter((event) => event.toolName === "runs_submit");
  assert.equal(doctorCalls.length, 1, "initial turn must call runs_doctor exactly once");
  assert.equal(submitCalls.length, 1, "initial turn must call runs_submit exactly once");
  assert.equal(starts.length, 2, "initial turn must not call tools other than runs_doctor and runs_submit");
  assertSubmitArgsMatch(submitCalls[0].args, spec.submitArgs);

  const doctorEnd = events.find(
    (event) => event?.type === "tool_execution_end" && event.toolName === "runs_doctor",
  );
  assert.ok(doctorEnd, "initial turn must persist a runs_doctor tool result");
  assert.equal(doctorEnd.isError, false, "runs_doctor must succeed");
  assert.equal(doctorEnd.result?.details?.ready, true, "runs_doctor must report ready=true before submission");

  const submitEnd = events.find(
    (event) => event?.type === "tool_execution_end" && event.toolName === "runs_submit",
  );
  assert.ok(submitEnd, "initial turn must persist a runs_submit tool result");
  assert.equal(submitEnd.isError, false, "runs_submit must succeed");
  assert.equal(submitEnd.result?.details?.run_id, spec.runId);
  assert.equal(submitEnd.result?.details?.continuation, "armed");

  const assistantTexts = events
    .filter((event) => event?.type === "message_end")
    .map((event) => extractAssistantText(event.message))
    .filter(Boolean);
  assert.ok(
    assistantTexts.includes(`R8B_SUBMITTED:${spec.runId}`),
    "initial Pi turn must stop at the exact submitted marker",
  );
  assert.ok(events.some((event) => event?.type === "agent_settled"), "initial Pi turn must settle");
  const agentEnd = [...events].reverse().find((event) => event?.type === "agent_end");
  assert.ok(agentEnd, "initial Pi turn must emit agent_end");
  const finalAssistant = [...(agentEnd.messages || [])]
    .reverse()
    .find((message) => message?.role === "assistant");
  assert.equal(finalAssistant?.stopReason, "stop", "initial Pi turn must end with assistant stop");
  return { doctor_calls: 1, submit_calls: 1, submitted_marker: true };
}

export function inspectPersistedSession(rows, spec, deliveryId) {
  const header = rows.find((row) => row?.type === "session");
  assert.ok(header?.id, "Pi session JSONL must contain a session id");
  const completionIndexes = [];
  const settledIndexes = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (
      row?.type === "custom_message" &&
      row?.customType === "runwatch/completion" &&
      Array.isArray(row?.details?.delivery_ids) &&
      row.details.delivery_ids.includes(deliveryId)
    ) {
      completionIndexes.push(index);
    }
    if (
      row?.type === "custom" &&
      row?.customType === "runwatch/completion-settled" &&
      row?.data?.delivery_id === deliveryId &&
      row?.data?.outcome === "delivered"
    ) {
      settledIndexes.push(index);
    }
  }
  assert.equal(completionIndexes.length, 1, "exactly one runwatch/completion must be persisted");
  assert.equal(settledIndexes.length, 1, "exactly one completion-settled receipt must be persisted");

  const afterCompletion = rows.slice(completionIndexes[0] + 1);
  const toolCalls = afterCompletion
    .filter((row) => row?.type === "message")
    .flatMap((row) => toolCallsFromMessage(row.message));
  const toolNames = toolCalls.map((call) => call.name);
  const readTool = spec.mode === "slurm" ? "ssh_read" : "read";
  const allowedTools = new Set(spec.verificationTools);
  for (const call of toolCalls) {
    assert.ok(allowedTools.has(call.name), `offline continuation used unexpected tool ${call.name}`);
  }
  for (const required of spec.verificationTools.filter((name) => name !== readTool)) {
    assert.equal(
      toolNames.filter((name) => name === required).length,
      1,
      `offline continuation must call ${required} exactly once`,
    );
  }
  const readCalls = toolCalls.filter((call) => call.name === readTool);
  assert.ok(readCalls.length >= 1, `offline continuation must call ${readTool} at least once`);
  assert.equal(toolNames.filter((name) => name === "runs_submit").length, 0, "offline continuation must never resubmit");
  assert.equal(toolNames.filter((name) => name === "runs_wait").length, 0, "offline continuation must not poll with runs_wait");

  if (spec.mode === "slurm") {
    const activate = toolCalls.find((call) => call.name === "ssh_activate");
    assert.equal(activate?.arguments?.target, `${spec.submitArgs.host}:${spec.submitArgs.workdir}`);
    for (const read of readCalls) {
      assert.ok(
        read.arguments?.path === spec.markerName || read.arguments?.path === spec.markerPath,
        `ssh_read may only inspect the acceptance marker, got ${JSON.stringify(read.arguments?.path)}`,
      );
    }
  } else {
    for (const read of readCalls) {
      assert.equal(resolve(read?.arguments?.path || ""), resolve(spec.markerPath));
    }
  }

  const successfulMarkerReads = readCalls.filter((call) =>
    afterCompletion.some(
      (row) =>
        row?.type === "message" &&
        row?.message?.role === "toolResult" &&
        row.message.toolCallId === call.id &&
        row.message.toolName === readTool &&
        row.message.isError !== true &&
        toolResultText(row.message).includes(spec.token),
    ),
  );
  assert.ok(
    successfulMarkerReads.length >= 1,
    `${readTool} must successfully read the exact acceptance token at least once`,
  );

  const successMarker = `R8B_RELEASE_OK:${spec.runId}:${spec.token}`;
  const assistantMessages = afterCompletion
    .filter((row) => row?.type === "message" && row?.message?.role === "assistant")
    .map((row) => row.message);
  const exactSuccesses = assistantMessages.filter((message) => extractAssistantText(message) === successMarker);
  assert.equal(exactSuccesses.length, 1, "offline continuation must persist exactly one release success marker");
  assert.equal(exactSuccesses[0].stopReason, "stop", "release success marker must be the terminal assistant stop");

  return {
    session_id: header.id,
    completion_count: completionIndexes.length,
    settlement_count: settledIndexes.length,
    verification_tools: toolNames,
    success_marker: successMarker,
  };
}

export function readJsonLines(path) {
  const metadata = statSync(path);
  if (metadata.size > MAX_EVIDENCE_FILE_BYTES) {
    throw new Error(`evidence file exceeds ${MAX_EVIDENCE_FILE_BYTES} bytes: ${path}`);
  }
  const text = readFileSync(path, "utf8");
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`invalid JSONL at ${path}:${index + 1}: ${error.message}`);
      }
    });
}

export function readDatabaseEvidence(dbPath, runId) {
  if (!existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 1000");
  try {
    const runRow = db.prepare("SELECT record_json FROM runs WHERE run_id=?").get(runId);
    if (!runRow) return null;
    const run = JSON.parse(runRow.record_json);
    const bindingRow = db
      .prepare("SELECT payload_json FROM continuation_bindings WHERE run_id=?")
      .get(runId);
    const binding = bindingRow ? JSON.parse(bindingRow.payload_json) : null;
    const delivery = db
      .prepare(
        "SELECT delivery_id,state,attempts,last_error,payload_json FROM deliveries WHERE run_id=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(runId);
    const invocation = delivery
      ? db
          .prepare(
            "SELECT invocation_id,delivery_id,state,pid,last_error,payload_json FROM agent_invocations WHERE delivery_id=? ORDER BY rowid DESC LIMIT 1",
          )
          .get(delivery.delivery_id)
      : null;
    const invocationCount = delivery
      ? Number(
          db
            .prepare("SELECT COUNT(*) AS count FROM agent_invocations WHERE delivery_id=?")
            .get(delivery.delivery_id)?.count || 0,
        )
      : 0;
    return {
      run,
      binding,
      delivery: delivery ? { ...delivery, payload: JSON.parse(delivery.payload_json) } : null,
      invocation: invocation ? { ...invocation, payload: JSON.parse(invocation.payload_json) } : null,
      invocation_count: invocationCount,
    };
  } finally {
    db.close();
  }
}

export async function waitFor(check, timeoutMs, label, intervalMs = 250) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

export async function waitForExit(
  child,
  timeoutMs,
  label,
  timers = { setTimeout, clearTimeout },
) {
  if (child.exitCode !== null) return child.exitCode;
  let timeoutHandle;
  const timeout = new Promise((_, reject) => {
    timeoutHandle = timers.setTimeout(
      () => reject(new Error(`timed out waiting for ${label}`)),
      timeoutMs,
    );
    timeoutHandle?.unref?.();
  });
  try {
    return await Promise.race([once(child, "exit").then(([code]) => code ?? 1), timeout]);
  } finally {
    if (timeoutHandle !== undefined) timers.clearTimeout(timeoutHandle);
  }
}

export function terminateTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // Process teardown is best effort; evidence files are preserved.
  }
}

export function openProcessLogs(evidenceDir, prefix) {
  const stdoutPath = join(evidenceDir, `${prefix}.stdout.log`);
  const stderrPath = join(evidenceDir, `${prefix}.stderr.log`);
  return {
    stdoutPath,
    stderrPath,
    stdoutFd: openSync(stdoutPath, "wx"),
    stderrFd: openSync(stderrPath, "wx"),
  };
}

export function closeProcessLogs(logs) {
  for (const fd of [logs?.stdoutFd, logs?.stderrFd]) {
    if (typeof fd !== "number") continue;
    try {
      closeSync(fd);
    } catch {
      // Evidence descriptor cleanup only.
    }
  }
}

function parseArgs(argv) {
  const result = {
    confirm: false,
    mode: "slurm",
    timeoutSec: DEFAULT_TIMEOUT_SEC,
    thinking: "low",
    evidenceRoot: resolve("acceptance-output"),
  };
  const valueFlags = new Set([
    "--mode",
    "--runwatch-exe",
    "--model",
    "--thinking",
    "--host",
    "--workdir",
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
      case "--mode": result.mode = value; break;
      case "--runwatch-exe": result.runwatchExe = resolve(value); break;
      case "--model": result.model = value; break;
      case "--thinking": result.thinking = value; break;
      case "--host": result.host = value; break;
      case "--workdir": result.workdir = value; break;
      case "--timeout-sec": result.timeoutSec = Number(value); break;
      case "--evidence-root": result.evidenceRoot = resolve(value); break;
      case "--pi-executable": result.piExecutable = value; break;
      default: throw new Error(`unhandled argument ${arg}`);
    }
  }
  if (!result.confirm) {
    throw new Error("real-provider acceptance requires explicit --confirm-real-provider");
  }
  if (!result.runwatchExe || !existsSync(result.runwatchExe)) {
    throw new Error("--runwatch-exe must point to an existing packaged runwatch executable");
  }
  if (!result.model) throw new Error("--model is required");
  if (!Number.isFinite(result.timeoutSec) || result.timeoutSec < 30 || result.timeoutSec > 3600) {
    throw new Error("--timeout-sec must be between 30 and 3600");
  }
  if (!new Set(["slurm", "local-process"]).has(result.mode)) {
    throw new Error("--mode must be slurm or local-process");
  }
  return result;
}

export function preflightPiSshTools(options) {
  if (options.mode !== "slurm") return;
  const launch = piCommand(["list"], options.piExecutable);
  const probe = spawnSync(launch.executable, launch.args, {
    cwd: process.cwd(),
    windowsHide: true,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (probe.status !== 0) throw new Error(`Pi package preflight failed with exit ${probe.status}`);
  if (!`${probe.stdout}\n${probe.stderr}`.includes("pi-ssh-tools")) {
    throw new Error("remote release acceptance requires pi-ssh-tools to be installed in Pi");
  }
}

export async function runAcceptance(options) {
  preflightPiSshTools(options);
  const nonce = safeNonce();
  await mkdir(options.evidenceRoot, { recursive: true });
  const evidenceDir = resolve(options.evidenceRoot, `${options.mode}-${nonce}`);
  await mkdir(evidenceDir, { recursive: false });
  await mkdir(join(evidenceDir, "pi-sessions"));
  const runwatchDataDir = join(evidenceDir, "runwatch-data");
  const endpoint = endpointFor(nonce);
  const env = {
    ...process.env,
    RUNWATCH_DATA_DIR: runwatchDataDir,
    RUNWATCH_ENDPOINT: endpoint,
    PI_RUNS_BACKEND: "auto",
  };
  const extension = resolve("extensions/runs/index.ts");
  const spec = buildAcceptanceSpec({ ...options, evidenceDir }, nonce);
  const prompt = buildSeedPrompt(spec);
  await writeFile(join(evidenceDir, "prompt.txt"), `${prompt}\n`, "utf8");

  const supervisorLogs = openProcessLogs(evidenceDir, "runwatch-supervisor");
  const supervisor = spawn(options.runwatchExe, ["supervise", "--interval", "1"], {
    cwd: dirname(options.runwatchExe),
    env,
    windowsHide: true,
    stdio: ["ignore", supervisorLogs.stdoutFd, supervisorLogs.stderrFd],
  });
  let piLogs;
  let piChild;
  try {
    const readiness = await waitFor(
      async () => {
        const info = await clientInfo({ env, timeout_ms: 750 });
        return info.available && info.service === "runwatchd" ? info : null;
      },
      20_000,
      "packaged runwatchd readiness",
    );

    piLogs = openProcessLogs(evidenceDir, "pi-initial");
    const piArgs = [
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
      join(evidenceDir, "pi-sessions"),
      "-e",
      extension,
      "-p",
      prompt,
    ];
    const launch = piCommand(piArgs, options.piExecutable);
    piChild = spawn(launch.executable, launch.args, {
      cwd: process.cwd(),
      env,
      windowsHide: true,
      stdio: ["ignore", piLogs.stdoutFd, piLogs.stderrFd],
    });
    const initialExit = await waitForExit(
      piChild,
      Math.min(options.timeoutSec * 1000, 180_000),
      "initial Pi provider turn",
    );
    closeProcessLogs(piLogs);
    piLogs = null;
    if (initialExit !== 0) {
      throw new Error(`initial Pi provider turn exited ${initialExit}`);
    }
    const initialEvents = readJsonLines(join(evidenceDir, "pi-initial.stdout.log"));
    const initial = inspectInitialEvents(initialEvents, spec);

    const run = await waitFor(
      async () => {
        const record = await statusRun(spec.runId, { env, timeout_ms: 1200 });
        if (TERMINAL_STATES.has(String(record.status))) return record;
        return null;
      },
      options.timeoutSec * 1000,
      `Run ${spec.runId} terminal state`,
      500,
    );
    if (String(run.status) !== "succeeded") {
      throw new Error(`Run ${spec.runId} reached ${run.status} instead of succeeded`);
    }

    const dbPath = join(runwatchDataDir, "runwatch.db");
    const durable = await waitFor(
      () => {
        const evidence = readDatabaseEvidence(dbPath, spec.runId);
        if (!evidence) return null;
        if (evidence.delivery?.state === "needs_rebind") {
          throw new Error(`Delivery needs_rebind: ${evidence.delivery.last_error || "no reason"}`);
        }
        if (evidence.delivery?.state === "delivered" && evidence.invocation?.state === "completed") {
          return evidence;
        }
        return null;
      },
      options.timeoutSec * 1000,
      `Delivery/AgentInvocation completion for ${spec.runId}`,
      500,
    );
    assert.equal(durable.delivery.attempts, 1, "clean release gate requires exactly one Delivery attempt");
    assert.equal(durable.invocation_count, 1, "clean release gate requires exactly one AgentInvocation");
    assert.equal(durable.binding?.agent_kind, "pi");
    assert.equal(durable.binding?.session_id, durable.run.session_id);
    assert.ok(durable.binding?.session_file, "durable binding must include the exact Pi session file");

    const sessionRows = readJsonLines(durable.binding.session_file);
    const session = inspectPersistedSession(sessionRows, spec, durable.delivery.delivery_id);
    assert.equal(session.session_id, durable.binding.session_id, "persisted Pi session id must match runwatch binding");

    if (spec.mode === "local-process") {
      const marker = await readFile(spec.markerPath, "utf8");
      assert.equal(marker, spec.token, "local Process marker file must contain the acceptance token");
    }

    const summary = {
      schema_version: 1,
      ok: true,
      mode: spec.mode,
      model: options.model,
      thinking: options.thinking,
      run_id: spec.runId,
      job_id: durable.run.job_id,
      run_status: durable.run.status,
      workspace: durable.run.workspace,
      delivery: {
        delivery_id: durable.delivery.delivery_id,
        state: durable.delivery.state,
        attempts: durable.delivery.attempts,
      },
      invocation: {
        invocation_id: durable.invocation.invocation_id,
        state: durable.invocation.state,
        count: durable.invocation_count,
      },
      session: {
        session_id: session.session_id,
        session_file: durable.binding.session_file,
        completion_count: session.completion_count,
        settlement_count: session.settlement_count,
        verification_tools: session.verification_tools,
        success_marker: session.success_marker,
      },
      initial,
      runwatch: {
        executable: options.runwatchExe,
        protocol_version: readiness.protocol_version,
        service: readiness.service,
        storage: readiness.storage,
      },
      evidence_dir: evidenceDir,
      preserved: true,
    };
    await writeFile(join(evidenceDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    return summary;
  } catch (error) {
    const failure = {
      schema_version: 1,
      ok: false,
      mode: options.mode,
      model: options.model,
      error: error instanceof Error ? error.message : String(error),
      evidence_dir: evidenceDir,
      preserved: true,
    };
    await writeFile(join(evidenceDir, "failure.json"), `${JSON.stringify(failure, null, 2)}\n`, "utf8");
    throw error;
  } finally {
    terminateTree(piChild);
    terminateTree(supervisor);
    closeProcessLogs(piLogs);
    closeProcessLogs(supervisorLogs);
  }
}

function usage() {
  return [
    "Pi v1 real-provider release acceptance",
    "",
    "Remote Slurm:",
    "  node scripts/acceptance/pi_v1_release.mjs --confirm-real-provider --mode slurm --runwatch-exe <packaged runwatch> --model <provider/model> --host <ssh-alias> --workdir </absolute/remote/path>",
    "",
    "Windows Local Process:",
    "  node scripts/acceptance/pi_v1_release.mjs --confirm-real-provider --mode local-process --runwatch-exe <packaged runwatch> --model <provider/model> [--workdir <local-dir>]",
    "",
    "Evidence is preserved under acceptance-output/ by default. The harness stops child processes but does not recursively delete evidence directories.",
  ].join("\n");
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(usage());
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  const summary = await runAcceptance(options);
  console.log(JSON.stringify(summary));
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(`PI_V1_RELEASE_FAIL: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    process.exitCode = 1;
  });
}
