import test from "node:test";
import assert from "node:assert/strict";
import {
  PI_V1_REQUIRED_CAPABILITIES,
  assessPiV1Readiness,
  backendInfo,
  doctorInfo,
  normalizeSubmitRequest,
  requestedBackend,
  submitCapability,
} from "../src/backend.mjs";

function env(value) {
  return {
    ...(value == null ? {} : { PI_RUNS_BACKEND: value }),
    RUNWATCH_ENDPOINT: process.platform === "win32"
      ? "\\\\.\\pipe\\runwatch-test-does-not-exist"
      : `/tmp/runwatch-test-does-not-exist-${process.pid}.sock`,
  };
}

test("backend auto fails closed instead of switching durable authority when daemon is unavailable", async () => {
  await assert.rejects(
    () => backendInfo("get_run", env("auto")),
    /requires the runwatch authority.*runwatchd is unavailable/,
  );
});

test("explicit legacy is retired from the active runtime", async () => {
  await assert.rejects(() => backendInfo("get_run", env("legacy")), /legacy has been retired/);
  const report = await doctorInfo({ env: env("legacy"), timeout_ms: 100 });
  assert.equal(report.ready, false);
  assert.equal(report.selected_backend, null);
  assert.match(report.reasons.join(" "), /legacy is retired/);
});

test("explicit runwatch fails closed while daemon is unavailable", async () => {
  await assert.rejects(
    () => backendInfo("get_run", env("runwatch")),
    /requested but unavailable/,
  );
});

test("auto rejects a capability gap instead of selecting legacy", async () => {
  const { createServer } = await import("node:net");
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\pi-runs-capability-gap-${process.pid}-${Date.now()}`
      : `/tmp/pi-runs-capability-gap-${process.pid}-${Date.now()}.sock`;
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline));
      socket.end(
        `${JSON.stringify({
          id: request.id,
          ok: true,
          result: {
            protocol_version: 1,
            service: "runwatchd",
            storage: "sqlite-wal",
            capabilities: ["hello", "list_runs"],
          },
        })}\n`,
      );
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  try {
    await assert.rejects(
      () => backendInfo("cancel_run", { PI_RUNS_BACKEND: "auto" }, { endpoint }),
      /requires the runwatch authority.*does not advertise capability cancel_run/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Pi v1 readiness requires runwatch authority, identity, and the full capability contract", () => {
  const healthy = {
    available: true,
    transport: "local-ipc",
    endpoint: "test-endpoint",
    protocol_version: 1,
    service: "runwatchd",
    storage: "sqlite-wal",
    capabilities: [...PI_V1_REQUIRED_CAPABILITIES],
  };
  const ready = assessPiV1Readiness(healthy, "auto");
  assert.equal(ready.ready, true);
  assert.equal(ready.selected_backend, "runwatch");
  assert.deepEqual(ready.missing_capabilities, []);
  assert.deepEqual(ready.reasons, []);

  const gap = assessPiV1Readiness(
    { ...healthy, capabilities: healthy.capabilities.filter((cap) => cap !== "offline_pi_continuation") },
    "runwatch",
  );
  assert.equal(gap.ready, false);
  assert.deepEqual(gap.missing_capabilities, ["offline_pi_continuation"]);
  assert.match(gap.reasons.join(" "), /missing Pi v1 capabilities/);

  const impostor = assessPiV1Readiness({ ...healthy, service: "other-service" }, "auto");
  assert.equal(impostor.ready, false);
  assert.equal(impostor.selected_backend, null);
  assert.match(impostor.reasons.join(" "), /unexpected runwatch service identity/);

  const legacy = assessPiV1Readiness(healthy, "legacy");
  assert.equal(legacy.ready, false);
  assert.equal(legacy.selected_backend, null);
  assert.match(legacy.reasons.join(" "), /legacy is retired/);
});

test("doctor reports an unavailable daemon without silently falling back to legacy", async () => {
  const report = await doctorInfo({ env: env("auto"), timeout_ms: 100 });
  assert.equal(report.ready, false);
  assert.equal(report.requested_backend, "auto");
  assert.equal(report.selected_backend, null);
  assert.equal(report.runwatch.available, false);
  assert.match(report.reasons.join(" "), /runwatchd unavailable/);
});

test("remote Slurm/LSF submission selects v2 capability only with explicit workspace", () => {
  assert.equal(
    submitCapability({ runner: "slurm", host: "hpc.example", workdir: "/shared/project" }),
    "submit_run_v2",
  );
  assert.equal(submitCapability({ runner: "slurm", workdir: "/shared/project" }), "submit_run");
  assert.throws(
    () => normalizeSubmitRequest({ command: "x", runner: "powershell" }, "C:/science"),
    /runner=powershell has been retired/,
  );
});

test("local auto submission normalizes to durable Process and selects v2", () => {
  const normalized = normalizeSubmitRequest(
    { command: "python local.py", runner: "auto" },
    "C:/science",
  );
  assert.equal(normalized.runner, "process");
  assert.equal(normalized.host, undefined);
  assert.equal(normalized.workdir, "C:/science");
  assert.equal(submitCapability(normalized), "submit_run_v2");
});

test("remote auto and local-only Process misuse fail before backend selection", () => {
  assert.throws(
    () => normalizeSubmitRequest({ host: "hpc.example", runner: "auto", workdir: "/x" }, "C:/science"),
    /explicit runner=slurm or runner=lsf/,
  );
  assert.throws(
    () => normalizeSubmitRequest({ host: "hpc.example", runner: "process", workdir: "/x" }, "C:/science"),
    /local-only/,
  );
  assert.throws(
    () => normalizeSubmitRequest({ runner: "slurm", workdir: "/x" }, "C:/science"),
    /requires an explicit.*host alias/,
  );
});

test("invalid backend is rejected", () => {
  assert.throws(() => requestedBackend(env("magic")), /invalid PI_RUNS_BACKEND/);
});
