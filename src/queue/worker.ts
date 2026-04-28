// Personal Agent P0 — queue worker.
//
// One-process-wide worker per HLD §4.3 (P0 concurrency=1). Core
// responsibilities:
//   1. Atomic claim: BEGIN IMMEDIATE + UPDATE ... WHERE status='queued'
//      so contention cannot produce double-claim.
//   2. Attachment capture pre-step (HLD §7.2 step 3): calls
//      src/telegram/attachment_capture.ts for every storage_objects
//      row owned by the claimed job. Runs OUTSIDE the claim txn.
//      Capture failures do NOT fail the job — the provider_run
//      continues with a capture-failure note.
//   3. Dispatch by job_type to a provider adapter.
//   4. Commit a terminal `jobs.status` (succeeded/failed/cancelled)
//      along with the assistant turn and a provider_runs row.
//
// Phase 4 deliberately does NOT implement Claude subprocess spawn
// — `providers/fake.ts` stands in. Phase 7 replaces the adapter.
//
// Invariants the tests assert:
//   - Claim is atomic (no double-claim under contention).
//   - Only one provider_run job is `running` at a time.
//   - running → succeeded produces at least one `turns` row with
//     role='assistant' plus one provider_runs row with status='succeeded'
//     (HLD §5.2 invariant 3).
//   - Capture failure path: storage_objects.capture_status='failed',
//     no storage_sync job, provider_run still reaches a terminal
//     status.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { DbHandle } from "~/db.ts";
import type { EventEmitter } from "~/observability/events.ts";
import type { Redactor } from "~/observability/redact.ts";
import type {
  AgentOutcome,
  AgentRequest,
  AgentRequestAttachment,
  ProviderAdapter,
} from "~/providers/types.ts";
import { buildStatusReport, formatStatus } from "~/commands/status.ts";
import { cancelJob } from "~/commands/cancel.ts";
import { runDoctor, type DoctorDeps } from "~/commands/doctor.ts";
import { correctMemory } from "~/commands/correct.ts";
import { forgetArtifact, forgetLast, forgetMemory, forgetSession } from "~/commands/forget.ts";
import { saveLastAttachment } from "~/commands/save.ts";
import { switchProvider } from "~/commands/provider.ts";
import { whoamiReply } from "~/commands/whoami.ts";
import { endSession, enqueueSummaryJob } from "~/commands/summary.ts";
import { shouldAutoTriggerSummary, writeSummary, SUMMARY_SYSTEM_IDENTITY, type SummaryOutput } from "~/memory/summary.ts";
import { buildContext, type JudgmentItemSlot, type MemoryItemSlot, type TurnSlot } from "~/context/builder.ts";
import { pack, renderAsMessage, serializeForProviderRun, PromptOverflowError } from "~/context/packer.ts";
import {
  runDeletePass,
  runRetryScheduler,
  runUploadPass,
  type SyncConfig,
} from "~/storage/sync.ts";
import {
  reducedSyncBatchLimit,
  unknownStorageCapacityReport,
  type StorageCapacityReport,
} from "~/storage/capacity.ts";
import type { S3Transport } from "~/storage/s3.ts";
import {
  captureOne,
  commitCaptureFailure,
  commitCaptureSuccess,
  pendingCapturesForJob,
  type CaptureConfig,
  type MimeProbe,
  type TelegramFileTransport,
} from "~/telegram/attachment_capture.ts";
import {
  createNotificationAndChunks,
  sendNotification,
  type NotificationType,
  type OutboundTransport,
} from "~/telegram/outbound.ts";
import { retryNotificationFromLedger } from "~/queue/notification_retry.ts";
import { evaluateTurn, recordControlGateDecision } from "~/judgment/control_gate.ts";
import { executeJudgmentExplainTool, executeJudgmentQueryTool } from "~/judgment/tool.ts";

export interface WorkerConfig {
  readonly capture: CaptureConfig;
  readonly poll_interval_ms?: number | undefined;
  readonly notifications?: {
    readonly chunk_size?: number | undefined;
    /** Max delivery attempts per notification chunk before giving up. Default: 3. */
    readonly max_attempts_per_chunk?: number | undefined;
  } | undefined;
  /** Optional S3 sync config. When present, storage_sync jobs run the upload/delete pass. */
  readonly sync?: SyncConfig | undefined;
  /**
   * Local directory for human-readable memory files.
   * When set, summary_generation writes `memory/sessions/<session_id>.jsonl`
   * under this base path (AC-MEM-001). Defaults to a `memory` sibling of the
   * objects root when absent.
   */
  readonly memory_base_path?: string | undefined;
}

export interface WorkerDeps {
  readonly db: DbHandle;
  readonly redactor: Redactor;
  readonly events: EventEmitter;
  readonly adapter: ProviderAdapter;
  /** Optional: when set, used for summary_generation jobs (advisory profile). Falls back to adapter. */
  readonly summaryAdapter?: ProviderAdapter | undefined;
  readonly transport: TelegramFileTransport;
  readonly mime: MimeProbe;
  readonly newId: () => string;
  readonly now: () => Date;
  readonly config: WorkerConfig;
  /** Optional: when set, terminal transitions enqueue an outbound notification and send it. */
  readonly outbound?: OutboundTransport | undefined;
  /** Optional: when set, storage_sync jobs call runUploadPass/runDeletePass via this transport. */
  readonly s3?: S3Transport | undefined;
  /** Optional: when set, /doctor deep checks use these hooks. */
  readonly doctor?: Omit<DoctorDeps, "db"> | undefined;
  /**
   * Registry of job_id → AbortController for currently-running jobs.
   * Used by /cancel (src/commands/cancel.ts) to actually abort a running
   * provider subprocess. The worker populates this before dispatch and
   * removes the entry after the run finishes. If omitted, /cancel on a
   * running job returns `cancel_unavailable` instead of a false success.
   */
  readonly runningCancelHandles?: Map<string, AbortController> | undefined;
}

interface ClaimedJob {
  readonly id: string;
  readonly job_type: string;
  readonly session_id: string | null;
  readonly user_id: string | null;
  readonly chat_id: string | null;
  readonly request_json: string;
  readonly idempotency_key: string;
  readonly attempts: number;
  readonly provider: string | null;
}

// ---------------------------------------------------------------
// Atomic claim
// ---------------------------------------------------------------

export function claimNextJob(db: DbHandle): ClaimedJob | null {
  return db.tx<ClaimedJob | null>(() => {
    const row = db
      .prepare<
        ClaimedJob,
        [string]
      >(
        `SELECT id, job_type, session_id, user_id, chat_id,
                request_json, idempotency_key, attempts, provider
         FROM jobs
         WHERE status = 'queued'
           AND scheduled_at <= ?
         ORDER BY priority DESC, scheduled_at ASC
         LIMIT 1`,
      )
      .get(nowIso());
    if (!row) return null;

    const res = db
      .prepare<
        unknown,
        [string]
      >(
        `UPDATE jobs
         SET status = 'running',
             started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             attempts = attempts + 1
         WHERE id = ? AND status = 'queued'`,
      )
      .run(row.id);

    if ((res.changes ?? 0) !== 1) {
      // Lost the race — fall through as no-claim.
      return null;
    }
    return { ...row, attempts: row.attempts + 1 };
  });
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.(\d{3})Z$/, ".$1Z");
}

// ---------------------------------------------------------------
// Capture pre-step (HLD §7.2 step 3)
// ---------------------------------------------------------------

interface CaptureSummary {
  readonly attachments: readonly AgentRequestAttachment[];
  readonly failures: number;
}

export async function runCapturePass(
  deps: WorkerDeps,
  jobId: string,
): Promise<CaptureSummary> {
  const pendings = pendingCapturesForJob(deps.db, jobId);
  const attachments: AgentRequestAttachment[] = [];
  let failures = 0;

  for (const pending of pendings) {
    const result = await captureOne({
      input: {
        storage_object_id: pending.storage_object_id,
        file_id: pending.source_external_id,
        current_sync_status: pending.status,
      },
      transport: deps.transport,
      mime: deps.mime,
      config: deps.config.capture,
    });
    if (result.kind === "success") {
      commitCaptureSuccess({
        db: deps.db,
        success: result,
        retention_class: pending.retention_class,
        newId: deps.newId,
        events: deps.events,
      });
      attachments.push({
        storage_object_id: result.storage_object_id,
        local_path: result.local_path,
        mime_type: result.mime_type,
        size_bytes: result.size_bytes,
        sha256: result.sha256,
      });
    } else {
      commitCaptureFailure({
        db: deps.db,
        failure: result,
        events: deps.events,
      });
      failures += 1;
    }
  }

  return { attachments, failures };
}

// ---------------------------------------------------------------
// Dispatch + terminal commit
// ---------------------------------------------------------------

export interface RunResult {
  readonly job_id: string;
  readonly terminal: "succeeded" | "failed" | "cancelled";
  readonly turn_id: string | null;
  readonly provider_run_id: string;
}

