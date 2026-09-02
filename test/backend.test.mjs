import test from "node:test";
import assert from "node:assert/strict";
import {
  backendInfo,
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
    /refuses implicit legacy fallback.*runwatchd is unavailable/,
  );
});

test("explicit legacy does not require a daemon probe", async () => {
  assert.equal((await backendInfo("submit_run", env("legacy"))).selected, "legacy");
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
      /refuses implicit legacy fallback.*does not advertise capability cancel_run/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("remote Slurm/LSF submission selects v2 capability only with explicit workspace", () => {
  assert.equal(
    submitCapability({ runner: "slurm", host: "hpc.example", workdir: "/shared/project" }),
    "submit_run_v2",
  );
  assert.equal(submitCapability({ runner: "slurm", workdir: "/shared/project" }), "submit_run");
  assert.equal(
    submitCapability({ runner: "powershell", host: "hpc.example", workdir: "/x" }),
    "submit_run",
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
