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
import {
  captureOne,
  commitCaptureFailure,
  commitCaptureSuccess,
  pendingCapturesForJob,
  type CaptureConfig,
  type MimeProbe,
  type TelegramFileTransport,
} from "~/telegram/attachment_capture.ts";

export interface WorkerConfig {
  readonly capture: CaptureConfig;
  readonly poll_interval_ms?: number;
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

  if (job.job_type !== "provider_run" && job.job_type !== "summary_generation") {
    // Phase 4 only wires provider_run / summary_generation to an adapter.
    // Other job types become succeeded no-ops here — Phase 9 wires
    // storage_sync, Phase 5 wires notification_retry. Recording a
    // provider_runs row for these would violate the invariant that
    // only provider subprocess work lives there, so we commit a
    // succeeded terminal without one.
    return commitSystemNoop(deps, job);
  }

  const request = parseRequest(job, capture.attachments);
  const providerRunId = deps.newId();
  insertProviderRunStart({
    db: deps.db,
    id: providerRunId,
    jobId: job.id,
    sessionId: job.session_id ?? "",
    provider: deps.adapter.name,
    req: request,
    redactor: deps.redactor,
  });

  const outcome = await safeRun(deps.adapter, request, signal);

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
    deps.db
      .prepare<unknown, [string, string | null, string | null, string]>(
        `UPDATE provider_runs
         SET status = ?,
             error_type = ?,
             finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             parser_status = ?
         WHERE id = ?`,
      )
      .run(
        terminalRunStatus,
        outcome.response.error_type ?? null,
        outcome.response.parser_status,
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
  });

  deps.events.info("queue.job.terminal", {
    job_id: job.id,
    terminal: terminalRunStatus,
    provider_run_id: providerRunId,
    capture_failures: capture.failures,
  });

  const terminal: RunResult["terminal"] =
    outcome.kind === "succeeded"
      ? "succeeded"
      : outcome.kind === "cancelled"
        ? "cancelled"
        : "failed";
  return { job_id: job.id, terminal, turn_id: turnId, provider_run_id: providerRunId };
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
): Promise<AgentOutcome> {
  try {
    return await adapter.run(req, signal);
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
  };
  return req;
}

function insertProviderRunStart(args: {
  db: DbHandle;
  id: string;
  jobId: string;
  sessionId: string;
  provider: string;
  req: AgentRequest;
  redactor: Redactor;
}): void {
  const argvRedacted = JSON.stringify(args.redactor.applyToJson({
    message: args.req.message,
    channel: args.req.channel,
  }));
  const snapshot = JSON.stringify(args.redactor.applyToJson({
    attachments: args.req.attachments ?? [],
    session_id: args.req.session_id,
  }));
  args.db
    .prepare<
      unknown,
      [string, string, string, string, string, string]
    >(
      `INSERT INTO provider_runs
         (id, job_id, session_id, provider, context_packing_mode, status,
          argv_json_redacted, cwd, injected_snapshot_json, parser_status)
       VALUES(?, ?, ?, ?, 'replay_mode', 'started', ?, '.', ?, 'parsed')`,
    )
    .run(args.id, args.jobId, args.sessionId, args.provider, argvRedacted, snapshot);
}

function commitSystemNoop(deps: WorkerDeps, job: ClaimedJob): RunResult {
  // Mark the job succeeded without a provider_runs row. Used by
  // Phase 4 for non-provider job types (storage_sync, notification_retry)
  // that haven't been wired yet — keeps the queue moving in tests.
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