export async function runOneClaimed(
  deps: WorkerDeps,
  job: ClaimedJob,
  signal?: AbortSignal,
): Promise<RunResult> {
  // Register a per-job AbortController so /cancel can actually abort the
  // running subprocess (not just pretend). The worker-level `signal`
  // (shutdown) is chained in so graceful stop still tears down the job.
  const jobController = new AbortController();
  const onWorkerAbort = (): void => jobController.abort();
  if (signal) {
    if (signal.aborted) jobController.abort();
    else signal.addEventListener("abort", onWorkerAbort, { once: true });
  }
  deps.runningCancelHandles?.set(job.id, jobController);
  try {
    return await runOneClaimedInner(deps, job, jobController.signal);
  } finally {
    deps.runningCancelHandles?.delete(job.id);
    signal?.removeEventListener("abort", onWorkerAbort);
  }
}

async function runOneClaimedInner(
  deps: WorkerDeps,
  job: ClaimedJob,
  signal: AbortSignal,
): Promise<RunResult> {
  // Capture pass first.
  const capture = await runCapturePass(deps, job.id);

  if (job.job_type === "storage_sync") {
    return runStorageSyncJob(deps, job);
  }

  if (job.job_type === "notification_retry") {
    return runNotificationRetryJob(deps, job);
  }

  if (job.job_type !== "provider_run" && job.job_type !== "summary_generation") {
    // Future non-provider job types: no-op until explicitly wired.
    return commitSystemNoop(deps, job);
  }

  // System commands: handle locally without calling the Claude adapter.
  if (job.job_type === "provider_run") {
    const req = JSON.parse(job.request_json) as { command?: string | null; args?: string };
    const cmd = req.command ?? null;
    if (cmd && isSystemCommand(cmd)) {
      return runSystemCommandJob(deps, job, cmd, req.args ?? "", signal);
    }
  }

  // job_accepted notification (PRD §13.3 DEC-012): sent for non-system provider_run
  // jobs when an outbound transport is available. Gives immediate feedback to the user
  // while the AI run is pending.
  if (
    job.job_type === "provider_run" &&
    deps.outbound &&
    job.chat_id
  ) {
    const accepted = createNotificationAndChunks({
      db: deps.db,
      newId: deps.newId,
      args: {
        job_id: job.id,
        chat_id: job.chat_id,
        notification_type: "job_accepted",
        text: `접수됨 · ${job.id.slice(0, 8)} · ${job.provider ?? "claude"} · 상태: queued`,
        chunk_size: deps.config.notifications?.chunk_size,
      },
    });
    let jobAcceptedRetryNeeded = false;
    try {
      const jobAcceptedResult = await sendNotification(
        { db: deps.db, transport: deps.outbound, events: deps.events },
        accepted.notification_id,
        accepted.chunks,
      );
      jobAcceptedRetryNeeded = jobAcceptedResult.roll_up_status !== "sent";
    } catch {
      // Non-fatal: job_accepted delivery failure must not block the AI run.
      jobAcceptedRetryNeeded = true;
    }
    if (jobAcceptedRetryNeeded) {
      enqueueNotificationRetryJob(deps, accepted.notification_id, job.chat_id);
    }
  }

  const isSummaryJob = job.job_type === "summary_generation";
  const selectedAdapter = isSummaryJob && deps.summaryAdapter
    ? deps.summaryAdapter
    : deps.adapter;

  // summary_generation always runs in replay_mode (fresh context, no resume).
  // Also respect an explicit replay_mode in request_json (e.g. after a resume-fallback).
  const requestRaw = JSON.parse(job.request_json) as { context_packing_mode?: string };
  const forcedReplay = requestRaw.context_packing_mode === "replay_mode";
  const priorSessionId = !isSummaryJob && !forcedReplay && job.session_id
    ? queryPriorProviderSessionId(deps.db, job.session_id)
    : null;
  const baseRequest = parseRequest(job, capture.attachments, priorSessionId);
  const providerRunId = deps.newId();
  const packingMode = priorSessionId ? "resume_mode" : "replay_mode";

  // Phase 1B.1 — Control Gate turn evaluation (append-only telemetry, L0-only).
  // Only for provider_run jobs (user turns). summary_generation is an internal
  // prompt and must NOT produce control_gate_events rows — those rows are append-only
  // and false summary entries would pollute gate telemetry irreversibly.
  // `evaluateTurn` supports escalation via is_explicit_review_request /
  // is_doubt_signal, but Phase 1B.1 passes neither — signal detection deferred.
  // direct_commit_allowed is always false per ADR-0012.
  if (!isSummaryJob) {
    // INSERT OR IGNORE in recordControlGateDecision handles retry idempotency
    // via the partial unique index on (job_id) WHERE phase='turn'.
    const cgDecision = evaluateTurn({ text: baseRequest.message });
    recordControlGateDecision(deps.db, cgDecision, job.id);
    deps.events.debug("queue.control_gate", {
      job_id: job.id,
      level: cgDecision.level,
      phase: cgDecision.phase,
      budget_class: cgDecision.budget_class,
    });
  }

  // In replay_mode, inject the full packed context (memory + turns + summary)
  // as the message so Claude receives the conversation history. In resume_mode
  // Claude already has the history via --resume, so inject only a fresh,
  // bounded judgment_active block plus the user message.
  let request = baseRequest;
  let snapshotJson: string;
  if (packingMode === "replay_mode" && job.session_id) {
    let ctx: ContextBuildResult;
    try {
      ctx = buildContextForRun({
        db: deps.db,
        sessionId: job.session_id,
        req: baseRequest,
        redactor: deps.redactor,
        // advisory profile: replace system_identity with schema instruction
        systemIdentity: isSummaryJob ? SUMMARY_SYSTEM_IDENTITY : undefined,
        // summary user message instructs Claude to produce structured output.
        // On retry (attempts >= 2), append a stricter schema reminder per HLD §7.5 failure modes.
        userMessage: isSummaryJob
          ? job.attempts >= 2
            ? "이 대화를 위의 JSON 스키마에 따라 요약해 주세요.\n\n반드시 유효한 JSON 객체만 반환하십시오. 마크다운 펜스나 설명 없이 JSON 객체 하나만 출력하세요. 이전 시도에서 스키마를 따르지 않은 것 같습니다."
            : "이 대화를 위의 JSON 스키마에 따라 요약해 주세요."
          : undefined,
        // Phase 1B.2: skip judgment injection for summary_generation (see skipJudgments doc).
        skipJudgments: isSummaryJob,
      });
    } catch (e) {
      if (e instanceof PromptOverflowError) {
        // HLD §10.3 rule 2: minimum prompt doesn't fit; fail the job explicitly.
        deps.db.tx<void>(() => {
          deps.db
            .prepare<unknown, [string, string]>(
              `UPDATE jobs SET status = 'failed', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
               error_json = ? WHERE id = ? AND status = 'running'`,
            )
            .run(JSON.stringify({ error_type: "prompt_overflow", detail: e.message }), job.id);
        });
        deps.events.warn("queue.job.prompt_overflow", { job_id: job.id, detail: e.message });
        return { job_id: job.id, terminal: "failed", turn_id: null, provider_run_id: providerRunId };
      }
      throw e;
    }
    request = { ...baseRequest, message: ctx.packedMessage };
    snapshotJson = ctx.snapshotJson;
  } else {
    // Phase 1B.2 — Resume-mode judgment refresh (issue #44).
    // Claude holds conversation history via --resume; inject a fresh, bounded
    // judgment_active block so judgments committed after the last replay are visible.
    // Excludes turns, memory, and summary — only judgment_items + user_message.
    const resumeJudgments = queryActiveGlobalJudgmentSlots(deps.db);
    if (resumeJudgments.length > 0) {
      const snap = buildContext({
        mode: "resume_mode",
        user_message: baseRequest.message,
        system_identity: "actwyn personal agent",
        judgment_items: resumeJudgments,
      });
      try {
        const packed = pack(snap, { total_budget_tokens: 6000 });
        request = { ...baseRequest, message: deps.redactor.apply(renderAsMessage(packed)).text };
        snapshotJson = deps.redactor.apply(serializeForProviderRun(packed)).text;
      } catch (e) {
        if (!(e instanceof PromptOverflowError)) throw e;
        snapshotJson = JSON.stringify({ mode: packingMode, session_id: job.session_id ?? "" });
      }
    } else {
      snapshotJson = JSON.stringify({ mode: packingMode, session_id: job.session_id ?? "" });
    }
  }

  insertProviderRunStart({
    db: deps.db,
    id: providerRunId,
    jobId: job.id,
    sessionId: job.session_id ?? "",
    provider: selectedAdapter.name,
    req: request,
    packingMode,
    redactor: deps.redactor,
    snapshotJson,
  });

  const outcome = await safeRun(selectedAdapter, request, signal, (pgid, pid) => {
    deps.db
      .prepare<unknown, [number, number, string]>(
        `UPDATE provider_runs SET process_group_id = ?, process_id = ? WHERE id = ?`,
      )
      .run(pgid, pid, providerRunId);
  });

  // Resume-fallback (HLD §10.2): if a resume_mode attempt fails, re-queue
  // the job in replay_mode without counting the failed attempt.
  if (
    outcome.kind === "failed" &&
    request.context_packing_mode === "resume_mode" &&
    outcome.response.exit_code !== 0
  ) {
    deps.db.tx<void>(() => {
      deps.db
        .prepare<unknown, [string, string]>(
          `UPDATE provider_runs
           SET status = 'failed',
               error_type = 'resume_failed',
               finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
               parser_status = ?
           WHERE id = ?`,
        )
        .run(outcome.response.parser_status, providerRunId);
      // Re-queue the job in replay_mode; decrement attempts so this doesn't count.
      const existingReq = JSON.parse(job.request_json) as Record<string, unknown>;
      const newRequestJson = JSON.stringify({ ...existingReq, context_packing_mode: "replay_mode" });
      deps.db
        .prepare<unknown, [string, string]>(
          `UPDATE jobs
           SET status = 'queued',
               started_at = NULL,
               finished_at = NULL,
               attempts = MAX(0, attempts - 1),
               result_json = json_object('resume_failed', 1),
               request_json = ?
           WHERE id = ? AND status = 'running'`,
        )
        .run(newRequestJson, job.id);
    });
    deps.events.info("queue.job.resume_fallback", { job_id: job.id, provider_run_id: providerRunId });
    return { job_id: job.id, terminal: "failed", turn_id: null, provider_run_id: providerRunId };
  }

  // Persist raw events for audit. Each payload must already be redacted by
  // the adapter (Claude adapter in Phase 7 will enforce line-by-line
  // redaction; the fake adapter emits structured text). We redact
  // again here to be safe (idempotent per redactor tests).
  for (const evt of outcome.response.raw_events) {
    const redacted = deps.redactor.apply(evt.payload).text;
    deps.db
      .prepare<
        unknown,
        [string, string, number, string, string, number, string]
      >(
        `INSERT INTO provider_raw_events
           (id, provider_run_id, event_index, stream, redacted_payload, redaction_applied, parser_status)
         VALUES(?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        deps.newId(),
        providerRunId,
        evt.index,
        evt.stream,
        redacted,
        1,
        evt.parser_status,
      );
  }

  const terminalRunStatus =
    outcome.kind === "succeeded"
      ? "succeeded"
      : outcome.kind === "cancelled"
        ? "cancelled"
        : "failed";

  let turnId: string | null = null;
  const finalText = outcome.response.final_text;
  const summaryResult = { sync: null as { summaryId: string; summaryData: SummaryOutput } | null };
  let pendingNotification: { notification_id: string; chunks: readonly string[] } | null = null;

  deps.db.tx<void>(() => {
    const providerSessionIdFromRun =
      outcome.kind === "succeeded" && outcome.response.session_id
        ? outcome.response.session_id
        : null;
    const usageJson = outcome.response.usage
      ? JSON.stringify(outcome.response.usage)
      : null;
    const providerVersion = outcome.response.provider_version ?? null;
    deps.db
      .prepare<unknown, [string, string | null, string | null, string | null, string | null, string | null, string]>(
        `UPDATE provider_runs
         SET status = ?,
             error_type = ?,
             finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             parser_status = ?,
             provider_session_id = ?,
             usage_json = ?,
             provider_version = ?
         WHERE id = ?`,
      )
      .run(
        terminalRunStatus,
        outcome.response.error_type ?? null,
        outcome.response.parser_status,
        providerSessionIdFromRun,
        usageJson,
        providerVersion,
        providerRunId,
      );

    // Review Blocker 9: summary_generation output is an internal structured
    // payload destined for memory_summaries, NOT a conversation turn. Writing
    // it into `turns` would pollute the replay context on the NEXT run.
    if (!isSummaryJob && finalText.length > 0 && job.session_id) {
      // Insert user turn first (chronological order) for non-summary provider_run jobs.
      // Use baseRequest.message (raw user text), not the packed context sent to Claude.
      if (baseRequest.message.length > 0) {
        const redactedUserMsg = deps.redactor.apply(baseRequest.message).text;
        deps.db
          .prepare<unknown, [string, string, string, string, string]>(
            `INSERT INTO turns(id, session_id, job_id, provider_run_id, role, content_redacted, redaction_applied)
             VALUES(?, ?, ?, ?, 'user', ?, 1)`,
          )
          .run(deps.newId(), job.session_id, job.id, providerRunId, redactedUserMsg);
      }
      turnId = deps.newId();
      const redactedText = deps.redactor.apply(finalText).text;
      deps.db
        .prepare<
          unknown,
          [string, string, string, string, string]
        >(
          `INSERT INTO turns(id, session_id, job_id, provider_run_id, role, content_redacted, redaction_applied)
           VALUES(?, ?, ?, ?, 'assistant', ?, 1)`,
        )
        .run(turnId, job.session_id, job.id, providerRunId, redactedText);
    }

    const terminalJobStatus: "succeeded" | "failed" | "cancelled" =
      outcome.kind === "succeeded"
        ? "succeeded"
        : outcome.kind === "cancelled"
          ? "cancelled"
          : "failed";
    const result_json =
      outcome.kind === "succeeded"
        ? JSON.stringify({
            parser_status: outcome.response.parser_status,
            duration_ms: outcome.response.duration_ms,
            capture_failures: capture.failures,
          })
        : null;
    // cancelled_after_start (HLD §14.5): set when the subprocess had begun
    // producing output before teardown, indicating possible side effects.
    const cancelledAfterStart =
      (outcome.kind === "cancelled" || outcome.kind === "failed") &&
      (outcome.response.raw_events.length > 0 || outcome.response.final_text.length > 0);
    const error_json =
      outcome.kind === "failed"
        ? JSON.stringify({
            error_type: outcome.error_type,
            exit_code: outcome.response.exit_code,
            ...(cancelledAfterStart ? { cancelled_after_start: true } : {}),
          })
        : outcome.kind === "cancelled"
          ? JSON.stringify({
              error_type: "cancelled",
              ...(cancelledAfterStart ? { cancelled_after_start: true } : {}),
            })
          : null;
    deps.db
      .prepare<
        unknown,
        [string, string | null, string | null, string]
      >(
        `UPDATE jobs
         SET status = ?,
             finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             result_json = ?,
             error_json = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(terminalJobStatus, result_json, error_json, job.id);

    // summary_generation: persist structured summary + optional /end session close.
    if (
      job.job_type === "summary_generation" &&
      job.session_id
    ) {
      const summaryReq = JSON.parse(job.request_json) as { command?: string; trigger?: string };
      const isEndTrigger = summaryReq.command === "/end" || summaryReq.trigger === "explicit_end";
      if (terminalJobStatus === "succeeded") {
        // Attempt to parse structured summary output from Claude's response.
        let parsed = false;
        if (finalText.length > 0) {
          try {
            const raw = JSON.parse(finalText) as SummaryOutput;
            const summaryData: SummaryOutput = { ...raw, session_id: job.session_id };
            const result = writeSummary({
              db: deps.db,
              newId: deps.newId,
              summary: summaryData,
            });
            summaryResult.sync = { summaryId: result.summary_id, summaryData };
            parsed = true;
          } catch {
            // Non-fatal: unstructured output is stored as a turn but not as a memory_summaries row.
          }
        }
        // HLD §7.5 failure mode: /end on empty session → produce minimal summary.
        if (!parsed && isEndTrigger) {
          const minimalSummary: SummaryOutput = {
            session_id: job.session_id,
            summary_type: "session",
            facts: [],
            preferences: [],
            decisions: [],
            open_tasks: [],
            cautions: [],
            source_turn_ids: [],
          };
          const result = writeSummary({ db: deps.db, newId: deps.newId, summary: minimalSummary });
          summaryResult.sync = { summaryId: result.summary_id, summaryData: minimalSummary };
        }
      }
      // HLD §7.5: /end closes the session regardless of summary success or failure.
      if (isEndTrigger) {
        endSession(deps.db, job.session_id);
      }
    }
  });

  // AC-MEM-001: write local snapshot file + enqueue storage_sync after summary succeeds.
  // Runs outside the tx to avoid blocking I/O inside a transaction (HLD §7.10).
  if (summaryResult.sync !== null && deps.config.sync) {
    try {
      await enqueueMemorySnapshotSync(deps, job.id, summaryResult.sync.summaryId, summaryResult.sync.summaryData);
    } catch {
      // Non-fatal: sync failure must not roll back the succeeded summary.
    }
  }

  // Auto-trigger summary check (AC-MEM-005 / PRD §12.3 DEC-019).
  // Only applies to successful conversational provider_run jobs.
  if (
    job.job_type === "provider_run" &&
    outcome.kind === "succeeded" &&
    job.session_id &&
    job.user_id &&
    job.chat_id
  ) {
    maybeEnqueueAutoSummary(deps, job.session_id, job.user_id, job.chat_id);
  }

  deps.events.info("queue.job.terminal", {
    job_id: job.id,
    terminal: terminalRunStatus,
    provider_run_id: providerRunId,
    capture_failures: capture.failures,
  });

  // Outbound notification: create rows in their own txn immediately after T5 completes
  // (HLD §7.10: notification creation uses its own transaction; T5 does not allow nesting
  // because createNotificationAndChunks wraps inserts in db.tx() internally).
  if (deps.outbound && job.chat_id) {
    const notificationType: NotificationType = isSummaryJob && outcome.kind === "succeeded"
      ? "summary"
      : outcome.kind === "succeeded"
        ? "job_completed"
        : outcome.kind === "cancelled"
          ? "job_cancelled"
          : "job_failed";
    const notifText = (isSummaryJob && summaryResult.sync !== null)
      ? buildSummaryNotificationText(summaryResult.sync.summaryData)
      : buildNotificationText(outcome.kind, outcome.response.final_text, {
          duration_ms: outcome.response.duration_ms,
          provider: outcome.response.provider,
        });
    const created = createNotificationAndChunks({
      db: deps.db,
      newId: deps.newId,
      args: {
        job_id: job.id,
        chat_id: job.chat_id,
        notification_type: notificationType,
        text: notifText,
        chunk_size: deps.config.notifications?.chunk_size,
      },
    });
    pendingNotification = { notification_id: created.notification_id, chunks: created.chunks };
  }

  // Send the notification (network I/O outside any transaction per HLD §7.10).
  if (deps.outbound && job.chat_id && pendingNotification !== null) {
    const { notification_id, chunks } = pendingNotification;
    let retryNeeded = false;
    try {
      const sendResult = await sendNotification(
        {
          db: deps.db,
          transport: deps.outbound,
          events: deps.events,
        },
        notification_id,
        chunks,
      );
      retryNeeded = sendResult.roll_up_status !== "sent";
    } catch (e) {
      deps.events.warn("telegram.outbound.pass_error", {
        job_id: job.id,
        notification_id,
        error_type: (e as Error).name,
        error_message: (e as Error).message,
      });
      // Do NOT roll back jobs.status or provider_runs.status here —
      // Provider success stands independently of delivery (AC-NOTIF-001).
      retryNeeded = true;
    }
    if (retryNeeded) {
      enqueueNotificationRetryJob(deps, notification_id, job.chat_id!);
    }
  }

  const terminal: RunResult["terminal"] =
    outcome.kind === "succeeded"
      ? "succeeded"
      : outcome.kind === "cancelled"
        ? "cancelled"
        : "failed";
  return { job_id: job.id, terminal, turn_id: turnId, provider_run_id: providerRunId };
}

