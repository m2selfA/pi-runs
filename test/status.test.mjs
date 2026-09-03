import test from "node:test";
import assert from "node:assert/strict";
import { projectRunPresence, summarizePiRunsStatus, summarizeRuns } from "../src/status.mjs";

test("status summary stays compact around actionable run states", () => {
  const summary = summarizeRuns([
    { status: "running" },
    { status: "running" },
    { status: "queued" },
    { status: "failed" },
    { status: "succeeded" },
  ]);
  assert.equal(summary.text, "Runs 2 running · 1 queued · 1 failed");
  assert.equal(summary.live, 3);
  assert.equal(summary.attention, 1);
  assert.equal(summary.tone, "warning");
});

test("idle history does not flood the footer with success counts", () => {
  const summary = summarizeRuns([{ status: "succeeded" }, { status: "cancelled" }]);
  assert.equal(summary.text, "Runs idle");
  assert.equal(summary.tone, "muted");
});

test("unknown states are surfaced as attention", () => {
  const summary = summarizeRuns([{ status: "mystery" }]);
  assert.equal(summary.text, "Runs 1 unknown");
  assert.equal(summary.attention, 1);
});

test("Pi status surfaces continuation and rebind without flooding terminal history", () => {
  const waiting = summarizePiRunsStatus(
    [{ status: "running" }, { status: "succeeded" }],
    "runwatch",
    { pending: 1, delivering: 1, retrying: 0, needs_rebind: 0 },
    "ok",
  );
  assert.equal(waiting.text, "Runs 1 running · 2 continuation");
  assert.equal(waiting.tone, "accent");

  const blocked = summarizePiRunsStatus(
    [{ status: "succeeded" }],
    "runwatch",
    { pending: 0, delivering: 0, retrying: 0, needs_rebind: 1 },
    "ok",
  );
  assert.equal(blocked.text, "Runs idle · 1 rebind");
  assert.equal(blocked.tone, "warning");
});

test("Pi status exposes bridge health only for the runwatch backend", () => {
  assert.equal(
    summarizePiRunsStatus([], "runwatch", {}, "offline").text,
    "Runs idle · bridge offline",
  );
  assert.equal(
    summarizePiRunsStatus([], "runwatch", {}, "busy").text,
    "Runs idle · session busy",
  );
});

test("Pi status prioritizes the current research session and compresses unrelated live work", () => {
  const summary = summarizePiRunsStatus(
    [
      { run_id: "current-refine", name: "refine-map", status: "running", session_id: "current" },
      { run_id: "other-queue", name: "preprocess", status: "queued", session_id: "other" },
      { run_id: "other-run", name: "reconstruct", status: "running", session_id: "other" },
      { run_id: "other-done", name: "done", status: "succeeded", session_id: "other" },
    ],
    "runwatch",
    {},
    "ok",
    { session_id: "current" },
  );
  assert.equal(summary.text, "Runs ● refine-map · 2 other live");
  assert.equal(summary.scoped_session_id, "current");
  assert.equal(summary.other_live, 2);
  assert.equal(summary.global_attention, 0);
});

test("Pi status names same-project work even when the current session has no Run", () => {
  const summary = summarizePiRunsStatus(
    [
      { run_id: "project-run", name: "reconstruction", status: "running", session_id: "other", project_root: "C:/science" },
      { run_id: "remote-other", name: "other-project", status: "queued", session_id: "another", project_root: "C:/elsewhere" },
    ],
    "runwatch",
    {},
    "ok",
    { session_id: "current", project_root: "C:/science" },
  );
  assert.equal(summary.text, "Runs ● reconstruction [project] · 1 other live");
});

test("Pi status avoids contradictory idle wording when only unrelated Runs are live", () => {
  const summary = summarizePiRunsStatus(
    [{ run_id: "other", name: "remote-task", status: "running", session_id: "other" }],
    "runwatch",
    {},
    "ok",
    { session_id: "current" },
  );
  assert.equal(summary.text, "Runs 1 other live");
});

test("Pi status never hides failures from another session", () => {
  const summary = summarizePiRunsStatus(
    [
      { run_id: "current-prep", name: "preprocess", status: "queued", session_id: "current" },
      { run_id: "other-failed", name: "mask-fit", status: "failed", session_id: "other" },
      { run_id: "another-unknown", name: "unknown-task", status: "mystery", session_id: "another" },
    ],
    "runwatch",
    {},
    "ok",
    { session_id: "current" },
  );
  assert.equal(summary.text, "Runs ○ preprocess · 2 global attention");
  assert.equal(summary.tone, "warning");
  assert.equal(summary.global_attention, 2);
});

test("Pi status surfaces current-session probe health without hiding the execution state", () => {
  const summary = summarizePiRunsStatus(
    [
      {
        run_id: "probe-current",
        name: "refine-map",
        status: "running",
        session_id: "current",
        observation: { health: "unreachable", source: "transport" },
      },
    ],
    "runwatch",
    {},
    "ok",
    { session_id: "current" },
  );
  assert.equal(summary.text, "Runs ⚠ refine-map · 1 probe issue");
  assert.equal(summary.tone, "warning");
  assert.equal(summary.observation_attention, 1);
});

test("Pi status counts another session's live probe failure as global attention", () => {
  const summary = summarizePiRunsStatus(
    [
      { run_id: "probe-queue", name: "preprocess", status: "queued", session_id: "current", observation: { health: "fresh" } },
      {
        run_id: "probe-other",
        name: "remote-fit",
        status: "running",
        session_id: "other",
        observation: { health: "probe_error", source: "scheduler" },
      },
    ],
    "runwatch",
    {},
    "ok",
    { session_id: "current" },
  );
  assert.equal(summary.text, "Runs ○ preprocess · 1 global attention");
  assert.equal(summary.global_attention, 1);
  assert.equal(summary.tone, "warning");
});

test("RunPresence prioritizes an attached named Run and carries watcher elapsed state", () => {
  const presence = projectRunPresence(
    [
      { run_id: "other", name: "other-task", status: "running", session_id: "other" },
      { run_id: "attached", name: "full-tests", status: "running", session_id: "current", runner: "process" },
    ],
    { session_id: "current", attached_run_id: "attached", attached_elapsed_ms: 125_000 },
  );
  assert.equal(presence[0].run_id, "attached");
  assert.equal(presence[0].display_name, "full-tests");
  assert.equal(presence[0].relation, "attached");
  assert.equal(presence[0].elapsed_ms, 125_000);
});

test("Pi status shows attached and reconnecting presence without hiding other work", () => {
  const summary = summarizePiRunsStatus(
    [
      { run_id: "attached", name: "full-tests", status: "running", session_id: "current" },
      { run_id: "other", name: "reconstruct", status: "running", session_id: "other" },
    ],
    "runwatch",
    {},
    "ok",
    {
      session_id: "current",
      attached_run_id: "attached",
      attached_elapsed_ms: 125_000,
      wait_state: "reconnecting",
    },
  );
  assert.equal(summary.text, "Runs ↻ full-tests 2m [attached] · 1 other live");
  assert.equal(summary.tone, "warning");
});

test("retired status backends fail closed", () => {
  assert.throws(
    () => summarizePiRunsStatus([], "legacy", {}, "unknown"),
    /status backend legacy is retired/,
  );
});
