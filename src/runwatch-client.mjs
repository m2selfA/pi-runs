import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { displayNameForRun } from "./naming.mjs";

const CLIENT_PROTOCOL_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 750;
const DEFAULT_WAIT_UPDATE_INTERVAL_MS = 5_000;
const MIN_WAIT_UPDATE_INTERVAL_MS = 1_000;
const MAX_WAIT_UPDATE_INTERVAL_MS = 30_000;
const INITIAL_WAIT_RECONNECT_BACKOFF_MS = 250;
const MAX_WAIT_RECONNECT_BACKOFF_MS = 5_000;
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "timed_out", "cancelled", "lost"]);

function clientError(kind, message, cause) {
  const error = new Error(message);
  error.name = "RunwatchClientError";
  error.runwatch_kind = kind;
  if (cause && typeof cause === "object" && "code" in cause) error.code = cause.code;
  return error;
}

export function isTransientRunwatchTransportError(error) {
  return error?.runwatch_kind === "transport";
}

function abortError() {
  return clientError("aborted", "runwatch IPC request aborted");
}

function sleepWithSignal(delayMs, signal) {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(abortError());
    const timer = setTimeout(() => finish(), delayMs);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function endpoint(env = process.env) {
  if (env.RUNWATCH_ENDPOINT) return env.RUNWATCH_ENDPOINT;
  if (process.platform === "win32") return "\\\\.\\pipe\\runwatch-v1";
  return join(homedir(), ".runwatch", "runwatch-v1.sock");
}

export function request(op, payload = {}, options = {}) {
  const timeoutMs = options.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const target = options.endpoint || endpoint(options.env);
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = "";
    const socket = net.createConnection(target);
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    const onAbort = () => finish(abortError());
    const timer = setTimeout(
      () => finish(clientError("transport", `runwatch IPC timeout after ${timeoutMs} ms`)),
      timeoutMs,
    );

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id, op, ...payload })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      let response;
      try {
        response = JSON.parse(line);
      } catch (err) {
        finish(clientError("protocol", `invalid runwatch IPC response: ${err.message}`, err));
        return;
      }
      if (response.id !== id) {
        finish(
          clientError(
            "protocol",
            `runwatch IPC response id mismatch: expected ${id}, got ${response.id}`,
          ),
        );
        return;
      }
      if (!response.ok) {
        finish(clientError("remote", response.error || `runwatch IPC ${op} failed`));
        return;
      }
      finish(null, response.result);
    });
    socket.on("error", (err) =>
      finish(clientError("transport", err instanceof Error ? err.message : String(err), err)),
    );
    socket.on("end", () => {
      if (!settled) finish(clientError("transport", "runwatch IPC closed without a response"));
    });

    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export async function clientInfo(options = {}) {
  const target = options.endpoint || endpoint(options.env);
  try {
    const hello = await request("hello", {}, options);
    const protocolVersion = Number(hello?.protocol_version);
    const capabilities = Array.isArray(hello?.capabilities)
      ? hello.capabilities.filter((value) => typeof value === "string")
      : [];
    if (protocolVersion !== CLIENT_PROTOCOL_VERSION) {
      return {
        available: false,
        transport: "local-ipc",
        endpoint: target,
        protocol_version: protocolVersion,
        version: typeof hello?.version === "string" ? hello.version : undefined,
        service: hello?.service,
        storage: hello?.storage,
        reason: `unsupported runwatch protocol ${protocolVersion}; expected ${CLIENT_PROTOCOL_VERSION}`,
        capabilities,
      };
    }
    return {
      available: true,
      transport: "local-ipc",
      endpoint: target,
      protocol_version: protocolVersion,
      version: typeof hello?.version === "string" ? hello.version : undefined,
      service: hello?.service,
      storage: hello?.storage,
      capabilities,
    };
  } catch (err) {
    return {
      available: false,
      transport: "local-ipc",
      endpoint: target,
      protocol_version: CLIENT_PROTOCOL_VERSION,
      capabilities: [],
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function optionalResourceText(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function optionalResourceCount(value) {
  return value === 0 ? undefined : value;
}

function buildSchedulerResources(req) {
  const resources = {};
  for (const key of ["time", "partition", "queue", "account", "mem"]) {
    const value = optionalResourceText(req?.[key]);
    if (value !== undefined) resources[key] = value;
  }
  for (const key of ["cpus", "gpus"]) {
    const value = optionalResourceCount(req?.[key]);
    if (value !== undefined) resources[key] = value;
  }
  return resources;
}

export function buildSubmitSpec(req) {
  const runner = String(req?.runner || "").toLowerCase();
  if (!req?.run_id) throw new Error("runwatch submit requires stable run_id");
  if (!req?.workdir) throw new Error("runwatch submit requires workdir");

  if (runner === "process") {
    if (req?.host && req.host !== "local") {
      throw new Error("runwatch runner=process is local-only; omit host or use host=local");
    }
    return {
      run_id: req.run_id,
      name: optionalResourceText(req.name),
      workspace: {
        host_alias: "local",
        cwd: req.workdir,
      },
      runner,
      command: req.command,
      resources: {},
      continuation: req._continuation,
    };
  }

  if (!req?.host) throw new Error("runwatch remote submit requires host");
  if (runner !== "slurm" && runner !== "lsf") {
    throw new Error("runwatch submit requires runner=process for local or runner=slurm/lsf for remote");
  }
  return {
    run_id: req.run_id,
    name: optionalResourceText(req.name),
    workspace: {
      host_alias: req.host,
      cwd: req.workdir,
    },
    runner,
    command: req.command,
    resources: buildSchedulerResources(req),
    continuation: req._continuation,
  };
}

function withDisplayName(run) {
  return run ? { ...run, display_name: displayNameForRun(run) } : run;
}

export async function submitRun(req, options = {}) {
  const spec = buildSubmitSpec(req);
  const result = await request(
    "submit_run_v2",
    { spec },
    { ...options, timeout_ms: options.timeout_ms ?? 70_000 },
  );
  const run = result?.run;
  if (!run?.run_id) throw new Error("runwatch submit returned no Run");
  return {
    ...withDisplayName(run),
    wakeup: "runwatch",
    handle: run.job_id ? { kind: run.runner, jobId: run.job_id } : undefined,
    continuation_binding_persisted: Boolean(spec.continuation),
    continuation_armed: false,
  };
}

export async function registerAgentSession(registration, options = {}) {
  return request("register_agent_session", { registration }, options);
}

export async function releaseAgentSession(registration, options = {}) {
  return request(
    "release_agent_session",
    {
      agent_kind: registration.agent_kind,
      session_id: registration.session_id,
      owner_instance_id: registration.owner_instance_id,
    },
    options,
  );
}

export async function claimDeliveries(registration, options = {}) {
  const result = await request(
    "claim_deliveries",
    {
      agent_kind: registration.agent_kind,
      session_id: registration.session_id,
      owner_instance_id: registration.owner_instance_id,
      limit: options.limit ?? 8,
    },
    options,
  );
  return result?.deliveries || [];
}

export async function deliveryStatus(registration, options = {}) {
  const result = await request(
    "delivery_status",
    {
      agent_kind: registration.agent_kind,
      session_id: registration.session_id,
      owner_instance_id: registration.owner_instance_id,
    },
    options,
  );
  return result?.status || { pending: 0, delivering: 0, retrying: 0, needs_rebind: 0 };
}

export async function verifyOfflineInvocation(
  invocationId,
  deliveryId,
  ownerInstanceId,
  options = {},
) {
  const result = await request(
    "verify_offline_invocation",
    {
      invocation_id: invocationId,
      delivery_id: deliveryId,
      owner_instance_id: ownerInstanceId,
    },
    options,
  );
  return Boolean(result?.owned);
}

export async function ackDelivery(registration, deliveryId, outcome, error, options = {}) {
  return request(
    "ack_delivery",
    {
      agent_kind: registration.agent_kind,
      session_id: registration.session_id,
      owner_instance_id: registration.owner_instance_id,
      delivery_id: deliveryId,
      outcome,
      error,
    },
    options,
  );
}

export async function rebindContinuation(runId, binding, options = {}) {
  return request("rebind_continuation", { run_id: runId, binding }, options);
}

export function normalizeWaitOptions(options = {}) {
  const hasTimeout = options.timeout_ms !== undefined && options.timeout_ms !== null;
  const timeoutMs = hasTimeout ? Number(options.timeout_ms) : null;
  if (hasTimeout && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
    throw new Error(`invalid runs_wait timeout_ms=${options.timeout_ms}; expected a non-negative finite number`);
  }

  const rawInterval = options.interval_ms ?? DEFAULT_WAIT_UPDATE_INTERVAL_MS;
  const intervalMs = Number(rawInterval);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`invalid runs_wait interval_ms=${rawInterval}; expected a positive finite number`);
  }

  const until = String(options.until ?? "terminal").trim().toLowerCase();
  if (until !== "terminal" && until !== "running") {
    throw new Error(`invalid runs_wait until=${until}; expected terminal or running`);
  }

  return {
    timeoutMs: timeoutMs === null ? null : Math.floor(timeoutMs),
    intervalMs: Math.min(
      MAX_WAIT_UPDATE_INTERVAL_MS,
      Math.max(MIN_WAIT_UPDATE_INTERVAL_MS, Math.floor(intervalMs)),
    ),
    until,
  };
}

export function waitConditionMet(run, until = "terminal") {
  const status = String(run?.status || "").toLowerCase();
  if (TERMINAL_RUN_STATUSES.has(status)) return true;
  return until === "running" && status === "running";
}

export async function waitRun(runId, options = {}) {
  const { timeoutMs, intervalMs, until } = normalizeWaitOptions(options);
  const startedAt = Date.now();
  let iteration = 0;
  let reconnectAttempt = 0;
  let reconnectCount = 0;
  let lastRun;

  while (true) {
    const elapsedBeforeSlice = Math.max(0, Date.now() - startedAt);
    const remainingMs =
      timeoutMs === null ? Number.POSITIVE_INFINITY : Math.max(0, timeoutMs - elapsedBeforeSlice);
    const sliceMs =
      timeoutMs === 0
        ? 0
        : timeoutMs === null
          ? intervalMs
          : Math.min(intervalMs, remainingMs);
    const timeoutSec =
      sliceMs === 0
        ? 0
        : timeoutMs === null
          ? Math.min(86_400, Math.max(1, Math.ceil(sliceMs / 1000)))
          : Math.min(86_400, Math.max(0, Math.floor(sliceMs / 1000)));
    const requestTimeoutMs =
      timeoutMs === null
        ? Math.max(2_000, sliceMs + 2_000)
        : timeoutSec > 0
          ? Math.max(250, Math.min(remainingMs + 100, timeoutSec * 1_000 + 500))
          : Math.max(100, Math.min(750, remainingMs + 100));
    let result;
    try {
      result = await request(
        "wait_run",
        { run_id: runId, timeout_sec: timeoutSec },
        { ...options, timeout_ms: requestTimeoutMs },
      );
    } catch (error) {
      if (options.signal?.aborted || error?.runwatch_kind === "aborted") throw error;
      if (!isTransientRunwatchTransportError(error)) throw error;

      reconnectAttempt += 1;
      reconnectCount += 1;
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      const timedOut = timeoutMs !== null && elapsedMs >= timeoutMs;
      if (timedOut) {
        if (!lastRun) {
          throw clientError(
            "transport",
            `runs_wait timed out after ${timeoutMs} ms while runwatch was unavailable: ${error.message}`,
            error,
          );
        }
        return {
          ...withDisplayName(lastRun),
          wait_observation: {
            until,
            outcome: "timeout",
            elapsed_ms: elapsedMs,
            timeout_ms: timeoutMs,
            interval_ms: intervalMs,
            iterations: iteration,
            reconnects: reconnectCount,
          },
        };
      }

      const backoffMs = Math.min(
        MAX_WAIT_RECONNECT_BACKOFF_MS,
        INITIAL_WAIT_RECONNECT_BACKOFF_MS * 2 ** Math.min(reconnectAttempt - 1, 8),
      );
      const boundedBackoffMs =
        timeoutMs === null ? backoffMs : Math.min(backoffMs, Math.max(0, timeoutMs - elapsedMs));
      options.on_update?.({
        run: lastRun,
        state: "reconnecting",
        until,
        condition_met: false,
        elapsed_ms: elapsedMs,
        timeout_ms: timeoutMs,
        interval_ms: intervalMs,
        iteration,
        reconnect_attempt: reconnectAttempt,
        reconnect_count: reconnectCount,
        retry_in_ms: boundedBackoffMs,
        error: error instanceof Error ? error.message : String(error),
      });
      await sleepWithSignal(boundedBackoffMs, options.signal);
      continue;
    }
    if (!result?.run) throw new Error(`unknown run ${runId}`);

    lastRun = result.run;
    iteration += 1;
    reconnectAttempt = 0;
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    const conditionMet = waitConditionMet(result.run, until);
    const timedOut = timeoutMs !== null && (timeoutMs === 0 || elapsedMs >= timeoutMs);
    options.on_update?.({
      run: result.run,
      state: "observing",
      until,
      condition_met: conditionMet,
      elapsed_ms: elapsedMs,
      timeout_ms: timeoutMs,
      interval_ms: intervalMs,
      iteration,
      reconnect_count: reconnectCount,
    });

    if (conditionMet || timedOut) {
      return {
        ...withDisplayName(result.run),
        wait_observation: {
          until,
          outcome: conditionMet ? "condition_met" : "timeout",
          elapsed_ms: elapsedMs,
          timeout_ms: timeoutMs,
          interval_ms: intervalMs,
          iterations: iteration,
          reconnects: reconnectCount,
        },
      };
    }

    if (timeoutMs !== null && timeoutSec === 0) {
      const remainingAfterSnapshot = Math.max(0, timeoutMs - elapsedMs);
      if (remainingAfterSnapshot > 0) {
        await sleepWithSignal(remainingAfterSnapshot, options.signal);
      }
    }
  }
}

function attachObservation(run, observation) {
  const named = withDisplayName(run);
  return observation ? { ...named, observation } : named;
}

function attachObservationList(runs, observations) {
  const byAttempt = new Map(
    (Array.isArray(observations) ? observations : []).map((observation) => [
      `${observation?.run_id}:${observation?.attempt_no}`,
      observation,
    ]),
  );
  return (Array.isArray(runs) ? runs : []).map((run) =>
    attachObservation(run, byAttempt.get(`${run?.run_id}:${run?.attempt_no}`)),
  );
}

export async function statusRun(runId, options = {}) {
  if (runId) {
    const result = await request("get_run", { run_id: runId }, options);
    if (!result?.run) throw new Error(`unknown run ${runId}`);
    return attachObservation(result.run, result.observation);
  }
  const result = await request("list_runs", {}, options);
  return attachObservationList(result?.runs, result?.observations);
}

export async function logsRun(runId, tail = 80, options = {}) {
  const result = await request("logs", { run_id: runId, tail }, options);
  if (!result?.logs) throw new Error(`runwatch logs returned no payload for ${runId}`);
  return result.logs;
}

export async function cancelRun(runId, options = {}) {
  const result = await request("cancel_run", { run_id: runId }, options);
  if (!result?.run) throw new Error(`runwatch cancel returned no Run for ${runId}`);
  return { ...withDisplayName(result.run), cancel_requested: Boolean(result.cancel_requested) };
}

export async function harvestRun(runId, options = {}) {
  const result = await request("artifacts", { run_id: runId }, options);
  if (!result?.artifacts) {
    throw new Error(`runwatch artifacts returned no payload for ${runId}`);
  }
  return result.artifacts;
}
