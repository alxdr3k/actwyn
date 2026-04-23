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
import { forgetArtifact, forgetLast, forgetMemory, forgetSession } from "~/commands/forget.ts";
import { saveLastAttachment } from "~/commands/save.ts";
import { switchProvider } from "~/commands/provider.ts";
import { whoamiReply } from "~/commands/whoami.ts";
import { endSession, enqueueSummaryJob } from "~/commands/summary.ts";
import { shouldAutoTriggerSummary, writeSummary, type SummaryOutput } from "~/memory/summary.ts";
import { buildContext, type MemoryItemSlot, type TurnSlot } from "~/context/builder.ts";
import { pack, serializeForProviderRun } from "~/context/packer.ts";
import { runUploadPass, runDeletePass, type SyncConfig } from "~/storage/sync.ts";
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
  splitForTelegram,
  type NotificationType,
  type OutboundTransport,
} from "~/telegram/outbound.ts";

export interface WorkerConfig {
  readonly capture: CaptureConfig;
  readonly poll_interval_ms?: number | undefined;
  readonly notifications?: {
    readonly chunk_size?: number | undefined;
  } | undefined;
  /** Optional S3 sync config. When present, storage_sync jobs run the upload/delete pass. */
  readonly sync?: SyncConfig | undefined;
}

export interface WorkerDeps {
  readonly db: DbHandle;
  readonly redactor: Redactor;
  readonly events: EventEmitter;
  readonly adapter: ProviderAdapter;
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
  readonly doctor?: Pick<DoctorDeps, "required_bun_version" | "current_bun_version" | "bootstrap_whoami" | "telegram_ping" | "s3_ping" | "claude_version"> | undefined;
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

  const priorSessionId = job.session_id
    ? queryPriorProviderSessionId(deps.db, job.session_id)
    : null;
  const request = parseRequest(job, capture.attachments, priorSessionId);
  const providerRunId = deps.newId();
  const packingMode = priorSessionId ? "resume_mode" : "replay_mode";
  insertProviderRunStart({
    db: deps.db,
    id: providerRunId,
    jobId: job.id,
    sessionId: job.session_id ?? "",
    provider: deps.adapter.name,
    req: request,
    packingMode,
    redactor: deps.redactor,
  });

  const outcome = await safeRun(deps.adapter, request, signal, (pgid) => {
    deps.db
      .prepare<unknown, [number, string]>(
        `UPDATE provider_runs SET process_group_id = ? WHERE id = ?`,
      )
      .run(pgid, providerRunId);
  });

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

  deps.db.tx<void>(() => {
    const providerSessionIdFromRun =
      outcome.kind === "succeeded" && outcome.response.session_id
        ? outcome.response.session_id
        : null;
    deps.db
      .prepare<unknown, [string, string | null, string | null, string | null, string]>(
        `UPDATE provider_runs
         SET status = ?,
             error_type = ?,
             finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             parser_status = ?,
             provider_session_id = ?
         WHERE id = ?`,
      )
      .run(
        terminalRunStatus,
        outcome.response.error_type ?? null,
        outcome.response.parser_status,
        providerSessionIdFromRun,
        providerRunId,
      );

    if (finalText.length > 0 && job.session_id) {
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
    const error_json =
      outcome.kind === "failed"
        ? JSON.stringify({
            error_type: outcome.error_type,
            exit_code: outcome.response.exit_code,
          })
        : outcome.kind === "cancelled"
          ? JSON.stringify({ error_type: "cancelled" })
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
      terminalJobStatus === "succeeded" &&
      job.session_id
    ) {
      // Attempt to parse structured summary output from Claude's response.
      if (finalText.length > 0) {
        try {
          const raw = JSON.parse(finalText) as SummaryOutput;
          writeSummary({
            db: deps.db,
            newId: deps.newId,
            summary: { ...raw, session_id: job.session_id },
          });
        } catch {
          // Non-fatal: unstructured output is stored as a turn but not as a memory_summaries row.
        }
      }
      const req = JSON.parse(job.request_json) as { command?: string; trigger?: string };
      if (req.command === "/end" || req.trigger === "explicit_end") {
        endSession(deps.db, job.session_id);
      }
    }
  });

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

