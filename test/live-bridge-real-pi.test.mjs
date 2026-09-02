import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import net from "node:net";

const ENABLED = process.env.PI_RUNS_REAL_LIVE_ACCEPTANCE === "1";

function endpointFor(nonce) {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\pi-runs-live-${process.pid}-${nonce}`
    : join(tmpdir(), `pi-runs-live-${process.pid}-${nonce}.sock`);
}

function piCommand(args) {
  if (process.env.PI_RUNS_REAL_PI_EXECUTABLE) {
    return { executable: process.env.PI_RUNS_REAL_PI_EXECUTABLE, args };
  }
  if (process.platform === "win32") {
    return { executable: "volta.exe", args: ["run", "pi", ...args] };
  }
  return { executable: "pi", args };
}

function terminateTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Best effort test cleanup.
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test(
  "real Pi live bridge claims a branch-matched terminal Delivery, injects completion, and acks delivered",
  { skip: !ENABLED, timeout: 30_000 },
  async () => {
    const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const endpoint = endpointFor(nonce);
    const sessionDir = resolve("acceptance-output", `live-bridge-${nonce}`, "pi-sessions");
    await mkdir(sessionDir, { recursive: true });
    const extension = resolve("extensions/runs/index.ts");
    const state = {
      registration: undefined,
      claimed: false,
      ack: undefined,
      releaseSeen: false,
      requests: [],
    };

    const server = net.createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const request = JSON.parse(buffer.slice(0, newline));
        state.requests.push(request.op);
        const ok = (result = {}) =>
          socket.end(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
        switch (request.op) {
          case "hello":
            ok({
              protocol_version: 1,
              service: "runwatchd",
              storage: "sqlite-wal",
              capabilities: [
                "hello",
                "list_runs",
                "get_run",
                "logs",
                "artifacts",
                "wait_run",
                "cancel_run",
                "register_agent_session",
                "release_agent_session",
                "claim_deliveries",
                "delivery_status",
                "ack_delivery",
                "rebind_continuation",
                "offline_pi_continuation",
              ],
            });
            break;
          case "register_agent_session":
            state.registration = request.registration;
            ok({ registered: true });
            break;
          case "claim_deliveries": {
            const registration = state.registration;
            if (!registration || state.claimed) {
              ok({ deliveries: [] });
              break;
            }
            state.claimed = true;
            const workspace = { host_alias: "hpc.example", cwd: "/tmp" };
            ok({
              deliveries: [
                {
                  delivery_id: "live-bridge-smoke:a1:terminal",
                  run_id: "live-bridge-smoke",
                  attempt_no: 1,
                  payload: {
                    delivery_id: "live-bridge-smoke:a1:terminal",
                    run_id: "live-bridge-smoke",
                    attempt_no: 1,
                    status: "succeeded",
                    job_id: "live-smoke-1",
                    workspace,
                    binding: {
                      agent_kind: "pi",
                      session_id: registration.session_id,
                      session_file: registration.session_file,
                      origin_leaf_id: registration.current_leaf_id,
                      project_root: registration.project_root,
                      workspace,
                      adapter_path: extension,
                    },
                  },
                },
              ],
            });
            break;
          }
          case "ack_delivery":
            state.ack = request;
            ok({ acked: true });
            break;
          case "delivery_status":
            ok({ status: { pending: 0, delivering: 0, retrying: 0, needs_rebind: 0 } });
            break;
          case "release_agent_session":
            state.releaseSeen = true;
            ok({ released: true });
            break;
          case "list_runs":
            ok({ runs: [] });
            break;
          case "get_run":
            ok({ run: { run_id: "live-bridge-smoke", status: "succeeded", workspace: { host_alias: "hpc.example", cwd: "/tmp" } } });
            break;
          case "logs":
            ok({ logs: { run_id: "live-bridge-smoke", status: "succeeded", stdout: "synthetic live bridge acceptance", stderr: "" } });
            break;
          case "artifacts":
            ok({ artifacts: { run_id: "live-bridge-smoke", status: "succeeded", artifacts: [] } });
            break;
          default:
            socket.end(`${JSON.stringify({ id: request.id, ok: false, error: `unsupported fake op ${request.op}` })}\n`);
        }
      });
    });

    await new Promise((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(endpoint, resolvePromise);
    });

    const args = [
      "--offline",
      "--no-extensions",
      "-e",
      extension,
      "--mode",
      "rpc",
      "--session-dir",
      sessionDir,
      "--provider",
      "openai",
      "--model",
      "gpt-4o-mini",
      "--api-key",
      "runwatch-live-acceptance-invalid-key",
      "--no-builtin-tools",
    ];
    const launch = piCommand(args);
    const child = spawn(launch.executable, launch.args, {
      cwd: process.cwd(),
      env: { ...process.env, RUNWATCH_ENDPOINT: endpoint, PI_RUNS_BACKEND: "auto" },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    try {
      await waitFor(() => state.ack, 15_000, "live Delivery ack");
      assert.equal(state.ack.outcome, "delivered");
      assert.equal(state.ack.delivery_id, "live-bridge-smoke:a1:terminal");
      assert.ok(state.registration?.session_id, "Pi should register its real session id");
      assert.ok(state.registration?.session_file, "Pi should register its real session file");

      await waitFor(
        () => stdout.includes('"type":"agent_start"') || stdout.includes('"type": "agent_start"'),
        5_000,
        "triggered Pi agent_start",
      );

      const sessionFile = state.registration.session_file;
      await waitFor(async () => {
        try {
          const text = await readFile(sessionFile, "utf8");
          return text.includes('"customType":"runwatch/completion"') &&
            text.includes("live-bridge-smoke:a1:terminal");
        } catch {
          return false;
        }
      }, 5_000, "persisted live completion message");
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nPi stdout:\n${stdout}\nPi stderr:\n${stderr}\nrequests=${JSON.stringify(state.requests)}`,
      );
    } finally {
      child.stdin.end();
      await Promise.race([
        new Promise((resolvePromise) => child.once("exit", resolvePromise)),
        new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000)),
      ]);
      terminateTree(child);
      await new Promise((resolvePromise) => server.close(resolvePromise));
      // Preserve the unique ignored acceptance-output directory for post-run evidence.
      // Repository acceptance paths never recursively delete user-visible evidence.
    }
  },
);
