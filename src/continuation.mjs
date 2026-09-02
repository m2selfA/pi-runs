export function originIsOnCurrentBranch(binding, branch) {
  const origin = binding?.origin_leaf_id;
  if (!origin) return true;
  return Array.isArray(branch) && branch.some((entry) => entry?.id === origin);
}

export function classifyFinalAgentOutcome(messages) {
  const rows = Array.isArray(messages) ? messages : [];
  const assistant = [...rows].reverse().find((message) => message?.role === "assistant");
  if (!assistant) {
    return {
      ok: false,
      error: "offline Pi settled without a final assistant message",
    };
  }

  const stopReason = String(assistant.stopReason || "").toLowerCase();
  if (stopReason === "error" || stopReason === "aborted") {
    return {
      ok: false,
      error:
        typeof assistant.errorMessage === "string" && assistant.errorMessage.trim()
          ? assistant.errorMessage.trim()
          : `offline Pi assistant stopped with ${stopReason}`,
    };
  }

  return { ok: true };
}

export const COMPLETION_SETTLED_ENTRY_TYPE = "runwatch/completion-settled";

function completionEntryMatchesDelivery(entry, deliveryId) {
  return (
    entry?.type === "custom_message" &&
    entry?.customType === "runwatch/completion" &&
    Array.isArray(entry?.details?.delivery_ids) &&
    entry.details.delivery_ids.includes(deliveryId)
  );
}

export function inspectOfflineDeliverySession(branch, deliveryId) {
  const rows = Array.isArray(branch) ? branch : [];
  const settled = [...rows].reverse().find(
    (entry) =>
      entry?.type === "custom" &&
      entry?.customType === COMPLETION_SETTLED_ENTRY_TYPE &&
      entry?.data?.delivery_id === deliveryId &&
      entry?.data?.outcome === "delivered",
  );
  if (settled) {
    return { state: "settled", settled_entry_id: settled.id };
  }

  let completionIndex = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (completionEntryMatchesDelivery(rows[i], deliveryId)) {
      completionIndex = i;
      break;
    }
  }
  if (completionIndex < 0) return { state: "absent" };

  const completion = rows[completionIndex];
  let assistantEntry;
  for (let i = completionIndex + 1; i < rows.length; i += 1) {
    const entry = rows[i];
    if (
      entry?.type === "custom_message" ||
      (entry?.type === "message" && entry?.message?.role === "user")
    ) {
      break;
    }
    if (entry?.type === "message" && entry?.message?.role === "assistant") {
      assistantEntry = entry;
    }
  }

  if (!assistantEntry) {
    return { state: "injected_unsettled", completion_entry_id: completion.id };
  }
  const stopReason = String(assistantEntry.message?.stopReason || "").toLowerCase();
  if (stopReason === "stop") {
    return {
      state: "completed_success",
      completion_entry_id: completion.id,
      assistant_entry_id: assistantEntry.id,
    };
  }
  if (stopReason === "error" || stopReason === "aborted") {
    return {
      state: "completed_failure",
      completion_entry_id: completion.id,
      assistant_entry_id: assistantEntry.id,
      error:
        typeof assistantEntry.message?.errorMessage === "string" &&
        assistantEntry.message.errorMessage.trim()
          ? assistantEntry.message.errorMessage.trim()
          : `persisted offline Pi assistant stopped with ${stopReason}`,
    };
  }
  return {
    state: "injected_unsettled",
    completion_entry_id: completion.id,
    assistant_entry_id: assistantEntry.id,
  };
}

export function formatCompletionRecoveryMessage(delivery) {
  const payload = delivery?.payload || {};
  const workspace = payload.workspace || payload.binding?.workspace || {};
  const lines = [
    `runwatch is recovering interrupted handling of delivery ${delivery?.delivery_id || "unknown"}.`,
    `The original runwatch/completion for Run ${payload.run_id || "unknown"} is already present on this Pi branch. Do not inject or resubmit it again.`,
    "Continue from the existing completion context, finish any incomplete verification, and avoid repeating side effects that are already visibly complete.",
  ];
  if (workspace.host_alias && workspace.cwd) {
    lines.push(`Recorded remote workspace: ${workspace.host_alias}:${workspace.cwd}`);
  }
  return lines.join("\n");
}

export function formatCompletionMessage(deliveries) {
  const rows = (Array.isArray(deliveries) ? deliveries : []).slice(0, 8);
  const plural = rows.length === 1 ? "Run" : "Runs";
  const lines = [
    `runwatch reports ${rows.length} long scientific ${plural} reached a terminal state.`,
    "",
  ];
  for (const item of rows) {
    const payload = item?.payload || {};
    const workspace = payload.workspace || payload.binding?.workspace || {};
    lines.push(`- ${payload.run_id || "unknown"}: ${payload.status || "unknown"}`);
    if (payload.job_id) lines.push(`  scheduler job: ${payload.job_id}`);
    if (workspace.host_alias && workspace.cwd) {
      lines.push(`  remote workspace: ${workspace.host_alias}:${workspace.cwd}`);
    }
  }
  lines.push(
    "",
    "Continue the scientific reasoning that created these Runs. Check runs_status/runs_logs first. Before inspecting remote scientific artifacts, explicitly activate the recorded workspace with ssh_activate, then use ssh_read/ssh_bash/ssh_edit as needed. Do not resubmit a completed attempt merely because this completion message arrived.",
  );
  return lines.join("\n");
}
