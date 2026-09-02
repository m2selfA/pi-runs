import test from "node:test";
import assert from "node:assert/strict";
import { buildSubmitSpec } from "../src/runwatch-client.mjs";

test("remote submit spec carries workspace and scheduler resources without pi-ssh-tools dependency", () => {
  const spec = buildSubmitSpec({
    run_id: "pi_call_123",
    name: "refine",
    host: "hpc.example",
    workdir: "/shared/refine",
    runner: "slurm",
    command: "python refine.py",
    time: "04:00:00",
    partition: "gpu",
    cpus: 8,
    mem: "32G",
    gpus: 2,
    _continuation: {
      agent_kind: "pi",
      session_id: "session-1",
      session_file: "C:/sessions/1.jsonl",
      origin_leaf_id: "leaf-1",
      project_root: "C:/science",
      workspace: { host_alias: "hpc.example", cwd: "/shared/refine" },
    },
  });
  assert.deepEqual(spec.workspace, { host_alias: "hpc.example", cwd: "/shared/refine" });
  assert.equal(spec.runner, "slurm");
  assert.equal(spec.resources.partition, "gpu");
  assert.equal(spec.resources.gpus, 2);
  assert.equal(spec.continuation.session_id, "session-1");
  assert.equal(spec.continuation.origin_leaf_id, "leaf-1");
});

test("remote submit spec drops model-generated neutral optional resource defaults", () => {
  const spec = buildSubmitSpec({
    run_id: "pi_call_neutral",
    name: "",
    host: "hpc.example",
    workdir: "/tmp",
    runner: "slurm",
    command: "python3 run.py",
    time: " 00:02:00 ",
    partition: "",
    queue: "  ",
    account: "",
    cpus: 1,
    mem: "",
    gpus: 0,
    wakeup: "auto",
    webhook_url: "",
  });
  assert.equal(spec.name, undefined);
  assert.deepEqual(spec.resources, { time: "00:02:00", cpus: 1 });
});

test("local Process submit spec uses local workspace and no scheduler resources", () => {
  const spec = buildSubmitSpec({
    run_id: "pi_local_1",
    name: "local science",
    workdir: "C:/science/project",
    runner: "process",
    command: "python analysis.py",
    time: "99:00:00",
    gpus: 8,
    _continuation: {
      agent_kind: "pi",
      session_id: "session-local",
      project_root: "C:/science/project",
      workspace: { host_alias: "local", cwd: "C:/science/project" },
    },
  });
  assert.deepEqual(spec.workspace, { host_alias: "local", cwd: "C:/science/project" });
  assert.equal(spec.runner, "process");
  assert.deepEqual(spec.resources, {});
  assert.equal(spec.continuation.session_id, "session-local");
});

test("remote submit spec requires stable identity and explicit scheduler", () => {
  assert.throws(
    () => buildSubmitSpec({ host: "hpc.example", workdir: "/shared/refine", runner: "slurm" }),
    /stable run_id/,
  );
  assert.throws(
    () => buildSubmitSpec({ run_id: "r1", host: "hpc.example", workdir: "/x", runner: "auto" }),
    /requires runner=process for local or runner=slurm\/lsf for remote/,
  );
  assert.throws(
    () => buildSubmitSpec({ run_id: "r2", host: "hpc.example", workdir: "/x", runner: "process" }),
    /local-only/,
  );
});
