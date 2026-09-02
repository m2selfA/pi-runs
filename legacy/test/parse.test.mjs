import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSbatchOutput,
  parseSacctLine,
  parseBsubOutput,
  parseBjobsLine,
  parseBhistExit,
  parsePowershellJobId,
  parseTerminalFile,
  mapSlurmState,
  mapLsfState,
  mapPowershellState,
} from "../src/parse.mjs";
import { canTransition } from "../src/state.mjs";

test("parse sbatch", () => {
  const h = parseSbatchOutput("Submitted batch job 1840293");
  assert.deepEqual(h, { kind: "slurm", jobId: "1840293" });
});

test("parse sacct completed", () => {
  const h = parseSacctLine("1840293|COMPLETED|0:0");
  assert.equal(h.status, "succeeded");
  assert.equal(h.exit_code, 0);
});

test("map slurm timeout", () => {
  assert.equal(mapSlurmState("TIMEOUT"), "timed_out");
  assert.equal(mapSlurmState("OUT_OF_MEMORY"), "failed");
});

test("parse bsub with queue", () => {
  const h = parseBsubOutput("Job <77881> is submitted to queue <normal>.");
  assert.deepEqual(h, { kind: "lsf", jobId: "77881", queue: "normal" });
});

test("parse bjobs RUN", () => {
  const h = parseBjobsLine("77881 user RUN normal *host1");
  assert.equal(h.status, "running");
});

test("parse bhist success", () => {
  const h = parseBhistExit("Job <77881> was submitted from host\nDone successfully.\n");
  assert.equal(h.status, "succeeded");
});

test("parse powershell guid", () => {
  const h = parsePowershellJobId("12\n3f2a1c10-9b44-4d2e-a111-aaaaaaaaaaaa");
  assert.equal(h.kind, "powershell");
  assert.equal(h.instanceId, "3f2a1c10-9b44-4d2e-a111-aaaaaaaaaaaa");
});

test("map powershell states", () => {
  assert.equal(mapPowershellState("Completed"), "succeeded");
  assert.equal(mapPowershellState("Failed"), "failed");
  assert.equal(mapLsfState("PEND"), "pending");
});

test("terminal sidecar", () => {
  assert.deepEqual(parseTerminalFile("succeeded 0\n"), { status: "succeeded", exit_code: 0 });
  assert.deepEqual(parseTerminalFile("failed 137"), { status: "failed", exit_code: 137 });
});

test("state machine", () => {
  assert.equal(canTransition("pending", "running"), true);
  assert.equal(canTransition("succeeded", "running"), false);
  assert.equal(canTransition("running", "timed_out"), true);
});
