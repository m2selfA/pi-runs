import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";

import {
  buildSoakPlan,
  deliverySessionCounts,
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
  assert.equal(plan.restartEvery, 0);
  assert.equal(plan.rebindEvery, 0);
  assert.equal(plan.settlementCrashEvery, 0);
  assert.throws(
    () => buildSoakPlan({ modes: "slurm", rounds: 1, durationSec: 20, host: "hpc.example", workdir: "/shared/workspace" }),
    /duration-sec/,
  );
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
