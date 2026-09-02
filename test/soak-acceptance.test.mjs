import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSoakPlan,
  isDurablySubmittedRun,
  parseModes,
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
  assert.throws(
    () => buildSoakPlan({ modes: "slurm", rounds: 1, durationSec: 20, host: "hpc.example", workdir: "/shared/workspace" }),
    /duration-sec/,
  );
});
