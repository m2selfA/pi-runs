import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";

import {
  aggregateEnduranceProgress,
  assertEnduranceContract,
  assertResumableEnduranceState,
  buildSoakPlan,
  deliverySessionCounts,
  evaluateV1EnduranceQualification,
  isDurablySubmittedRun,
  parseModes,
  piApiModuleForShimPath,
} from "../scripts/acceptance/pi_v1_soak.mjs";

test("soak modes are deduplicated and reject unknown execution shapes", () => {
  assert.deepEqual(parseModes("slurm,local-process,slurm"), ["slurm", "local-process"]);
  assert.throws(() => parseModes("slurm,ssh"), /unsupported soak mode/);
});

test("fault injection waits for a durable execution handle rather than a submitting row", () => {
  assert.equal(isDurablySubmittedRun({ status: "submitting", job_id: null }), false);
  assert.equal(isDurablySubmittedRun({ status: "submitting", job_id: "31751" }), false);
  assert.equal(isDurablySubmittedRun({ status: "queued", job_id: null }), false);
  assert.equal(isDurablySubmittedRun({ status: "queued", job_id: "31751" }), true);
  assert.equal(isDurablySubmittedRun({ status: "running", job_id: "local:<handle>:abcd" }), true);
});

test("soak plan requires a shared absolute Slurm workspace", () => {
  assert.throws(
    () => buildSoakPlan({ modes: "slurm", rounds: 1, host: "hpc.example", workdir: "tmp" }),
    /absolute shared persistent/,
  );
  const plan = buildSoakPlan({
    modes: "slurm",
    rounds: 2,
    host: "hpc.example",
    workdir: "/shared/workspace",
    runDelaySec: 30,
    restartEvery: 1,
    timeoutSec: 900,
  });
  assert.deepEqual(plan.modes, ["slurm"]);
  assert.equal(plan.rounds, 2);
  assert.equal(plan.runDelaySec, 30);
  assert.equal(plan.seedTimeoutSec, 180);
  assert.equal(plan.restartEvery, 1);
  assert.equal(plan.rebindEvery, 0);
  assert.equal(plan.settlementCrashEvery, 0);
  assert.equal(plan.sshFaultEvery, 0);
  assert.equal(plan.sshFaultSec, 8);
  assert.equal(plan.timeoutSec, 900);
});

test("duration mode is bounded and restart injection can be disabled", () => {
  const plan = buildSoakPlan({
    modes: process.platform === "win32" ? "local-process" : "slurm",
    rounds: 1,
    durationSec: 7200,
    host: "hpc.example",
    workdir: "/shared/workspace",
    restartEvery: 0,
  });
  assert.equal(plan.durationSec, 7200);
  assert.equal(plan.targetDurationSec, undefined);
  assert.equal(plan.restartEvery, 0);
  assert.equal(plan.rebindEvery, 0);
  assert.equal(plan.settlementCrashEvery, 0);
  assert.throws(
    () => buildSoakPlan({ modes: "slurm", rounds: 1, durationSec: 20, host: "hpc.example", workdir: "/shared/workspace" }),
    /duration-sec/,
  );
});

test("endurance target is bounded independently from per-segment duration", () => {
  const plan = buildSoakPlan({
    modes: process.platform === "win32" ? "local-process" : "slurm",
    rounds: 1,
    durationSec: 120,
    targetDurationSec: 7200,
    restartEvery: 0,
    host: "hpc.example",
    workdir: "/shared/workspace",
  });
  assert.equal(plan.durationSec, 120);
  assert.equal(plan.targetDurationSec, 7200);
  assert.equal(plan.seedTimeoutSec, 180);
  assert.throws(
    () => buildSoakPlan({ modes: "slurm", rounds: 1, targetDurationSec: 30, host: "hpc.example", workdir: "/shared/workspace" }),
    /target-duration-sec/,
  );
});

