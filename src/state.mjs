import { isTerminal as _isTerminal } from "./status.mjs";

const allowed = {
  submitted: ["pending", "running", "succeeded", "failed", "timed_out", "cancelled", "lost"],
  pending: ["running", "succeeded", "failed", "timed_out", "cancelled", "lost"],
  running: ["cancelling", "succeeded", "failed", "timed_out", "cancelled", "lost"],
  cancelling: ["cancelled", "failed", "succeeded", "lost"],
  succeeded: [],
  failed: [],
  timed_out: [],
  cancelled: [],
  lost: [],
};

export function canTransition(from, to) {
  if (from === to) return true;
  return (allowed[from] || []).includes(to);
}

export function applyStatus(record, status, extra = {}) {
  if (!canTransition(record.status, status)) {
    throw new Error(`illegal transition ${record.status} -> ${status} for ${record.run_id}`);
  }
  return {
    ...record,
    ...extra,
    status,
    updated_at: new Date().toISOString(),
  };
}

export { _isTerminal as isTerminal };