function buildSummaryNotificationText(summary: SummaryOutput): string {
  const counts: string[] = [];
  if (summary.facts.length > 0) counts.push(`사실 ${summary.facts.length}개`);
  if (summary.preferences.length > 0) counts.push(`선호도 ${summary.preferences.length}개`);
  if (summary.decisions.length > 0) counts.push(`결정 ${summary.decisions.length}개`);
  if (summary.open_tasks.length > 0) counts.push(`열린 작업 ${summary.open_tasks.length}개`);
  if (summary.cautions.length > 0) counts.push(`주의사항 ${summary.cautions.length}개`);
  const detail = counts.length > 0 ? ` (${counts.join(", ")})` : "";
  return `요약이 완료됐습니다${detail}.`;
}

function buildNotificationText(
  kind: "succeeded" | "failed" | "cancelled",
  finalText: string,
  meta?: { duration_ms?: number; provider?: string },
): string {
  if (kind === "succeeded") {
    const base = finalText.length > 0 ? finalText : "(empty response)";
    if (meta?.duration_ms !== undefined && meta.provider) {
      const sec = (meta.duration_ms / 1000).toFixed(1);
      return `${base}\n\n---\n${sec}s · ${meta.provider}`;
    }
    return base;
  }
  if (kind === "cancelled") {
    return "작업이 취소됐습니다.";
  }
  return finalText.length > 0 ? finalText : "작업이 실패했습니다. /status 를 확인하세요.";
}