  // Outbound notification (optional at the worker level; wired by
  // Phase 5 tests + prod). Chunk creation is atomic with the
  // parent row insert (HLD §6.3); the send pass itself is async
  // and outside that txn.
  if (deps.outbound && job.chat_id) {
    const notificationType: NotificationType =
      outcome.kind === "succeeded"
        ? "job_completed"
        : outcome.kind === "cancelled"
          ? "job_cancelled"
          : "job_failed";
    const text = buildNotificationText(outcome.kind, outcome.response.final_text);
    const created = createNotificationAndChunks({
      db: deps.db,
      newId: deps.newId,
      args: {
        job_id: job.id,
        chat_id: job.chat_id,
        notification_type: notificationType,
        text,
        chunk_size: deps.config.notifications?.chunk_size,
      },
    });
    let retryNeeded = false;
    try {
      const sendResult = await sendNotification(
        {
          db: deps.db,
          transport: deps.outbound,
          events: deps.events,
        },
        created.notification_id,
        created.chunks,
      );
      retryNeeded = sendResult.roll_up_status !== "sent";
    } catch (e) {
      deps.events.warn("telegram.outbound.pass_error", {
        job_id: job.id,
        notification_id: created.notification_id,
        error_type: (e as Error).name,
        error_message: (e as Error).message,
      });
      // Do NOT roll back jobs.status or provider_runs.status here —
      // Provider success stands independently of delivery (AC-NOTIF-001).
      retryNeeded = true;
    }
    if (retryNeeded) {
      enqueueNotificationRetryJob(deps, created.notification_id, job.chat_id!);
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

function buildNotificationText(
  kind: "succeeded" | "failed" | "cancelled",
  finalText: string,
): string {
  if (kind === "succeeded") {
    return finalText.length > 0 ? finalText : "(empty response)";
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
  onSpawn?: (pgid: number) => void,
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

function buildContextSnapshot(args: {
  db: DbHandle;
  sessionId: string;
  req: AgentRequest;
  redactor: Redactor;
}): string {
  if (!args.sessionId) {
    return JSON.stringify({ attachments: args.req.attachments ?? [], session_id: "" });
  }

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

  // Include the latest session summary if available.
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

  const snap = buildContext({
    mode: "replay_mode",
    user_message: args.req.message,
    system_identity: "actwyn personal agent",
    recent_turns: turns,
    memory_items: memItems,
    ...(currentSessionSummary ? { current_session_summary: currentSessionSummary } : {}),
  });

  try {
    const packed = pack(snap, { total_budget_tokens: 6000 });
    return args.redactor.apply(serializeForProviderRun(packed)).text;
  } catch {
    return JSON.stringify({ attachments: args.req.attachments ?? [], session_id: args.sessionId });
  }
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
}): void {
  const argvRedacted = JSON.stringify(args.redactor.applyToJson({
    message: args.req.message,
    channel: args.req.channel,
  }));
  const snapshot = buildContextSnapshot(args);
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
    .run(args.id, args.jobId, args.sessionId, args.provider, args.packingMode, argvRedacted, snapshot);
}

async function runStorageSyncJob(deps: WorkerDeps, job: ClaimedJob): Promise<RunResult> {
  if (!deps.s3 || !deps.config.sync) {
    // No S3 transport configured — noop so the queue keeps moving.
    return commitSystemNoop(deps, job);
  }

  const syncDeps = {
    db: deps.db,
    transport: deps.s3,
    events: deps.events,
    config: deps.config.sync,
  };

  let uploadResult: { uploaded: number; failed: number; local_missing: number };
  let deleteResult: { deleted: number; delete_failed: number; local_only_deleted: number };
  try {
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
  });
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
// System command dispatch (local, no Claude subprocess)
// ---------------------------------------------------------------

const SYSTEM_COMMANDS = new Set([
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

  // Persist a turn so the notification retry can reconstruct chunk texts.
  let turnId: string | null = null;
  if (job.session_id && responseText.length > 0) {
    turnId = deps.newId();
    const redacted = deps.redactor.apply(responseText).text;
    deps.db
      .prepare<unknown, [string, string, string, string]>(
        `INSERT INTO turns(id, session_id, job_id, role, content_redacted, redaction_applied)
         VALUES(?, ?, ?, 'assistant', ?, 0)`,
      )
      .run(turnId, job.session_id, job.id, redacted);
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
    const created = createNotificationAndChunks({
      db: deps.db,
      newId: deps.newId,
      args: {
        job_id: job.id,
        chat_id: job.chat_id,
        notification_type: "job_completed",
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
    case "/status": {
      const report = buildStatusReport(deps.db);
      return formatStatus(report);
    }

    case "/cancel": {
      const cancelArgs = job.session_id
        ? { session_id: job.session_id }
        : {};
      const outcome = cancelJob(deps.db, cancelArgs);
      switch (outcome.kind) {
        case "cancelled_queued": return `취소됐습니다 (job_id=${outcome.job_id}).`;
        case "cancel_signalled": return `실행 중인 작업에 취소 신호를 보냈습니다 (job_id=${outcome.job_id}).`;
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
        ...(deps.doctor?.telegram_ping ? { telegram_ping: deps.doctor.telegram_ping } : {}),
        ...(deps.doctor?.s3_ping ? { s3_ping: deps.doctor.s3_ping } : {}),
        ...(deps.doctor?.claude_version ? { claude_version: deps.doctor.claude_version } : {}),
      };
      const results = await runDoctor(doctorDeps);
      const lines = results.map((r) =>
        `${r.status === "ok" ? "✓" : r.status === "warn" ? "⚠" : "✗"} ${r.name}${r.detail ? `: ${r.detail}` : ""}`,
      );
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
      const result = saveLastAttachment({
        db: deps.db,
        newId: deps.newId,
        session_id: job.session_id,
        caption: args || undefined,
      });
      return result.promoted
        ? `첨부 파일을 저장했습니다 (id=${result.storage_object_id}).`
        : "저장할 수 있는 첨부 파일이 없습니다.";
    }

    case "/forget_artifact": {
      const id = args.trim();
      if (!id) return "사용법: /forget_artifact <storage_object_id>";
      const result = forgetArtifact(deps.db, id);
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
      return result.affected > 0 ? `세션의 모든 아티팩트를 삭제 예약했습니다.` : "삭제할 아티팩트가 없습니다.";
    }

    case "/forget_last": {
      if (!job.session_id) return "활성 세션이 없습니다.";
      const result = forgetLast(deps.db, job.session_id);
      return result.affected > 0 ? `마지막 아티팩트를 삭제 예약했습니다.` : "삭제할 아티팩트가 없습니다.";
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

  const notif = deps.db
    .prepare<{ job_id: string }, [string]>(
      "SELECT job_id FROM outbound_notifications WHERE id = ?",
    )
    .get(req.notification_id);
  if (!notif) {
    return commitSystemNoop(deps, job);
  }

  // Recover chunk texts from the assistant turn for this notification's job.
  const turn = deps.db
    .prepare<{ content_redacted: string }, [string]>(
      "SELECT content_redacted FROM turns WHERE job_id = ? AND role = 'assistant' ORDER BY created_at ASC LIMIT 1",
    )
    .get(notif.job_id);
  const chunks = turn ? splitForTelegram(turn.content_redacted) : [];

  if (chunks.length > 0) {
    try {
      await sendNotification(
        { db: deps.db, transport: deps.outbound, events: deps.events },
        req.notification_id,
        chunks,
      );
    } catch (e) {
      deps.events.warn("telegram.outbound.retry_error", {
        job_id: job.id,
        notification_id: req.notification_id,
        error_message: (e as Error).message,
      });
    }
  }

  deps.db
    .prepare<unknown, [string, string]>(
      `UPDATE jobs
       SET status = 'succeeded',
           finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           result_json = ?
       WHERE id = ? AND status = 'running'`,
    )
    .run(JSON.stringify({ notification_id: req.notification_id, chunks_attempted: chunks.length }), job.id);
  deps.events.info("queue.job.notification_retry", { job_id: job.id, notification_id: req.notification_id });
  return { job_id: job.id, terminal: "succeeded", turn_id: null, provider_run_id: "" };
}

function enqueueNotificationRetryJob(
  deps: WorkerDeps,
  notification_id: string,
  chat_id: string,
): void {
  const idempotencyKey = `notif-retry:${notification_id}`;
  deps.db
    .prepare<unknown, [string, string, string, string]>(
      `INSERT INTO jobs(id, status, job_type, chat_id, request_json, idempotency_key)
       VALUES(?, 'queued', 'notification_retry', ?, ?, ?)
       ON CONFLICT(job_type, idempotency_key) DO NOTHING`,
    )
    .run(deps.newId(), chat_id, JSON.stringify({ notification_id }), idempotencyKey);
  deps.events.info("queue.job.notification_retry.enqueued", { notification_id });
}
