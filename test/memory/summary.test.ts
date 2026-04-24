import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, type DbHandle } from "../../src/db.ts";
import { migrate } from "../../src/db/migrator.ts";
import {
  shouldAutoTriggerSummary,
  writeSummary,
  type SummaryOutput,
} from "../../src/memory/summary.ts";

const MIGRATIONS = join(import.meta.dir, "..", "..", "migrations");

let workdir: string;
let db: DbHandle;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "actwyn-sum-"));
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

describe("shouldAutoTriggerSummary — DEC-019 throttle + triggers", () => {
  test("no trigger matches → trigger=false, throttle_blocked=false", () => {
    const r = shouldAutoTriggerSummary({
      turns_since_last_summary: 1,
      transcript_estimated_tokens: 100,
      session_age_seconds: 60,
      user_turns_since_last_summary: 3,
    });
    expect(r.trigger).toBe(false);
    expect(r.throttle_blocked).toBe(false);
  });

  test("turn_count trigger + enough user turns → trigger=true", () => {
    const r = shouldAutoTriggerSummary({
      turns_since_last_summary: 20,
      transcript_estimated_tokens: 100,
      session_age_seconds: 60,
      user_turns_since_last_summary: 10,
    });
    expect(r.trigger).toBe(true);
    expect(r.reason).toContain("turn_count");
  });

  test("token_budget trigger but fewer than 8 user turns → throttle blocks", () => {
    const r = shouldAutoTriggerSummary({
      turns_since_last_summary: 5,
      transcript_estimated_tokens: 7000,
      session_age_seconds: 60,
      user_turns_since_last_summary: 3,
    });
    expect(r.trigger).toBe(false);
    expect(r.throttle_blocked).toBe(true);
    expect(r.reason).toContain("throttle_blocked");
    expect(r.reason).toContain("token_budget");
  });

  test("session_age trigger ≥ 24h and enough turns → trigger=true", () => {
    const r = shouldAutoTriggerSummary({
      turns_since_last_summary: 2,
      transcript_estimated_tokens: 50,
      session_age_seconds: 30 * 60 * 60, // 30h
      user_turns_since_last_summary: 8,
    });
    expect(r.trigger).toBe(true);
    expect(r.reason).toContain("session_age");
  });

  test("exactly 8 user turns satisfies throttle", () => {
    const r = shouldAutoTriggerSummary({
      turns_since_last_summary: 20,
      transcript_estimated_tokens: 100,
      session_age_seconds: 60,
      user_turns_since_last_summary: 8,
    });
    expect(r.trigger).toBe(true);
  });
});

// ---------------------------------------------------------------
// writeSummary — persistence + provenance gate on preferences
// ---------------------------------------------------------------

function summary(overrides: Partial<SummaryOutput> = {}): SummaryOutput {
  return {
    session_id: "sess-1",
    summary_type: "session",
    facts: [{ content: "fact", provenance: "observed", confidence: 0.6 }],
    preferences: [],
    open_tasks: [],
    decisions: [],
    cautions: [],
    source_turn_ids: ["turn-1", "turn-2"],
    ...overrides,
  };
}

describe("writeSummary — schema-valid row", () => {
  test("persists a memory_summaries row with every JSON column populated", () => {
    const out = writeSummary({
      db,
      newId: () => "sum-1",
      summary: summary({
        preferences: [{ content: "likes dark mode", provenance: "user_stated", confidence: 0.95 }],
      }),
    });
    expect(out.summary_id).toBe("sum-1");
    expect(out.kept_preferences).toBe(1);
    expect(out.dropped_preferences).toBe(0);

    const row = db
      .prepare<
        {
          session_id: string;
          summary_type: string;
          facts_json: string;
          preferences_json: string;
          provenance_json: string;
          confidence_json: string;
          source_turn_ids: string;
        },
        [string]
      >(
        `SELECT session_id, summary_type, facts_json, preferences_json,
                provenance_json, confidence_json, source_turn_ids
         FROM memory_summaries WHERE id = ?`,
      )
      .get("sum-1")!;
    expect(row.session_id).toBe("sess-1");
    expect(row.summary_type).toBe("session");
    expect(JSON.parse(row.facts_json).length).toBe(1);
    expect(JSON.parse(row.preferences_json).length).toBe(1);
    expect(JSON.parse(row.provenance_json).preferences).toEqual(["user_stated"]);
    expect(JSON.parse(row.confidence_json).preferences).toEqual([0.95]);
    expect(JSON.parse(row.source_turn_ids)).toEqual(["turn-1", "turn-2"]);
  });

  test("inferred preferences are dropped before persistence (PRD §12.2 gate)", () => {
    const out = writeSummary({
      db,
      newId: () => "sum-2",
      summary: summary({
        preferences: [
          { content: "likes dark mode", provenance: "user_stated", confidence: 0.9 },
          { content: "prefers terse replies", provenance: "inferred", confidence: 0.4 },
          { content: "hates noise", provenance: "assistant_generated", confidence: 0.5 },
        ],
      }),
    });
    expect(out.kept_preferences).toBe(1);
    expect(out.dropped_preferences).toBe(2);

    const row = db
      .prepare<{ preferences_json: string }, [string]>(
        "SELECT preferences_json FROM memory_summaries WHERE id = ?",
      )
      .get("sum-2")!;
    const kept = JSON.parse(row.preferences_json);
    expect(kept.length).toBe(1);
    expect(kept[0].content).toBe("likes dark mode");
  });

  test("empty summary writes a row with empty arrays", () => {
    writeSummary({ db, newId: () => "sum-3", summary: summary({ facts: [] }) });
    const n = db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM memory_summaries").get()!.n;
    expect(n).toBe(1);
  });
});

