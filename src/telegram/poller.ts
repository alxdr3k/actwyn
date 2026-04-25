// Personal Agent P0 — Telegram long-poll loop.
//
// Reads `telegram_next_offset` from `settings`, calls `getUpdates`,
// and hands each batch to `processBatch()` in `inbound.ts`. The
// offset advance happens in the same db.tx() that inbound uses —
// this module never writes the offset directly (HLD §9.5).
//
// Transport is injectable: tests pass a stub; prod passes a small
// Telegram Bot API client that calls `fetch`.

import type { DbHandle } from "~/db.ts";
import type { EventEmitter } from "~/observability/events.ts";
import { processBatch, readOffset, type BatchResult, type InboundDeps } from "~/telegram/inbound.ts";
import type { OutboundTransport } from "~/telegram/outbound.ts";
import type { TelegramUpdate } from "~/telegram/types.ts";
import { whoamiReply } from "~/commands/whoami.ts";

export interface GetUpdatesArgs {
  readonly offset: number;
  readonly timeout_seconds: number;
}

export interface TelegramTransport {
  getUpdates(args: GetUpdatesArgs): Promise<readonly TelegramUpdate[]>;
}

export interface PollerDeps {
  readonly db: DbHandle;
  readonly inbound: InboundDeps;
  readonly transport: TelegramTransport;
  readonly events: EventEmitter;
  readonly poll_timeout_seconds?: number;
  readonly on_batch?: (result: BatchResult) => void;
  /** Optional outbound transport for bootstrap whoami replies (DEC-009). */
  readonly outbound?: OutboundTransport;
}

/** Run one poll iteration: fetch at current offset → process batch. */
export async function pollOnce(deps: PollerDeps): Promise<BatchResult> {
  const offset = readOffset(deps.db);
  const timeout = deps.poll_timeout_seconds ?? 25;
  const updates = await deps.transport.getUpdates({ offset, timeout_seconds: timeout });
  const result = processBatch(deps.inbound, updates);
  if (deps.on_batch) deps.on_batch(result);
  if (updates.length > 0) {
    deps.events.info("telegram.poll", {
      received: updates.length,
      offset_before: offset,
      offset_after: result.offset_after,
      enqueued: result.processed.filter((p) => p.telegram_status === "enqueued").length,
      skipped: result.processed.filter((p) => p.telegram_status === "skipped").length,
    });
  }

  // Control-plane instant responses (e.g. /cancel handled without a job):
  // send notifications outside the inbound txn (zero-network invariant).
  if (deps.outbound) {
    for (const outcome of result.processed) {
      if (!outcome.instant_response) continue;
      const { chat_id, text } = outcome.instant_response;
      deps.outbound.send({ chat_id, text }).catch((e) => {
        deps.events.warn("telegram.instant_response.send_error", {
          chat_id,
          error_message: (e as Error).message,
        });
      });
    }
  }

  // Bootstrap whoami delivery (DEC-009): send user_id/chat_id to the sender
  // outside the inbound txn (zero-network invariant in inbound.ts §4.2).
  if (deps.outbound && deps.inbound.config.bootstrap_whoami) {
    // Check DEC-009 expiry — skip delivery if the window has closed.
    const expiryRow = deps.db
      .prepare<{ value: string }, [string]>(
        "SELECT value FROM settings WHERE key = ?",
      )
      .get("bootstrap_whoami.expires_at");
    const expired = expiryRow?.value
      ? new Date(expiryRow.value).getTime() <= Date.now()
      : false;

    if (!expired) {
      for (const outcome of result.processed) {
        if (outcome.skip_reason !== "bootstrap_whoami_only") continue;
        const update = updates.find((u) => u.update_id === outcome.update_id);
        if (!update?.message) continue;
        const chatId = String(update.message.chat.id);
        const userId = String(update.message.from?.id ?? "");
        const reply = whoamiReply({ user_id: userId, chat_id: chatId, bootstrap: true });
        deps.outbound.send({ chat_id: chatId, text: reply.text }).catch((e) => {
          deps.events.warn("telegram.bootstrap_whoami.send_error", {
            chat_id: chatId,
            error_message: (e as Error).message,
          });
        });
      }
    }
  }

  return result;
}

export interface RunOptions {
  readonly signal?: AbortSignal;
  /** Max iterations; `undefined` = forever. Tests cap this. */
  readonly max_iterations?: number;
  /** Milliseconds to wait between iterations when the transport throws. */
  readonly error_backoff_ms_initial?: number;
  readonly error_backoff_ms_max?: number;
}

/** Drive the poll loop until `signal.aborted` or `max_iterations`. */
export async function runPoller(
  deps: PollerDeps,
  opts: RunOptions = {},
): Promise<void> {
  const initialBackoff = opts.error_backoff_ms_initial ?? 500;
  const maxBackoff = opts.error_backoff_ms_max ?? 30_000;
  let backoff = initialBackoff;
  let iterations = 0;
  while (!opts.signal?.aborted) {
    try {
      await pollOnce(deps);
      backoff = initialBackoff;
    } catch (e) {
      deps.events.warn("telegram.poll.error", {
        error_type: (e as Error).name,
        error_message: (e as Error).message,
        backoff_ms: backoff,
      });
      await sleep(backoff, opts.signal);
      backoff = Math.min(maxBackoff, backoff * 2);
    }
    iterations += 1;
    if (opts.max_iterations !== undefined && iterations >= opts.max_iterations) {
      return;
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
// In-memory stub transport for tests.
// ---------------------------------------------------------------

export interface StubTransportOptions {
  /** Batches to return, in order, keyed by the offset the poller sends. */
  readonly scripted: ReadonlyArray<readonly TelegramUpdate[]>;
  /** When true, drop updates whose update_id < offset (Telegram real behaviour). */
  readonly filter_by_offset?: boolean;
}

export class StubTransport implements TelegramTransport {
  private calls: GetUpdatesArgs[] = [];
  private index = 0;
  constructor(private readonly opts: StubTransportOptions) {}

  async getUpdates(args: GetUpdatesArgs): Promise<readonly TelegramUpdate[]> {
    this.calls.push(args);
    const batch = this.opts.scripted[this.index] ?? [];
    this.index += 1;
    if (this.opts.filter_by_offset ?? true) {
      return batch.filter((u) => u.update_id >= args.offset);
    }
    return batch;
  }

  get call_log(): readonly GetUpdatesArgs[] {
    return this.calls;
  }

  get calls_made(): number {
    return this.calls.length;
  }
}
