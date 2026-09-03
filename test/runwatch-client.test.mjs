import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { buildSubmitSpec, normalizeWaitOptions, waitRun } from "../src/runwatch-client.mjs";

function testEndpoint(label) {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\pi-runs-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    : `/tmp/pi-runs-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`;
}

async function withTestServer(label, handler, body) {
  const endpoint = testEndpoint(label);
  const requests = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline));
      requests.push(request);
      handler(request, socket);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  try {
    await body(endpoint, requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

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


test("foreground wait has no user-level deadline when timeout_ms is omitted", () => {
  assert.equal(normalizeWaitOptions({}).timeoutMs, null);
  assert.equal(normalizeWaitOptions({ timeout_ms: 0 }).timeoutMs, 0);
});

test("foreground wait returns terminal state with explicit condition metadata", async () => {
  await withTestServer(
    "wait-terminal",
    (request, socket) => {
      assert.equal(request.op, "wait_run");
      socket.end(`${JSON.stringify({ id: request.id, ok: true, result: { run: { run_id: "r-terminal", status: "succeeded", runner: "process" } } })}\n`);
    },
    async (endpoint, requests) => {
      const updates = [];
      const run = await waitRun("r-terminal", {
        endpoint,
        timeout_ms: 10_000,
        until: "terminal",
        on_update: (update) => updates.push(update),
      });
      assert.equal(run.status, "succeeded");
      assert.equal(run.wait_observation.outcome, "condition_met");
      assert.equal(run.wait_observation.until, "terminal");
      assert.equal(updates.length, 1);
      assert.equal(updates[0].condition_met, true);
      assert.deepEqual(requests.map((request) => request.op), ["wait_run"]);
    },
  );
});

test("foreground wait can observe running with periodic updates and terminal also satisfies running", async () => {
  let calls = 0;
  await withTestServer(
    "wait-running",
    (request, socket) => {
      calls += 1;
      const status = calls < 3 ? "queued" : "running";
      setTimeout(() => {
        socket.end(`${JSON.stringify({ id: request.id, ok: true, result: { run: { run_id: "r-running", status, runner: "slurm", job_id: "42" } } })}\n`);
      }, 10);
    },
    async (endpoint, requests) => {
      const updates = [];
      const run = await waitRun("r-running", {
        endpoint,
        timeout_ms: 5_000,
        interval_ms: 1_000,
        until: "running",
        on_update: (update) => updates.push(update),
      });
      assert.equal(run.status, "running");
      assert.equal(run.wait_observation.outcome, "condition_met");
      assert.equal(updates.length, 3);
      assert.equal(updates.at(-1).condition_met, true);
      assert.equal(requests.some((request) => request.op === "cancel_run"), false);
    },
  );
});

test("unbounded foreground wait keeps observing until terminal", async () => {
  let calls = 0;
  await withTestServer(
    "wait-unbounded",
    (request, socket) => {
      calls += 1;
      const status = calls < 3 ? "running" : "succeeded";
      socket.end(`${JSON.stringify({ id: request.id, ok: true, result: { run: { run_id: "r-unbounded", status, runner: "process" } } })}\n`);
    },
    async (endpoint, requests) => {
      const run = await waitRun("r-unbounded", { endpoint, interval_ms: 1_000 });
      assert.equal(run.status, "succeeded");
      assert.equal(run.wait_observation.timeout_ms, null);
      assert.equal(run.wait_observation.outcome, "condition_met");
      assert.equal(requests.filter((request) => request.op === "wait_run").length, 3);
    },
  );
});

test("foreground wait reconnects after transient transport loss without cancelling the Run", async () => {
  let calls = 0;
  await withTestServer(
    "wait-reconnect",
    (request, socket) => {
      calls += 1;
      if (calls === 1) {
        socket.end(`${JSON.stringify({ id: request.id, ok: true, result: { run: { run_id: "r-reconnect", status: "running", runner: "slurm", job_id: "77" } } })}\n`);
        return;
      }
      if (calls === 2) {
        socket.destroy();
        return;
      }
      socket.end(`${JSON.stringify({ id: request.id, ok: true, result: { run: { run_id: "r-reconnect", status: "succeeded", runner: "slurm", job_id: "77" } } })}\n`);
    },
    async (endpoint, requests) => {
      const updates = [];
      const run = await waitRun("r-reconnect", {
        endpoint,
        interval_ms: 1_000,
        on_update: (update) => updates.push(update),
      });
      assert.equal(run.status, "succeeded");
      assert.equal(run.wait_observation.reconnects, 1);
      assert.equal(updates.some((update) => update.state === "reconnecting"), true);
      assert.equal(updates.at(-1).state, "observing");
      assert.equal(requests.some((request) => request.op === "cancel_run"), false);
    },
  );
});

test("foreground wait does not retry semantic daemon errors", async () => {
  await withTestServer(
    "wait-semantic-error",
    (request, socket) => {
      socket.end(`${JSON.stringify({ id: request.id, ok: false, error: "unknown run missing-run" })}\n`);
    },
    async (endpoint, requests) => {
      await assert.rejects(() => waitRun("missing-run", { endpoint }), /unknown run missing-run/);
      assert.deepEqual(requests.map((request) => request.op), ["wait_run"]);
    },
  );
});

test("foreground wait timeout detaches watcher without cancelling the durable Run", async () => {
  await withTestServer(
    "wait-timeout",
    (request, socket) => {
      socket.end(`${JSON.stringify({ id: request.id, ok: true, result: { run: { run_id: "r-timeout", status: "queued", runner: "slurm", job_id: "43" } } })}\n`);
    },
    async (endpoint, requests) => {
      const run = await waitRun("r-timeout", { endpoint, timeout_ms: 0, until: "terminal" });
      assert.equal(run.status, "queued");
      assert.equal(run.wait_observation.outcome, "timeout");
      assert.deepEqual(requests.map((request) => request.op), ["wait_run"]);
    },
  );
});

test("finite sub-second wait respects the user observation budget without a tight poll loop", async () => {
  await withTestServer(
    "wait-finite-budget",
    (request, socket) => {
      assert.equal(request.timeout_sec, 0);
      socket.end(`${JSON.stringify({ id: request.id, ok: true, result: { run: { run_id: "r-budget", status: "queued", runner: "process" } } })}\n`);
    },
    async (endpoint, requests) => {
      const started = Date.now();
      const run = await waitRun("r-budget", { endpoint, timeout_ms: 150, until: "terminal" });
      const elapsed = Date.now() - started;
      assert.equal(run.wait_observation.outcome, "timeout");
      assert.ok(elapsed >= 100, `finite wait returned too early: ${elapsed}ms`);
      assert.ok(elapsed < 600, `finite wait substantially exceeded its budget: ${elapsed}ms`);
      assert.ok(requests.length <= 3, `finite wait polled too tightly: ${requests.length} requests`);
      assert.equal(requests.some((request) => request.op === "cancel_run"), false);
    },
  );
});

test("foreground wait abort closes only the watcher IPC and never sends cancel_run", async () => {
  await withTestServer(
    "wait-abort",
    (_request, _socket) => {
      // Intentionally leave the wait request open until AbortSignal destroys the client socket.
    },
    async (endpoint, requests) => {
      const controller = new AbortController();
      const pending = waitRun("r-abort", {
        endpoint,
        interval_ms: 5_000,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 20);
      await assert.rejects(pending, /runwatch IPC request aborted/);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(requests.map((request) => request.op), ["wait_run"]);
      assert.equal(requests.some((request) => request.op === "cancel_run"), false);
    },
  );
});
