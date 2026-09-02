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
  const pending = Number(deliveries?.pending || 0);
  const delivering = Number(deliveries?.delivering || 0);
  const retrying = Number(deliveries?.retrying || 0);
  const needsRebind = Number(deliveries?.needs_rebind || 0);
  const continuation = pending + delivering + retrying;
  let text = summary.text;
  let tone = summary.tone;
  const observationAttention = currentRuns.filter(hasObservationAttention).length;
  const otherObservationAttention = otherRuns.filter(hasObservationAttention).length;

  if (observationAttention > 0) {
    text += ` · ${observationAttention} probe issue${observationAttention === 1 ? "" : "s"}`;
    tone = "warning";
  }

  if (currentSessionId) {
    const globalAttention = otherSummary.attention + otherObservationAttention;
    if (globalAttention > 0) {
      text += ` · ${globalAttention} global attention`;
      tone = "warning";
    } else if (otherSummary.live > 0) {
      text += ` · ${otherSummary.live} other live`;
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
  };
}
