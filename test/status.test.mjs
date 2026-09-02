import test from "node:test";
import assert from "node:assert/strict";
import { summarizePiRunsStatus, summarizeRuns } from "../src/status.mjs";

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

test("legacy pending/submitted states collapse into queued", () => {
  const summary = summarizeRuns(
    [{ status: "submitted" }, { status: "submitting" }, { status: "pending" }],
    "legacy",
  );
  assert.equal(summary.text, "Runs 3 queued · legacy");
  assert.equal(summary.live, 3);
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
    summarizePiRunsStatus([], "legacy", {}, "offline").text,
    "Runs idle · legacy",
  );
  assert.equal(
    summarizePiRunsStatus([], "runwatch", {}, "busy").text,
    "Runs idle · session busy",
  );
});

test("Pi status prioritizes the current research session and compresses unrelated live work", () => {
  const summary = summarizePiRunsStatus(
    [
      { status: "running", session_id: "current" },
      { status: "queued", session_id: "other" },
      { status: "running", session_id: "other" },
      { status: "succeeded", session_id: "other" },
    ],
    "runwatch",
    {},
    "ok",
    { session_id: "current" },
  );
  assert.equal(summary.text, "Runs 1 running · 2 other live");
  assert.equal(summary.scoped_session_id, "current");
  assert.equal(summary.other_live, 2);
  assert.equal(summary.global_attention, 0);
});

test("Pi status never hides failures from another session", () => {
  const summary = summarizePiRunsStatus(
    [
      { status: "queued", session_id: "current" },
      { status: "failed", session_id: "other" },
      { status: "mystery", session_id: "another" },
    ],
    "runwatch",
    {},
    "ok",
    { session_id: "current" },
  );
  assert.equal(summary.text, "Runs 1 queued · 2 global attention");
  assert.equal(summary.tone, "warning");
  assert.equal(summary.global_attention, 2);
});

test("Pi status surfaces current-session probe health without hiding the execution state", () => {
  const summary = summarizePiRunsStatus(
    [
      {
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
  assert.equal(summary.text, "Runs 1 running · 1 probe issue");
  assert.equal(summary.tone, "warning");
  assert.equal(summary.observation_attention, 1);
});

test("Pi status counts another session's live probe failure as global attention", () => {
  const summary = summarizePiRunsStatus(
    [
      { status: "queued", session_id: "current", observation: { health: "fresh" } },
      {
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
  assert.equal(summary.text, "Runs 1 queued · 1 global attention");
  assert.equal(summary.global_attention, 1);
  assert.equal(summary.tone, "warning");
});

test("legacy status stays global because legacy Runs do not have durable Pi binding", () => {
  const summary = summarizePiRunsStatus(
    [
      { status: "running", session_id: "current" },
      { status: "queued", session_id: "other" },
    ],
    "legacy",
    {},
    "unknown",
    { session_id: "current" },
  );
  assert.equal(summary.text, "Runs 1 running · 1 queued · legacy");
  assert.equal(summary.scoped_session_id, undefined);
});
