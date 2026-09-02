import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  buildAcceptanceSpec,
  buildSeedPrompt,
  inspectInitialEvents,
  inspectPersistedSession,
  waitForExit,
} from "../scripts/acceptance/pi_v1_release.mjs";

function localSpec() {
  return buildAcceptanceSpec(
    {
      mode: "local-process",
      workdir: process.cwd(),
      evidenceDir: process.cwd(),
    },
    "20260902-test",
  );
}

test("waitForExit clears and unreferences its timeout after a child exits", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  let cleared = false;
  let unrefed = false;
  const timeoutHandle = {
    unref() {
      unrefed = true;
    },
  };
  const timers = {
    setTimeout() {
      return timeoutHandle;
    },
    clearTimeout(handle) {
      assert.equal(handle, timeoutHandle);
      cleared = true;
    },
  };
  queueMicrotask(() => {
    child.exitCode = 0;
    child.emit("exit", 0);
  });

  assert.equal(await waitForExit(child, 180_000, "test child", timers), 0);
  assert.equal(unrefed, true);
  assert.equal(cleared, true);
});

function slurmSpec() {
  return buildAcceptanceSpec(
    {
      mode: "slurm",
      host: "hpc.example",
      workdir: "/tmp",
      evidenceDir: process.cwd(),
    },
    "20260902-slurm-test",
  );
}

test("release prompt freezes initial handoff and future verification contract", () => {
  const spec = localSpec();
  const prompt = buildSeedPrompt(spec);
  assert.equal(prompt.includes("\n"), false, "Windows Volta/Pi launch requires a single-line acceptance prompt");
  assert.match(prompt, /Call runs_doctor exactly once/);
  assert.match(prompt, /Call runs_submit exactly once/);
  assert.equal(spec.submitArgs.name, spec.runId);
  assert.match(prompt, /Do not call runs_wait/);
  assert.match(prompt, new RegExp(`R8B_SUBMITTED:${spec.runId}`));
  assert.match(prompt, new RegExp(`R8B_RELEASE_OK:${spec.runId}:${spec.token}`));
});

test("Slurm seed prompt avoids Windows shell metacharacters while preserving the remote token write", () => {
  const spec = slurmSpec();
  const prompt = buildSeedPrompt(spec);
  assert.doesNotMatch(spec.submitArgs.command, /[>|&<^]/);
  assert.doesNotMatch(prompt, /[>|&<^]/);
  assert.match(spec.submitArgs.command, /python3 -c/);
  assert.match(spec.submitArgs.command, new RegExp(spec.token));
  assert.equal(spec.submitArgs.host, "hpc.example");
  assert.equal(spec.submitArgs.workdir, "/tmp");
});

test("initial event inspection requires exact doctor, submit arguments, armed continuation, and stop", () => {
  const spec = localSpec();
  const marker = `R8B_SUBMITTED:${spec.runId}`;
  const actualSubmitArgs = {
    ...spec.submitArgs,
    account: "",
    gpus: 0,
    host: "",
    mem: "",
    partition: "",
    queue: "",
    time: "",
    wakeup: "auto",
    webhook_url: "",
  };
  const events = [
    { type: "tool_execution_start", toolName: "runs_doctor", args: {} },
    { type: "tool_execution_end", toolName: "runs_doctor", result: { details: { ready: true } }, isError: false },
    { type: "tool_execution_start", toolName: "runs_submit", args: actualSubmitArgs },
    {
      type: "tool_execution_end",
      toolName: "runs_submit",
      result: { details: { run_id: spec.runId, continuation: "armed" } },
      isError: false,
    },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: marker }] } },
    { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: marker }], stopReason: "stop" }] },
    { type: "agent_settled" },
  ];
  assert.deepEqual(inspectInitialEvents(events, spec), {
    doctor_calls: 1,
    submit_calls: 1,
    submitted_marker: true,
  });
  assert.throws(
    () => inspectInitialEvents([...events, { type: "tool_execution_start", toolName: "runs_submit", args: spec.submitArgs }], spec),
    /exactly once/,
  );
  const nonNeutral = events.map((event) =>
    event?.type === "tool_execution_start" && event.toolName === "runs_submit"
      ? { ...event, args: { ...event.args, gpus: 1 } }
      : event,
  );
  assert.throws(() => inspectInitialEvents(nonNeutral, spec), /neutral default/);
  const renamed = events.map((event) =>
    event?.type === "tool_execution_start" && event.toolName === "runs_submit"
      ? { ...event, args: { ...event.args, name: "different-display-name" } }
      : event,
  );
  assert.throws(() => inspectInitialEvents(renamed, spec), /argument name must match/);
  const extraTool = [
    ...events,
    { type: "tool_execution_start", toolName: "runs_status", args: { run_id: spec.runId } },
  ];
  assert.throws(() => inspectInitialEvents(extraTool, spec), /must not call tools other than/);
});

test("persisted session inspection enforces exactly-once completion, settlement, tools, and final marker", () => {
  const spec = localSpec();
  const deliveryId = `${spec.runId}:a1:terminal`;
  const success = `R8B_RELEASE_OK:${spec.runId}:${spec.token}`;
  const rows = [
    { type: "session", id: "session-1" },
    {
      type: "custom_message",
      customType: "runwatch/completion",
      details: { delivery_ids: [deliveryId] },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "status-1", name: "runs_status", arguments: { run_id: spec.runId } },
          { type: "toolCall", id: "logs-1", name: "runs_logs", arguments: { run_id: spec.runId } },
          { type: "toolCall", id: "read-1", name: "read", arguments: { path: spec.markerPath } },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "read-1",
        toolName: "read",
        content: [{ type: "text", text: spec.token }],
        isError: false,
      },
    },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: success }], stopReason: "stop" } },
    {
      type: "custom",
      customType: "runwatch/completion-settled",
      data: { delivery_id: deliveryId, outcome: "delivered" },
    },
  ];
  const result = inspectPersistedSession(rows, spec, deliveryId);
  assert.equal(result.session_id, "session-1");
  assert.equal(result.completion_count, 1);
  assert.equal(result.settlement_count, 1);
  assert.deepEqual(result.verification_tools, ["runs_status", "runs_logs", "read"]);
  assert.throws(
    () => inspectPersistedSession([...rows, rows[1]], spec, deliveryId),
    /exactly one runwatch\/completion/,
  );
  const retryRows = rows.flatMap((row) => {
    if (row?.type !== "message" || row?.message?.toolCallId !== "read-1") return [row];
    return [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "read-0", name: "read", arguments: { path: spec.markerPath } }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "read-0",
          toolName: "read",
          content: [{ type: "text", text: "temporary read failure" }],
          isError: true,
        },
      },
      row,
    ];
  });
  const retried = inspectPersistedSession(retryRows, spec, deliveryId);
  assert.equal(retried.verification_tools.filter((name) => name === "read").length, 2);
});
