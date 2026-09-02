import * as legacy from "./core.mjs";
import * as runwatch from "./runwatch-client.mjs";

const VALID_BACKENDS = new Set(["auto", "legacy", "runwatch"]);

export const PI_V1_REQUIRED_CAPABILITIES = Object.freeze([
  "hello",
  "list_runs",
  "get_run",
  "submit_run_v2",
  "wait_run",
  "logs",
  "artifacts",
  "cancel_run",
  "register_agent_session",
  "release_agent_session",
  "claim_deliveries",
  "delivery_status",
  "ack_delivery",
  "rebind_continuation",
  "verify_offline_invocation",
  "offline_pi_continuation",
]);

export function requestedBackend(env = process.env) {
  const value = String(env.PI_RUNS_BACKEND || "auto").trim().toLowerCase();
  if (!VALID_BACKENDS.has(value)) {
    throw new Error(`invalid PI_RUNS_BACKEND=${value}; expected auto, legacy, or runwatch`);
  }
  return value;
}

export async function backendInfo(capability = "hello", env = process.env, options = {}) {
  const requested = requestedBackend(env);
  if (requested === "legacy") {
    return {
      requested,
      selected: "legacy",
      runwatch: { available: false, capabilities: [], reason: "legacy explicitly requested" },
    };
  }

  const runwatchInfo = await runwatch.clientInfo({ ...options, env });
  const supported =
    runwatchInfo.available &&
    (capability === "hello" || runwatchInfo.capabilities?.includes(capability));

  if (requested === "runwatch") {
    if (!runwatchInfo.available) {
      throw new Error(
        `PI_RUNS_BACKEND=runwatch requested but unavailable: ${runwatchInfo.reason}`,
      );
    }
    if (!supported) {
      throw new Error(`PI_RUNS_BACKEND=runwatch does not support capability ${capability}`);
    }
    return { requested, selected: "runwatch", runwatch: runwatchInfo, capability };
  }

  if (supported) {
    return { requested, selected: "runwatch", runwatch: runwatchInfo, capability };
  }

  const reason = runwatchInfo.available
    ? `runwatchd is online but does not advertise capability ${capability}`
    : `runwatchd is unavailable: ${runwatchInfo.reason}`;
  throw new Error(
    `PI_RUNS_BACKEND=auto refuses implicit legacy fallback: ${reason}. ` +
      "Use PI_RUNS_BACKEND=legacy only as an explicit migration compatibility choice.",
  );
}

export function assessPiV1Readiness(runwatchInfo, requested = "auto") {
  const capabilities = Array.isArray(runwatchInfo?.capabilities)
    ? runwatchInfo.capabilities.filter((value) => typeof value === "string")
    : [];
  const capabilitySet = new Set(capabilities);
  const missingCapabilities = PI_V1_REQUIRED_CAPABILITIES.filter(
    (capability) => !capabilitySet.has(capability),
  );
  const reasons = [];

  if (requested === "legacy") {
    reasons.push(
      "PI_RUNS_BACKEND=legacy explicitly selects the migration backend; Pi v1 production requires runwatch",
    );
  }
  if (!runwatchInfo?.available) {
    reasons.push(`runwatchd unavailable: ${runwatchInfo?.reason || "unknown local IPC failure"}`);
  } else {
    if (runwatchInfo.service !== "runwatchd") {
      reasons.push(`unexpected runwatch service identity ${JSON.stringify(runwatchInfo.service)}`);
    }
    if (runwatchInfo.storage !== "sqlite-wal") {
      reasons.push(`unexpected runwatch storage identity ${JSON.stringify(runwatchInfo.storage)}`);
    }
    if (missingCapabilities.length) {
      reasons.push(`runwatchd is missing Pi v1 capabilities: ${missingCapabilities.join(", ")}`);
    }
  }

  const ready =
    requested !== "legacy" &&
    Boolean(runwatchInfo?.available) &&
    runwatchInfo.service === "runwatchd" &&
    runwatchInfo.storage === "sqlite-wal" &&
    missingCapabilities.length === 0;

  return {
    schema_version: 1,
    ready,
    requested_backend: requested,
    selected_backend: requested === "legacy" ? "legacy" : ready ? "runwatch" : null,
    runwatch: {
      available: Boolean(runwatchInfo?.available),
      transport: runwatchInfo?.transport || "local-ipc",
      endpoint: runwatchInfo?.endpoint,
      protocol_version: runwatchInfo?.protocol_version,
      service: runwatchInfo?.service,
      storage: runwatchInfo?.storage,
      capabilities,
      reason: runwatchInfo?.reason,
    },
    required_capabilities: [...PI_V1_REQUIRED_CAPABILITIES],
    missing_capabilities: missingCapabilities,
    reasons,
  };
}

