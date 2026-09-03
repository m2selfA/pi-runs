import { displayNameForRun } from "./naming.mjs";

export const TERMINAL = ["succeeded", "failed", "timed_out", "cancelled", "lost"];
const KNOWN = new Set(["submitted", "submitting", "pending", "queued", "running", "cancelling", ...TERMINAL, "unknown"]);

export function isTerminal(status) {
  return TERMINAL.includes(status);
}

function normalizedSessionId(run) {
  const value = run?.session_id ?? run?.sessionId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function hasObservationAttention(run) {
  if (isTerminal(String(run?.status || "").toLowerCase())) return false;
  const health = String(run?.observation?.health || "").toLowerCase();
  return health === "probe_error" || health === "unreachable";
}

export function summarizeRuns(runs) {
  const counts = {
    queued: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    timed_out: 0,
    lost: 0,
    unknown: 0,
  };

  for (const run of Array.isArray(runs) ? runs : []) {
    let status = String(run?.status || "unknown").toLowerCase();
    if (["submitted", "submitting", "pending", "cancelling"].includes(status)) status = "queued";
    if (!KNOWN.has(String(run?.status || "unknown").toLowerCase()) && status !== "queued") status = "unknown";
    if (Object.hasOwn(counts, status)) counts[status] += 1;
    else counts.unknown += 1;
  }

  const failed = counts.failed + counts.timed_out + counts.lost;
  const parts = [];
  if (counts.running) parts.push(`${counts.running} running`);
  if (counts.queued) parts.push(`${counts.queued} queued`);
  if (failed) parts.push(`${failed} failed`);
  if (counts.unknown) parts.push(`${counts.unknown} unknown`);

  let text = parts.length ? `Runs ${parts.join(" · ")}` : "Runs idle";

  return {
    text,
    tone: failed || counts.unknown ? "warning" : counts.running || counts.queued ? "accent" : "muted",
    counts,
    live: counts.running + counts.queued,
    attention: failed + counts.unknown,
    backend: "runwatch",
  };
}

function executionState(status) {
  const value = String(status || "unknown").toLowerCase();
  if (isTerminal(value)) return "terminal";
  if (value === "running") return "running";
  if (["submitted", "submitting", "pending", "queued", "cancelling"].includes(value)) return "queued";
  return "unknown";
}

function runAttention(run) {
  const status = String(run?.status || "unknown").toLowerCase();
  if (["failed", "timed_out", "lost", "unknown"].includes(status)) return status;
  if (!KNOWN.has(status)) return "unknown";
  if (hasObservationAttention(run)) return "observation";
  return undefined;
}

function relationForRun(run, options) {
  if (options?.attached_run_id && run?.run_id === options.attached_run_id) return "attached";
  const sessionId = normalizedSessionId(run);
  if (options?.session_id && sessionId === options.session_id) return "current_session";
  if (options?.project_root && run?.project_root === options.project_root) return "same_project";
  return "other";
}

function updatedTime(run) {
  const value = Date.parse(run?.updated_at || "");
  return Number.isFinite(value) ? value : 0;
}

function presenceRank(item) {
  if (item.relation === "attached") return 0;
  if (item.relation === "current_session" && item.live) return 1;
  if (item.relation === "current_session" && item.attention) return 2;
  if (item.relation === "same_project" && item.live) return 3;
  if (item.attention) return 4;
  if (item.live) return 5;
  return 9;
}

export function projectRunPresence(runs, options = {}) {
  return (Array.isArray(runs) ? runs : [])
    .map((run) => {
      const execution = executionState(run?.status);
      const relation = relationForRun(run, options);
      return {
        run_id: run?.run_id,
        display_name: displayNameForRun(run),
        relation,
        execution,
        live: execution === "running" || execution === "queued",
        status: String(run?.status || "unknown").toLowerCase(),
        runner: run?.runner,
        durable_handle: run?.job_id,
        elapsed_ms:
          relation === "attached" && Number.isFinite(Number(options?.attached_elapsed_ms))
            ? Math.max(0, Number(options.attached_elapsed_ms))
            : undefined,
        observation_health: run?.observation?.health,
        continuation: run?.continuation || "none",
        attention: runAttention(run),
        updated_at: run?.updated_at,
        session_id: normalizedSessionId(run),
        project_root: run?.project_root,
      };
    })
    .sort((a, b) => presenceRank(a) - presenceRank(b) || updatedTime(b) - updatedTime(a) || String(a.run_id).localeCompare(String(b.run_id)));
}

export function formatPresenceElapsed(elapsedMs) {
  if (!Number.isFinite(Number(elapsedMs))) return "";
  const seconds = Math.max(0, Math.floor(Number(elapsedMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h${remainder}m` : `${hours}h`;
}

export function summarizePiRunsStatus(
  runs,
  backend = "runwatch",
  deliveries = {},
  bridgeState = "unknown",
  options = {},
) {
  if (backend !== "runwatch") {
    throw new Error(`status backend ${backend} is retired; Pi v1 status is runwatch-only`);
  }
  const allRuns = Array.isArray(runs) ? runs : [];
  const currentSessionId =
    typeof options?.session_id === "string" && options.session_id.trim()
      ? options.session_id.trim()
      : undefined;
  const currentRuns = currentSessionId
    ? allRuns.filter((run) => normalizedSessionId(run) === currentSessionId)
    : allRuns;
  const otherRuns = currentSessionId
    ? allRuns.filter((run) => normalizedSessionId(run) !== currentSessionId)
    : [];
  const summary = summarizeRuns(currentRuns);
  const otherSummary = summarizeRuns(otherRuns);
  const presence = projectRunPresence(allRuns, options);
  const pending = Number(deliveries?.pending || 0);
  const delivering = Number(deliveries?.delivering || 0);
  const retrying = Number(deliveries?.retrying || 0);
  const needsRebind = Number(deliveries?.needs_rebind || 0);
  const continuation = pending + delivering + retrying;
  let text = summary.text;
  let tone = summary.tone;
  if (currentSessionId) {
    const primary =
      presence.find((item) => item.relation === "attached" && (item.live || item.attention)) ||
      presence.find((item) => item.relation === "current_session" && (item.live || item.attention)) ||
      presence.find((item) => item.relation === "same_project" && (item.live || item.attention));
    if (primary) {
      const reconnecting = primary.relation === "attached" && options?.wait_state === "reconnecting";
      const symbol = reconnecting
        ? "↻"
        : primary.attention
          ? "⚠"
          : primary.execution === "running"
            ? "●"
            : "○";
      const elapsed = formatPresenceElapsed(primary.elapsed_ms);
      text = `Runs ${symbol} ${primary.display_name}${elapsed ? ` ${elapsed}` : ""}${primary.relation === "attached" ? " [attached]" : primary.relation === "same_project" ? " [project]" : ""}`;
      const additionalCurrentLive = presence.filter(
        (item) => item !== primary && ["attached", "current_session"].includes(item.relation) && item.live,
      ).length;
      if (additionalCurrentLive > 0) text += ` · +${additionalCurrentLive} active`;
      tone = reconnecting || primary.attention ? "warning" : "accent";
    }
  }
  const observationAttention = currentRuns.filter(hasObservationAttention).length;
  const otherObservationAttention = otherRuns.filter(hasObservationAttention).length;

  if (observationAttention > 0) {
    text += ` · ${observationAttention} probe issue${observationAttention === 1 ? "" : "s"}`;
    tone = "warning";
  }

  if (currentSessionId) {
    const primaryRunId = presence.find(
      (item) => ["attached", "current_session", "same_project"].includes(item.relation) && (item.live || item.attention),
    )?.run_id;
    const primaryIsOtherSession = Boolean(
      primaryRunId && otherRuns.some((run) => run?.run_id === primaryRunId),
    );
    const primaryOtherAttention = primaryIsOtherSession
      ? presence.find((item) => item.run_id === primaryRunId)?.attention
        ? 1
        : 0
      : 0;
    const primaryOtherLive = primaryIsOtherSession
      ? presence.find((item) => item.run_id === primaryRunId)?.live
        ? 1
        : 0
      : 0;
    const globalAttention = Math.max(
      0,
      otherSummary.attention + otherObservationAttention - primaryOtherAttention,
    );
    const otherLive = Math.max(0, otherSummary.live - primaryOtherLive);
    if (globalAttention > 0) {
      text = text === "Runs idle" ? `Runs ${globalAttention} global attention` : `${text} · ${globalAttention} global attention`;
      tone = "warning";
    } else if (otherLive > 0) {
      text = text === "Runs idle" ? `Runs ${otherLive} other live` : `${text} · ${otherLive} other live`;
    }
  }

  if (needsRebind > 0) {
    text += ` · ${needsRebind} rebind`;
    tone = "warning";
  } else if (continuation > 0) {
    text += ` · ${continuation} continuation`;
  }

  if (bridgeState === "busy") {
    text += " · session busy";
    tone = "warning";
  } else if (bridgeState === "offline") {
    text += " · bridge offline";
    tone = "warning";
  }

  return {
    ...summary,
    text,
    tone,
    scoped_session_id: currentSessionId,
    other_live: otherSummary.live,
    global_attention: otherSummary.attention + otherObservationAttention,
    observation_attention: observationAttention,
    continuation,
    needs_rebind: needsRebind,
    bridge_state: bridgeState,
    presence,
  };
}
