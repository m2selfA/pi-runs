import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  backendInfo,
  doctorInfo,
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

function waitProgressResult(runId: string, progress: any) {
  const run = progress?.run;
  const status = typeof run?.status === "string" ? run.status : "unknown";
  const elapsedMs = Number(progress?.elapsed_ms || 0);
  const elapsed = elapsedMs < 10_000 ? `${(elapsedMs / 1000).toFixed(1)}s` : `${Math.round(elapsedMs / 1000)}s`;
  const handle = run?.job_id ? ` · ${run.runner || "job"} ${run.job_id}` : run?.runner ? ` · ${run.runner}` : "";
  const condition = progress?.condition_met ? ` · ${progress.until} reached` : ` · waiting for ${progress?.until || "terminal"}`;
  return {
    content: [
      {
        type: "text",
        text: `Run ${runId}: ${status}${handle} · elapsed ${elapsed}${condition}. Escape/abort detaches this foreground wait; the durable Run is not cancelled.`,
      },
    ],
    details: {
      run_id: runId,
      status,
      runner: run?.runner,
      job_id: run?.job_id,
      wait: {
        until: progress?.until,
        condition_met: Boolean(progress?.condition_met),
        elapsed_ms: elapsedMs,
        timeout_ms: progress?.timeout_ms,
        interval_ms: progress?.interval_ms,
        iteration: progress?.iteration,
      },
    },
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
  let liveDelivery: any | undefined;
  let liveBootstrapSent = false;
  let liveAgentStarted = false;
  let liveSettledPendingAck = false;
  let liveAgentOutcome: { ok: boolean; error?: string } | undefined;
  let agentActive = false;

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

  const resetLiveDelivery = () => {
    liveDelivery = undefined;
    liveBootstrapSent = false;
    liveAgentStarted = false;
    liveSettledPendingAck = false;
    liveAgentOutcome = undefined;
  };

  const finishLiveSettled = async (ctx: ExtensionContext) => {
    if (!liveDelivery || !liveSettledPendingAck) return;
    const registration = sessionRegistration(ctx);
    const outcome =
      liveAgentOutcome ||
      ({ ok: false, error: "live Pi settled without a final successful agent_end" } as const);
    try {
      if (outcome.ok) {
        const evidence = inspectOfflineDeliverySession(
          ctx.sessionManager.getBranch(),
          liveDelivery.delivery_id,
        );
        if (evidence.state !== "settled") {
          pi.appendEntry(COMPLETION_SETTLED_ENTRY_TYPE, {
            schema_version: 1,
            delivery_id: liveDelivery.delivery_id,
            run_id: liveDelivery.payload?.run_id,
            attempt_no: liveDelivery.payload?.attempt_no,
            outcome: "delivered",
            settled_at: new Date().toISOString(),
            settled_leaf_id: ctx.sessionManager.getLeafId(),
            live_owner_instance_id: ownerInstanceId,
          });
        }
      }
      await ackDelivery(
        registration,
        liveDelivery.delivery_id,
        outcome.ok ? "delivered" : "retry",
        outcome.ok ? undefined : outcome.error,
        { timeout_ms: 1_200 },
      );
      resetLiveDelivery();
    } catch {
      bridgeState = "offline";
      // Keep the live session and its durable completion evidence intact. The next bridge refresh
      // retries settlement/ack without injecting a second runwatch/completion.
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

      if (liveDelivery) {
        if (liveSettledPendingAck) await finishLiveSettled(ctx);
        bridgeDeliveries = await deliveryStatus(registration, { timeout_ms: 900 });
        return;
      }

      // One live Delivery per triggered Pi turn keeps completion, agent outcome, settlement receipt,
      // and final ack unambiguous. Additional terminal Runs remain pending and are claimed on the
      // next bridge refresh after this Delivery settles.
      const claimed = await claimDeliveries(registration, { timeout_ms: 1_200, limit: 1 });
      const delivery = claimed[0];
      if (delivery) {
        if (!deliveryFitsCurrentBranch(delivery, registration, ctx)) {
          await ackDelivery(
            registration,
            delivery.delivery_id,
            "needs_rebind",
            "Run origin leaf/session file is not on the current Pi branch",
            { timeout_ms: 900 },
          );
        } else {
          const sessionEvidence = inspectOfflineDeliverySession(
            ctx.sessionManager.getBranch(),
            delivery.delivery_id,
          );
          if (sessionEvidence.state === "settled") {
            await ackDelivery(registration, delivery.delivery_id, "delivered", undefined, {
              timeout_ms: 900,
            });
          } else if (sessionEvidence.state === "completed_success") {
            liveDelivery = delivery;
            liveAgentOutcome = { ok: true };
            liveSettledPendingAck = true;
            await finishLiveSettled(ctx);
          } else {
            const recoveringExistingCompletion =
              sessionEvidence.state === "injected_unsettled" ||
              sessionEvidence.state === "completed_failure";
            // sendMessage({ triggerTurn: true }) may synchronously emit agent_start before returning.
            // Arm the exact live Delivery first so agent_start/agent_end/agent_settled are bound to
            // this completion instead of being mistaken for an unrelated Pi turn.
            liveDelivery = delivery;
            liveBootstrapSent = true;
            liveAgentStarted = agentActive;
            liveAgentOutcome = undefined;
            liveSettledPendingAck = false;
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
                      delivery_ids: [delivery.delivery_id],
                      runs: [delivery.payload],
                      recovery: recoveringExistingCompletion,
                    },
                  },
                  { triggerTurn: true, deliverAs: "followUp" },
                ),
              );
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              try {
                await ackDelivery(registration, delivery.delivery_id, "retry", message, {
                  timeout_ms: 900,
                });
              } finally {
                resetLiveDelivery();
              }
              throw err;
            }
          }
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
    name: "runs_doctor",
    label: "Runwatch readiness",
    description:
      "Read-only Pi v1 readiness check for the runwatch durable backend. Reports protocol/service/storage identity, required capabilities, explicit legacy selection and actionable reasons without changing configuration.",
    parameters: Type.Object({}),
    promptSnippet: "Check whether the Pi durable-run backend is ready",
    promptGuidelines: [
      "Use runs_doctor when runwatch-backed tools are unavailable or before release/installation validation. It is diagnostic only and must not be treated as an installer.",
    ],
    async execute(_id, _params, signal) {
      return jsonResult(await doctorInfo({ signal }));
    },
  });

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
      runner: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("process"), Type.Literal("slurm"), Type.Literal("lsf")])),
      workdir: Type.Optional(Type.String({ description: "Working directory. Local Process defaults to the current Pi cwd. For remote Slurm/LSF this must be an absolute persistent workspace path shared at the same path by the SSH login node and scheduler compute nodes; node-local /tmp/scratch is unsupported unless the cluster makes it shared." })),
      time: Type.Optional(Type.String({ description: "Walltime, e.g. 04:00:00 or LSF -W value" })),
      partition: Type.Optional(Type.String()),
      queue: Type.Optional(Type.String()),
      account: Type.Optional(Type.String()),
      cpus: Type.Optional(Type.Number()),
      mem: Type.Optional(Type.String()),
      gpus: Type.Optional(Type.Number()),
    }),
    promptSnippet: "Durably hand off a long scientific computation as a Run",
    promptGuidelines: [
      "Use runs_submit for long scientific computation instead of manually polling sbatch/bsub jobs.",
      "For remote Slurm/LSF work prepared with pi-ssh-tools, pass the ssh_status Host alias as host and its remote cwd as workdir; do not submit with ssh_bash and register afterwards.",
      "For remote scheduler Runs, choose a persistent shared workdir visible at the same path from login and compute nodes; never default to node-local /tmp or scratch merely because it exists on the SSH host.",
      "For long local Windows computation, omit host and use runner=process (or leave runner=auto); pi-runs defaults workdir to the current Pi cwd and runwatch owns the detached process lifecycle.",
      "After durable continuation is armed, normally end the turn instead of waiting. Use runs_wait when the user explicitly wants foreground run-to-completion observation; aborting that watcher never cancels the durable Run.",
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
              : "pending_agent_binding",
        note: rec.continuation_armed || offlineContinuationArmed
          ? "offline-capable continuation is armed: the current Pi process may exit completely; runwatch will resume the exact saved Pi session through an RPC worker after terminal completion if no live Pi lease exists"
          : liveContinuationArmed
            ? "live Pi continuation is armed: end the current turn and leave Pi running; terminal completion will arrive as a follow-up"
            : rec.continuation_binding_persisted
              ? "durable Pi session/branch binding is stored, but no live/offline continuation capability is currently armed"
              : "durable Run monitoring is active, but no Pi continuation binding was stored",
      });
    },
  });

  pi.registerTool({
    name: "runs_wait",
    label: "Wait for run",
    description:
      "Foreground observer for an existing durable Run. It may stay attached for an explicit run-to-completion workflow, reports periodic progress, and can wait for running or terminal state. Timeout or Escape/abort detaches only this watcher; cancelling the scientific Run requires runs_cancel.",
    promptSnippet: "Stay attached to a durable Run when the user explicitly wants run-to-completion observation",
    promptGuidelines: [
      "Long scientific Runs still default to runs_submit plus durable continuation so Pi may exit completely.",
      "Use runs_wait when foreground waiting is itself the requested workflow, including minutes-long run-to-completion checks; keep it observable and cancellable rather than silently polling.",
      "A runs_wait timeout or Escape/abort only detaches the foreground watcher. Never claim that the Run was cancelled unless runs_cancel was explicitly called and runwatch later confirms terminal cancellation.",
    ],
    parameters: Type.Object({
      run_id: Type.String(),
      until: Type.Optional(Type.Union([
        Type.Literal("terminal"),
        Type.Literal("running"),
      ], { description: "Condition to observe. running is also satisfied by a terminal state so fast Runs are not missed; default terminal." })),
      timeout_ms: Type.Optional(Type.Number({ description: "Total foreground attachment budget in milliseconds. Default 30000; capped at 24 hours. Timeout detaches the watcher and does not cancel the Run." })),
      interval_ms: Type.Optional(Type.Number({ description: "Progress-update slice in milliseconds. Default 5000; clamped to 1000..30000." })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      onUpdate?.({
        content: [{ type: "text", text: `Attached to Run ${params.run_id}; waiting for ${params.until || "terminal"}. Escape/abort detaches this watcher without cancelling the durable Run.` }],
        details: { run_id: params.run_id, wait: { until: params.until || "terminal", attached: true } },
      });
      const result = await waitRun(
        params.run_id,
        {
          ...params,
          on_update: (progress: any) => onUpdate?.(waitProgressResult(params.run_id, progress)),
        },
        { signal },
      );
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
    description: "Request cancellation of a queued or running Run through the canonical runwatch authority (scancel / bkill / local Process tree).",
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
    agentActive = true;
    if (offlineBootstrapSent && !offlineDeliveryFinished) {
      offlineAgentStarted = true;
      offlineAgentOutcome = undefined;
    }
    if (liveBootstrapSent && liveDelivery) {
      liveAgentStarted = true;
      liveAgentOutcome = undefined;
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
    if (liveBootstrapSent && liveDelivery && liveAgentStarted && !event.willRetry) {
      liveAgentOutcome = classifyFinalAgentOutcome(event.messages);
    }
    agentActive = false;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (offlineBootstrapSent && offlineAgentStarted && !offlineDeliveryFinished) {
      offlineSettledPendingAck = true;
      await finishOfflineSettled(ctx);
    }
    if (liveBootstrapSent && liveDelivery && liveAgentStarted) {
      liveSettledPendingAck = true;
      await finishLiveSettled(ctx);
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