export async function doctorInfo(options = {}) {
  const env = options.env ?? process.env;
  let requested;
  let configError;
  try {
    requested = requestedBackend(env);
  } catch (err) {
    requested = String(env.PI_RUNS_BACKEND || "auto").trim().toLowerCase();
    configError = err instanceof Error ? err.message : String(err);
  }
  const runwatchInfo = await runwatch.clientInfo({ ...options, env });
  const report = assessPiV1Readiness(runwatchInfo, requested);
  if (configError) {
    report.ready = false;
    report.selected_backend = null;
    report.reasons.unshift(configError);
  }
  return report;
}

export function normalizeSubmitRequest(req, cwd) {
  const runner = String(req?.runner || "auto").toLowerCase();
  const host = typeof req?.host === "string" && req.host.trim() ? req.host.trim() : undefined;
  const workdir = typeof req?.workdir === "string" && req.workdir.trim() ? req.workdir : undefined;

  if (host) {
    if (runner === "auto") {
      throw new Error("remote durable submission requires explicit runner=slurm or runner=lsf");
    }
    if (runner === "process") {
      throw new Error("runner=process is local-only; omit host for a durable local Process Run");
    }
    return { ...req, host, workdir };
  }

  if (runner === "slurm" || runner === "lsf") {
    throw new Error(`runner=${runner} requires an explicit ~/.ssh/config host alias`);
  }
  if (runner === "auto" || runner === "process") {
    const localWorkdir = workdir || cwd;
    if (!localWorkdir) {
      throw new Error("durable local Process submission requires a working directory");
    }
    return { ...req, runner: "process", host: undefined, workdir: localWorkdir };
  }

  return { ...req, host: undefined, workdir };
}

export function submitCapability(req) {
  const runner = String(req?.runner || "auto").toLowerCase();
  if (req?.workdir && runner === "process" && !req?.host) return "submit_run_v2";
  return req?.host && req?.workdir && (runner === "slurm" || runner === "lsf")
    ? "submit_run_v2"
    : "submit_run";
}

async function selectedModule(capability, options = {}) {
  const info = await backendInfo(capability, options.env ?? process.env, options);
  return { module: info.selected === "runwatch" ? runwatch : legacy, info };
}

export async function submitRun(req, options = {}) {
  const capability = submitCapability(req);
  const selected = await selectedModule(capability, options);
  if (capability === "submit_run_v2" && selected.info.selected !== "runwatch") {
    throw new Error(
      `durable submission requires runwatchd capability submit_run_v2; ${selected.info.migration || "runwatch backend unavailable"}`,
    );
  }
  return selected.module.submitRun(req, options);
}

export async function waitRun(runId, opts = {}, options = {}) {
  const merged = { ...opts, ...options };
  const { module } = await selectedModule("wait_run", merged);
  return module.waitRun(runId, merged);
}

export async function statusRun(runId, options = {}) {
  const capability = runId ? "get_run" : "list_runs";
  const { module } = await selectedModule(capability, options);
  return module.statusRun(runId, options);
}

export async function statusOverview(options = {}) {
  const info = await backendInfo("list_runs", options.env ?? process.env, options);
  const module = info.selected === "runwatch" ? runwatch : legacy;
  const runs = await module.statusRun(undefined, options);
  return { backend: info.selected, backend_info: info, runs };
}

export async function rebindRun(runId, binding, options = {}) {
  const selected = await selectedModule("rebind_continuation", options);
  if (selected.info.selected !== "runwatch") {
    throw new Error("runs_rebind requires a live runwatchd rebind_continuation capability");
  }
  return selected.module.rebindContinuation(runId, binding, options);
}

export async function logsRun(runId, tail, options = {}) {
  const { module } = await selectedModule("logs", options);
  return module.logsRun(runId, tail, options);
}

export async function cancelRun(runId, options = {}) {
  const { module } = await selectedModule("cancel_run", options);
  return module.cancelRun(runId, options);
}

export async function harvestRun(runId, options = {}) {
  const { module } = await selectedModule("artifacts", options);
  return module.harvestRun(runId, options);
}
