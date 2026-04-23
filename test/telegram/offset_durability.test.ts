import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, type DbHandle } from "../../src/db.ts";
import { migrate } from "../../src/db/migrator.ts";
import { createRedactor } from "../../src/observability/redact.ts";
import {
  processBatch,
  readOffset,
  insertReceived,
  classifyAndCommit,
  type InboundDeps,
} from "../../src/telegram/inbound.ts";
import type { TelegramUpdate } from "../../src/telegram/types.ts";

// Reproduces SP-03 offset-durability invariants deterministically:
//   1. A crash BEFORE the batch txn commits must NOT advance the offset.
//      (The same updates reappear on next poll.)
//   2. A crash AFTER the batch txn commits MUST leave the advanced
//      offset intact (re-opening the DB sees the new value).
//   3. Duplicate delivery of already-processed update_ids is idempotent:
//      no second telegram_updates row and no second jobs row.
//
// We simulate crash-before-commit by having the batch work throw
// from inside db.tx(); the tx helper rolls back.

const MIGRATIONS = join(import.meta.dir, "..", "..", "migrations");
const AUTHORIZED = 1_000_001;

function ids(): () => string {
  let n = 0;
  return () => `id-${(++n).toString().padStart(5, "0")}`;
}

function buildDeps(db: DbHandle): InboundDeps {
  return {
    db,
    redactor: createRedactor(
      {
        email_pii_mode: false,
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
    now: () => new Date(),
  };
}

function txt(update_id: number, text: string): TelegramUpdate {
  return {
    update_id,
    message: {
      message_id: update_id * 10,
      date: 1_700_000_000,
      from: { id: AUTHORIZED },
      chat: { id: 100, type: "private" },
      text,
    },
  };
}

let workdir: string;
let dbPath: string;
let db: DbHandle;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "actwyn-offset-"));
  dbPath = join(workdir, "t.db");
  db = openDatabase({ path: dbPath, busyTimeoutMs: 250 });
  migrate(db, MIGRATIONS);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // May already be closed in the restart test.
  }
  rmSync(workdir, { recursive: true, force: true });
});

describe("SP-03 — offset durability", () => {
  test("crash BEFORE commit: offset does NOT advance; no rows persist", () => {
    const deps = buildDeps(db);
    expect(readOffset(db)).toBe(0);

    // Simulate a crash inside the batch txn by throwing after
    // classifyAndCommit.
    expect(() =>
      db.tx(() => {
        const u = txt(100, "will be rolled back");
        insertReceived(deps, u);
        classifyAndCommit(deps, u);
        throw new Error("simulated crash before commit");
      }),
    ).toThrow("simulated crash before commit");

    expect(readOffset(db)).toBe(0);
    const n =
      db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM telegram_updates").get()?.n ?? 0;
    expect(n).toBe(0);
    const j = db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM jobs").get()?.n ?? 0;
    expect(j).toBe(0);
  });

  test("commit persists offset and survives a DB close/reopen", () => {
    const deps = buildDeps(db);
    processBatch(deps, [txt(1, "a"), txt(2, "b"), txt(3, "c")]);
    expect(readOffset(db)).toBe(4);
    db.close();
    const reopened = openDatabase({ path: dbPath, busyTimeoutMs: 250 });
    try {
      expect(readOffset(reopened)).toBe(4);
      const rows =
        reopened
          .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM telegram_updates")
          .get()?.n ?? 0;
      expect(rows).toBe(3);
    } finally {
      reopened.close();
      // Re-open so afterEach can close without error.
      db = openDatabase({ path: dbPath, busyTimeoutMs: 250 });
    }
  });

  test("re-delivery of already-processed update_id is idempotent", () => {
    const deps = buildDeps(db);
    const u = txt(7, "hi");
    processBatch(deps, [u]);
    processBatch(deps, [u, u]); // Telegram re-delivers twice.
    const rows =
      db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM telegram_updates").get()?.n ?? 0;
    expect(rows).toBe(1);
    const jobs = db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM jobs").get()?.n ?? 0;
    expect(jobs).toBe(1);
    expect(readOffset(db)).toBe(8);
  });

  test("interleaved batch with failing classify does NOT lose earlier updates", () => {
    // A row that throws mid-txn must roll the whole batch back per
    // HLD §7.1 transaction boundary (single txn per batch). This
    // test asserts the behaviour so we don't silently drift.
    const deps = buildDeps(db);
    const bad: TelegramUpdate = {
      update_id: 42,
      // Crafted to be malformed (no from); will be classified "skip",
      // which is a commit-clean path. Replace with an actual throw
      // by poking the redactor: we inject a redactor that throws on
      // the second applyToJson call.
      message: {
        message_id: 420,
        date: 1_700_000_000,
        from: { id: AUTHORIZED },
        chat: { id: 100, type: "private" },
        text: "real",
      },
    };

    let calls = 0;
    const throwingRedactor = {
      apply: deps.redactor.apply.bind(deps.redactor),
      detect: deps.redactor.detect.bind(deps.redactor),
      applyToJson: <T,>(v: T): T => {
        calls += 1;
        if (calls === 2) throw new Error("redactor boom");
        return deps.redactor.applyToJson(v) as T;
      },
    };
    const depsWithBoom: InboundDeps = { ...deps, redactor: throwingRedactor };

    expect(() =>
      processBatch(depsWithBoom, [txt(1, "first"), bad]),
    ).toThrow("redactor boom");

    // Entire batch rolled back: no rows, no offset move.
    expect(readOffset(db)).toBe(0);
    const rows =
      db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM telegram_updates").get()?.n ?? 0;
    expect(rows).toBe(0);
  });
});