// ---------------------------------------------------------------
// Top-level loop
// ---------------------------------------------------------------

export interface RunLoopOptions {
  readonly signal?: AbortSignal;
  readonly max_iterations?: number;
  readonly idle_sleep_ms?: number;
}

export async function runWorkerOnce(deps: WorkerDeps, signal?: AbortSignal): Promise<RunResult | null> {
  const claimed = claimNextJob(deps.db);
  if (!claimed) return null;
  return runOneClaimed(deps, claimed, signal);
}

export async function runWorkerLoop(deps: WorkerDeps, opts: RunLoopOptions = {}): Promise<void> {
  let iterations = 0;
  const idleMs = opts.idle_sleep_ms ?? deps.config.poll_interval_ms ?? 200;
  while (!opts.signal?.aborted) {
    const result = await runWorkerOnce(deps, opts.signal);
    iterations += 1;
    if (opts.max_iterations !== undefined && iterations >= opts.max_iterations) return;
    if (!result) {
      await sleep(idleMs, opts.signal);
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

// ---------------------------------------------------------------
// helpers
// ---------------------------------------------------------------

async function safeRun(
  adapter: ProviderAdapter,
  req: AgentRequest,
  signal?: AbortSignal,
  onSpawn?: (pgid: number, pid: number) => void,
): Promise<AgentOutcome> {
  try {
    return await adapter.run(req, signal, onSpawn);
  } catch (e) {
    const msg = (e as Error).message ?? "adapter_threw";
    return {
      kind: "failed",
      error_type: "adapter_threw",
      response: {
        provider: adapter.name,
        session_id: "",
        final_text: "",
        raw_events: [],
        duration_ms: 0,
        exit_code: 1,
        parser_status: "parse_error",
        error_type: msg.slice(0, 200),
      },
    };
  }
}

function parseRequest(
  job: ClaimedJob,
  attachments: readonly AgentRequestAttachment[],
  priorProviderSessionId?: string | null,
): AgentRequest {
  const parsed = JSON.parse(job.request_json) as {
    text?: string;
    command?: string | null;
    args?: string;
  };
  const message = parsed.text ?? parsed.command ?? "";
  const req: AgentRequest = {
    provider: job.provider ?? "fake",
    message,
    session_id: job.session_id ?? "",
    user_id: job.user_id ?? "",
    chat_id: job.chat_id ?? "",
    channel: job.chat_id ? `telegram:${job.chat_id}` : "",
    idempotency_key: job.idempotency_key,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(priorProviderSessionId
      ? {
          context_packing_mode: "resume_mode" as const,
          provider_session_id: priorProviderSessionId,
        }
      : { context_packing_mode: "replay_mode" as const }),
  };
  return req;
}

function queryPriorProviderSessionId(db: DbHandle, session_id: string): string | null {
  const row = db
    .prepare<{ provider_session_id: string }, [string]>(
      `SELECT provider_session_id
       FROM provider_runs
       WHERE session_id = ? AND status = 'succeeded'
         AND provider_session_id IS NOT NULL
       ORDER BY finished_at DESC
       LIMIT 1`,
    )
    .get(session_id);
  return row?.provider_session_id ?? null;
}

interface ContextBuildResult {
  /** Full packed message text: used as the actual prompt in replay_mode. */
  readonly packedMessage: string;
  /** JSON metadata for provider_runs.injected_snapshot_json. */
  readonly snapshotJson: string;
}

/**
 * Build and pack the full replay_mode context for a provider run.
 *
 * Returns both the full rendered message (to pass to Claude) and the
 * observability snapshot (to persist in injected_snapshot_json).
 * Resume-mode judgment refresh is handled separately in runOneClaimedInner.
 */
function buildContextForRun(args: {
  db: DbHandle;
  sessionId: string;
  req: AgentRequest;
  redactor: Redactor;
  /** Override the system_identity slot (e.g. advisory profile for summary_generation). */
  systemIdentity?: string | undefined;
  /** Override the user_message slot (e.g. schema prompt for summary_generation). */
  userMessage?: string | undefined;
  /**
   * When true, skip active-judgment injection (Phase 1B.2).
   * Set for summary_generation to prevent durable judgments from
   * contaminating session summaries persisted to memory_summaries.
   */
  skipJudgments?: boolean | undefined;
}): ContextBuildResult {
  const fallback: ContextBuildResult = {
    packedMessage: args.userMessage ?? args.req.message,
    snapshotJson: JSON.stringify({ mode: "replay_mode", session_id: args.sessionId ?? "" }),
  };

  if (!args.sessionId) return fallback;

  const turns = args.db
    .prepare<TurnSlot, [string]>(
      `SELECT id, role, content_redacted, created_at
       FROM turns
       WHERE session_id = ?
       ORDER BY created_at DESC
       LIMIT 20`,
    )
    .all(args.sessionId)
    .reverse();

  const memItems = args.db
    .prepare<MemoryItemSlot, [string]>(
      `SELECT id, content, provenance, confidence, status
       FROM memory_items
       WHERE session_id = ? AND status = 'active'
       ORDER BY created_at DESC
       LIMIT 50`,
    )
    .all(args.sessionId);

  const latestSummary = args.db
    .prepare<{ facts_json: string | null; open_tasks_json: string | null; created_at: string }, [string]>(
      `SELECT facts_json, open_tasks_json, created_at
       FROM memory_summaries
       WHERE session_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(args.sessionId);

  let currentSessionSummary: string | undefined;
  if (latestSummary) {
    const parts: string[] = [`[요약 기준: ${latestSummary.created_at}]`];
    if (latestSummary.facts_json) {
      try {
        const facts = JSON.parse(latestSummary.facts_json) as Array<{ content: string }>;
        if (facts.length > 0) parts.push(`사실: ${facts.map((f) => f.content).join("; ")}`);
      } catch { /* ignore malformed JSON */ }
    }
    if (latestSummary.open_tasks_json) {
      try {
        const tasks = JSON.parse(latestSummary.open_tasks_json) as Array<{ content: string }>;
        if (tasks.length > 0) parts.push(`미결: ${tasks.map((t) => t.content).join("; ")}`);
      } catch { /* ignore */ }
    }
    currentSessionSummary = parts.join("\n");
  }

  // Phase 1B.2 — Query active/eligible judgments for context injection.
  // Skipped for summary_generation (args.skipJudgments) to prevent durable
  // judgments from being persisted into memory_summaries as if they were
  // conversation-derived facts.
  // retention_state = 'normal' excludes archived/deleted rows.
  // Scope: inject only rows whose scope_json contains "global":true. Full
  // per-session/chat scope matching is deferred to a later sub-phase when a
  // scope resolver is available; global-scope judgments are universally
  // applicable and safe to inject without a resolver.
  const activeJudgments = args.skipJudgments ? [] : queryActiveGlobalJudgmentSlots(args.db);

  const snap = buildContext({
    mode: "replay_mode",
    user_message: args.userMessage ?? args.req.message,
    system_identity: args.systemIdentity ?? "actwyn personal agent",
    recent_turns: turns,
    memory_items: memItems,
    ...(activeJudgments.length > 0 ? { judgment_items: activeJudgments } : {}),
    ...(currentSessionSummary ? { current_session_summary: currentSessionSummary } : {}),
  });

  try {
    const packed = pack(snap, { total_budget_tokens: 6000 });
    return {
      packedMessage: args.redactor.apply(renderAsMessage(packed)).text,
      snapshotJson: args.redactor.apply(serializeForProviderRun(packed)).text,
    };
  } catch (e) {
    // HLD §10.3 rule 2: PromptOverflowError must propagate so the caller can
    // fail the job with a user-visible error. All other packing errors fall back
    // to bare user message to avoid blocking the queue.
    if (e instanceof PromptOverflowError) throw e;
    return fallback;
  }
}

function queryActiveGlobalJudgmentSlots(db: DbHandle): JudgmentItemSlot[] {
  return db
    .prepare<JudgmentItemSlot, []>(
      `SELECT id, kind, statement, authority_source, confidence
       FROM judgment_items
       WHERE lifecycle_status = 'active'
         AND activation_state = 'eligible'
         AND retention_state = 'normal'
         AND json_extract(scope_json, '$.global') = 1
         AND (valid_from IS NULL OR valid_from <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         AND (valid_until IS NULL OR valid_until > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ORDER BY importance DESC, created_at DESC
       LIMIT 20`,
    )
    .all();
}

function insertProviderRunStart(args: {
  db: DbHandle;
  id: string;
  jobId: string;
  sessionId: string;
  provider: string;
  req: AgentRequest;
  packingMode: "resume_mode" | "replay_mode";
  redactor: Redactor;
  snapshotJson: string;
}): void {
  const argvRedacted = JSON.stringify(args.redactor.applyToJson({
    message: args.req.message,
    channel: args.req.channel,
  }));
  args.db
    .prepare<
      unknown,
      [string, string, string, string, string, string, string]
    >(
      `INSERT INTO provider_runs
         (id, job_id, session_id, provider, context_packing_mode, status,
          argv_json_redacted, cwd, injected_snapshot_json, parser_status)
       VALUES(?, ?, ?, ?, ?, 'started', ?, '.', ?, 'parsed')`,
    )
    .run(args.id, args.jobId, args.sessionId, args.provider, args.packingMode, argvRedacted, args.snapshotJson);
}

async function runStorageSyncJob(deps: WorkerDeps, job: ClaimedJob): Promise<RunResult> {
  if (!deps.s3 || !deps.config.sync) {
    // No S3 transport configured — noop so the queue keeps moving.
    return commitSystemNoop(deps, job);
  }

  const capacity = await readStorageCapacityForWorker(deps);
  const batchLimit = reducedSyncBatchLimit(capacity, deps.config.sync.max_uploads_per_pass);
  const syncDeps = {
    db: deps.db,
    transport: deps.s3,
    events: deps.events,
    config: {
      ...deps.config.sync,
      ...(batchLimit !== undefined ? { max_uploads_per_pass: batchLimit } : {}),
    },
  };

  let uploadResult: { uploaded: number; failed: number; local_missing: number };
  let deleteResult: { deleted: number; delete_failed: number; local_only_deleted: number };
  let schedulerResult: { repended: number; exhausted: number; delete_repended: number; delete_exhausted: number } = {
    repended: 0,
    exhausted: 0,
    delete_repended: 0,
    delete_exhausted: 0,
  };
  try {
    schedulerResult = runRetryScheduler(syncDeps);
    uploadResult = await runUploadPass(syncDeps);
    deleteResult = await runDeletePass(syncDeps);
  } catch (e) {
    deps.db
      .prepare<unknown, [string, string]>(
        `UPDATE jobs
         SET status = 'failed',
             finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             error_json = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(JSON.stringify({ error_type: "sync_pass_threw", message: (e as Error).message.slice(0, 200) }), job.id);
    return { job_id: job.id, terminal: "failed", turn_id: null, provider_run_id: "" };
  }

  const result_json = JSON.stringify({
    uploaded: uploadResult.uploaded,
    upload_failed: uploadResult.failed,
    local_missing: uploadResult.local_missing,
    deleted: deleteResult.deleted,
    delete_failed: deleteResult.delete_failed,
    local_only_deleted: deleteResult.local_only_deleted,
    retry_scheduler_repended: schedulerResult.repended,
    retry_scheduler_exhausted: schedulerResult.exhausted,
    retry_scheduler_delete_repended: schedulerResult.delete_repended,
    retry_scheduler_delete_exhausted: schedulerResult.delete_exhausted,
  });

  // Blocker 5: if retryable failures remain after this pass, mark the job
  // failed with safe_retry=true so the queue re-runs it. This ensures failed
  // storage rows are eventually retried without relying on an external trigger.
  // The owning provider_run is never touched — its success stands independently.
  const retryableFailures =
    uploadResult.failed + uploadResult.local_missing + deleteResult.delete_failed;
  if (retryableFailures > 0) {
    deps.db
      .prepare<unknown, [string, string]>(
        `UPDATE jobs
         SET status = 'failed',
             finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             result_json = ?,
             safe_retry = 1
         WHERE id = ? AND status = 'running'`,
      )
      .run(result_json, job.id);
    deps.events.warn("queue.job.storage_sync.partial_failure", {
      job_id: job.id,
      upload_failed: uploadResult.failed,
      local_missing: uploadResult.local_missing,
      delete_failed: deleteResult.delete_failed,
    });
    return { job_id: job.id, terminal: "failed", turn_id: null, provider_run_id: "" };
  }

  deps.db
    .prepare<unknown, [string, string]>(
      `UPDATE jobs
       SET status = 'succeeded',
           finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           result_json = ?
       WHERE id = ? AND status = 'running'`,
    )
    .run(result_json, job.id);
  deps.events.info("queue.job.storage_sync", {
    job_id: job.id,
    uploaded: uploadResult.uploaded,
    deleted: deleteResult.deleted,
  });
  return { job_id: job.id, terminal: "succeeded", turn_id: null, provider_run_id: "" };
}

function commitSystemNoop(deps: WorkerDeps, job: ClaimedJob): RunResult {
  deps.db
    .prepare<unknown, [string]>(
      `UPDATE jobs
       SET status = 'succeeded',
           finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           result_json = json_object('noop', 1)
       WHERE id = ? AND status = 'running'`,
    )
    .run(job.id);
  deps.events.info("queue.job.noop", { job_id: job.id, job_type: job.job_type });
  return { job_id: job.id, terminal: "succeeded", turn_id: null, provider_run_id: "" };
}

async function readStorageCapacityForWorker(
  deps: WorkerDeps,
): Promise<StorageCapacityReport | null> {
  if (!deps.doctor?.storage_capacity_check) return null;
  try {
    return await deps.doctor.storage_capacity_check();
  } catch (e) {
    return unknownStorageCapacityReport(e);
  }
}

// ---------------------------------------------------------------
// Auto-trigger summary (AC-MEM-005 / PRD §12.3)
// ---------------------------------------------------------------

function maybeEnqueueAutoSummary(
  deps: WorkerDeps,
  session_id: string,
  user_id: string,
  chat_id: string,
): void {
  try {
    const counts = deps.db
      .prepare<
        {
          total_turns: number;
          user_turns: number;
          total_chars: number;
          session_age_seconds: number;
          turns_since_last_summary: number;
          user_turns_since_last_summary: number;
        },
        [string, string]
      >(
        `WITH last_sum AS (
           SELECT COALESCE(MAX(created_at), '1970-01-01T00:00:00.000Z') AS ts
           FROM memory_summaries WHERE session_id = ?
         )
         SELECT
           COUNT(t.id) AS total_turns,
           SUM(CASE WHEN t.role = 'user' THEN 1 ELSE 0 END) AS user_turns,
           SUM(LENGTH(t.content_redacted)) AS total_chars,
           CAST((JULIANDAY('now') - JULIANDAY(s.started_at)) * 86400 AS INTEGER) AS session_age_seconds,
           SUM(CASE WHEN t.created_at > ls.ts THEN 1 ELSE 0 END) AS turns_since_last_summary,
           SUM(CASE WHEN t.role = 'user' AND t.created_at > ls.ts THEN 1 ELSE 0 END) AS user_turns_since_last_summary
         FROM turns t
         JOIN sessions s ON s.id = t.session_id
         CROSS JOIN last_sum ls
         WHERE t.session_id = ?`,
      )
      .get(session_id, session_id);

    if (!counts) return;

    const decision = shouldAutoTriggerSummary({
      turns_since_last_summary: counts.turns_since_last_summary ?? 0,
      transcript_estimated_tokens: Math.ceil((counts.total_chars ?? 0) / 4),
      session_age_seconds: counts.session_age_seconds ?? 0,
      user_turns_since_last_summary: counts.user_turns_since_last_summary ?? 0,
    });

    if (!decision.trigger) return;

    // Throttle: don't enqueue a second auto-summary if one is already pending.
    const pending = deps.db
      .prepare<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM jobs
         WHERE job_type = 'summary_generation' AND session_id = ?
           AND status IN ('queued', 'running')`,
      )
      .get(session_id);
    if ((pending?.n ?? 0) > 0) return;

    enqueueSummaryJob({
      db: deps.db,
      newId: deps.newId,
      session_id,
      user_id,
      chat_id,
      trigger: "auto",
    });
    deps.events.info("queue.summary.auto_enqueued", { session_id, reason: decision.reason });
  } catch (e) {
    // Non-fatal: auto-trigger failure must not affect the parent job's terminal status.
    deps.events.warn("queue.summary.auto_trigger_error", {
      session_id,
      error_message: (e as Error).message,
    });
  }
}

// ---------------------------------------------------------------
// AC-MEM-001: memory snapshot → local file + storage_sync enqueue
// ---------------------------------------------------------------

async function enqueueMemorySnapshotSync(
  deps: WorkerDeps,
  jobId: string,
  summaryId: string,
  summary: SummaryOutput,
): Promise<void> {
  const sync = deps.config.sync!;
  const content = JSON.stringify(summary) + "\n";
  const bytes = new TextEncoder().encode(content);
  const now = deps.now();
  const yyyy = now.getUTCFullYear().toString();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");

  // AC-MEM-001: write human-readable memory files per PRD §12 / HLD §11.2.
  // memory/sessions/<session_id>.jsonl — append-only JSONL per session.
  // memory/personal/YYYY-MM-DD.md — rolled-up daily markdown line.
  if (summary.session_id) {
    const memBase = deps.config.memory_base_path ?? dirname(sync.local_path("x")).replace(/\/[^/]+$/, "/memory");
    const sessionDir = join(memBase, "sessions");
    mkdirSync(sessionDir, { recursive: true });
    appendFileSync(join(sessionDir, `${summary.session_id}.jsonl`), content);

    const personalDir = join(memBase, "personal");
    mkdirSync(personalDir, { recursive: true });
    const mdLine = `<!-- ${yyyy}-${mm}-${dd} session=${summary.session_id} summary=${summaryId} -->\n`;
    appendFileSync(join(personalDir, `${yyyy}-${mm}-${dd}.md`), mdLine);
  }

  const capacity = await readStorageCapacityForWorker(deps);
  if (capacity && !capacity.long_term_writes_allowed) {
    deps.events.warn("memory.snapshot.storage_capacity_blocked", {
      job_id: jobId,
      summary_id: summaryId,
      capacity: capacity.detail,
    });
    return;
  }

  const sha256Buf = await crypto.subtle.digest("SHA-256", bytes);
  const sha256Hex = Array.from(new Uint8Array(sha256Buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const objectId = deps.newId();
  const storageKey = `objects/${yyyy}/${mm}/${dd}/${objectId}/${sha256Hex}.jsonl`;
  const localPath = sync.local_path(objectId);

  // Write S3 staging file (HLD §7.10: no blocking I/O inside transactions).
  mkdirSync(dirname(localPath), { recursive: true });
  writeFileSync(localPath, bytes);

  const bucket = sync.bucket ?? null;

  // Atomic: create storage_objects row + update summary FK + enqueue storage_sync.
  deps.db.tx<void>(() => {
    deps.db
      .prepare<unknown, [string, string | null, string, number, string, string]>(
        `INSERT INTO storage_objects
           (id, storage_backend, bucket, storage_key, mime_type, size_bytes, sha256,
            source_channel, source_job_id, artifact_type, retention_class,
            capture_status, status, captured_at)
         VALUES(?, 's3', ?, ?, 'application/jsonl', ?, ?,
                'system', ?, 'memory_snapshot', 'long_term',
                'captured', 'pending', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      )
      .run(objectId, bucket, storageKey, bytes.length, sha256Hex, jobId);

    deps.db
      .prepare<unknown, [string, string]>(
        `UPDATE memory_summaries SET storage_key = ? WHERE id = ?`,
      )
      .run(storageKey, summaryId);

    const syncJobId = deps.newId();
    deps.db
      .prepare<unknown, [string, string]>(
        `INSERT INTO jobs(id, status, job_type, request_json, idempotency_key)
         VALUES(?, 'queued', 'storage_sync', '{}', ?)
         ON CONFLICT(job_type, idempotency_key) DO NOTHING`,
      )
      .run(syncJobId, `sync:${objectId}`);
  });
}

// ---------------------------------------------------------------
// System command dispatch (local, no Claude subprocess)
// ---------------------------------------------------------------

const SYSTEM_COMMANDS = new Set([
  "/new",
  "/chat",
  "/help",
  "/status",
  "/cancel",
  "/doctor",
  "/whoami",
  "/provider",
  "/save_last_attachment",
  "/forget_last",
  "/forget_session",
  "/forget_artifact",
  "/forget_memory",
  "/correct",
  // Phase 1B.3 — Judgment System commands
  "/judgment",
  "/judgment_explain",
]);

function isSystemCommand(cmd: string): boolean {
  return SYSTEM_COMMANDS.has(cmd);
}

async function runSystemCommandJob(
  deps: WorkerDeps,
  job: ClaimedJob,
  command: string,
  args: string,
  _signal?: AbortSignal,
): Promise<RunResult> {
  let responseText: string;

  try {
    responseText = await dispatchSystemCommand(deps, job, command, args);
  } catch (e) {
    const errMsg = (e as Error).message;
    deps.db
      .prepare<unknown, [string, string]>(
        `UPDATE jobs
         SET status = 'failed',
             finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             error_json = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(JSON.stringify({ error_type: "command_threw", message: errMsg.slice(0, 200) }), job.id);
    return { job_id: job.id, terminal: "failed", turn_id: null, provider_run_id: "" };
  }

  // Persist a turn for conversational context replay and summaries.
  // Phase 1B.3: judgment commands (/judgment, /judgment_explain) are EXCLUDED
  // from turn storage. Their output contains judgment statements that would
  // flow into context replay and summaries even after revoke/expire. Notification
  // retry uses outbound_notification_chunks, not turns, so omitting the turn
  // is safe.
  // Review Medium 11: the redaction_applied flag must reflect whether the
  // stored `content_redacted` was actually rewritten by the redactor, not a
  // hard-coded zero.
  const JUDGMENT_COMMANDS_NO_TURN = new Set(["/judgment", "/judgment_explain"]);
  let turnId: string | null = null;
  if (job.session_id && responseText.length > 0 && !JUDGMENT_COMMANDS_NO_TURN.has(command)) {
    turnId = deps.newId();
    const redactedResult = deps.redactor.apply(responseText);
    deps.db
      .prepare<unknown, [string, string, string, string, number]>(
        `INSERT INTO turns(id, session_id, job_id, role, content_redacted, redaction_applied)
         VALUES(?, ?, ?, 'assistant', ?, ?)`,
      )
      .run(
        turnId,
        job.session_id,
        job.id,
        redactedResult.text,
        redactedResult.replacements > 0 ? 1 : 0,
      );
  }

  deps.db
    .prepare<unknown, [string, string]>(
      `UPDATE jobs
       SET status = 'succeeded',
           finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           result_json = ?
       WHERE id = ? AND status = 'running'`,
    )
    .run(JSON.stringify({ command, response_length: responseText.length }), job.id);

  deps.events.info("queue.job.system_command", { job_id: job.id, command });

  if (deps.outbound && job.chat_id && responseText.length > 0) {
    // /doctor responses use the 'doctor' notification type (PRD §13.3 DEC-012).
    const cmdNotifType: NotificationType = command === "/doctor" ? "doctor" : "job_completed";
    const created = createNotificationAndChunks({
      db: deps.db,
      newId: deps.newId,
      args: {
        job_id: job.id,
        chat_id: job.chat_id,
        notification_type: cmdNotifType,
        text: responseText,
        chunk_size: deps.config.notifications?.chunk_size,
      },
    });
    let retryNeeded = false;
    try {
      const sendResult = await sendNotification(
        { db: deps.db, transport: deps.outbound, events: deps.events },
        created.notification_id,
        created.chunks,
      );
      retryNeeded = sendResult.roll_up_status !== "sent";
    } catch {
      retryNeeded = true;
    }
    if (retryNeeded) {
      enqueueNotificationRetryJob(deps, created.notification_id, job.chat_id);
    }
  }

  return { job_id: job.id, terminal: "succeeded", turn_id: turnId, provider_run_id: "" };
}

async function dispatchSystemCommand(
  deps: WorkerDeps,
  job: ClaimedJob,
  command: string,
  args: string,
): Promise<string> {
  switch (command) {
    case "/new":
    case "/chat": {
      // End the current session so the next message starts a fresh one.
      if (job.session_id) {
        endSession(deps.db, job.session_id);
      }
      return "새 세션을 시작합니다. 다음 메시지부터 새 대화가 시작됩니다.";
    }

    case "/help": {
      // Look up current session + provider for the header (PRD §8.1).
      let sessionLine = "";
      let providerLine = "";
      if (job.session_id) {
        sessionLine = `\nsession: ${job.session_id.slice(0, 6)}`;
        const lastRun = deps.db
          .prepare<{ provider: string; context_packing_mode: string }, [string]>(
            `SELECT provider, context_packing_mode FROM provider_runs
             WHERE session_id = ? ORDER BY started_at DESC LIMIT 1`,
          )
          .get(job.session_id);
        if (lastRun) {
          providerLine = `\nprovider: ${lastRun.provider} · ${lastRun.context_packing_mode}`;
        }
      }
      return [
        `사용 가능한 명령어:${sessionLine}${providerLine}`,
        "/new · /chat — 새 세션 시작",
        "/status — 큐 상태 확인",
        "/cancel — 실행 중인 작업 취소",
        "/summary — 현재 세션 요약 생성",
        "/end — 세션 종료 및 요약",
        "/provider <name> — provider 전환 (P0: claude만 활성)",
        "/doctor — 시스템 상태 진단",
        "/whoami — 내 Telegram user_id 확인",
        "/save_last_attachment — 마지막 첨부파일을 long_term으로 저장",
        "/forget_last — 직전 기억/파일 비활성화",
        "/forget_session — 현재 세션 메모리 비활성화",
        "/forget_artifact <id> — 특정 아티팩트 삭제",
        "/forget_memory <id> — 특정 메모리 비활성화",
        "/correct <id> <새 내용> — 메모리 정정",
        "/judgment — 활성 판단(judgment) 목록",
        "/judgment_explain <id> — 특정 판단 상세 조회",
      ].join("\n");
    }

    case "/status": {
      const capacity = await readStorageCapacityForWorker(deps);
      const report = buildStatusReport(deps.db, {
        session_id: job.session_id,
        chat_id: job.chat_id,
        storage_capacity: capacity,
        now: deps.now,
      });
      return formatStatus(report);
    }

    case "/cancel": {
      const cancelArgs = job.session_id
        ? { session_id: job.session_id, deps: { running_cancel_handles: deps.runningCancelHandles } }
        : { deps: { running_cancel_handles: deps.runningCancelHandles } };
      const outcome = cancelJob(deps.db, cancelArgs);
      // For a queued job that was just cancelled, enqueue a job_cancelled
      // notification for the cancelled job (HLD §6.2 / PRD §13.3 DEC-012).
      // The running-job case is handled by the worker when teardown completes.
      if (outcome.kind === "cancelled_queued" && deps.outbound && job.chat_id) {
        const cancelNotif = createNotificationAndChunks({
          db: deps.db,
          newId: deps.newId,
          args: {
            job_id: outcome.job_id,
            chat_id: job.chat_id,
            notification_type: "job_cancelled",
            text: "작업이 취소됐습니다.",
            chunk_size: deps.config.notifications?.chunk_size,
          },
        });
        let cancelRetryNeeded = false;
        try {
          const cancelSendResult = await sendNotification(
            { db: deps.db, transport: deps.outbound, events: deps.events },
            cancelNotif.notification_id,
            cancelNotif.chunks,
          );
          cancelRetryNeeded = cancelSendResult.roll_up_status !== "sent";
        } catch {
          cancelRetryNeeded = true;
        }
        if (cancelRetryNeeded) {
          enqueueNotificationRetryJob(deps, cancelNotif.notification_id, job.chat_id!);
        }
      }
      switch (outcome.kind) {
        case "cancelled_queued": return `취소됐습니다 (job_id=${outcome.job_id}).`;
        case "cancel_signalled": return `실행 중인 작업에 취소 신호를 보냈습니다 (job_id=${outcome.job_id}).`;
        case "cancel_unavailable":
          return `실행 중인 작업을 이 프로세스에서 취소할 수 없습니다 (job_id=${outcome.job_id}). /status 로 상태를 확인하세요.`;
        case "not_found": return "취소할 활성 작업이 없습니다.";
        case "terminal": return `작업은 이미 종료됐습니다 (status=${outcome.status}).`;
      }
      break;
    }

    case "/doctor": {
      const doctorDeps: DoctorDeps = {
        db: deps.db,
        required_bun_version: deps.doctor?.required_bun_version ?? Bun.version,
        current_bun_version: deps.doctor?.current_bun_version ?? Bun.version,
        bootstrap_whoami: deps.doctor?.bootstrap_whoami ?? false,
        ...(deps.doctor?.expected_schema_version !== undefined
          ? { expected_schema_version: deps.doctor.expected_schema_version } : {}),
        ...(deps.doctor?.pinned_claude_version
          ? { pinned_claude_version: deps.doctor.pinned_claude_version } : {}),
        ...(deps.doctor?.stale_threshold_ms !== undefined
          ? { stale_threshold_ms: deps.doctor.stale_threshold_ms } : {}),
        ...(deps.doctor?.config_ok ? { config_ok: deps.doctor.config_ok } : {}),
        ...(deps.doctor?.redaction_self_test
          ? { redaction_self_test: deps.doctor.redaction_self_test } : {}),
        ...(deps.doctor?.telegram_ping ? { telegram_ping: deps.doctor.telegram_ping } : {}),
        ...(deps.doctor?.s3_ping ? { s3_ping: deps.doctor.s3_ping } : {}),
        ...(deps.doctor?.claude_version ? { claude_version: deps.doctor.claude_version } : {}),
        ...(deps.doctor?.storage_capacity_check
          ? { storage_capacity_check: deps.doctor.storage_capacity_check } : {}),
        ...(deps.doctor?.disk_check ? { disk_check: deps.doctor.disk_check } : {}),
        ...(deps.doctor?.claude_lockdown_smoke
          ? { claude_lockdown_smoke: deps.doctor.claude_lockdown_smoke } : {}),
        ...(deps.doctor?.subprocess_teardown_smoke
          ? { subprocess_teardown_smoke: deps.doctor.subprocess_teardown_smoke } : {}),
      };
      const results = await runDoctor(doctorDeps);
      const lines = results.map((r) => {
        const icon = r.status === "ok" ? "✓" : r.status === "warn" ? "⚠" : "✗";
        const detail = r.detail ? `: ${r.detail}` : "";
        return `${icon} [${r.category}] ${r.name} (${r.duration_ms}ms)${detail}`;
      });
      return lines.join("\n");
    }

    case "/whoami": {
      const reply = whoamiReply({
        user_id: job.user_id,
        chat_id: job.chat_id,
        bootstrap: deps.doctor?.bootstrap_whoami ?? false,
      });
      return reply.text;
    }

    case "/provider": {
      const result = switchProvider({ requested: args });
      return result.message;
    }

    case "/save_last_attachment": {
      if (!job.session_id) return "활성 세션이 없습니다.";
      const capacity = await readStorageCapacityForWorker(deps);
      const result = saveLastAttachment({
        db: deps.db,
        newId: deps.newId,
        session_id: job.session_id,
        caption: args || undefined,
        storage_capacity: capacity,
      });
      if (result.blocked_reason === "storage_capacity_critical") {
        return `저장하지 않았습니다: 디스크 용량 임계치 때문에 long_term 저장이 차단됐습니다. ${result.blocked_detail ?? ""}`;
      }
      if (result.promoted && result.storage_object_id) {
        const artType = result.artifact_type ?? "user_upload";
        const shortId = result.storage_object_id.slice(0, 8);
        return `저장함: ${artType} · ${shortId} · long_term`;
      }
      return "저장할 수 있는 첨부 파일이 없습니다.";
    }

    case "/forget_artifact": {
      const id = args.trim();
      if (!id) return "사용법: /forget_artifact <storage_object_id>";
      const result = forgetArtifact(deps.db, id, { newId: deps.newId });
      return result.affected > 0
        ? `아티팩트(${id})를 삭제 예약했습니다.`
        : "해당 아티팩트를 찾을 수 없거나 이미 삭제됐습니다.";
    }

    case "/forget_memory": {
      const id = args.trim();
      if (!id) return "사용법: /forget_memory <memory_id>";
      const result = forgetMemory(deps.db, id);
      return result.affected > 0 ? `메모리 항목(${id})을 취소했습니다.` : "해당 메모리 항목을 찾을 수 없습니다.";
    }

    case "/forget_session": {
      if (!job.session_id) return "활성 세션이 없습니다.";
      const result = forgetSession(deps.db, job.session_id);
      return result.affected > 0
        ? `세션 memory 항목을 revoked 처리했습니다. 저장된 artifact 파일은 삭제하지 않았습니다. 파일 삭제가 필요하면 /forget_artifact <id>를 사용하세요.`
        : "비활성화할 memory 항목이 없습니다.";
    }

    case "/forget_last": {
      if (!job.session_id) return "활성 세션이 없습니다.";
      const result = forgetLast(deps.db, job.session_id);
      return result.affected > 0
        ? `마지막 기억 링크를 해제했습니다. 파일 자체 삭제가 필요하면 /forget_artifact <id>를 사용하세요.`
        : "해제할 기억 링크 또는 memory 항목이 없습니다.";
    }

    case "/correct": {
      const parts = args.trim().split(/\s+/);
      const oldId = parts[0];
      if (!oldId) return "사용법: /correct <memory_id> <새로운 내용>";
      const newContent = parts.slice(1).join(" ").trim();
      if (!newContent) return "사용법: /correct <memory_id> <새로운 내용>";
      const existing = deps.db
        .prepare<
          { session_id: string; item_type: string; provenance: string; confidence: number },
          [string]
        >("SELECT session_id, item_type, provenance, confidence FROM memory_items WHERE id = ?")
        .get(oldId);
      if (!existing) return `메모리 항목(${oldId})을 찾을 수 없습니다.`;
      const sessionId = job.session_id ?? existing.session_id;
      try {
        const newMemId = deps.newId();
        correctMemory(deps.db, {
          old_id: oldId,
          new_id: newMemId,
          new_item: {
            session_id: sessionId,
            item_type: existing.item_type as import("~/memory/items.ts").ItemType,
            content: newContent,
            provenance: "user_stated",
            confidence: 1.0,
            source_turn_ids: [],
          },
        });
        // PRD §8.4 footer: 정정함: <old_id> → <new_id>
        return `정정함: ${oldId} → ${newMemId}`;
      } catch (e) {
        return `수정 실패: ${(e as Error).message}`;
      }
    }

    // Phase 1B.3 — Judgment System commands
    case "/judgment": {
      const result = executeJudgmentQueryTool(deps.db, {
        lifecycle_status: "active",
        activation_state: "eligible",
        limit: 50,
      });
      if (!result.ok) return `판단 조회 실패: ${result.error.message}`;
      // Apply the same temporal validity filter as context injection so the command
      // and the provider context agree on what is "currently active".
      const nowIso = new Date().toISOString();
      const items = result.result.items.filter(
        (j) =>
          (j.valid_from == null || j.valid_from <= nowIso) &&
          (j.valid_until == null || j.valid_until > nowIso),
      );
      if (items.length === 0) return "활성 판단(judgment)이 없습니다.";
      const lines = items.map(
        (j) => `[${j.id.slice(0, 8)}] (${j.kind}/${j.confidence}) ${j.statement}`,
      );
      return `활성 판단 ${items.length}건:\n${lines.join("\n")}`;
    }

    case "/judgment_explain": {
      const id = args.trim();
      if (!id) return "사용법: /judgment_explain <judgment_id>";
      const result = executeJudgmentExplainTool(deps.db, { judgment_id: id });
      if (!result.ok) {
        return result.error.code === "not_found"
          ? `판단(${id})을 찾을 수 없습니다.`
          : `설명 조회 실패: ${result.error.message}`;
      }
      const j = result.explanation;
      const sourceCount = j.sources.length;
      const evidenceCount = j.evidence_links.length;
      const eventCount = j.events.length;
      return [
        `[${j.judgment.kind}] ${j.judgment.statement}`,
        `상태: ${j.judgment.lifecycle_status} / ${j.judgment.activation_state} / 신뢰도: ${j.judgment.confidence}`,
        `근원: ${j.judgment.epistemic_origin} / 권위: ${j.judgment.authority_source}`,
        `소스 ${sourceCount}건 · 증거링크 ${evidenceCount}건 · 이벤트 ${eventCount}건`,
      ].join("\n");
    }

    default:
      return `알 수 없는 시스템 명령: ${command}`;
  }
  return "";
}

// ---------------------------------------------------------------
// Notification retry job dispatch
// ---------------------------------------------------------------

async function runNotificationRetryJob(deps: WorkerDeps, job: ClaimedJob): Promise<RunResult> {
  if (!deps.outbound) {
    return commitSystemNoop(deps, job);
  }

  const req = JSON.parse(job.request_json) as { notification_id?: string };
  if (!req.notification_id) {
    return commitSystemNoop(deps, job);
  }

  const retryResult = await retryNotificationFromLedger({
    db: deps.db,
    transport: deps.outbound,
    events: deps.events,
    chunk_size: deps.config.notifications?.chunk_size,
    max_attempts_per_chunk: deps.config.notifications?.max_attempts_per_chunk,
    retry_job_id: job.id,
  }, req.notification_id);
  if (!retryResult) {
    return commitSystemNoop(deps, job);
  }

  if (retryResult.retry_outcome === "retry_scheduled" && retryResult.chat_id) {
    enqueueNotificationRetryJob(deps, req.notification_id, retryResult.chat_id, job.id);
  }

  deps.db
    .prepare<unknown, [string, string]>(
      `UPDATE jobs
       SET status = 'succeeded',
           finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           result_json = ?
       WHERE id = ? AND status = 'running'`,
    )
    .run(
      JSON.stringify({
        notification_id: req.notification_id,
        chunks_attempted: retryResult.chunks_attempted,
        roll_up_status: retryResult.roll_up_status,
        retry_outcome: retryResult.retry_outcome,
        retryable_chunks: retryResult.retryable_chunks,
      }),
      job.id,
    );
  deps.events.info("queue.job.notification_retry", {
    job_id: job.id,
    notification_id: req.notification_id,
    roll_up_status: retryResult.roll_up_status,
    retry_outcome: retryResult.retry_outcome,
  });
  return { job_id: job.id, terminal: "succeeded", turn_id: null, provider_run_id: "" };
}

function enqueueNotificationRetryJob(
  deps: WorkerDeps,
  notification_id: string,
  chat_id: string,
  from_job_id?: string,
): void {
  // When re-enqueuing from within a retry job, append the current job's id so the
  // new key doesn't conflict with the completed retry row still in the jobs table.
  const idempotencyKey = from_job_id
    ? `notif-retry:${notification_id}:from:${from_job_id}`
    : `notif-retry:${notification_id}`;
  deps.db
    .prepare<unknown, [string, string, string, string]>(
      `INSERT INTO jobs(id, status, job_type, chat_id, request_json, idempotency_key)
       VALUES(?, 'queued', 'notification_retry', ?, ?, ?)
       ON CONFLICT(job_type, idempotency_key) DO NOTHING`,
    )
    .run(deps.newId(), chat_id, JSON.stringify({ notification_id }), idempotencyKey);
  deps.events.info("queue.job.notification_retry.enqueued", { notification_id });
}
