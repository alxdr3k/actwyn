import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, type DbHandle } from "../../src/db.ts";
import { migrate } from "../../src/db/migrator.ts";
import {
  insertMemoryItem,
  MemoryProvenanceError,
  revokeMemoryItem,
  supersedeMemoryItem,
  type NewMemoryItem,
} from "../../src/memory/items.ts";

const MIGRATIONS = join(import.meta.dir, "..", "..", "migrations");

let workdir: string;
let db: DbHandle;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "actwyn-mem-"));
  db = openDatabase({ path: join(workdir, "t.db"), busyTimeoutMs: 250 });
  migrate(db, MIGRATIONS);
  db.prepare<unknown, [string, string, string]>(
    "INSERT INTO sessions(id, chat_id, user_id) VALUES(?, ?, ?)",
  ).run("sess-1", "chat-1", "user-1");
});

afterEach(() => {
  db.close();
  rmSync(workdir, { recursive: true, force: true });
});

function sample(overrides: Partial<NewMemoryItem> = {}): NewMemoryItem {
  return {
    session_id: "sess-1",
    item_type: "fact",
    content: "sky is blue",
    provenance: "user_stated",
    confidence: 0.9,
    source_turn_ids: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------
// Provenance gate
// ---------------------------------------------------------------

describe("provenance gate — long-term preferences", () => {
  test("preference with user_stated provenance → inserted", () => {
    insertMemoryItem(db, "m-1", sample({ item_type: "preference" }));
    const row = db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM memory_items").get()!;
    expect(row.n).toBe(1);
  });

  test("preference with inferred provenance → rejected", () => {
    expect(() =>
      insertMemoryItem(db, "m-2", sample({ item_type: "preference", provenance: "inferred" })),
    ).toThrow(MemoryProvenanceError);
  });

  test("non-preference item with inferred provenance is fine", () => {
    insertMemoryItem(db, "m-3", sample({ item_type: "fact", provenance: "inferred" }));
    const row = db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM memory_items").get()!;
    expect(row.n).toBe(1);
  });
});

// ---------------------------------------------------------------
// Supersede semantics (AC-MEM-004)
// ---------------------------------------------------------------

describe("AC-MEM-004 — supersede flips old row in the same txn", () => {
  test("new item with supersedes_memory_id flips old row to superseded", () => {
    insertMemoryItem(db, "m-old", sample({ content: "outdated" }));
    supersedeMemoryItem({
      db,
      old_id: "m-old",
      new_id: "m-new",
      new_item: sample({ content: "updated" }),
    });
    const oldRow = db
      .prepare<{ status: string; status_changed_at: string | null }, [string]>(
        "SELECT status, status_changed_at FROM memory_items WHERE id = ?",
      )
      .get("m-old")!;
    expect(oldRow.status).toBe("superseded");
    expect(oldRow.status_changed_at).not.toBeNull();

    const newRow = db
      .prepare<
        { status: string; supersedes_memory_id: string | null },
        [string]
      >("SELECT status, supersedes_memory_id FROM memory_items WHERE id = ?")
      .get("m-new")!;
    expect(newRow.status).toBe("active");
    expect(newRow.supersedes_memory_id).toBe("m-old");
  });

  test("correcting a REVOKED id produces a fresh row without a supersedes pointer", () => {
    insertMemoryItem(db, "m-a", sample({ content: "original" }));
    revokeMemoryItem(db, "m-a");
    supersedeMemoryItem({
      db,
      old_id: "m-a",
      new_id: "m-b",
      new_item: sample({ content: "correction" }),
    });
    const newRow = db
      .prepare<
        { status: string; supersedes_memory_id: string | null },
        [string]
      >("SELECT status, supersedes_memory_id FROM memory_items WHERE id = ?")
      .get("m-b")!;
    expect(newRow.status).toBe("active");
    expect(newRow.supersedes_memory_id).toBeNull();
  });

  test("unknown old_id throws MemoryProvenanceError", () => {
    expect(() =>
      supersedeMemoryItem({
        db,
        old_id: "nope",
        new_id: "m-x",
        new_item: sample(),
      }),
    ).toThrow(MemoryProvenanceError);
  });
});

// ---------------------------------------------------------------
// Revoke (tombstone)
// ---------------------------------------------------------------

describe("revokeMemoryItem — tombstone only, no delete", () => {
  test("active → revoked", () => {
    insertMemoryItem(db, "m-r", sample());
    revokeMemoryItem(db, "m-r");
    const row = db
      .prepare<{ status: string }, [string]>(
        "SELECT status FROM memory_items WHERE id = ?",
      )
      .get("m-r")!;
    expect(row.status).toBe("revoked");
  });

  test("superseded → revoked", () => {
    insertMemoryItem(db, "m-s", sample());
    supersedeMemoryItem({ db, old_id: "m-s", new_id: "m-s2", new_item: sample() });
    revokeMemoryItem(db, "m-s");
    const row = db
      .prepare<{ status: string }, [string]>(
        "SELECT status FROM memory_items WHERE id = ?",
      )
      .get("m-s")!;
    expect(row.status).toBe("revoked");
  });

  test("already-revoked row stays revoked (idempotent)", () => {
    insertMemoryItem(db, "m-r2", sample());
    revokeMemoryItem(db, "m-r2");
    revokeMemoryItem(db, "m-r2");
    const row = db
      .prepare<{ status: string }, [string]>(
        "SELECT status FROM memory_items WHERE id = ?",
      )
      .get("m-r2")!;
    expect(row.status).toBe("revoked");
  });
});
