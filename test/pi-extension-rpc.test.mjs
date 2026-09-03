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

function jsonLines(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("real Pi RPC exposes /runs and executes detach without a provider turn", (t) => {
  const extension = resolve("extensions/runs/index.ts");
  const launch = piCommand([
    "--offline",
    "--no-extensions",
    "-e",
    extension,
    "--mode",
    "rpc",
    "--no-session",
    "--no-builtin-tools",
  ]);
  const input = [
    JSON.stringify({ id: "commands", type: "get_commands" }),
    JSON.stringify({ id: "detach", type: "prompt", message: "/runs detach" }),
    "",
  ].join("\n");
  const probe = spawnSync(launch.executable, launch.args, {
    cwd: process.cwd(),
    windowsHide: true,
    encoding: "utf8",
    input,
    timeout: 30_000,
  });
  if (probe.error?.code === "ENOENT") {
    t.skip(`Pi executable is unavailable: ${launch.executable}`);
    return;
  }
  assert.equal(
    probe.status,
    0,
    `Pi RPC command smoke failed\nstdout:\n${probe.stdout || ""}\nstderr:\n${probe.stderr || ""}`,
  );
  const messages = jsonLines(probe.stdout);
  const commandResponse = messages.find(
    (message) => message?.type === "response" && message?.command === "get_commands",
  );
  assert.ok(commandResponse?.success, "get_commands should succeed");
  const runsCommand = commandResponse.data?.commands?.find((command) => command?.name === "runs");
  assert.equal(runsCommand?.source, "extension");

  const detachResponse = messages.find(
    (message) => message?.type === "response" && message?.id === "detach" && message?.command === "prompt",
  );
  assert.equal(detachResponse?.success, true);
  assert.equal(
    messages.some(
      (message) =>
        message?.type === "extension_ui_request" &&
        message?.method === "notify" &&
        /No foreground Run watcher is attached/.test(String(message?.message || message?.text || "")),
    ),
    true,
    `expected /runs detach informational notify; messages=${JSON.stringify(messages.filter((message) => message?.type === "extension_ui_request"))}`,
  );
  assert.equal(
    messages.some(
      (message) => message?.type === "extension_ui_request" && message?.method === "setStatus" && message?.statusKey === "pi-runs",
    ),
    true,
  );
  assert.equal(
    messages.some(
      (message) => message?.type === "extension_ui_request" && message?.method === "setWidget" && message?.widgetKey === "pi-runs-presence",
    ),
    true,
  );
});
