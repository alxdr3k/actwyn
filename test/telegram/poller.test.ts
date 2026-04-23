import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, type DbHandle } from "../../src/db.ts";
import { migrate } from "../../src/db/migrator.ts";
import { createRedactor } from "../../src/observability/redact.ts";
import { createEmitter } from "../../src/observability/events.ts";
import { readOffset, type InboundDeps } from "../../src/telegram/inbound.ts";
import { pollOnce, runPoller, StubTransport } from "../../src/telegram/poller.ts";
import type { TelegramUpdate } from "../../src/telegram/types.ts";

const MIGRATIONS = join(import.meta.dir, "..", "..", "migrations");
const AUTHORIZED = 1_000_001;
const UNAUTHORIZED = 999_999;

let workdir: string;
let db: DbHandle;
let inbound: InboundDeps;

function ids(): () => string {
  let n = 0;
  return () => `id-${(++n).toString().padStart(4, "0")}`;
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "actwyn-poller-"));
  db = openDatabase({ path: join(workdir, "t.db"), busyTimeoutMs: 250 });
  migrate(db, MIGRATIONS);
  inbound = {
    db,
    redactor: createRedactor(
      {
        email_pii_mode: true,
        phone_pii_mode: false,
        high_entropy_min_length: 32,
        high_entropy_min_bits_per_char: 4.0,
      },
      { exact_values: [] },
    ),
    config: {
      authorized_user_ids: new Set([AUTHORIZED]),
      bootstrap_whoami: false,
      attachment: { max_inbound_size_bytes: 20 * 1024 * 1024 },
      s3_bucket: "actwyn-test",
    },
    newId: ids(),
    now: () => new Date("2026-04-23T00:00:00.000Z"),
  };
});

afterEach(() => {
  db.close();
  rmSync(workdir, { recursive: true, force: true });
});

function txt(update_id: number, text: string, userId = AUTHORIZED): TelegramUpdate {
  return {
    update_id,
    message: {
      message_id: update_id * 10,
      date: 1_700_000_000,
      from: { id: userId },
      chat: { id: 100, type: "private" },
      text,
    },
  };
}

function silent() {
  return createEmitter({ level: "error", sink: () => {} });
}

// ---------------------------------------------------------------
// pollOnce + StubTransport — single iteration
// ---------------------------------------------------------------

describe("pollOnce", () => {
  test("empty batch: no writes, offset unchanged", async () => {
    const transport = new StubTransport({ scripted: [[]] });
    const result = await pollOnce({
      db,
      inbound,
      transport,
      events: silent(),
      poll_timeout_seconds: 1,
    });
    expect(result.processed).toEqual([]);
    expect(readOffset(db)).toBe(0);
    expect(transport.call_log[0]!.offset).toBe(0);
  });

  test("single batch: offset advances past max(update_id)", async () => {
    const transport = new StubTransport({ scripted: [[txt(5, "a"), txt(6, "b")]] });
    const result = await pollOnce({
      db,
      inbound,
      transport,
      events: silent(),
      poll_timeout_seconds: 1,
    });
    expect(result.offset_after).toBe(7);
    expect(readOffset(db)).toBe(7);
  });

  test("second call uses advanced offset", async () => {
    const transport = new StubTransport({
      scripted: [[txt(1, "a")], [txt(2, "b")]],
    });
    await pollOnce({ db, inbound, transport, events: silent() });
    await pollOnce({ db, inbound, transport, events: silent() });
    const calls = transport.call_log;
    expect(calls[0]!.offset).toBe(0);
    expect(calls[1]!.offset).toBe(2);
  });
});

// ---------------------------------------------------------------
// End-to-end stub test (Phase 3 exit criterion)
// ---------------------------------------------------------------

describe("stub end-to-end — 50 updates", () => {
  test("50 updates → 50 telegram_updates rows → correct counts + offset = max+1", async () => {
    const updates: TelegramUpdate[] = [];
    for (let i = 1; i <= 50; i++) {
      if (i % 10 === 0) updates.push(txt(i, "spy", UNAUTHORIZED));
      else if (i % 7 === 0)
        updates.push({ update_id: i, edited_message: {} } as TelegramUpdate);
      else updates.push(txt(i, `msg ${i}`));
    }
    const transport = new StubTransport({ scripted: [updates, [], []] });
    await pollOnce({ db, inbound, transport, events: silent() });

    const rowCount =
      db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM telegram_updates").get()?.n ?? 0;
    expect(rowCount).toBe(50);
    const enqueued =
      db
        .prepare<{ n: number }>(
          "SELECT COUNT(*) AS n FROM telegram_updates WHERE status='enqueued'",
        )
        .get()?.n ?? 0;
    const skipped =
      db
        .prepare<{ n: number }>(
          "SELECT COUNT(*) AS n FROM telegram_updates WHERE status='skipped'",
        )
        .get()?.n ?? 0;
    expect(enqueued + skipped).toBe(50);
    expect(readOffset(db)).toBe(51);
    // Unauthorized updates created zero jobs (AC-TEL-001).
    const jobCount =
      db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM jobs").get()?.n ?? 0;
    expect(jobCount).toBe(enqueued);
  });
});

// ---------------------------------------------------------------
// Error backoff in runPoller
// ---------------------------------------------------------------

describe("runPoller — error backoff", () => {
  test("retries after transport error and bounds iterations", async () => {
    let throws = 0;
    const transport: import("../../src/telegram/poller.ts").TelegramTransport = {
      async getUpdates() {
        throws += 1;
        if (throws < 2) throw new Error("network");
        return [];
      },
    };
    await runPoller(
      { db, inbound, transport, events: silent() },
      { max_iterations: 3, error_backoff_ms_initial: 1, error_backoff_ms_max: 2 },
    );
    expect(throws).toBeGreaterThanOrEqual(2);
  });

  test("stops immediately when signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let called = 0;
    const transport = {
      async getUpdates() {
        called += 1;
        return [];
      },
    };
    await runPoller(
      { db, inbound, transport, events: silent() },
      { signal: controller.signal, max_iterations: 5 },
    );
    expect(called).toBe(0);
  });
});
