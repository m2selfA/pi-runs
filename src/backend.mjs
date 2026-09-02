import * as legacy from "./core.mjs";
import * as runwatch from "./runwatch-client.mjs";

const VALID_BACKENDS = new Set(["auto", "legacy", "runwatch"]);

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