test("formal fault endurance requires scientific delay to outlive the bounded seed turn", () => {
  const modes = process.platform === "win32" ? "local-process,slurm" : "slurm";
  assert.throws(
    () => buildSoakPlan({
      modes,
      rounds: 1,
      targetDurationSec: 7200,
      runDelaySec: 60,
      seedTimeoutSec: 480,
      restartEvery: 1,
      host: "hpc.example",
      workdir: "/shared/workspace",
      timeoutSec: 1200,
    }),
    /run-delay-sec.*seed-timeout-sec|formal endurance/i,
  );
  const plan = buildSoakPlan({
    modes,
    rounds: 1,
    targetDurationSec: 7200,
    runDelaySec: 600,
    seedTimeoutSec: 480,
    restartEvery: 1,
    host: "hpc.example",
    workdir: "/shared/workspace",
    timeoutSec: 1200,
  });
  assert.equal(plan.runDelaySec, 600);
  assert.equal(plan.seedTimeoutSec, 480);
  assert.throws(
    () => buildSoakPlan({
      modes: "slurm",
      rounds: 1,
      targetDurationSec: 7200,
      runDelaySec: 600,
      seedTimeoutSec: 541,
      restartEvery: 1,
      host: "hpc.example",
      workdir: "/shared/workspace",
      timeoutSec: 1200,
    }),
    /seed-timeout-sec/,
  );
});

test("resumable endurance progress accumulates immutable successful segments", () => {
  const progress = aggregateEnduranceProgress([
    { segment: 2, elapsed_sec: 61.25, rounds_completed: 2, total_cases: 4, round_end: 4 },
    { segment: 1, elapsed_sec: 60.5, rounds_completed: 2, total_cases: 4, round_end: 2 },
  ]);
  assert.deepEqual(progress, {
    segments_completed: 2,
    rounds_completed: 4,
    total_cases: 8,
    active_elapsed_sec: 121.75,
    last_round: 4,
  });
});

test("resume contract rejects a changed package/model/fault contract", () => {
  const frozen = {
    model: "provider/model",
    plan: { restart_every: 1 },
    artifacts: { runwatch_sha256: "abc" },
  };
  assert.doesNotThrow(() => assertEnduranceContract(frozen, structuredClone(frozen)));
  assert.throws(
    () => assertEnduranceContract(frozen, { ...structuredClone(frozen), model: "provider/other" }),
    /resume invocation|frozen endurance contract/i,
  );
});

test("v1 endurance qualification requires multi-hour mixed repeated fault coverage", () => {
  const segmentSummaries = [1, 2].map((segment) => ({
    segment,
    elapsed_sec: 3600,
    rounds_completed: 1,
    total_cases: 2,
    round_end: segment,
    rounds: [
      {
        round: segment,
        restart: { old_pid: segment, new_pid: segment + 10 },
        ssh_fault: { recovered: true },
        cases: [
          { mode: "local-process", rebind_fault: { rebound: true }, settlement_crash_fault: null },
          { mode: "slurm", rebind_fault: null, settlement_crash_fault: { recovered: true } },
        ],
      },
    ],
  }));
  const progress = aggregateEnduranceProgress(segmentSummaries);
  const qualified = evaluateV1EnduranceQualification({
    targetDurationSec: 7200,
    progress,
    segmentSummaries,
    dirtySegments: [],
  });
  assert.equal(qualified.qualified, true);
  assert.deepEqual(qualified.reasons, []);
  assert.equal(qualified.coverage.serve_restarts, 2);
  assert.equal(qualified.coverage.ssh_loss_recoveries, 2);
  assert.equal(qualified.coverage.rebind_recoveries, 2);
  assert.equal(qualified.coverage.settlement_crash_recoveries, 2);

  const tooShort = evaluateV1EnduranceQualification({
    targetDurationSec: 600,
    progress,
    segmentSummaries,
    dirtySegments: [],
  });
  assert.equal(tooShort.qualified, false);
  assert.ok(tooShort.reasons.includes("target_duration_at_least_7200"));

  const dirty = evaluateV1EnduranceQualification({
    targetDurationSec: 7200,
    progress,
    segmentSummaries,
    dirtySegments: ["failed:3"],
  });
  assert.equal(dirty.qualified, false);
  assert.ok(dirty.reasons.includes("no_dirty_segments"));
});

