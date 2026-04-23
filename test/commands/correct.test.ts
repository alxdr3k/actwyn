import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, type DbHandle } from "../../src/db.ts";
import { migrate } from "../../src/db/migrator.ts";
import { correctMemory, parseCorrection } from "../../src/commands/correct.ts";
import { insertMemoryItem } from "../../src/memory/items.ts";

const MIGRATIONS = join(import.meta.dir, "..", "..", "migrations");

let workdir: string;
let db: DbHandle;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "actwyn-correct-"));
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

describe("parseCorrection — natural language", () => {
  test("Korean: '정정: 서울이 아니라 부산이야'", () => {
    const r = parseCorrection("정정: 서울이 아니라 부산이야");
    expect(r?.old_hint).toBe("서울");
    expect(r?.new_value).toBe("부산");
  });

  test("English: 'not X but Y'", () => {
    const r = parseCorrection("not Tuesday but Wednesday");
    expect(r?.old_hint).toBe("Tuesday");
    expect(r?.new_value).toBe("Wednesday");
  });

  test("English: 'correction: not X but Y.'", () => {
    const r = parseCorrection("correction: not blue but green.");
    expect(r?.old_hint).toBe("blue");
    expect(r?.new_value).toBe("green");
  });

  test("No correction phrase → null", () => {
    expect(parseCorrection("what time is it")).toBeNull();
    expect(parseCorrection("")).toBeNull();
  });
});

describe("correctMemory — supersede semantics (AC-MEM-004)", () => {
  test("inserts new + flips old in the same txn", () => {
    insertMemoryItem(db, "m-old", {
      session_id: "sess-1",
      item_type: "fact",
      content: "서울",
      provenance: "user_stated",
      confidence: 0.9,
      source_turn_ids: [],
    });
    correctMemory(db, {
      old_id: "m-old",
      new_id: "m-new",
      new_item: {
        session_id: "sess-1",
        item_type: "fact",
        content: "부산",
        provenance: "user_stated",
        confidence: 0.95,
        source_turn_ids: [],
      },
    });
    const old = db
      .prepare<{ status: string }, [string]>("SELECT status FROM memory_items WHERE id = ?")
      .get("m-old")!;
    const fresh = db
      .prepare<
        { status: string; supersedes_memory_id: string | null },
        [string]
      >("SELECT status, supersedes_memory_id FROM memory_items WHERE id = ?")
      .get("m-new")!;
    expect(old.status).toBe("superseded");
    expect(fresh.status).toBe("active");
    expect(fresh.supersedes_memory_id).toBe("m-old");
  });
});
