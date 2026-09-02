import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

function piCommand(args) {
  if (process.env.PI_RUNS_REAL_PI_EXECUTABLE) {
    return { executable: process.env.PI_RUNS_REAL_PI_EXECUTABLE, args };
  }
  if (process.platform === "win32") {
    return { executable: "volta.exe", args: ["run", "pi", ...args] };
  }
  return { executable: "pi", args };
}

test("Pi can parse and load the active pi-runs extension", (t) => {
  const extension = resolve("extensions/runs/index.ts");
  const launch = piCommand([
    "--offline",
    "--no-extensions",
    "-e",
    extension,
    "--list-models",
    "___pi_runs_loader_regression_no_match___",
  ]);
  const probe = spawnSync(launch.executable, launch.args, {
    cwd: process.cwd(),
    windowsHide: true,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (probe.error?.code === "ENOENT") {
    t.skip(`Pi executable is unavailable: ${launch.executable}`);
    return;
  }
  assert.equal(
    probe.status,
    0,
    `Pi extension loader failed\nstdout:\n${probe.stdout || ""}\nstderr:\n${probe.stderr || ""}`,
  );
});
