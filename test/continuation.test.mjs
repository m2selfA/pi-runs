import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPLETION_SETTLED_ENTRY_TYPE,
  classifyFinalAgentOutcome,
  formatCompletionMessage,
  formatCompletionRecoveryMessage,
  inspectOfflineDeliverySession,
  originIsOnCurrentBranch,
} from "../src/continuation.mjs";

test("origin leaf must remain on the current Pi branch", () => {
  const binding = { origin_leaf_id: "leaf-origin" };
  assert.equal(
    originIsOnCurrentBranch(binding, [{ id: "root" }, { id: "leaf-origin" }, { id: "new-leaf" }]),
    true,
  );
  assert.equal(originIsOnCurrentBranch(binding, [{ id: "root" }, { id: "other" }]), false);
  assert.equal(originIsOnCurrentBranch({ origin_leaf_id: null }, []), true);
});

test("offline continuation requires a successful final assistant outcome", () => {
  assert.deepEqual(
    classifyFinalAgentOutcome([{ role: "assistant", stopReason: "stop", content: [] }]),
    { ok: true },
  );
  assert.deepEqual(
    classifyFinalAgentOutcome([
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "provider request failed",
      },
    ]),
    { ok: false, error: "provider request failed" },
  );
  assert.deepEqual(
    classifyFinalAgentOutcome([{ role: "assistant", stopReason: "aborted" }]),
    { ok: false, error: "offline Pi assistant stopped with aborted" },
  );
  assert.deepEqual(classifyFinalAgentOutcome([{ role: "user", content: [] }]), {
    ok: false,
    error: "offline Pi settled without a final assistant message",
  });
});

test("offline delivery session evidence prevents duplicate completion after crash windows", () => {
  const deliveryId = "r1:a1:terminal";
  const completion = {
    id: "completion-1",
    type: "custom_message",
    customType: "runwatch/completion",
    details: { delivery_ids: [deliveryId] },
  };
  assert.deepEqual(inspectOfflineDeliverySession([], deliveryId), { state: "absent" });
  assert.deepEqual(inspectOfflineDeliverySession([completion], deliveryId), {
    state: "injected_unsettled",
    completion_entry_id: "completion-1",
  });
  assert.deepEqual(
    inspectOfflineDeliverySession(
      [
        completion,
        {
          id: "assistant-tool",
          type: "message",
          message: { role: "assistant", stopReason: "toolUse" },
        },
      ],
      deliveryId,
    ),
    {
      state: "injected_unsettled",
      completion_entry_id: "completion-1",
      assistant_entry_id: "assistant-tool",
    },
  );
  assert.deepEqual(
    inspectOfflineDeliverySession(
      [
        completion,
        {
          id: "assistant-stop",
          type: "message",
          message: { role: "assistant", stopReason: "stop" },
        },
      ],
      deliveryId,
    ),
    {
      state: "completed_success",
      completion_entry_id: "completion-1",
      assistant_entry_id: "assistant-stop",
    },
  );
  assert.equal(
    inspectOfflineDeliverySession(
      [
        completion,
        {
          id: "assistant-error",
          type: "message",
          message: { role: "assistant", stopReason: "error", errorMessage: "provider failed" },
        },
      ],
      deliveryId,
    ).state,
    "completed_failure",
  );
  assert.deepEqual(
    inspectOfflineDeliverySession(
      [
        completion,
        {
          id: "settled-1",
          type: "custom",
          customType: COMPLETION_SETTLED_ENTRY_TYPE,
          data: { delivery_id: deliveryId, outcome: "delivered" },
        },
      ],
      deliveryId,
    ),
    { state: "settled", settled_entry_id: "settled-1" },
  );
});

test("recovery message references the existing completion instead of duplicating it", () => {
  const text = formatCompletionRecoveryMessage({
    delivery_id: "r1:a1:terminal",
    payload: {
      run_id: "r1",
      workspace: { host_alias: "hpc.example", cwd: "/tmp/r1" },
    },
  });
  assert.match(text, /original runwatch\/completion.*already present/i);
  assert.match(text, /do not inject or resubmit it again/i);
  assert.match(text, /hpc.example:\/tmp\/r1/);
});

test("completion message is bounded and points Pi back to explicit SSH workspace activation", () => {
  const deliveries = Array.from({ length: 12 }, (_, i) => ({
    payload: {
      run_id: `r${i}`,
      status: "succeeded",
      job_id: String(100 + i),
      workspace: { host_alias: "hpc.example", cwd: `/shared/r${i}` },
    },
  }));
  const text = formatCompletionMessage(deliveries);
  assert.match(text, /runwatch reports 8/);
  assert.match(text, /ssh_activate/);
  assert.match(text, /hpc.example:\/shared\/r0/);
  assert.doesNotMatch(text, /r8:/);
});
