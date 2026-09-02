import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  backendInfo,
  normalizeSubmitRequest,
  submitCapability,
  submitRun,
  waitRun,
  statusRun,
  statusOverview,
  logsRun,
  cancelRun,
  harvestRun,
  rebindRun,
} from "../../src/backend.mjs";
import { summarizePiRunsStatus } from "../../src/status.mjs";
import {
  ackDelivery,
  claimDeliveries,
  deliveryStatus,
  registerAgentSession,
  releaseAgentSession,
  verifyOfflineInvocation,
} from "../../src/runwatch-client.mjs";
import {
  COMPLETION_SETTLED_ENTRY_TYPE,
  classifyFinalAgentOutcome,
  formatCompletionMessage,
  formatCompletionRecoveryMessage,
  inspectOfflineDeliverySession,
  originIsOnCurrentBranch,
} from "../../src/continuation.mjs";

const STATUS_KEY = "pi-runs";
const STATUS_REFRESH_MS = 10_000;
const ADAPTER_PATH = fileURLToPath(import.meta.url);

function offlineBootstrapPayload() {
  const encoded = process.env.RUNWATCH_OFFLINE_DELIVERY_B64;
  if (!encoded) return undefined;
  try {
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch (err) {
    throw new Error(`pi-runs: invalid RUNWATCH_OFFLINE_DELIVERY_B64: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function jsonResult(data: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

export default function (pi: ExtensionAPI) {
  const offlineDelivery = offlineBootstrapPayload();
  const ownerInstanceId = process.env.RUNWATCH_OFFLINE_OWNER_INSTANCE_ID || randomUUID();
  let statusTimer: ReturnType<typeof setInterval> | undefined;
  let statusRefreshInFlight = false;
  let bridgeRefreshInFlight = false;
  let activeRegistration: ReturnType<typeof sessionRegistration> | undefined;
  let bridgeState: "unknown" | "ok" | "busy" | "offline" = "unknown";
  let bridgeDeliveries = { pending: 0, delivering: 0, retrying: 0, needs_rebind: 0 };
  let offlineBootstrapSent = false;
  let offlineAgentStarted = false;
  let offlineSettledPendingAck = false;
  let offlineAgentOutcome: { ok: boolean; error?: string } | undefined;
  let offlineDeliveryFinished = false;

  const refreshStatus = async (ctx: ExtensionContext) => {
    if (!ctx.hasUI || statusRefreshInFlight) return;
    statusRefreshInFlight = true;
    try {
      const overview = await statusOverview({ timeout_ms: 650 });
      const summary = summarizePiRunsStatus(
        overview.runs,
        overview.backend,
        bridgeDeliveries,
        bridgeState,
        { session_id: ctx.sessionManager.getSessionId() },
      );
      ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(summary.tone, summary.text));
    } catch {
      ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", "Runs unavailable"));
    } finally {
      statusRefreshInFlight = false;
    }
  };

  function sessionRegistration(ctx: ExtensionContext) {
    return {
      agent_kind: "pi",
      session_id: ctx.sessionManager.getSessionId(),
      owner_instance_id: ownerInstanceId,
      session_file: ctx.sessionManager.getSessionFile(),
      project_root: ctx.sessionManager.getCwd(),
      current_leaf_id: ctx.sessionManager.getLeafId(),
    };
  }

  const deliveryFitsCurrentBranch = (
    delivery: any,
    registration: ReturnType<typeof sessionRegistration>,
    ctx: ExtensionContext,
  ) => {
    const binding = delivery?.payload?.binding;
    if (!binding || binding.session_id !== registration.session_id) return false;
    if (binding.session_file && binding.session_file !== registration.session_file) return false;
    return originIsOnCurrentBranch(binding, ctx.sessionManager.getBranch());
  };

  const finishOfflineSettled = async (ctx: ExtensionContext) => {
    if (!offlineDelivery || !offlineSettledPendingAck || offlineDeliveryFinished) return;
    const registration = sessionRegistration(ctx);
    const outcome =
      offlineAgentOutcome ||
      ({ ok: false, error: "offline Pi settled without a final successful agent_end" } as const);
    try {
      if (outcome.ok) {
        const evidence = inspectOfflineDeliverySession(
          ctx.sessionManager.getBranch(),
          offlineDelivery.delivery_id,
        );
        if (evidence.state !== "settled") {
          pi.appendEntry(COMPLETION_SETTLED_ENTRY_TYPE, {
            schema_version: 1,
            delivery_id: offlineDelivery.delivery_id,
            run_id: offlineDelivery.run_id,
            attempt_no: offlineDelivery.attempt_no,
            outcome: "delivered",
            settled_at: new Date().toISOString(),
            settled_leaf_id: ctx.sessionManager.getLeafId(),
            offline_invocation_id: process.env.RUNWATCH_OFFLINE_INVOCATION_ID,
          });
        }
      }
      await ackDelivery(
        registration,
        offlineDelivery.delivery_id,
        outcome.ok ? "delivered" : "retry",
        outcome.ok ? undefined : outcome.error,
        { timeout_ms: 1_200 },
      );
      offlineDeliveryFinished = true;
      offlineSettledPendingAck = false;
      await ctx.shutdown();
    } catch {
      bridgeState = "offline";
      // Keep the RPC worker alive. The session loop will retry once runwatch IPC returns.
    }
  };

  const syncLiveBridge = async (ctx: ExtensionContext) => {
    if (bridgeRefreshInFlight) return;
    bridgeRefreshInFlight = true;
    const registration = sessionRegistration(ctx);
    try {
      await registerAgentSession(registration, { timeout_ms: 900 });
      activeRegistration = registration;
      bridgeState = "ok";

      if (offlineDelivery) {
        const delivery = {
          delivery_id: offlineDelivery.delivery_id,
          payload: offlineDelivery,
        };
        const invocationId = process.env.RUNWATCH_OFFLINE_INVOCATION_ID;
        const stillOwned = invocationId
          ? await verifyOfflineInvocation(
              invocationId,
              offlineDelivery.delivery_id,
              ownerInstanceId,
              { timeout_ms: 900 },
            )
          : false;
        if (!stillOwned) {
          // A daemon restart may have reconciled this invocation after its lease expired. A late
          // orphan must never inject the old completion after the Delivery has been requeued or
          // reassigned to another exact-session worker.
          offlineDeliveryFinished = true;
          await ctx.shutdown();
          return;
        }
        if (!offlineBootstrapSent && !offlineDeliveryFinished) {
          if (!ctx.isProjectTrusted()) {
            await ackDelivery(
              registration,
              offlineDelivery.delivery_id,
              "needs_rebind",
              "offline continuation blocked because the Pi project is not trusted; open it interactively, resolve trust, then runs_rebind this Run",
              { timeout_ms: 1_200 },
            );
            offlineDeliveryFinished = true;
            await ctx.shutdown();
            return;
          }
          if (!deliveryFitsCurrentBranch(delivery, registration, ctx)) {
            await ackDelivery(
              registration,
              offlineDelivery.delivery_id,
              "needs_rebind",
              "offline continuation target session file/origin leaf does not match the resumed Pi branch",
              { timeout_ms: 1_200 },
            );
            offlineDeliveryFinished = true;
            await ctx.shutdown();
            return;
          }
          const sessionEvidence = inspectOfflineDeliverySession(
            ctx.sessionManager.getBranch(),
            offlineDelivery.delivery_id,
          );
          if (
            sessionEvidence.state === "settled" ||
            sessionEvidence.state === "completed_success"
          ) {
            offlineAgentOutcome = { ok: true };
            offlineSettledPendingAck = true;
            await finishOfflineSettled(ctx);
            return;
          }
          const recoveringExistingCompletion =
            sessionEvidence.state === "injected_unsettled" ||
            sessionEvidence.state === "completed_failure";
          // Pi may synchronously emit agent_start from triggerTurn before sendMessage returns.
          // Arm the lifecycle gate first so agent_start/agent_end/agent_settled belong to this
          // exact offline Delivery instead of leaving it stuck in delivering forever.
          offlineBootstrapSent = true;
          try {
            await Promise.resolve(
              pi.sendMessage(
                {
                  customType: recoveringExistingCompletion
                    ? "runwatch/completion-recovery"
                    : "runwatch/completion",
                  content: recoveringExistingCompletion
                    ? formatCompletionRecoveryMessage(delivery)
                    : formatCompletionMessage([delivery]),
                  display: true,
                  details: {
                    delivery_ids: [offlineDelivery.delivery_id],
                    runs: [offlineDelivery],
                    recovery: recoveringExistingCompletion,
                    offline_invocation_id: process.env.RUNWATCH_OFFLINE_INVOCATION_ID,
                  },
                },
                { triggerTurn: true, deliverAs: "followUp" },
              ),
            );
          } catch (err) {
            offlineBootstrapSent = false;
            const message = err instanceof Error ? err.message : String(err);
            await ackDelivery(
              registration,
              offlineDelivery.delivery_id,
              "retry",
              `offline Pi could not inject completion: ${message}`,
              { timeout_ms: 1_200 },
            );
            offlineDeliveryFinished = true;
            await ctx.shutdown();
            return;
          }
        }
        if (offlineSettledPendingAck) {
          await finishOfflineSettled(ctx);
        }
        if (!offlineDeliveryFinished) {
          bridgeDeliveries = await deliveryStatus(registration, { timeout_ms: 900 });
        }
        return;
      }

      const claimed = await claimDeliveries(registration, { timeout_ms: 1_200, limit: 8 });
      const deliverable = [];
      for (const delivery of claimed) {
        if (deliveryFitsCurrentBranch(delivery, registration, ctx)) {
          deliverable.push(delivery);
        } else {
          await ackDelivery(
            registration,
            delivery.delivery_id,
            "needs_rebind",
            "Run origin leaf/session file is not on the current Pi branch",
            { timeout_ms: 900 },
          );
        }
      }

      if (deliverable.length) {
        const content = formatCompletionMessage(deliverable);
        try {
          await Promise.resolve(
            pi.sendMessage(
              {
                customType: "runwatch/completion",
                content,
                display: true,
                details: {
                  delivery_ids: deliverable.map((item: any) => item.delivery_id),
                  runs: deliverable.map((item: any) => item.payload),
                },
              },
              { triggerTurn: true, deliverAs: "followUp" },
            ),
          );
          for (const delivery of deliverable) {
            await ackDelivery(registration, delivery.delivery_id, "delivered", undefined, {
              timeout_ms: 900,
            });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          for (const delivery of deliverable) {
            try {
              await ackDelivery(registration, delivery.delivery_id, "retry", message, {
                timeout_ms: 900,
              });
            } catch {
              // The claim lease will expire and make the delivery retryable even if this ack is lost.
            }
          }
          throw err;
        }
      }

      bridgeDeliveries = await deliveryStatus(registration, { timeout_ms: 900 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      bridgeState = /already leased by another live instance|owned by another instance/.test(message)
        ? "busy"
        : "offline";
    } finally {
      bridgeRefreshInFlight = false;
    }
  };

  const stopStatusLoop = (ctx?: ExtensionContext) => {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = undefined;
    if (ctx?.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  };

  const startStatusLoop = (ctx: ExtensionContext) => {
    stopStatusLoop();
    void syncLiveBridge(ctx);
    if (ctx.hasUI) void refreshStatus(ctx);
    statusTimer = setInterval(() => {
      void syncLiveBridge(ctx);
      if (ctx.hasUI) void refreshStatus(ctx);
    }, STATUS_REFRESH_MS);
    statusTimer.unref?.();
  };

  const continuationBinding = (ctx: ExtensionContext, request: Record<string, unknown>) => {
    const runner = typeof request.runner === "string" ? request.runner.toLowerCase() : undefined;
    const host = typeof request.host === "string" ? request.host : undefined;
    const workdir = typeof request.workdir === "string" ? request.workdir : undefined;
    const local = runner === "process" || host === "local";
    if (!workdir || (!local && !host)) return undefined;
    return {
      agent_kind: "pi",
      session_id: ctx.sessionManager.getSessionId(),
      session_file: ctx.sessionManager.getSessionFile(),
      origin_leaf_id: ctx.sessionManager.getLeafId(),
      project_root: ctx.sessionManager.getCwd(),
      workspace: { host_alias: local ? "local" : host, cwd: workdir },
      adapter_path: ADAPTER_PATH,
    };
  };

  pi.registerTool({
    name: "runs_submit",
    label: "Submit run",
    description:
      "Submit a long scientific job as a durable Run. Local Windows work uses runwatch Process; remote HPC uses Slurm/LSF. Use this instead of Start-Job or manual scheduler polling. Returns run_id immediately; launch/submission success is not scientific completion.",
    parameters: Type.Object({
      command: Type.String({ description: "Command to run inside the job script" }),
      run_id: Type.Optional(Type.String({ description: "Stable Run ID. Normally generated by pi-runs; reuse it when retrying an ambiguous submission." })),
      host: Type.Optional(Type.String({ description: "~/.ssh/config Host alias for remote durable Slurm/LSF submission." })),
      name: Type.Optional(Type.String()),
      runner: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("process"), Type.Literal("slurm"), Type.Literal("lsf"), Type.Literal("powershell")])),
      wakeup: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("poll"), Type.Literal("sidecar"), Type.Literal("systemd-user"), Type.Literal("powershell-event"), Type.Literal("webhook")])),
      workdir: Type.Optional(Type.String({ description: "Working directory. Local Process defaults to the current Pi cwd; with host set this must be the absolute remote POSIX workspace path." })),
      time: Type.Optional(Type.String({ description: "Walltime, e.g. 04:00:00 or LSF -W value" })),
      partition: Type.Optional(Type.String()),
      queue: Type.Optional(Type.String()),
      account: Type.Optional(Type.String()),
      cpus: Type.Optional(Type.Number()),
      mem: Type.Optional(Type.String()),
      gpus: Type.Optional(Type.Number()),
      webhook_url: Type.Optional(Type.String()),
    }),
    promptSnippet: "Durably hand off a long scientific computation as a Run",
    promptGuidelines: [
      "Use runs_submit for long scientific computation instead of manually polling sbatch/bsub jobs.",
      "For remote Slurm/LSF work prepared with pi-ssh-tools, pass the ssh_status Host alias as host and its remote cwd as workdir; do not submit with ssh_bash and register afterwards.",
      "For long local Windows computation, omit host and use runner=process (or leave runner=auto); pi-runs defaults workdir to the current Pi cwd and runwatch owns the detached process lifecycle.",
      "After durable continuation is armed, stop actively waiting; runs_wait is only for short synchronous waits.",
    ],
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const options = { signal };
      const runId = params.run_id || `pi_${String(toolCallId).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80)}`;
      const normalized = normalizeSubmitRequest(params, ctx.sessionManager.getCwd());
      const request = {
        ...normalized,
        run_id: runId,
        _continuation: continuationBinding(ctx, normalized),
      };
      const capability = submitCapability(request);
      const backend = await backendInfo(capability, process.env, options);
      let rec;
      try {
        rec = await submitRun(request, options);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`runs_submit ${runId} failed: ${message}. Reuse run_id=${runId} when retrying this submission.`);
      }
      if (rec.continuation_binding_persisted) {
        await syncLiveBridge(ctx);
      }
      void refreshStatus(ctx);
      const liveContinuationArmed =
        Boolean(rec.continuation_binding_persisted) && bridgeState === "ok";
      const offlineContinuationArmed =
        Boolean(rec.continuation_binding_persisted) &&
        backend.selected === "runwatch" &&
        backend.runwatch?.capabilities?.includes("offline_pi_continuation");
      return jsonResult({
        run_id: rec.run_id,
        status: rec.status,
        runner: rec.runner,
        wakeup: rec.wakeup,
        handle: rec.handle,
        backend: backend.selected,
        continuation: rec.continuation_armed || offlineContinuationArmed
          ? "armed"
          : liveContinuationArmed
            ? "live_armed"
            : rec.continuation_binding_persisted
              ? "binding_persisted_delivery_pending"
              : backend.selected === "runwatch"
                ? "pending_agent_binding"
                : "legacy_compatibility",
        note: rec.continuation_armed || offlineContinuationArmed
          ? "offline-capable continuation is armed: the current Pi process may exit completely; runwatch will resume the exact saved Pi session through an RPC worker after terminal completion if no live Pi lease exists"
          : liveContinuationArmed
            ? "live Pi continuation is armed: end the current turn and leave Pi running; terminal completion will arrive as a follow-up"
            : rec.continuation_binding_persisted
              ? "durable Pi session/branch binding is stored, but no live/offline continuation capability is currently armed"
              : backend.selected === "runwatch"
                ? "durable Run monitoring is active, but no Pi continuation binding was stored"
                : "legacy compatibility backend; submission success is not scientific completion",
      });
    },
  });

  pi.registerTool({
    name: "runs_wait",
    label: "Wait for run",
    description:
      "Short synchronous wait for a Run. Do not use this for minutes-to-days scientific waits; durable continuation is the default long-job path.",
    promptSnippet: "Wait briefly for a Run that is expected to finish soon",
    promptGuidelines: [
      "Use runs_wait only for short synchronous waits. Never turn it into the watcher for a long scientific job.",
    ],
    parameters: Type.Object({
      run_id: Type.String(),
      timeout_ms: Type.Optional(Type.Number()),
      interval_ms: Type.Optional(Type.Number()),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const result = await waitRun(params.run_id, params, { signal });
      void refreshStatus(ctx);
      return jsonResult(result);
    },
  });

  pi.registerTool({
    name: "runs_status",
    label: "Run status",
    description: "Snapshot one Run or list all Runs. When runwatchd is online this reads its canonical SQLite state. Do not poll in a tight loop.",
    parameters: Type.Object({ run_id: Type.Optional(Type.String()) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const data = await statusRun(params?.run_id, { signal });
      void refreshStatus(ctx);
      return jsonResult(data);
    },
  });

  pi.registerTool({
    name: "runs_logs",
    label: "Run logs",
    description: "Tail stdout/stderr captured for a Run.",
    parameters: Type.Object({
      run_id: Type.String(),
      tail: Type.Optional(Type.Number()),
    }),
    async execute(_id, params, signal) {
      return jsonResult(await logsRun(params.run_id, params.tail ?? 80, { signal }));
    },
  });

  pi.registerTool({
    name: "runs_harvest",
    label: "Harvest run",
    description: "Mark artifacts after a terminal Run. Call only after succeeded/failed.",
    parameters: Type.Object({ run_id: Type.String() }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const result = await harvestRun(params.run_id, { signal });
      void refreshStatus(ctx);
      return jsonResult(result);
    },
  });

  pi.registerTool({
    name: "runs_rebind",
    label: "Rebind run",
    description:
      "Explicitly rebind a durable Run continuation to the current Pi session branch. Use when the pi-runs status shows rebind/branch mismatch; the tool captures session identity itself.",
    parameters: Type.Object({ run_id: Type.String() }),
    promptSnippet: "Rebind a blocked Run continuation to this Pi branch",
    promptGuidelines: [
      "Use runs_rebind only when the Run should intentionally continue on the current Pi branch; never fabricate session ids or leaf ids.",
    ],
    async execute(_id, params, signal, _onUpdate, ctx) {
      const run = await statusRun(params.run_id, { signal });
      const workspace = run?.workspace;
      if (!workspace?.host_alias || !workspace?.cwd) {
        throw new Error(`runs_rebind ${params.run_id}: Run has no durable workspace metadata`);
      }
      const binding = continuationBinding(ctx, {
        host: workspace.host_alias,
        workdir: workspace.cwd,
      });
      if (!binding) throw new Error(`runs_rebind ${params.run_id}: could not capture Pi binding`);
      const result = await rebindRun(params.run_id, binding, { signal });
      await syncLiveBridge(ctx);
      const offline = await backendInfo("offline_pi_continuation", process.env, { signal });
      void refreshStatus(ctx);
      return jsonResult({
        run_id: params.run_id,
        ...result,
        continuation:
          offline.selected === "runwatch"
            ? "armed"
            : bridgeState === "ok"
              ? "live_armed"
              : "binding_persisted_delivery_pending",
      });
    },
  });

  pi.registerTool({
    name: "runs_cancel",
    label: "Cancel run",
    description: "Request cancellation of a queued or running Run (scancel / bkill / local Process tree). Legacy Stop-Job exists only under explicit legacy mode.",
    parameters: Type.Object({ run_id: Type.String() }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const result = await cancelRun(params.run_id, { signal });
      void refreshStatus(ctx);
      return jsonResult(result);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    startStatusLoop(ctx);
  });

  pi.on("agent_start", async () => {
    if (offlineBootstrapSent && !offlineDeliveryFinished) {
      offlineAgentStarted = true;
      offlineAgentOutcome = undefined;
    }
  });

  pi.on("agent_end", async (event) => {
    if (
      offlineBootstrapSent &&
      offlineAgentStarted &&
      !offlineDeliveryFinished &&
      !event.willRetry
    ) {
      offlineAgentOutcome = classifyFinalAgentOutcome(event.messages);
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (offlineBootstrapSent && offlineAgentStarted && !offlineDeliveryFinished) {
      offlineSettledPendingAck = true;
      await finishOfflineSettled(ctx);
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    void syncLiveBridge(ctx);
    void refreshStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopStatusLoop(ctx);
    const registration = activeRegistration;
    activeRegistration = undefined;
    if (registration) {
      try {
        await releaseAgentSession(registration, { timeout_ms: 700 });
      } catch {
        // Lease expiry is the crash-safe cleanup path.
      }
    }
  });
}