// ---------------------------------------------------------------
// writeSummary — promotes items to memory_items (HLD §6.5 / line 409)
// ---------------------------------------------------------------

describe("writeSummary — promotes summary items to memory_items rows", () => {
  let idSeq = 0;
  function nextId(): string { return `id-${++idSeq}`; }

  beforeEach(() => { idSeq = 0; });

  test("facts → memory_items with item_type='fact' and status='active'", () => {
    writeSummary({
      db,
      newId: nextId,
      summary: summary({
        facts: [
          { content: "user prefers Python", provenance: "observed", confidence: 0.7 },
          { content: "user has a dog", provenance: "user_stated", confidence: 0.99 },
        ],
      }),
    });
    const items = db
      .prepare<{ item_type: string; status: string; provenance: string; content: string }>(
        "SELECT item_type, status, provenance, content FROM memory_items WHERE session_id = 'sess-1' ORDER BY created_at",
      )
      .all();
    expect(items.length).toBe(2);
    for (const it of items) {
      expect(it.item_type).toBe("fact");
      expect(it.status).toBe("active");
    }
    expect(items.map((i) => i.content)).toContain("user prefers Python");
    expect(items.map((i) => i.content)).toContain("user has a dog");
  });

  test("provenance-gated preference (user_stated) → memory_items; inferred preference → dropped", () => {
    const out = writeSummary({
      db,
      newId: nextId,
      summary: summary({
        preferences: [
          { content: "prefers short replies", provenance: "user_stated", confidence: 0.9 },
          { content: "prefers Python", provenance: "inferred", confidence: 0.4 },
        ],
      }),
    });
    expect(out.kept_preferences).toBe(1);
    expect(out.dropped_preferences).toBe(1);
    expect(out.memory_items_inserted).toBe(2); // 1 fact (from summary()) + 1 preference
    const prefs = db
      .prepare<{ item_type: string; content: string }>(
        "SELECT item_type, content FROM memory_items WHERE item_type = 'preference'",
      )
      .all();
    expect(prefs.length).toBe(1);
    expect(prefs[0]!.content).toBe("prefers short replies");
  });

  test("open_tasks, decisions, cautions each produce memory_items rows", () => {
    writeSummary({
      db,
      newId: nextId,
      summary: summary({
        facts: [],
        open_tasks: [{ content: "buy coffee", provenance: "user_stated", confidence: 0.8 }],
        decisions: [{ content: "use PostgreSQL", provenance: "observed", confidence: 0.6 }],
        cautions: [{ content: "avoid peanuts", provenance: "user_stated", confidence: 1.0 }],
      }),
    });
    const types = db
      .prepare<{ item_type: string }>("SELECT item_type FROM memory_items WHERE session_id = 'sess-1'")
      .all()
      .map((r) => r.item_type);
    expect(types).toContain("open_task");
    expect(types).toContain("decision");
    expect(types).toContain("caution");
  });

  test("memory_items_inserted count reflects total promoted items", () => {
    const out = writeSummary({
      db,
      newId: nextId,
      summary: summary({
        facts: [{ content: "f1", provenance: "observed", confidence: 0.5 }],
        open_tasks: [{ content: "t1", provenance: "user_stated", confidence: 0.8 }],
        decisions: [{ content: "d1", provenance: "observed", confidence: 0.6 }],
        preferences: [{ content: "p1", provenance: "user_stated", confidence: 0.9 }],
        cautions: [{ content: "c1", provenance: "user_stated", confidence: 1.0 }],
      }),
    });
    expect(out.memory_items_inserted).toBe(5);
  });
});