test("resumable endurance fails closed on failed, incomplete, ambiguous, or missing prior segments", () => {
  const clean = {
    failed_segments: [],
    incomplete_segments: [],
    ambiguous_segments: [],
    missing_segments: [],
  };
  assert.doesNotThrow(() => assertResumableEnduranceState(clean));
  for (const [field, values] of [
    ["failed_segments", [1]],
    ["incomplete_segments", [2]],
    ["ambiguous_segments", [3]],
    ["missing_segments", [4]],
  ]) {
    assert.throws(
      () => assertResumableEnduranceState({ ...clean, [field]: values }),
      /not resumable|prior segment|new endurance session/i,
    );
  }
});

test("fault cadence is bounded and can schedule rebind plus settlement crash", () => {
  const plan = buildSoakPlan({
    modes: process.platform === "win32" ? "local-process" : "slurm",
    rounds: 10,
    host: "hpc.example",
    workdir: "/shared/workspace",
    rebindEvery: 3,
    settlementCrashEvery: 5,
  });
  assert.equal(plan.rebindEvery, 3);
  assert.equal(plan.settlementCrashEvery, 5);
  assert.equal(plan.sshFaultEvery, 0);
  assert.throws(
    () => buildSoakPlan({ modes: "slurm", rounds: 1, host: "hpc.example", workdir: "/shared/workspace", rebindEvery: -1 }),
    /rebind-every/,
  );
  assert.throws(
    () => buildSoakPlan({ modes: "slurm", rounds: 1, host: "hpc.example", workdir: "/shared/workspace", settlementCrashEvery: 1001 }),
    /settlement-crash-every/,
  );
});

test("SSH fault cadence requires Slurm and bounds the outage hold", () => {
  assert.throws(
    () => buildSoakPlan({ modes: "local-process", rounds: 1, sshFaultEvery: 1 }),
    /requires slurm mode/,
  );
  const plan = buildSoakPlan({
    modes: "slurm",
    rounds: 4,
    host: "hpc.example",
    workdir: "/shared/workspace",
    sshFaultEvery: 2,
    sshFaultSec: 9,
  });
  assert.equal(plan.sshFaultEvery, 2);
  assert.equal(plan.sshFaultSec, 9);
  assert.throws(
    () => buildSoakPlan({ modes: "slurm", rounds: 1, host: "hpc.example", workdir: "/shared/workspace", sshFaultSec: 121 }),
    /ssh-fault-sec/,
  );
});

test("Pi API module path is derived beside the executable shim", () => {
  const shim = resolve("fake-volta-image", "packages", "pi-coding-agent", "pi");
  assert.equal(
    piApiModuleForShimPath(shim),
    join(dirname(shim), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"),
  );
});

test("session evidence counts one completion and one delivered settlement for the exact Delivery", () => {
  const deliveryId = "r1:a1:terminal";
  const rows = [
    { type: "custom_message", customType: "runwatch/completion", details: { delivery_ids: [deliveryId] } },
    { type: "custom_message", customType: "runwatch/completion", details: { delivery_ids: ["other:a1:terminal"] } },
    { type: "custom", customType: "runwatch/completion-settled", data: { delivery_id: deliveryId, outcome: "delivered" } },
    { type: "custom", customType: "runwatch/completion-settled", data: { delivery_id: deliveryId, outcome: "retry" } },
  ];
  assert.deepEqual(deliverySessionCounts(rows, deliveryId), { completion: 1, settlement: 1 });
});
